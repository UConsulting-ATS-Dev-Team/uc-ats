import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  EventBusy as EventBusyIcon,
  HourglassTop as HourglassIcon,
  Visibility as VisibilityIcon,
} from '@mui/icons-material';
import apiClient from '../../utils/api';
import { formatDateTime, formatTimeRange } from '../../utils/scheduleFormat';

const slotHeading = (slot) => slot.label || formatTimeRange(slot.startTime, slot.endTime);
const fullName = (c) => `${c?.firstName ?? ''} ${c?.lastName ?? ''}`.trim();

/**
 * The candidate's page, as an admin.
 *
 * Served by the same functions the candidate's own request calls, so this is
 * what they see rather than a reconstruction of it. Read-only: this answers
 * "what are they looking at"; changing it for them is done on the roster, where
 * it is attributed.
 */
export default function CandidateSchedulingPreview() {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (applicationId) => {
    setLoading(true);
    try {
      setError('');
      const query = applicationId ? `?applicationId=${applicationId}` : '';
      const result = await apiClient.get(`/admin/scheduling/preview${query}`);
      setData(result);
      if (result.application) setSelected(result.application);
    } catch (e) {
      setError(e.message || 'Failed to build the preview.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !data) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  const view = data?.view;
  const mine = view?.signups?.[0] ?? null;

  return (
    <Box>
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
        <VisibilityIcon color="disabled" />
        <Autocomplete
          size="small"
          sx={{ minWidth: 340 }}
          options={data?.candidates ?? []}
          value={selected}
          onChange={(e, next) => {
            setSelected(next);
            load(next?.id);
          }}
          getOptionLabel={(option) => `${fullName(option)} — round ${option.currentRound}`}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          renderInput={(params) => <TextField {...params} label="Preview as candidate" />}
        />
        {loading && <CircularProgress size={18} />}
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {(data?.candidates?.length ?? 0) === 0 && (
        <Alert severity="info">
          Nobody is in a scheduling round right now, so there is no candidate view to preview. Candidates
          appear here once Staging moves them into the coffee chat or first round.
        </Alert>
      )}

      {view && (
        <Paper variant="outlined" sx={{ p: 3, bgcolor: 'action.hover' }}>
          <Typography variant="overline" color="text.secondary">
            What {fullName(selected) || 'this candidate'} sees at /interview-signup
          </Typography>

          <Typography variant="h6" sx={{ mt: 1 }}>
            Interview Scheduling
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Pick the time that works for you. You can change it up to {view.modifyCutoffHours} hours
            beforehand.
          </Typography>

          {/* The reason the page is empty, which the candidate never sees but an
              admin has to - otherwise a blank preview is indistinguishable from
              a broken one. */}
          {data.emptyExplanation && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              <strong>They see an empty page.</strong> {data.emptyExplanation}
            </Alert>
          )}

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
              <strong>{slotHeading(mine.slot)}</strong>.
            </Alert>
          )}
          {mine?.status === 'NEEDS_PLACEMENT' && (
            <Alert severity="error" icon={<EventBusyIcon />} sx={{ mb: 2 }}>
              Every session was full when you signed up. Recruitment has been notified.
            </Alert>
          )}

          {(view.interviews ?? []).map((interview) => (
            <Box key={interview.id} sx={{ mb: 3 }}>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                {interview.title}
              </Typography>
              <Stack spacing={1}>
                {interview.slots.map((slot) => (
                  <Card key={slot.id} variant="outlined">
                    <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
                        <Box>
                          <Typography variant="body2" fontWeight={600}>
                            {slotHeading(slot)}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {formatDateTime(slot.startTime)}
                            {slot.location ? ` · ${slot.location}` : ''}
                          </Typography>
                        </Box>
                        <Stack direction="row" spacing={1} alignItems="center">
                          {!slot.isOpen && <Chip size="small" color="default" label="Signup closed" />}
                          <Chip
                            size="small"
                            color={slot.isFull ? 'default' : 'primary'}
                            variant={slot.isFull ? 'outlined' : 'filled'}
                            label={slot.isFull ? 'Full' : `${slot.seatsRemaining} left`}
                          />
                        </Stack>
                      </Stack>
                    </CardContent>
                  </Card>
                ))}
              </Stack>
            </Box>
          ))}

          <Divider sx={{ my: 2 }} />
          <Typography variant="caption" color="text.secondary">
            Read-only. To change this candidate's time, move them on the Sessions tab — that records who
            did it and emails them.
          </Typography>
        </Paper>
      )}
    </Box>
  );
}
