import React, { useEffect, useState } from 'react';
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
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { Add as AddIcon, DeleteOutline as DeleteIcon } from '@mui/icons-material';
import apiClient from '../../utils/api';
import { formatDay, formatTimeRange } from '../../utils/scheduleFormat';

/**
 * Change an interview after it exists.
 *
 * Everything moves eventually - the day slips, the room changes, a session needs
 * more seats because more people advanced than expected. Sessions are edited
 * here rather than on the roster because changing a time is a different act from
 * moving a candidate, and mixing them on one screen invites the wrong one.
 *
 * Moving the interview does not move its sessions: those carry their own times
 * and are what candidates booked. Shifting the whole day is its own button, so
 * it is never a side effect of fixing a title.
 */

const asLocalInput = (value) => {
  if (!value) return '';
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const asTimeInput = (value) => {
  if (!value) return '';
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const asDayInput = (value) => {
  if (!value) return '';
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export default function InterviewEditDialog({ open, interview, onClose, onSaved }) {
  const [details, setDetails] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [moveTo, setMoveTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!open || !interview) return;
    setError('');
    setNotice('');
    setMoveTo('');
    setDetails({
      title: interview.title ?? '',
      location: interview.location ?? '',
      dresscode: interview.dresscode ?? '',
      startDate: asLocalInput(interview.startDate),
      endDate: asLocalInput(interview.endDate),
    });
    apiClient
      .get(`/admin/interviews/${interview.id}/roster`)
      .then((roster) =>
        setSessions(
          (roster.slots ?? []).map((slot) => ({
            id: slot.id,
            label: slot.label ?? '',
            day: asDayInput(slot.startTime),
            start: asTimeInput(slot.startTime),
            end: asTimeInput(slot.endTime),
            candidateCapacity: slot.candidateCapacity ?? '',
            interviewerCapacity: slot.interviewerCapacity ?? '',
            booked: slot.signups.filter((s) => s.status === 'CONFIRMED').length,
            dirty: false,
          }))
        )
      )
      .catch(() => setSessions([]));
  }, [open, interview]);

  const update = (index, changes) =>
    setSessions((current) =>
      current.map((s, i) => (i === index ? { ...s, ...changes, dirty: true } : s))
    );

  const run = async (fn, message) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      if (message) setNotice(message);
      onSaved?.();
    } catch (e) {
      setError(e.message || 'That did not save.');
    } finally {
      setBusy(false);
    }
  };

  const saveDetails = () =>
    run(
      () =>
        apiClient.patch(`/admin/interviews/${interview.id}`, {
          title: details.title,
          location: details.location,
          dresscode: details.dresscode,
          startDate: details.startDate ? new Date(details.startDate).toISOString() : undefined,
          endDate: details.endDate ? new Date(details.endDate).toISOString() : undefined,
        }),
      'Interview updated.'
    );

  const saveSession = (index) => {
    const s = sessions[index];
    return run(
      () =>
        apiClient.patch(`/admin/interviews/slots/${s.id}`, {
          label: s.label,
          startTime: new Date(`${s.day}T${s.start}`).toISOString(),
          endTime: new Date(`${s.day}T${s.end}`).toISOString(),
          candidateCapacity: s.candidateCapacity === '' ? null : Number(s.candidateCapacity),
          interviewerCapacity: s.interviewerCapacity === '' ? null : Number(s.interviewerCapacity),
        }),
      'Session updated.'
    ).then(() => update(index, { dirty: false }));
  };

  const deleteSession = (index) => {
    const s = sessions[index];
    const warning = s.booked
      ? `${s.booked} candidate${s.booked === 1 ? ' is' : 's are'} in this session. Delete it anyway? They will lose their spot.`
      : 'Delete this session?';
    if (!window.confirm(warning)) return Promise.resolve();
    return run(
      () => apiClient.delete(`/admin/interviews/slots/${s.id}${s.booked ? '?force=true' : ''}`),
      'Session deleted.'
    ).then(() => setSessions((cur) => cur.filter((_, i) => i !== index)));
  };

  const addSession = () => {
    const last = sessions[sessions.length - 1];
    return run(
      () =>
        apiClient.post(`/admin/interviews/${interview.id}/slots`, {
          label: '',
          startTime: new Date(`${last?.day ?? asDayInput(interview.startDate)}T${last?.end ?? '09:00'}`).toISOString(),
          endTime: new Date(
            `${last?.day ?? asDayInput(interview.startDate)}T${last?.end ?? '10:00'}`
          ).toISOString(),
          candidateCapacity: last?.candidateCapacity || 4,
          interviewerCapacity: last?.interviewerCapacity || 2,
        }),
      'Session added — set its time below.'
    );
  };

  const shiftDay = () =>
    run(
      () => apiClient.post(`/admin/interviews/${interview.id}/reschedule`, { day: moveTo }),
      'Every session moved, keeping its time of day.'
    );

  if (!interview || !details) return null;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>Edit {interview.title}</DialogTitle>
      <DialogContent>
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

        <Typography variant="overline" color="text.secondary">
          Details
        </Typography>
        <Stack spacing={2} sx={{ mt: 1, mb: 2 }}>
          <Stack direction="row" spacing={2}>
            <TextField
              label="Title"
              value={details.title}
              onChange={(e) => setDetails({ ...details, title: e.target.value })}
              fullWidth
            />
            <TextField
              label="Location"
              value={details.location}
              onChange={(e) => setDetails({ ...details, location: e.target.value })}
              fullWidth
            />
          </Stack>
          <Stack direction="row" spacing={2} alignItems="center">
            <TextField
              label="Dress code"
              value={details.dresscode}
              onChange={(e) => setDetails({ ...details, dresscode: e.target.value })}
              sx={{ width: 220 }}
            />
            <Button variant="outlined" onClick={saveDetails} disabled={busy}>
              Save details
            </Button>
          </Stack>
        </Stack>

        <Divider />

        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mt: 2, mb: 1 }}>
          <Typography variant="overline" color="text.secondary">
            Sessions ({sessions.length})
          </Typography>
          <Button size="small" startIcon={<AddIcon />} onClick={addSession} disabled={busy}>
            Add a session
          </Button>
        </Stack>

        {sessions.length === 0 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            This interview has no sessions. Add one, and candidates can start booking it.
          </Alert>
        )}

        <Stack spacing={1.5}>
          {sessions.map((session, index) => (
            <Stack key={session.id} direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
              <TextField
                size="small"
                label="Name"
                placeholder={formatTimeRange(
                  new Date(`${session.day}T${session.start}`),
                  new Date(`${session.day}T${session.end}`)
                )}
                value={session.label}
                onChange={(e) => update(index, { label: e.target.value })}
                sx={{ width: 160 }}
              />
              <TextField
                size="small"
                type="date"
                label="Day"
                value={session.day}
                onChange={(e) => update(index, { day: e.target.value })}
                InputLabelProps={{ shrink: true }}
                sx={{ width: 150 }}
              />
              <TextField
                size="small"
                type="time"
                label="Start"
                value={session.start}
                onChange={(e) => update(index, { start: e.target.value })}
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                size="small"
                type="time"
                label="End"
                value={session.end}
                onChange={(e) => update(index, { end: e.target.value })}
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                size="small"
                type="number"
                label="Seats"
                value={session.candidateCapacity}
                onChange={(e) => update(index, { candidateCapacity: e.target.value })}
                sx={{ width: 92 }}
                helperText={session.booked ? `${session.booked} booked` : ' '}
              />
              <TextField
                size="small"
                type="number"
                label="Interviewers"
                value={session.interviewerCapacity}
                onChange={(e) => update(index, { interviewerCapacity: e.target.value })}
                sx={{ width: 118 }}
              />
              <Button size="small" disabled={!session.dirty || busy} onClick={() => saveSession(index)}>
                Save
              </Button>
              <IconButton size="small" onClick={() => deleteSession(index)} disabled={busy}>
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Stack>
          ))}
        </Stack>

        {/* Lowering seats below what is booked is allowed - the roster shows the
            session over capacity afterwards, which is the honest outcome. */}
        {sessions.some((s) => s.candidateCapacity !== '' && Number(s.candidateCapacity) < s.booked) && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            One of these has fewer seats than the people already in it. Nobody is removed — the session
            will simply show as over capacity until you move someone.
          </Alert>
        )}

        <Divider sx={{ my: 3 }} />

        <Typography variant="overline" color="text.secondary">
          Move the whole day
        </Typography>
        <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 1 }}>
          <TextField
            size="small"
            type="date"
            label="New day"
            value={moveTo}
            onChange={(e) => setMoveTo(e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ width: 180 }}
          />
          <Button variant="outlined" disabled={!moveTo || busy || sessions.length === 0} onClick={shiftDay}>
            Move every session
          </Button>
          <Typography variant="caption" color="text.secondary">
            Keeps each session at the same time of day.
          </Typography>
        </Stack>
        {sessions.length > 0 && (
          <Stack direction="row" spacing={0.5} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
            <Chip
              size="small"
              variant="outlined"
              label={`Currently ${formatDay(new Date(`${sessions[0].day}T${sessions[0].start}`))}`}
            />
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}
