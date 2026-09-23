import React, { useEffect, useState } from 'react';
import apiClient from '../utils/api';
import { fetchActiveCycle, slotsInCycleDates } from '../utils/activeCycle';
import { useAuth } from '../context/AuthContext';
import AccessControl from '../components/AccessControl';
import {
  GtkucBookedMeetingCard,
  GtkucSlotCard,
  GtkucSlotGrid,
  formatSlotDateTime,
} from '../components/GtkucSlotGallery';
import {
  MODIFY_CUTOFF_HOURS,
  canModify,
  currentCycleBooking,
  errorText,
} from '../utils/schedulingWindows';
import {
  Box,
  Container,
  Typography,
  Paper,
  Button,
  Alert,
  CircularProgress,
} from '@mui/material';
import {
  Schedule as ScheduleIcon,
  CheckCircle as CheckCircleIcon,
} from '@mui/icons-material';

// /my-meeting-signups does not always carry the slot id, so match the slot the
// booking sits in by id when it is there, and by host, time and place otherwise.
const isBookedSlot = (slot, signup) =>
  signup.slotId
    ? slot.id === signup.slotId
    : new Date(slot.startTime).getTime() === new Date(signup.startTime).getTime() &&
      slot.location === signup.location &&
      slot.memberName === signup.memberName;

