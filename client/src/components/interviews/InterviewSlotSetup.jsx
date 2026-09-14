import React, { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import apiClient from '../../utils/api';

/**
 * Create the sessions candidates book into.
 *
 * Two shapes, because recruitment runs two shapes: a coffee chat day is a
 * morning and an afternoon block with a headcount each, and a first round day is
 * back-to-back group interviews of four. The default is chosen from the
 * interview type so the common case needs no decision.
 */
export default function InterviewSlotSetup({ interviewId, interviewType, onCreated }) {
  const isCoffeeChat = interviewType === 'COFFEE_CHAT';
  const [mode, setMode] = useState(isCoffeeChat ? 'blocks' : 'cadence');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [day, setDay] = useState('');
  const [blocks, setBlocks] = useState([
    { label: 'Morning Block', start: '09:00', end: '11:00', capacity: 40 },
    { label: 'Afternoon Block', start: '14:00', end: '16:00', capacity: 40 },
  ]);
  const [cadence, setCadence] = useState({ start: '11:00', end: '17:00', minutes: 60, capacity: 4 });

  // The page renders Pacific everywhere, so an admin typing 9:00 means 9:00 on
  // campus. Building the ISO string from the local parts keeps that true.
  const at = (time) => (day && time ? new Date(`${day}T${time}:00`).toISOString() : null);

  const updateBlock = (index, changes) =>
    setBlocks((current) => current.map((block, i) => (i === index ? { ...block, ...changes } : block)));

  const submit = async () => {
    setError('');
    if (!day) {
      setError('Pick the day these sessions run.');
      return;
    }
    setSaving(true);
    try {
      const payload =
        mode === 'blocks'
          ? {
              blocks: blocks.map((block) => ({
                label: block.label,
                startTime: at(block.start),
                endTime: at(block.end),
                candidateCapacity: Number(block.capacity),
              })),
            }
          : {
              cadence: {
                startTime: at(cadence.start),
                endTime: at(cadence.end),
                minutes: Number(cadence.minutes),
                candidateCapacity: Number(cadence.capacity),
              },
            };

      const result = await apiClient.post(`/admin/interviews/${interviewId}/slots/generate`, payload);
      onCreated?.(result);
    } catch (e) {
      setError(e.message || 'Failed to create those sessions.');
    } finally {
      setSaving(false);
    }
  };

  const slotPreview =
    mode === 'cadence' && cadence.start && cadence.end && Number(cadence.minutes) > 0
      ? Math.max(
          0,
          Math.floor(
            ((Number(cadence.end.split(':')[0]) * 60 + Number(cadence.end.split(':')[1])) -
              (Number(cadence.start.split(':')[0]) * 60 + Number(cadence.start.split(':')[1]))) /
              Number(cadence.minutes)
          )
        )
      : 0;

  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Typography variant="h6" gutterBottom>
        Set up sessions
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Candidates pick from these. Nothing is bookable until you create them.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <ToggleButtonGroup
        exclusive
        size="small"
        value={mode}
        onChange={(e, next) => next && setMode(next)}
        sx={{ mb: 2 }}
      >
        <ToggleButton value="blocks">Named blocks</ToggleButton>
        <ToggleButton value="cadence">Back-to-back sessions</ToggleButton>
      </ToggleButtonGroup>

      <TextField
        type="date"
        label="Day"
        size="small"
        value={day}
        onChange={(e) => setDay(e.target.value)}
        InputLabelProps={{ shrink: true }}
        sx={{ mb: 2, display: 'block', maxWidth: 220 }}
      />

      {mode === 'blocks' ? (
        <Stack spacing={2}>
          {blocks.map((block, index) => (
            <Stack key={index} direction="row" spacing={1} alignItems="center">
              <TextField
                size="small"
                label="Name"
                value={block.label}
                onChange={(e) => updateBlock(index, { label: e.target.value })}
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
                label="Seats"
                value={block.capacity}
                onChange={(e) => updateBlock(index, { capacity: e.target.value })}
                sx={{ width: 100 }}
              />
            </Stack>
          ))}
          <Box>
            <Button
              size="small"
              onClick={() =>
                setBlocks((current) => [
                  ...current,
                  { label: `Block ${current.length + 1}`, start: '17:00', end: '19:00', capacity: 40 },
                ])
              }
            >
              Add another block
            </Button>
          </Box>
        </Stack>
      ) : (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
          <TextField
            size="small"
            type="time"
            label="First starts"
            value={cadence.start}
            onChange={(e) => setCadence({ ...cadence, start: e.target.value })}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            size="small"
            type="time"
            label="Last ends"
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
          {slotPreview > 0 && (
            <Typography variant="caption" color="text.secondary">
              {slotPreview} session{slotPreview === 1 ? '' : 's'}, {slotPreview * Number(cadence.capacity || 0)} seats
            </Typography>
          )}
        </Stack>
      )}

      <Box sx={{ mt: 3 }}>
        <Button variant="contained" onClick={submit} disabled={saving}>
          {saving ? 'Creating…' : 'Create sessions'}
        </Button>
      </Box>
    </Paper>
  );
}
