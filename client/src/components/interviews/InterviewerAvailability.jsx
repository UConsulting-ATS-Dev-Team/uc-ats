import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import apiClient from '../../utils/api';
import { formatDay, formatTimeRange } from '../../utils/scheduleFormat';

/**
 * When a member can interview.
 *
 * Asked before the day is designed, because recruitment cannot know whether
 * first round needs two panels at 10:00 or four until it knows how many people
 * can be there at 10:00.
 *
 * Two ways of asking, one answer underneath. A coffee chat has named sittings
 * that everybody recognises, so it offers those as checkboxes. A first round
 * usually has no sessions yet - that is the point - so it offers every hour
 * inside the day recruitment described, to be ticked.
 *
 * Both save the same thing: windows of time. An hour ticked is an hour-long
 * window; contiguous ticks merge server-side, so ticking 9, 10 and 11 says
 * "I can do 9 to 12" without anyone having to phrase it that way.
 */

/** Every whole hour inside the interview's own window. */
function hoursWithin(startDate, endDate) {
  const from = new Date(startDate);
  const to = new Date(endDate);
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return [];
  const out = [];
  const cursor = new Date(from);
  // Truncate in UTC, not local. Pacific sits a whole number of hours from UTC,
  // so a UTC hour boundary is a Pacific hour boundary - and the grid then lines
  // up with the admin coverage grid no matter what clock the member is on.
  cursor.setUTCMinutes(0, 0, 0);
  while (cursor < to && out.length < 24) {
    const next = new Date(cursor.getTime() + 3600000);
    if (next > to) break;
    out.push({
      key: cursor.toISOString(),
      startTime: new Date(cursor),
      endTime: next,
      label: formatTimeRange(cursor, next),
    });
    cursor.setTime(next.getTime());
  }
  return out;
}

export default function InterviewerAvailability({ interviewId, onSaved }) {
  const [data, setData] = useState(null);
  const [checkedSessions, setCheckedSessions] = useState([]);
  const [checkedHours, setCheckedHours] = useState([]);
  const [hours, setHours] = useState([]);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      const result = await apiClient.get(`/member/interviews/${interviewId}/availability`);
      setData(result);

      const grid = hoursWithin(result.interview.startDate, result.interview.endDate);
      setHours(grid);
      // An hour counts as marked when a saved window covers it. Windows that
      // were merged on the way in still light up each hour they span.
      setCheckedHours(
        grid
          .filter((hour) =>
            (result.windows ?? []).some(
              (w) =>
                new Date(w.startTime) <= hour.startTime && new Date(w.endTime) >= hour.endTime
            )
          )
          .map((hour) => hour.key)
      );
      setNote((result.windows ?? []).find((w) => w.note)?.note ?? '');
      // A window that exactly matches a session is that session ticked.
      setCheckedSessions(
        (result.interview.slots ?? [])
          .filter((slot) =>
            (result.windows ?? []).some(
              (w) =>
                new Date(w.startTime).getTime() <= new Date(slot.startTime).getTime() &&
                new Date(w.endTime).getTime() >= new Date(slot.endTime).getTime()
            )
          )
          .map((slot) => slot.id)
      );

    } catch (e) {
      setError(e.message || 'Failed to load your availability.');
    } finally {
      setLoading(false);
    }
  }, [interviewId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
        <CircularProgress size={26} />
      </Box>
    );
  }
  if (!data) return null;

  const sessions = data.interview.slots ?? [];
  const bySession = sessions.length > 0;

  const save = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const windows = bySession
        ? sessions
            .filter((slot) => checkedSessions.includes(slot.id))
            .map((slot) => ({ startTime: slot.startTime, endTime: slot.endTime }))
        : hours
            .filter((hour) => checkedHours.includes(hour.key))
            .map((hour) => ({
              startTime: hour.startTime.toISOString(),
              endTime: hour.endTime.toISOString(),
              note: note || null,
            }));

      await apiClient.put(`/member/interviews/${interviewId}/availability`, { windows });
      setNotice(
        windows.length === 0
          ? "Saved — you've said you can't make any of it."
          : 'Saved. Recruitment will place you into sessions from this.'
      );
      onSaved?.();
      await load();
    } catch (e) {
      setError(e.message || 'Failed to save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Typography variant="subtitle1" fontWeight={700}>
        {data.interview.title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {formatDay(data.interview.startDate)} ·{' '}
        {bySession
          ? 'Tick the sessions you can run.'
          : `Open ${formatTimeRange(data.interview.startDate, data.interview.endDate)}. Tick the hours you can be there.`}
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

      {data.assignments?.length > 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          You are already placed in {data.assignments.length} session
          {data.assignments.length === 1 ? '' : 's'}. Changing your availability here does not move you —
          tell recruitment if you can no longer make it.
        </Alert>
      )}

      {bySession ? (
        <Stack spacing={0.5}>
          {sessions.map((slot) => (
            <FormControlLabel
              key={slot.id}
              control={
                <Checkbox
                  checked={checkedSessions.includes(slot.id)}
                  onChange={(e) =>
                    setCheckedSessions((current) =>
                      e.target.checked ? [...current, slot.id] : current.filter((id) => id !== slot.id)
                    )
                  }
                />
              }
              label={
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="body2" fontWeight={600}>
                    {slot.label || formatTimeRange(slot.startTime, slot.endTime)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {formatTimeRange(slot.startTime, slot.endTime)}
                  </Typography>
                  {slot.interviewerCapacity ? (
                    <Chip size="small" variant="outlined" label={`wants ${slot.interviewerCapacity}`} />
                  ) : null}
                </Stack>
              }
            />
          ))}
        </Stack>
      ) : (
        <Stack spacing={1.5}>
          <Typography variant="body2" color="text.secondary">
            Recruitment decides how many interviews run at once from how many of us can be there.
          </Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
            {hours.map((hour) => {
              const on = checkedHours.includes(hour.key);
              return (
                <Chip
                  key={hour.key}
                  label={hour.label}
                  color={on ? 'primary' : 'default'}
                  variant={on ? 'filled' : 'outlined'}
                  onClick={() =>
                    setCheckedHours((current) =>
                      on ? current.filter((k) => k !== hour.key) : [...current, hour.key]
                    )
                  }
                  sx={{ fontWeight: on ? 600 : 400 }}
                />
              );
            })}
          </Stack>
          {hours.length === 0 && (
            <Alert severity="info">
              This interview has no time range yet, so there are no hours to mark.
            </Alert>
          )}
          <Stack direction="row" spacing={1}>
            <Button size="small" onClick={() => setCheckedHours(hours.map((h) => h.key))}>
              All day
            </Button>
            <Button size="small" onClick={() => setCheckedHours([])}>
              None
            </Button>
          </Stack>
          <TextField
            size="small"
            label="Anything we should know"
            placeholder="Leaving at 3 for class"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            fullWidth
          />
        </Stack>
      )}

      <Box sx={{ mt: 2 }}>
        <Button variant="contained" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save my availability'}
        </Button>
      </Box>
    </Paper>
  );
}
