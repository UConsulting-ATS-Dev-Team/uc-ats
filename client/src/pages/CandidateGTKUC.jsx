import React, { useEffect, useState } from 'react';
import apiClient from '../utils/api';
import { useAuth } from '../context/AuthContext';
import AccessControl from '../components/AccessControl';
import {
  Box,
  Container,
  Typography,
  Paper,
  Button,
  Card,
  CardContent,
  CardActions,
  Stack,
  Chip,
  Alert,
  CircularProgress,
  Avatar,
  Divider,
} from '@mui/material';
import {
  Schedule as ScheduleIcon,
  LocationOn as LocationIcon,
  Person as PersonIcon,
  CheckCircle as CheckCircleIcon,
  LockClock as LockClockIcon,
} from '@mui/icons-material';

const MODIFY_CUTOFF_HOURS = 12;

const formatDateTime = (dateTime) => {
  const date = new Date(dateTime);
  return date.toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Los_Angeles',
  });
};

// Keep only slots that fall within the active recruiting cycle's date range.
const filterSlotsByCycle = (slotsToFilter, cycle) => {
  if (!cycle) return [];
  if (cycle.startDate || cycle.endDate) {
    return slotsToFilter.filter((slot) => {
      const slotDate = new Date(slot.startTime);
      const startDate = cycle.startDate ? new Date(cycle.startDate) : null;
      const endDate = cycle.endDate ? new Date(cycle.endDate) : null;
      if (startDate && slotDate < startDate) return false;
      if (endDate && slotDate > endDate) return false;
      return true;
    });
  }
  return [];
};

