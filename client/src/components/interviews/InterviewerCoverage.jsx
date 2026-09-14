import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Warning as WarningIcon } from '@mui/icons-material';
import apiClient from '../../utils/api';
import { formatTime, formatTimeRange } from '../../utils/scheduleFormat';

/**
 * Who can interview when, and what that means for the day.
 *
 * The grid answers the question that has to come first: how many panels can run
 * at 10:00. Until that is known there is no way to decide whether first round
 * needs one room at a time or four, and building the schedule first means
 * discovering the answer when somebody does not turn up.
 *
 * Placement sits underneath, and offers the people who said they could make
 * that time - so choosing an interviewer is choosing from the people who
 * already said yes, rather than from the whole roster and hoping.
 */

const fullName = (u) => u?.fullName ?? 'Unknown';

/** How a coverage hour reads at a glance: enough, thin, or nobody. */
const toneFor = (row, wanted) => {
  if (row.availableInterviewers === 0) return { color: 'error', label: 'nobody' };
  if (row.possibleSessions === 0) return { color: 'warning', label: 'not enough for a panel' };
  if (wanted && row.possibleSessions < wanted) return { color: 'warning', label: `${row.possibleSessions} panel${row.possibleSessions === 1 ? '' : 's'}` };
  return { color: 'success', label: `${row.possibleSessions} panel${row.possibleSessions === 1 ? '' : 's'}` };
};

