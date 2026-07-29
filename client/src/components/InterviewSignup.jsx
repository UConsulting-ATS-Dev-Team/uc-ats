import React, { useEffect, useState, useCallback } from 'react';
import {
  Box,
  Typography,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Alert,
  Stack,
  Grid,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Tooltip,
} from '@mui/material';
import { Schedule as ScheduleIcon, Cancel as CancelIcon, Event as EventIcon } from '@mui/icons-material';
import apiClient from '../utils/api';

function formatInLA(date, options = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) {
  if (!date) return 'TBD';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    ...options,
  }).format(new Date(date));
}

function formatTimeOnly(date) {
  return formatInLA(date, { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatInterviewType(type) {
  return String(type || 'Interview')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function InterviewSignup() {
  const [data, setData] = useState({ activeCycle: null, groups: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(null);

  const fetchSlots = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await apiClient.get('/member/interviews/slots');
      setData(result || { activeCycle: null, groups: [] });
    } catch (err) {
      setError(err.message || 'Failed to load interview signups');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSlots();
  }, [fetchSlots]);

  const handleSignup = async (slotId) => {
    try {
      setActionLoading(slotId);
      setActionError(null);
      await apiClient.post(`/member/interviews/slots/${slotId}/signup`);
      await fetchSlots();
    } catch (err) {
      setActionError(err.message || 'Failed to sign up');
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancel = async (signupId) => {
    try {
      setActionLoading(signupId);
      setActionError(null);
      await apiClient.delete(`/member/interviews/signups/${signupId}`);
      setConfirmCancel(null);
      await fetchSlots();
    } catch (err) {
      setActionError(err.message || 'Failed to cancel signup');
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert severity="error" sx={{ mb: 2 }}>
        {error}
      </Alert>
    );
  }

  const totalSlots = data.groups.reduce((sum, g) => sum + g.slots.length, 0);

  if (totalSlots === 0) {
    return (
      <Card sx={{ mb: 4 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <EventIcon /> Interview Signup
          </Typography>
          <Typography variant="body2" color="text.secondary">
            No interview slots are available in the active cycle right now. Check back later.
          </Typography>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card sx={{ mb: 4 }}>
      <CardContent>
        <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <EventIcon /> Interview Signup
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Active cycle: {data.activeCycle?.name || 'Unknown'}
        </Typography>

        {actionError && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
            {actionError}
          </Alert>
        )}

        <Stack spacing={2}>
          {data.groups.map((group) => (
            <Card key={group.interview.id} variant="outlined">
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                  {formatInterviewType(group.interview.interviewType)} - {group.interview.title}
                </Typography>
                <Grid container spacing={2}>
                  {group.slots.map((slot) => (
                    <Grid size={{ xs: 12, sm: 6, md: 4 }} key={slot.id}>
                      <Card variant="outlined" sx={{ height: '100%' }}>
                        <CardContent>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                            <ScheduleIcon fontSize="small" color="action" />
                            <Typography variant="body2">
                              {formatInLA(slot.startTime)} - {formatTimeOnly(slot.endTime)}
                            </Typography>
                          </Box>
                          <Chip
                            label={slot.isFull ? 'Full' : `${slot.remainingSeats} seat${slot.remainingSeats === 1 ? '' : 's'} left`}
                            color={slot.isFull ? 'error' : slot.remainingSeats <= 2 ? 'warning' : 'success'}
                            size="small"
                            sx={{ mb: 1 }}
                          />
                          {slot.userSignup ? (
                            <Box>
                              <Chip label="You're signed up" color="primary" size="small" sx={{ mr: 1 }} />
                              {slot.userSignup.confirmationStatus === 'FAILED' && (
                                <Typography variant="caption" color="error" display="block">
                                  Confirmation email failed
                                </Typography>
                              )}
                              <Box sx={{ mt: 1 }}>
                                <Button
                                  size="small"
                                  variant="outlined"
                                  color="error"
                                  startIcon={<CancelIcon />}
                                  onClick={() => setConfirmCancel(slot.userSignup.id)}
                                  disabled={actionLoading === slot.userSignup.id}
                                >
                                  Cancel
                                </Button>
                              </Box>
                            </Box>
                          ) : (
                            <Button
                              size="small"
                              variant="contained"
                              onClick={() => handleSignup(slot.id)}
                              disabled={slot.isFull || actionLoading === slot.id}
                              fullWidth
                            >
                              {slot.isFull ? 'Full' : actionLoading === slot.id ? 'Signing up...' : 'Sign Up'}
                            </Button>
                          )}
                        </CardContent>
                      </Card>
                    </Grid>
                  ))}
                </Grid>
                {group.slots.length === 0 && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    No slots configured for this interview yet.
                  </Typography>
                )}
              </CardContent>
            </Card>
          ))}
        </Stack>

        <Dialog open={Boolean(confirmCancel)} onClose={() => setConfirmCancel(null)}>
          <DialogTitle>Cancel signup?</DialogTitle>
          <DialogContent>
            <Typography variant="body2">Are you sure you want to cancel this interview slot?</Typography>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmCancel(null)}>Keep signup</Button>
            <Button
              color="error"
              onClick={() => handleCancel(confirmCancel)}
              disabled={actionLoading === confirmCancel}
            >
              Cancel signup
            </Button>
          </DialogActions>
        </Dialog>
      </CardContent>
    </Card>
  );
}