export default function CandidateGTKUC() {
  const { user } = useAuth();
  const [signups, setSignups] = useState([]);
  const [slots, setSlots] = useState([]);
  const [activeCycle, setActiveCycle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // One booking per cycle: with one, the gallery only comes back to pick a new time.
  const [changingTime, setChangingTime] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const [mine, cycle, allSlots] = await Promise.all([
        apiClient.get('/my-meeting-signups'),
        fetchActiveCycle(apiClient).catch(() => null),
        apiClient.get('/meeting-slots'),
      ]);
      setSignups(Array.isArray(mine) ? mine : []);
      setActiveCycle(cycle);
      setSlots(allSlots || []);
    } catch (e) {
      setError(errorText(e, 'Failed to load your Get to Know UC details'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.email]);

  const mySignup = currentCycleBooking(signups, activeCycle, (s) => s.startTime);
  const locked = mySignup ? (mySignup.canModify ?? canModify(mySignup.startTime)) === false : false;
  const cutoffHours = mySignup?.modifyCutoffHours ?? MODIFY_CUTOFF_HOURS;
  const picking = Boolean(mySignup) && changingTime;

  // Bookable slots: within the active cycle, not in the past, with room left,
  // and not the one the candidate already holds.
  const now = new Date();
  const availableSlots = slotsInCycleDates(slots, activeCycle).filter(
    (slot) =>
      new Date(slot.startTime) >= now &&
      slot.remaining > 0 &&
      !(mySignup && isBookedSlot(slot, mySignup))
  );

  const clearMessages = () => {
    setError('');
    setSuccess('');
  };

  const handleBook = async (slotId) => {
    try {
      setActionLoading(true);
      clearMessages();
      const response = await apiClient.post('/my-meeting-signups', { slotId });
      setSuccess(response.message || 'Successfully signed up! You will receive a confirmation email shortly.');
      await load();
    } catch (e) {
      if (e.status === 409 && e.code === 'ALREADY_BOOKED') {
        // They already hold this cycle's meeting; show it.
        setChangingTime(false);
        await load();
      }
      setError(errorText(e, 'Failed to sign up for this meeting slot'));
    } finally {
      setActionLoading(false);
    }
  };

  // Moves the booking in one step. If the new slot is gone the server keeps the
  // current one, so nothing is lost on failure.
  const handleMove = async (slotId) => {
    if (!mySignup) return;
    try {
      setActionLoading(true);
      clearMessages();
      const response = await apiClient.put(`/meeting-signups/${mySignup.id}`, { slotId });
      setChangingTime(false);
      setSuccess(response?.message || 'Your meeting time has been changed.');
      await load();
    } catch (e) {
      setError(errorText(e, 'Failed to change your meeting time'));
      if (e.status === 409) await load();
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!mySignup) return;
    const confirmed = window.confirm('Cancel your Get to Know UC meeting? Your spot will go to someone else.');
    if (!confirmed) return;
    try {
      setActionLoading(true);
      clearMessages();
      await apiClient.delete(`/my-meeting-signups/${mySignup.id}`);
      setChangingTime(false);
      setSuccess('Your meeting has been cancelled. You can book a new time below.');
      await load();
    } catch (e) {
      setError(errorText(e, 'Failed to cancel your meeting'));
    } finally {
      setActionLoading(false);
    }
  };

  const renderSlotPicker = () => (
    <Paper sx={{ p: { xs: 2, md: 3 } }}>
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', sm: 'row' },
          alignItems: { xs: 'stretch', sm: 'center' },
          justifyContent: 'space-between',
          gap: 1.5,
          mb: 2,
        }}
      >
        <Typography variant="h6" sx={{ fontWeight: 600, color: 'primary.dark' }}>
          {picking ? 'Pick a new time' : 'Available Meeting Slots'}
        </Typography>
        {picking && (
          <Button
            variant="outlined"
            onClick={() => setChangingTime(false)}
            disabled={actionLoading}
            sx={{ minHeight: { xs: 44, md: 36 } }}
          >
            Keep my current time
          </Button>
        )}
      </Box>
      {picking && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Your current meeting is {formatSlotDateTime(mySignup.startTime)} with {mySignup.memberName}. It stays
          booked until you pick a new time.
        </Alert>
      )}
      {availableSlots.length === 0 ? (
        <Box sx={{ textAlign: 'center', p: 4 }}>
          <ScheduleIcon sx={{ fontSize: 60, color: 'grey.400', mb: 2 }} />
          <Typography variant="h6" color="text.secondary" sx={{ mb: 1 }}>
            No Available Meeting Slots
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Check back later for new meeting opportunities.
          </Typography>
        </Box>
      ) : (
        <GtkucSlotGrid>
          {availableSlots.map((slot) => (
            <GtkucSlotCard
              key={slot.id}
              slot={slot}
              actions={
                <Button
                  variant="contained"
                  startIcon={<CheckCircleIcon />}
                  onClick={() => (picking ? handleMove(slot.id) : handleBook(slot.id))}
                  disabled={actionLoading}
                  sx={{ minHeight: { xs: 44, md: 36 } }}
                >
                  {picking ? 'Move to this time' : 'Sign Up'}
                </Button>
              }
            />
          ))}
        </GtkucSlotGrid>
      )}
    </Paper>
  );

  return (
    <AccessControl allowedRoles={['USER']}>
      <Container maxWidth="lg" sx={{ py: { xs: 3, md: 4 } }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 1 }}>
          Get to Know UC
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
          Meet with a UConsulting member to learn more about the club and get your questions answered.
        </Typography>
        <Alert severity="info" sx={{ mb: 3 }}>
          <strong>Important:</strong> You can hold one meeting slot per cycle. Change or cancel it yourself here
          (or on the /meet page) up to {MODIFY_CUTOFF_HOURS} hours before it starts.
        </Alert>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}
        {success && (
          <Alert severity="success" sx={{ mb: 3 }} onClose={() => setSuccess('')}>
            {success}
          </Alert>
        )}

        {/* Spinner only on the first load; reloads after an action keep the view in place. */}
        {loading && !mySignup && slots.length === 0 ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
            <CircularProgress />
          </Box>
        ) : mySignup && !changingTime ? (
          <Box sx={{ maxWidth: 852 }}>
            <GtkucBookedMeetingCard
              memberName={mySignup.memberName}
              profile={mySignup.memberProfile}
              startTime={mySignup.startTime}
              location={mySignup.location}
              locked={locked}
              cutoffHours={cutoffHours}
              busy={actionLoading}
              onChangeTime={() => {
                clearMessages();
                setChangingTime(true);
              }}
              onCancel={handleCancel}
            />
          </Box>
        ) : (
          renderSlotPicker()
        )}
      </Container>
    </AccessControl>
  );
}
