import React, { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { Add as AddIcon, Close as CloseIcon } from '@mui/icons-material';
import apiClient from '../../utils/api';

/**
 * Create an interview and the sessions it runs, together.
 *
 * Recruitment describes a day in two ways and both are right for their round:
 * coffee chats are two named sittings, first round is a schedule - doors at 8,
 * groups of four every hour until 5, break for lunch. The form offers whichever
 * shape matches the round and lets it be changed, rather than asking everyone
 * to describe a schedule as a list of blocks.
 *
 * The preview is the point. Creating nine sessions is a thing worth seeing
 * before it happens, not after.
 */

const TYPE_LABEL = {
  COFFEE_CHAT: 'Coffee Chat',
  ROUND_ONE: 'First Round',
  FINAL_ROUND: 'Final Round',
  DELIBERATIONS: 'Deliberations',
};

const defaultBlocks = () => [
  { label: 'Morning Session', start: '09:00', end: '11:00', capacity: 20, interviewers: 4 },
  { label: 'Afternoon Session', start: '14:00', end: '16:00', capacity: 20, interviewers: 4 },
];

const defaultCadence = (type) => ({
  start: '08:00',
  end: '17:00',
  minutes: 60,
  capacity: type === 'ROUND_ONE' ? 4 : 1,
  interviewers: 2,
  breaks: [{ start: '12:00', end: '13:00' }],
});

/** Mirrors services/slotPlanner.js so the preview matches what will be made. */
function previewCadence(cadence) {
  const toMin = (t) => {
    const [h, m] = String(t).split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  };
  const start = toMin(cadence.start);
  const end = toMin(cadence.end);
  const length = Number(cadence.minutes);
  if (start == null || end == null || !length || end <= start) return [];

  const breaks = (cadence.breaks ?? [])
    .map((b) => ({ start: toMin(b.start), end: toMin(b.end) }))
    .filter((b) => b.start != null && b.end != null && b.end > b.start);

  const rows = [];
  let cursor = start;
  while (cursor < end && rows.length < 60) {
    const next = cursor + length;
    if (next > end) break;
    const clash = breaks.find((b) => cursor < b.end && next > b.start);
    if (clash) {
      cursor = clash.end;
      continue;
    }
    rows.push({ start: cursor, end: next });
    cursor = next;
  }
  return rows;
}

const asTime = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
};

