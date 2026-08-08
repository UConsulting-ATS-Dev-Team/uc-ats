import React, { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Stack,
  Box,
  Typography,
  TextField,
  Alert,
  Chip,
  Divider,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Step,
  Stepper,
  StepLabel,
  CircularProgress,
} from '@mui/material';
import apiClient from '../utils/api';

const STEPS = ['Timeline', 'Review & commit'];

const formatDateTime = (value) =>
  value
    ? new Date(value).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/Los_Angeles',
      })
    : '—';

// Full-timeline cycle bootstrap: capture every stage date in one pass, preview
// the event shells the timeline generates, then commit them transactionally.
export default function CycleTimelineBootstrapDialog({ open, cycles = [], onClose, onCommitted }) {
  const [stages, setStages] = useState([]);
  const [name, setName] = useState('');
  const [timeline, setTimeline] = useState({});
  const [activate, setActivate] = useState(false);
  const [cloneFrom, setCloneFrom] = useState('');
  const [step, setStep] = useState(0);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName('');
    setTimeline({});
    setActivate(false);
    setCloneFrom('');
    setStep(0);
    setPreview(null);
    setError('');

    apiClient
      .get('/admin/cycles/timeline-template')
      .then((data) => setStages(data.stages || []))
      .catch((e) => setError(e.message || 'Failed to load the timeline template'));
  }, [open]);

  // Per-field errors keyed by `${stage}:${field}` so each input can show its own message.
  const fieldErrors = useMemo(() => {
    const map = {};
    (preview?.validationErrors || []).forEach((err) => {
      map[`${err.stage || 'cycle'}:${err.field}`] = err.message;
    });
    return map;
  }, [preview]);

  const setStageValue = (stageKey, field, value) => {
    setTimeline((prev) => ({
      ...prev,
      [stageKey]: { ...(prev[stageKey] || {}), [field]: value },
    }));
  };

  // Clone dates from a prior cycle's stored timeline snapshot. Form links are
  // never carried over — stale form IDs are the failure mode this avoids.
  const handleClone = async (sourceCycleId) => {
    setCloneFrom(sourceCycleId);
    if (!sourceCycleId) return;
    try {
      setBusy(true);
      setError('');
      const clone = await apiClient.get(`/admin/cycles/${sourceCycleId}/timeline-clone`);
      const seeded = {};
      Object.entries(clone.stages || {}).forEach(([key, value]) => {
        seeded[key] = {
          start: value.start ? value.start.slice(0, 10) : '',
          end: value.end ? value.end.slice(0, 10) : '',
        };
      });
      setTimeline(seeded);
    } catch (e) {
      setError(e.message || 'Failed to clone the prior cycle timeline');
    } finally {
      setBusy(false);
    }
  };

  const handlePreview = async () => {
    try {
      setBusy(true);
      setError('');
      const result = await apiClient.post('/admin/cycles/bootstrap-preview', { name, timeline });
      setPreview(result);
      if (result.valid) setStep(1);
    } catch (e) {
      setError(e.message || 'Failed to preview the timeline');
    } finally {
      setBusy(false);
    }
  };

  const handleCommit = async () => {
    try {
      setBusy(true);
      setError('');
      const result = await apiClient.post('/admin/cycles/bootstrap-commit', {
        name,
        timeline,
        events: preview?.events || [],
        activate,
      });
      onCommitted?.(result);
    } catch (e) {
      setError(e.message || 'Failed to create the cycle');
    } finally {
      setBusy(false);
    }
  };

  const downloadChangeSet = () => {
    const blob = new Blob([JSON.stringify(preview.publishChangeSet, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(name || 'cycle').replace(/\s+/g, '-').toLowerCase()}-publish-change-set.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const clonableCycles = cycles.filter((cycle) => cycle.timelineSnapshot);

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle>New Recruiting Cycle — full timeline</DialogTitle>
      <DialogContent dividers>
        <Stepper activeStep={step} sx={{ mb: 3 }}>
          {STEPS.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {step === 0 && (
          <Stack spacing={2.5}>
            <TextField
              label="Cycle name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              fullWidth
              required
              error={Boolean(fieldErrors['cycle:name'])}
              helperText={fieldErrors['cycle:name'] || 'e.g. Fall 2026'}
            />

            {clonableCycles.length > 0 && (
              <TextField
                select
                label="Clone dates from a prior cycle (optional)"
                value={cloneFrom}
                onChange={(e) => handleClone(e.target.value)}
                fullWidth
                helperText="Shifts the prior timeline forward one year. Form links are never copied."
              >
                <MenuItem value="">Start from scratch</MenuItem>
                {clonableCycles.map((cycle) => (
                  <MenuItem key={cycle.id} value={cycle.id}>
                    {cycle.name}
                  </MenuItem>
                ))}
              </TextField>
            )}

            <Divider />

            {stages.map((stage) => (
              <Stack key={stage.key} direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="flex-start">
                <Box sx={{ minWidth: 200, pt: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {stage.label}
                    {stage.required ? ' *' : ''}
                  </Typography>
                  <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
                    {stage.generatesEvent && <Chip size="small" label="creates event" variant="outlined" />}
                    {stage.publicFacing && <Chip size="small" label="public" variant="outlined" />}
                  </Stack>
                </Box>
                <TextField
                  label={stage.type === 'window' ? 'Start' : 'Date'}
                  type="date"
                  value={timeline[stage.key]?.start || ''}
                  onChange={(e) => setStageValue(stage.key, 'start', e.target.value)}
                  InputLabelProps={{ shrink: true }}
                  error={Boolean(fieldErrors[`${stage.key}:start`])}
                  helperText={fieldErrors[`${stage.key}:start`] || ''}
                  sx={{ flex: 1 }}
                />
                {stage.type === 'window' && (
                  <TextField
                    label="End"
                    type="date"
                    value={timeline[stage.key]?.end || ''}
                    onChange={(e) => setStageValue(stage.key, 'end', e.target.value)}
                    InputLabelProps={{ shrink: true }}
                    error={Boolean(fieldErrors[`${stage.key}:end`])}
                    helperText={fieldErrors[`${stage.key}:end`] || ''}
                    sx={{ flex: 1 }}
                  />
                )}
              </Stack>
            ))}
          </Stack>
        )}

        {step === 1 && preview && (
          <Stack spacing={2.5}>
            <Typography variant="body2" color="text.secondary">
              Nothing has been created yet. These {preview.events.length} event shells will be created for{' '}
              <strong>{preview.name}</strong> in a single transaction.
            </Typography>

            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Event</TableCell>
                  <TableCell>Start</TableCell>
                  <TableCell>End</TableCell>
                  <TableCell align="center">Candidate-visible</TableCell>
                  <TableCell align="center">Form</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {preview.events.map((event) => (
                  <TableRow key={event.stageKey}>
                    <TableCell>{event.eventName}</TableCell>
                    <TableCell>{formatDateTime(event.eventStartDate)}</TableCell>
                    <TableCell>{formatDateTime(event.eventEndDate)}</TableCell>
                    <TableCell align="center">{event.showToCandidates ? 'Yes' : 'No'}</TableCell>
                    <TableCell align="center">
                      {event.needsForms ? (
                        <Chip size="small" color="warning" label="Needs form link" />
                      ) : (
                        <Typography variant="caption" color="text.secondary">
                          n/a
                        </Typography>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {preview.pendingFormCount > 0 && (
              <Alert severity="warning">
                {preview.pendingFormCount} event{preview.pendingFormCount === 1 ? '' : 's'} will be created without
                Google Forms. Forms cannot be auto-created yet (the service account is read-only for the Forms API),
                so these are marked <strong>Needs form link</strong> in Event Management until an admin pastes the URL.
              </Alert>
            )}

            <Alert severity="info" action={<Button size="small" onClick={downloadChangeSet}>Download</Button>}>
              {preview.publishChangeSet.entries.length} public date
              {preview.publishChangeSet.entries.length === 1 ? '' : 's'} need publishing on the website / Linktree by
              hand — nothing is published automatically.
            </Alert>

            <FormControlLabel
              control={<Checkbox checked={activate} onChange={(e) => setActivate(e.target.checked)} />}
              label="Make this the active cycle (deactivates the current one)"
            />
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {step === 1 && (
          <Button onClick={() => setStep(0)} disabled={busy}>
            Back
          </Button>
        )}
        {step === 0 ? (
          <Button
            variant="contained"
            onClick={handlePreview}
            disabled={busy}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : null}
          >
            Preview events
          </Button>
        ) : (
          <Button
            variant="contained"
            onClick={handleCommit}
            disabled={busy}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : null}
          >
            Create cycle & events
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
