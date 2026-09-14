import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { Add as AddIcon, Close as CloseIcon } from '@mui/icons-material';
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
 * usually has no sessions yet - that is the point - so it asks for times.
 */

const pad = (n) => String(n).padStart(2, '0');
const toTimeInput = (value) => {
  const d = new Date(value);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const toDayInput = (value) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export default function InterviewerAvailability({ interviewId, onSaved }) {
  const [data, setData] = useState(null);
  const [rows, setRows] = useState([]);
  const [checkedSessions, setCheckedSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      const result = await apiClient.get(`/member/interviews/${interviewId}/availability`);
      setData(result);

      const day = toDayInput(result.interview.startDate);
      setRows(
        (result.windows ?? []).map((w) => ({
          day: toDayInput(w.startTime),
          start: toTimeInput(w.startTime),
          end: toTimeInput(w.endTime),
          note: w.note ?? '',
        }))
      );
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
      if (!result.windows?.length) setRows([{ day, start: '09:00', end: '17:00', note: '' }]);
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
        : rows
            .filter((r) => r.day && r.start && r.end)
            .map((r) => ({
              startTime: new Date(`${r.day}T${r.start}`).toISOString(),
              endTime: new Date(`${r.day}T${r.end}`).toISOString(),
              note: r.note,
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
          : 'Tell us when you are free and recruitment will build the schedule around it.'}
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
          {rows.map((row, index) => (
            <Stack key={index} direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
              <TextField
                size="small"
                type="date"
                label="Day"
                value={row.day}
                onChange={(e) =>
                  setRows((c) => c.map((r, i) => (i === index ? { ...r, day: e.target.value } : r)))
                }
                InputLabelProps={{ shrink: true }}
                sx={{ width: 160 }}
              />
              <TextField
                size="small"
                type="time"
                label="From"
                value={row.start}
                onChange={(e) =>
                  setRows((c) => c.map((r, i) => (i === index ? { ...r, start: e.target.value } : r)))
                }
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                size="small"
                type="time"
                label="Until"
                value={row.end}
                onChange={(e) => setRows((c) => c.map((r, i) => (i === index ? { ...r, end: e.target.value } : r)))}
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                size="small"
                label="Anything we should know"
                placeholder="Leaving at 3 for class"
                value={row.note}
                onChange={(e) => setRows((c) => c.map((r, i) => (i === index ? { ...r, note: e.target.value } : r)))}
                sx={{ flex: 1, minWidth: 200 }}
              />
              <IconButton
                size="small"
                aria-label={`Remove window ${index + 1}`}
                onClick={() => setRows((c) => c.filter((_, i) => i !== index))}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>
          ))}
          <Box>
            <Button
              size="small"
              startIcon={<AddIcon />}
              onClick={() =>
                setRows((c) => [
                  ...c,
                  { day: toDayInput(data.interview.startDate), start: '13:00', end: '17:00', note: '' },
                ])
              }
            >
              Add another time
            </Button>
          </Box>
          <Typography variant="caption" color="text.secondary">
            Split it up if there is a gap — two windows say more than one long one that is not quite true.
          </Typography>
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
