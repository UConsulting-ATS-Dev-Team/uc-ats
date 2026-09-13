import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  Groups as GroupsIcon,
  LocationOn as LocationIcon,
} from '@mui/icons-material';
import apiClient from '../../utils/api';
import { formatDateTime, formatTimeRange } from '../../utils/scheduleFormat';

const slotHeading = (slot) => slot.label || formatTimeRange(slot.startTime, slot.endTime);

/**
 * Sessions a member can sign up to run (issue #63).
 *
 * Unlike the candidate side, members see each other: they are colleagues
 * running the session together, and knowing who else is in the room is the
 * point. Over-staffing is allowed and only flagged - an extra interviewer is a
 * good problem. Overlapping sessions are refused, because nobody can be in two
 * rooms at once.
 */
export default function InterviewStaffingSignup() {
  const [interviews, setInterviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      const data = await apiClient.get('/member/interview-slots');
      setInterviews(data.interviews || []);
    } catch (e) {
      setError(e.message || 'Failed to load interview sessions.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const claim = async (slot) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await apiClient.post(`/member/interview-slots/${slot.id}/claim`, {});
      setNotice(
        result.overStaffed
          ? `You're signed up for ${slotHeading(slot)}. This session now has more interviewers than it needs - check with recruitment.`
          : `You're signed up for ${slotHeading(slot)}.`
      );
      await load();
    } catch (e) {
      setError(e.message || 'Failed to sign up.');
    } finally {
      setBusy(false);
    }
  };

  const drop = async (assignmentId) => {
    if (!window.confirm('Drop this session? Recruitment will need to find cover.')) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiClient.delete(`/member/interview-slot-assignments/${assignmentId}`);
      setNotice('You have been removed from that session.');
      await load();
    } catch (e) {
      setError(e.message || 'Failed to drop that session.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Interview Signup
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Pick the sessions you can run. You cannot take two that overlap.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      )}

      {interviews.length === 0 && (
        <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
          <GroupsIcon color="disabled" sx={{ fontSize: 40, mb: 1 }} />
          <Typography variant="body2" color="text.secondary">
            No interview sessions are set up yet. They will appear here once recruitment schedules them.
          </Typography>
        </Paper>
      )}

      {interviews.map((interview) => (
        <Paper key={interview.id} variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            {interview.title}
          </Typography>
          <Stack spacing={1.5}>
            {interview.slots.map((slot) => {
              const mine = Boolean(slot.yourAssignmentId);
              const needed = slot.interviewerCapacity;
              const staffed = slot.interviewers.length;
              const short = needed != null && staffed < needed;

              return (
                <Card key={slot.id} variant="outlined" sx={{ borderColor: mine ? 'success.main' : undefined }}>
                  <CardContent sx={{ pb: 1 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="subtitle2" fontWeight={600}>
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
                        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                          {slot.candidateCount} candidate{slot.candidateCount === 1 ? '' : 's'} booked
                        </Typography>
                        {slot.interviewers.length > 0 && (
                          <Stack direction="row" spacing={0.5} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
                            {slot.interviewers.map((interviewer) => (
                              <Chip
                                key={interviewer.id}
                                size="small"
                                variant="outlined"
                                label={interviewer.user.fullName}
                              />
                            ))}
                          </Stack>
                        )}
                      </Box>
                      <Stack spacing={0.5} alignItems="flex-end">
                        {mine && <Chip size="small" color="success" icon={<CheckCircleIcon />} label="You're on this" />}
                        {needed != null && (
                          <Chip
                            size="small"
                            color={short ? 'warning' : 'default'}
                            variant={short ? 'filled' : 'outlined'}
                            label={`${staffed} / ${needed} interviewers`}
                          />
                        )}
                      </Stack>
                    </Stack>
                  </CardContent>
                  <CardActions sx={{ px: 2, pb: 2 }}>
                    {mine ? (
                      <Button size="small" color="error" disabled={busy} onClick={() => drop(slot.yourAssignmentId)}>
                        Drop this session
                      </Button>
                    ) : (
                      <Button size="small" variant="contained" disabled={busy} onClick={() => claim(slot)}>
                        Sign up to run this
                      </Button>
                    )}
                  </CardActions>
                </Card>
              );
            })}
          </Stack>
        </Paper>
      ))}
    </Box>
  );
}