export default function InterviewerCoverage({ interviewId, onChanged }) {
  const [data, setData] = useState(null);
  const [minutes, setMinutes] = useState(60);
  const [per, setPer] = useState(2);
  const [wanted, setWanted] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [asked, setAsked] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      setData(await apiClient.get(`/admin/interviews/${interviewId}/availability?minutes=${minutes}&per=${per}`));
    } catch (e) {
      setError(e.message || 'Failed to load availability.');
    } finally {
      setLoading(false);
    }
  }, [interviewId, minutes, per]);

  useEffect(() => {
    load();
  }, [load]);

  // Defaults to chasing only the people who have not answered, so pressing it
  // twice does not nag everybody who already did their bit.
  const askForAvailability = async (everyone) => {
    setBusy(true);
    setError('');
    setAsked('');
    try {
      const result = await apiClient.post(`/admin/interviews/${interviewId}/request-availability`, { everyone });
      setAsked(
        result.queued === 0
          ? result.message || 'Nobody to email.'
          : `Asked ${result.queued} ${result.queued === 1 ? 'person' : 'people'}.` +
            (result.emailsEnabled === false ? ' Scheduling emails are switched off, so these are being held.' : '')
      );
      await load();
    } catch (e) {
      setError(e.message || 'Failed to send that request.');
    } finally {
      setBusy(false);
    }
  };

  const place = async (slotId, userId) => {
    setBusy(true);
    setError('');
    try {
      await apiClient.post(`/admin/interviews/slots/${slotId}/interviewers`, { userId });
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Failed to place that interviewer.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (assignmentId) => {
    setBusy(true);
    try {
      await apiClient.delete(`/admin/interviews/slot-assignments/${assignmentId}`);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Failed to remove that interviewer.');
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
  if (!data) return null;

  const nobodyYet = data.interviewers.length === 0;
  // A coffee chat runs as named sittings that everybody rotates through, so
  // "how many panels could run at 10:00" is not a question about it. Sizing the
  // day that way belongs to first round, where sessions are small and parallel.
  const sizesTheDay = data.interview.interviewType !== 'COFFEE_CHAT';
  const conflicts = (data.placements ?? []).filter((p) => p.conflict === 'OUTSIDE_AVAILABILITY');

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
        <Button variant="contained" size="small" disabled={busy} onClick={() => askForAvailability(false)}>
          Ask members for availability
        </Button>
        {data.interviewers.length > 0 && (
          <Button size="small" disabled={busy} onClick={() => askForAvailability(true)}>
            Ask everyone again
          </Button>
        )}
        {asked && (
          <Typography variant="caption" color="text.secondary">
            {asked}
          </Typography>
        )}
      </Stack>

      {nobodyYet && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <strong>Nobody has said when they are free yet.</strong> Send the request above; members fill it
          in from My Interviews. Until they do there is nothing to size the day against.
        </Alert>
      )}

      {sizesTheDay && (
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="subtitle2">If sessions were</Typography>
        <TextField
          size="small"
          select
          label="this long"
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
          sx={{ width: 140 }}
        >
          {[20, 30, 45, 60, 90].map((m) => (
            <MenuItem key={m} value={m}>
              {m} minutes
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          select
          label="with this many interviewers"
          value={per}
          onChange={(e) => setPer(Number(e.target.value))}
          sx={{ width: 210 }}
        >
          {[1, 2, 3, 4].map((n) => (
            <MenuItem key={n} value={n}>
              {n} each
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          type="number"
          label="panels you want"
          value={wanted}
          onChange={(e) => setWanted(e.target.value)}
          sx={{ width: 150 }}
          helperText="optional"
        />
      </Stack>
      )}

      {/* The answer recruitment is actually after - for first round. */}
      {sizesTheDay && (
      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Typography variant="overline" color="text.secondary">
          How many panels each hour could support
        </Typography>
        {data.coverage.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            This interview has no time range to lay out yet.
          </Typography>
        ) : (
          <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', gap: 1 }}>
            {data.coverage.map((row) => {
              const tone = toneFor(row, Number(wanted) || null);
              return (
                <Tooltip
                  key={row.startTime}
                  title={`${row.availableInterviewers} interviewer${row.availableInterviewers === 1 ? '' : 's'} free`}
                >
                  <Paper
                    variant="outlined"
                    sx={{
                      px: 1.25,
                      py: 0.75,
                      minWidth: 96,
                      borderColor: `${tone.color}.main`,
                      borderWidth: tone.color === 'success' ? 1 : 2,
                    }}
                  >
                    <Typography variant="caption" fontWeight={700} display="block">
                      {formatTime(row.startTime)} – {formatTime(row.endTime)}
                    </Typography>
                    <Typography variant="caption" color={`${tone.color}.main`}>
                      {tone.label}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block">
                      {row.availableInterviewers} free
                    </Typography>
                  </Paper>
                </Tooltip>
              );
            })}
          </Stack>
        )}
      </Paper>
      )}

      {conflicts.length > 0 && (
        <Alert severity="warning" icon={<WarningIcon />} sx={{ mb: 3 }}>
          {conflicts.length} interviewer{conflicts.length === 1 ? ' is' : 's are'} placed outside the times
          they gave: {conflicts.map((c) => fullName(c.user)).join(', ')}. That is allowed — just check they
          know.
        </Alert>
      )}

      {/* Placement, offering the people who said they could make it. */}
      {data.sessions.length > 0 && (
        <>
          <Typography variant="overline" color="text.secondary">
            Place interviewers
          </Typography>
          <Stack spacing={1.5} sx={{ mt: 1, mb: 3 }}>
            {data.sessions.map((session) => {
              const able = data.interviewers.filter((i) => session.canCover.includes(i.user.id));
              const assignedIds = session.assigned.map((u) => u.id);
              const free = able.filter((i) => !assignedIds.includes(i.user.id));
              const short =
                session.interviewerCapacity != null && session.assigned.length < session.interviewerCapacity;

              return (
                <Paper key={session.id} variant="outlined" sx={{ p: 1.75 }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                    <Typography variant="body2" fontWeight={700}>
                      {session.label || formatTimeRange(session.startTime, session.endTime)}
                    </Typography>
                    <Chip
                      size="small"
                      color={short ? 'warning' : 'default'}
                      variant={short ? 'filled' : 'outlined'}
                      label={`${session.assigned.length}${session.interviewerCapacity != null ? ` / ${session.interviewerCapacity}` : ''} interviewers`}
                    />
                  </Stack>

                  <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
                    {session.assigned.map((user) => {
                      const placement = data.placements.find(
                        (p) => p.slotId === session.id && p.user.id === user.id
                      );
                      return (
                        <Chip
                          key={user.id}
                          size="small"
                          color={placement?.conflict === 'OUTSIDE_AVAILABILITY' ? 'warning' : 'default'}
                          variant={placement?.conflict ? 'filled' : 'outlined'}
                          label={fullName(user)}
                          onDelete={() => remove(placement?.assignmentId)}
                        />
                      );
                    })}
                    {session.assigned.length === 0 && (
                      <Typography variant="caption" color="text.secondary">
                        Nobody yet
                      </Typography>
                    )}
                  </Stack>

                  <Divider sx={{ my: 1 }} />
                  <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                    {free.length > 0
                      ? 'Said they can make this time:'
                      : 'Nobody who is free for this time is left to place.'}
                  </Typography>
                  <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                    {free.map((i) => (
                      <Chip
                        key={i.user.id}
                        size="small"
                        variant="outlined"
                        label={fullName(i.user)}
                        onClick={() => place(session.id, i.user.id)}
                        disabled={busy}
                      />
                    ))}
                  </Stack>
                </Paper>
              );
            })}
          </Stack>
        </>
      )}

      {/* What everybody actually said, because a grid hides the exceptions. */}
      {data.interviewers.length > 0 && (
        <>
          <Typography variant="overline" color="text.secondary">
            What people said ({data.interviewers.length})
          </Typography>
          <Stack spacing={0.75} sx={{ mt: 1 }}>
            {data.interviewers.map(({ user, windows }) => (
              <Stack
                key={user.id}
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ flexWrap: 'wrap', gap: 0.5 }}
              >
                <Typography variant="body2" sx={{ minWidth: 180 }}>
                  {fullName(user)}
                </Typography>
                {windows.map((w) => (
                  <Chip
                    key={w.id}
                    size="small"
                    variant="outlined"
                    label={formatTimeRange(w.startTime, w.endTime)}
                  />
                ))}
                {windows.filter((w) => w.note).map((w) => (
                  <Typography key={`${w.id}-note`} variant="caption" color="text.secondary">
                    — {w.note}
                  </Typography>
                ))}
              </Stack>
            ))}
          </Stack>
        </>
      )}
    </Box>
  );
}