// Curated background for the hosting member. Industries are taxonomy tags, so
// this never surfaces employer names.
const MemberProfile = ({ profile, compact = false }) => {
  if (!profile) return null;
  return (
    <Box sx={{ mt: compact ? 1.5 : 2 }}>
      {!compact && <Divider sx={{ mb: 2 }} />}
      {profile.industries?.length > 0 && (
        <Box sx={{ mb: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
            Industry experience
          </Typography>
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
            {profile.industries.map((industry) => (
              <Chip key={industry} label={industry} size="small" color="primary" variant="outlined" />
            ))}
          </Stack>
        </Box>
      )}
      {profile.interests?.length > 0 && (
        <Box sx={{ mb: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
            Interests
          </Typography>
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
            {profile.interests.map((interest) => (
              <Chip key={interest} label={interest} size="small" variant="outlined" />
            ))}
          </Stack>
        </Box>
      )}
      {profile.relevance && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {profile.relevance}
        </Typography>
      )}
    </Box>
  );
};

export default function CandidateGTKUC() {
  const { user } = useAuth();
  const [mySignup, setMySignup] = useState(null);
  const [slots, setSlots] = useState([]);
  const [activeCycle, setActiveCycle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [rebooking, setRebooking] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      setError('');
      const [signups, cycle, allSlots] = await Promise.all([
        apiClient.get('/my-meeting-signups'),
        apiClient.get('/active-cycle').catch(() => null),
        apiClient.get('/meeting-slots'),
      ]);
      setMySignup(Array.isArray(signups) && signups.length > 0 ? signups[0] : null);
      setActiveCycle(cycle || null);
      setSlots(allSlots || []);
    } catch (e) {
      setError(e.message || 'Failed to load your Get to Know UC details');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.email]);

  // Available slots to book: within the active cycle, not in the past, with room left.
  const getAvailableSlots = () => {
    const now = new Date();
    return filterSlotsByCycle(slots, activeCycle).filter(
      (slot) => new Date(slot.startTime) >= now && slot.remaining > 0
    );
  };

  const handleBook = async (slotId) => {
    try {
      setActionLoading(true);
      setError('');
      setSuccess('');
      const response = await apiClient.post('/my-meeting-signups', { slotId });
      setSuccess(response.message || 'Successfully signed up! You will receive a confirmation email shortly.');
      setRebooking(false);
      await load();
    } catch (e) {
      setError(e.message || 'Failed to sign up for this meeting slot');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!mySignup) return;
    const confirmed = window.confirm('Are you sure you want to cancel your Get to Know UC meeting?');
    if (!confirmed) return;
    try {
      setActionLoading(true);
      setError('');
      setSuccess('');
      await apiClient.delete(`/my-meeting-signups/${mySignup.id}`);
      setSuccess('Your meeting has been cancelled.');
      await load();
    } catch (e) {
      setError(e.message || 'Failed to cancel your meeting');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRebook = async () => {
    if (!mySignup) return;
    const confirmed = window.confirm(
      'Rebooking will release your current meeting slot so you can choose a new one. Continue?'
    );
    if (!confirmed) return;
    try {
      setActionLoading(true);
      setError('');
      setSuccess('');
      await apiClient.delete(`/my-meeting-signups/${mySignup.id}`);
      setRebooking(true);
      await load();
    } catch (e) {
      setError(e.message || 'Failed to start rebooking');
    } finally {
      setActionLoading(false);
    }
  };

  const availableSlots = getAvailableSlots();

  const renderBookedCard = () => (
    <Card variant="outlined" sx={{ borderColor: 'primary.main', borderWidth: 2 }}>
      <CardContent sx={{ p: { xs: 2, md: 3 } }}>
        <Chip label="Upcoming Meeting" color="primary" size="small" sx={{ mb: 2 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
          {mySignup.memberProfile?.photo ? (
            <Avatar src={mySignup.memberProfile.photo} sx={{ width: 48, height: 48 }} />
          ) : (
            <PersonIcon sx={{ color: 'primary.main' }} />
          )}
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            {mySignup.memberName}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <ScheduleIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
          <Typography variant="body1" color="text.secondary">
            {formatDateTime(mySignup.startTime)}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <LocationIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
          <Typography variant="body1" color="text.secondary">
            {mySignup.location}
          </Typography>
        </Box>

        <MemberProfile profile={mySignup.memberProfile} />

        {!mySignup.canModify && (
          <Alert
            severity="info"
            icon={<LockClockIcon fontSize="inherit" />}
            sx={{ mt: 2 }}
          >
            Changes are locked within {MODIFY_CUTOFF_HOURS} hours of your meeting.
          </Alert>
        )}
      </CardContent>
      <CardActions sx={{ px: { xs: 2, md: 3 }, pb: 2, gap: 1, flexWrap: 'wrap' }}>
        <Button
          variant="outlined"
          onClick={handleRebook}
          disabled={!mySignup.canModify || actionLoading}
        >
          Rebook
        </Button>
        <Button
          variant="outlined"
          color="error"
          onClick={handleCancel}
          disabled={!mySignup.canModify || actionLoading}
        >
          Cancel
        </Button>
      </CardActions>
    </Card>
  );

  const renderSlotPicker = () => (
    <Paper sx={{ p: { xs: 2, md: 3 } }}>
      <Typography variant="h6" sx={{ fontWeight: 600, mb: 2, color: 'primary.dark' }}>
        Available Meeting Slots
      </Typography>
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
        <Stack spacing={{ xs: 1.5, md: 2 }}>
          {availableSlots.map((slot) => (
            <Card key={slot.id} variant="outlined">
              <CardContent sx={{ p: { xs: 2, md: 3 } }}>
                <Box
                  sx={{
                    display: 'flex',
                    flexDirection: { xs: 'column', sm: 'row' },
                    justifyContent: 'space-between',
                    gap: { xs: 2, sm: 0 },
                  }}
                >
                  <Box sx={{ flex: 1 }}>
                    <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
                      {formatDateTime(slot.startTime)}
                    </Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                      {slot.memberProfile?.photo ? (
                        <Avatar src={slot.memberProfile.photo} sx={{ width: 28, height: 28 }} />
                      ) : (
                        <PersonIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                      )}
                      <Typography variant="body2" color="text.secondary">
                        {slot.memberName}
                        {slot.memberProfile?.graduationClass
                          ? ` · Class of ${slot.memberProfile.graduationClass}`
                          : ''}
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <LocationIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                      <Typography variant="body2" color="text.secondary">
                        {slot.location}
                      </Typography>
                    </Box>
                    <MemberProfile profile={slot.memberProfile} compact />
                  </Box>
                  <Box sx={{ textAlign: { xs: 'left', sm: 'right' } }}>
                    <Chip label={`${slot.remaining} spots left`} color="primary" size="small" />
                  </Box>
                </Box>
              </CardContent>
              <CardActions sx={{ justifyContent: 'center', pb: 2 }}>
                <Button
                  variant="contained"
                  startIcon={<CheckCircleIcon />}
                  onClick={() => handleBook(slot.id)}
                  disabled={actionLoading}
                >
                  Sign Up
                </Button>
              </CardActions>
            </Card>
          ))}
        </Stack>
      )}
    </Paper>
  );

  return (
    <AccessControl allowedRoles={['USER']}>
      <Container maxWidth="md" sx={{ py: { xs: 3, md: 4 } }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 1 }}>
          Get to Know UC
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
          Meet with a UConsulting member to learn more about the club and get your questions answered.
        </Typography>

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

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
            <CircularProgress />
          </Box>
        ) : mySignup && !rebooking ? (
          renderBookedCard()
        ) : (
          renderSlotPicker()
        )}
      </Container>
    </AccessControl>
  );
}
