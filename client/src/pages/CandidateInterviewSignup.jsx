import React, { useCallback, useEffect, useMemo, useState } from 'react';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  CircularProgress,
  Container,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  EventBusy as EventBusyIcon,
  HourglassTop as HourglassIcon,
  LocationOn as LocationIcon,
  LockClock as LockClockIcon,
  Schedule as ScheduleIcon,
} from '@mui/icons-material';
import { formatDateTime, formatTimeRange } from '../utils/scheduleFormat';

const DEFAULT_MODIFY_CUTOFF_HOURS = 12;

/// A slot's heading: its own name if it has one ("Morning Block"), otherwise the
/// time range. Coffee chats are named blocks; first round slots are just times.
const slotHeading = (slot) => slot.label || formatTimeRange(slot.startTime, slot.endTime);

const STATUS_CHIP = {
  CONFIRMED: { label: 'Confirmed', color: 'success', icon: <CheckCircleIcon /> },
  WAITLISTED: { label: 'Waitlisted', color: 'warning', icon: <HourglassIcon /> },
  NEEDS_PLACEMENT: { label: 'Awaiting placement', color: 'error', icon: <EventBusyIcon /> },
};

export default function CandidateInterviewSignup() {
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [signups, setSignups] = useState([]);
  const [interviews, setInterviews] = useState([]);
  const [cutoffHours, setCutoffHours] = useState(DEFAULT_MODIFY_CUTOFF_HOURS);

  const load = useCallback(async () => {
    try {
      setError('');
      const [mine, options] = await Promise.all([
        apiClient.get('/my-interview-signups'),
        apiClient.get('/my-interview-signups/options'),
      ]);
      setSignups(mine.signups || []);
      setInterviews(options.interviews || []);
      setCutoffHours(mine.modifyCutoffHours ?? DEFAULT_MODIFY_CUTOFF_HOURS);
    } catch (e) {
      setError(e.message || 'We could not load your interview times.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const signupByInterview = useMemo(
    () => new Map(signups.map((signup) => [signup.interview.id, signup])),
    [signups]
  );

  // A full slot is still rendered, not hidden. Seeing that the morning block is
  // full is what makes the waitlist offer make sense - a candidate who is simply
  // shown fewer options has no idea why.
  const handleBook = async (slotId) => {
    setActionLoading(true);
    setError('');
    setNotice('');
    try {
      const result = await apiClient.post('/my-interview-signups', { slotId });
      setNotice(result.message || 'Your time is confirmed. Check your email for the details.');
      await load();
    } catch (e) {
      setError(e.message || 'We could not book that time.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSwitch = async (signupId, slotId) => {
    setActionLoading(true);
    setError('');
    setNotice('');
    try {
      await apiClient.patch(`/my-interview-signups/${signupId}`, { slotId });
      setNotice('Your time has been updated.');
      await load();
    } catch (e) {
      setError(e.message || 'We could not change your time.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async (signupId) => {
    if (!window.confirm('Cancel this booking? You will need to pick a new time, and spots may be limited.')) {
      return;
    }
    setActionLoading(true);
    setError('');
    setNotice('');
    try {
      await apiClient.delete(`/my-interview-signups/${signupId}`);
      setNotice('Your booking has been cancelled.');
      await load();
    } catch (e) {
      setError(e.message || 'We could not cancel that booking.');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <AccessControl allowedRoles={['USER']}>
      <Container maxWidth="md" sx={{ py: 4 }}>
        <Typography variant="h4" gutterBottom>
          Interview Scheduling
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
          Pick the time that works for you. You can change it up to {cutoffHours} hours beforehand.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}
        {notice && (
          <Alert severity="success" sx={{ mb: 3 }} onClose={() => setNotice('')}>
            {notice}
          </Alert>
        )}

        {interviews.length === 0 && (
          <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
            <ScheduleIcon color="disabled" sx={{ fontSize: 48, mb: 1 }} />
            <Typography variant="h6" gutterBottom>
              Nothing to schedule yet
            </Typography>
            <Typography variant="body2" color="text.secondary">
              When you advance to a round with interview times, they will appear here and we will email you.
            </Typography>
          </Paper>
        )}

        {interviews.map((interview) => {
          const mine = signupByInterview.get(interview.id);
          const status = mine ? STATUS_CHIP[mine.status] : null;
          const locked = mine && !mine.canModify;

          return (
            <Paper key={interview.id} variant="outlined" sx={{ p: 3, mb: 4 }}>
              <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
                <Typography variant="h6">{interview.title}</Typography>
                {status && <Chip size="small" color={status.color} icon={status.icon} label={status.label} />}
              </Stack>

              {mine?.status === 'CONFIRMED' && (
                <Alert severity="success" icon={<CheckCircleIcon />} sx={{ mb: 2 }}>
                  You are booked for <strong>{slotHeading(mine.slot)}</strong> on{' '}
                  {formatDateTime(mine.slot.startTime)}
                  {mine.slot.location ? ` at ${mine.slot.location}` : ''}.
                </Alert>
              )}
              {mine?.status === 'WAITLISTED' && (
                <Alert severity="warning" icon={<HourglassIcon />} sx={{ mb: 2 }}>
                  You have a confirmed spot, and you are on the waitlist for{' '}
                  <strong>{slotHeading(mine.slot)}</strong>. If a spot opens up we will move you
                  automatically and email you - there is nothing else you need to do.
                </Alert>
              )}
              {mine?.status === 'NEEDS_PLACEMENT' && (
                <Alert severity="error" icon={<EventBusyIcon />} sx={{ mb: 2 }}>
                  Every session was full when you signed up, so we could not give you a spot
                  automatically. Recruitment has been notified and will be in touch shortly.
                </Alert>
              )}
              {locked && (
                <Alert severity="info" icon={<LockClockIcon />} sx={{ mb: 2 }}>
                  Changes are locked within {cutoffHours} hours of your session. Email recruitment if
                  something has come up.
                </Alert>
              )}

              <Divider sx={{ my: 2 }} />

              <Stack spacing={2}>
                {interview.slots.map((slot) => {
                  const isMine = mine?.slot?.id === slot.id;
                  const disabled = actionLoading || locked || !slot.isOpen;

                  return (
                    <Card key={slot.id} variant="outlined" sx={{ borderColor: isMine ? 'success.main' : undefined }}>
                      <CardContent sx={{ pb: 1 }}>
                        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
                          <Box>
                            <Typography variant="subtitle1" fontWeight={600}>
                              {slotHeading(slot)}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              {formatDateTime(slot.startTime)}
                            </Typography>
                            {slot.location && (
                              <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mt: 0.5 }}>
                                <LocationIcon fontSize="small" color="disabled" />
                                <Typography variant="body2" color="text.secondary">
                                  {slot.location}
                                </Typography>
                              </Stack>
                            )}
                          </Box>
                          <Chip
                            size="small"
                            color={slot.isFull ? 'default' : 'primary'}
                            variant={slot.isFull ? 'outlined' : 'filled'}
                            label={slot.isFull ? 'Full' : `${slot.seatsRemaining} left`}
                          />
                        </Stack>
                      </CardContent>
                      <CardActions sx={{ px: 2, pb: 2 }}>
                        {isMine ? (
                          <Button
                            size="small"
                            color="error"
                            disabled={disabled}
                            onClick={() => handleCancel(mine.id)}
                          >
                            Cancel this booking
                          </Button>
                        ) : mine ? (
                          <Button
                            size="small"
                            variant="outlined"
                            disabled={disabled}
                            onClick={() => handleSwitch(mine.id, slot.id)}
                          >
                            {slot.isFull ? 'Join waitlist for this time' : 'Switch to this time'}
                          </Button>
                        ) : (
                          <Button
                            size="small"
                            variant="contained"
                            disabled={disabled}
                            onClick={() => handleBook(slot.id)}
                          >
                            {slot.isFull ? 'Join waitlist' : 'Book this time'}
                          </Button>
                        )}
                      </CardActions>
                    </Card>
                  );
                })}
              </Stack>
            </Paper>
          );
        })}
      </Container>
    </AccessControl>
  );
}