export default function InterviewCreateDialog({ open, onClose, onCreated }) {
  const [interviewType, setInterviewType] = useState('COFFEE_CHAT');
  const [title, setTitle] = useState('');
  const [day, setDay] = useState('');
  const [location, setLocation] = useState('');
  const [dresscode, setDresscode] = useState('');
  const [mode, setMode] = useState('blocks');
  const [blocks, setBlocks] = useState(defaultBlocks);
  const [cadence, setCadence] = useState(() => defaultCadence('COFFEE_CHAT'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Changing the round changes what the day looks like, so the shape follows it
  // rather than leaving a coffee chat described as an hourly schedule.
  const chooseType = (next) => {
    setInterviewType(next);
    if (next === 'COFFEE_CHAT') {
      setMode('blocks');
      setBlocks(defaultBlocks());
    } else {
      setMode('cadence');
      setCadence(defaultCadence(next));
    }
  };

  const cadencePreview = useMemo(() => (mode === 'cadence' ? previewCadence(cadence) : []), [mode, cadence]);
  const parallel = Math.max(1, Math.min(12, Number(cadence.parallel) || 1));
  const sessionCount =
    mode === 'blocks' ? blocks.length : cadencePreview.length * parallel;
  const seatCount =
    mode === 'blocks'
      ? blocks.reduce((n, b) => n + (Number(b.capacity) || 0), 0)
      : sessionCount * (Number(cadence.capacity) || 0);

  const updateBlock = (index, changes) =>
    setBlocks((current) => current.map((b, i) => (i === index ? { ...b, ...changes } : b)));

  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      const interview = await apiClient.post('/admin/interviews/with-sessions', {
        title,
        interviewType,
        location,
        dresscode,
        day,
        sessions: mode === 'blocks' ? { blocks } : { cadence },
      });
      onCreated?.(interview);
      reset();
    } catch (e) {
      setError(e.message || 'Failed to create that interview.');
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setTitle('');
    setDay('');
    setLocation('');
    setDresscode('');
    chooseType('COFFEE_CHAT');
    setError('');
  };

  const canSubmit = title && day && location && sessionCount > 0 && !saving;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>New interview</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        <Typography variant="overline" color="text.secondary">
          The interview
        </Typography>
        <Stack spacing={2} sx={{ mt: 1, mb: 3 }}>
          <Stack direction="row" spacing={2}>
            <TextField
              select
              label="Round"
              value={interviewType}
              onChange={(e) => chooseType(e.target.value)}
              sx={{ minWidth: 180 }}
            >
              {Object.entries(TYPE_LABEL).map(([value, label]) => (
                <MenuItem key={value} value={value}>
                  {label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={`W27 ${TYPE_LABEL[interviewType]}`}
              fullWidth
            />
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField
              type="date"
              label="Day"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              InputLabelProps={{ shrink: true }}
              sx={{ minWidth: 200 }}
            />
            <TextField label="Location" value={location} onChange={(e) => setLocation(e.target.value)} fullWidth />
            <TextField
              label="Dress code"
              value={dresscode}
              onChange={(e) => setDresscode(e.target.value)}
              sx={{ minWidth: 180 }}
            />
          </Stack>
        </Stack>

        <Divider />

        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 2, mb: 1 }}>
          <Typography variant="overline" color="text.secondary">
            How the day runs
          </Typography>
          <ToggleButtonGroup exclusive size="small" value={mode} onChange={(e, next) => next && setMode(next)}>
            <ToggleButton value="blocks">Named sessions</ToggleButton>
            <ToggleButton value="cadence">A schedule</ToggleButton>
          </ToggleButtonGroup>
        </Stack>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {mode === 'blocks'
            ? 'A few long sittings that candidates recognise by name — how coffee chats run.'
            : 'Back-to-back sessions through the day — how first round runs. Candidates see the times.'}
        </Typography>

        {mode === 'blocks' ? (
          <Stack spacing={1.5}>
            {blocks.map((block, index) => (
              <Stack key={index} direction="row" spacing={1} alignItems="center">
                <TextField
                  size="small"
                  label="Name"
                  value={block.label}
                  onChange={(e) => updateBlock(index, { label: e.target.value })}
                  sx={{ flex: 1 }}
                />
                <TextField
                  size="small"
                  type="time"
                  label="Start"
                  value={block.start}
                  onChange={(e) => updateBlock(index, { start: e.target.value })}
                  InputLabelProps={{ shrink: true }}
                />
                <TextField
                  size="small"
                  type="time"
                  label="End"
                  value={block.end}
                  onChange={(e) => updateBlock(index, { end: e.target.value })}
                  InputLabelProps={{ shrink: true }}
                />
                <TextField
                  size="small"
                  type="number"
                  label="Candidates"
                  value={block.capacity}
                  onChange={(e) => updateBlock(index, { capacity: e.target.value })}
                  sx={{ width: 120 }}
                />
                <TextField
                  size="small"
                  type="number"
                  label="Interviewers"
                  value={block.interviewers}
                  onChange={(e) => updateBlock(index, { interviewers: e.target.value })}
                  sx={{ width: 130 }}
                />
                <IconButton
                  size="small"
                  aria-label={`Remove ${block.label || `session ${index + 1}`}`}
                  disabled={blocks.length <= 1}
                  onClick={() => setBlocks((c) => c.filter((_, i) => i !== index))}
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
                  setBlocks((c) => [
                    ...c,
                    { label: `Session ${c.length + 1}`, start: '17:00', end: '19:00', capacity: 20, interviewers: 4 },
                  ])
                }
              >
                Add a session
              </Button>
            </Box>
          </Stack>
        ) : (
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
              <TextField
                size="small"
                type="time"
                label="Day starts"
                value={cadence.start}
                onChange={(e) => setCadence({ ...cadence, start: e.target.value })}
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                size="small"
                type="time"
                label="Day ends"
                value={cadence.end}
                onChange={(e) => setCadence({ ...cadence, end: e.target.value })}
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                size="small"
                select
                label="Each runs"
                value={cadence.minutes}
                onChange={(e) => setCadence({ ...cadence, minutes: e.target.value })}
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
                type="number"
                label="Candidates each"
                value={cadence.capacity}
                onChange={(e) => setCadence({ ...cadence, capacity: e.target.value })}
                sx={{ width: 150 }}
              />
              <TextField
                size="small"
                type="number"
                label="Interviewers each"
                value={cadence.interviewers}
                onChange={(e) => setCadence({ ...cadence, interviewers: e.target.value })}
                sx={{ width: 160 }}
              />
              {/* Several panels often run at the same hour. Each is its own
                  session, with its own candidates and its own interviewers. */}
              <TextField
                size="small"
                select
                label="Running at once"
                value={cadence.parallel ?? 1}
                onChange={(e) => setCadence({ ...cadence, parallel: e.target.value })}
                sx={{ width: 160 }}
              >
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <MenuItem key={n} value={n}>
                    {n === 1 ? 'One at a time' : `${n} at once`}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>

            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
              <Typography variant="body2" color="text.secondary">
                Breaks
              </Typography>
              {(cadence.breaks ?? []).map((b, index) => (
                <Stack key={index} direction="row" spacing={0.5} alignItems="center">
                  <TextField
                    size="small"
                    type="time"
                    value={b.start}
                    onChange={(e) =>
                      setCadence({
                        ...cadence,
                        breaks: cadence.breaks.map((x, i) => (i === index ? { ...x, start: e.target.value } : x)),
                      })
                    }
                  />
                  <Typography variant="body2">to</Typography>
                  <TextField
                    size="small"
                    type="time"
                    value={b.end}
                    onChange={(e) =>
                      setCadence({
                        ...cadence,
                        breaks: cadence.breaks.map((x, i) => (i === index ? { ...x, end: e.target.value } : x)),
                      })
                    }
                  />
                  <IconButton
                    size="small"
                    aria-label={`Remove break ${index + 1}`}
                    onClick={() => setCadence({ ...cadence, breaks: cadence.breaks.filter((_, i) => i !== index) })}
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Stack>
              ))}
              <Button
                size="small"
                onClick={() =>
                  setCadence({ ...cadence, breaks: [...(cadence.breaks ?? []), { start: '12:00', end: '13:00' }] })
                }
              >
                Add a break
              </Button>
            </Stack>
          </Stack>
        )}

        {/* Nine sessions is worth seeing before it happens, not after. */}
        <Paper variant="outlined" sx={{ mt: 3, p: 2, bgcolor: 'action.hover' }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="subtitle2">
              {sessionCount} session{sessionCount === 1 ? '' : 's'}
            </Typography>
            {mode === 'cadence' && parallel > 1 && (
              <Chip
                size="small"
                variant="outlined"
                label={`${cadencePreview.length} times × ${parallel} at once`}
              />
            )}
            <Chip size="small" label={`${seatCount} candidate seats`} />
            {sessionCount === 0 && <Chip size="small" color="error" label="Nothing to create" />}
          </Stack>
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
            {mode === 'blocks'
              ? blocks.map((b, i) => (
                  <Chip key={i} size="small" variant="outlined" label={`${b.label || `Session ${i + 1}`} · ${b.start}–${b.end}`} />
                ))
              : cadencePreview.map((row, i) => (
                  <Chip
                    key={i}
                    size="small"
                    variant="outlined"
                    label={`${asTime(row.start)}–${asTime(row.end)}${parallel > 1 ? ` ×${parallel}` : ''}`}
                  />
                ))}
          </Stack>
        </Paper>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={!canSubmit}>
          {saving ? 'Creating…' : `Create with ${sessionCount} session${sessionCount === 1 ? '' : 's'}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
