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
import { Add as AddIcon, DeleteOutline as DeleteIcon, Send as SendIcon } from '@mui/icons-material';
import apiClient from '../../utils/api';
import { formatDay, formatTimeRange, fromPacificInput, toPacificInput } from '../../utils/scheduleFormat';

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
 *
 * Saving emails nobody. A save that moves a session's time or place leaves it
 * with Send update, which stays until somebody presses it, here or after
 * reopening the dialog, so several edits can go out as one email.
 */

// Read and written in Pacific, as the pages show them, not in the browser's
// own zone. An admin travelling would otherwise load a form whose hours differ
// from the session they clicked, and save that difference back.
const asLocalInput = toPacificInput;
const asTimeInput = (value) => toPacificInput(value).slice(11);
const asDayInput = (value) => toPacificInput(value).slice(0, 10);
// Throws rather than returning nothing: the request would drop an undefined
// time, keep the old one, and still report the edit as saved.
const asInstant = (day, time) => {
  const instant = fromPacificInput(`${day}T${time}`);
  if (!instant) throw new Error('Give the session a day, a start time and an end time.');
  return instant.toISOString();
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Who the page last saw in a session, for the pending line's wording only. The
// server reads who is in it when the update is sent, since someone may have
// booked since this dialog opened.
const knownPeople = (s) =>
  [
    s.booked ? plural(s.booked, 'booked candidate') : null,
    s.interviewers ? plural(s.interviewers, 'interviewer') : null,
  ]
    .filter(Boolean)
    .join(' and ');

// What Send update did, read from the server's answer.
const updateSentMessage = (result) => {
  const notified = result?.notified ?? {};
  const who = [
    notified.candidates ? plural(notified.candidates, 'candidate') : null,
    notified.interviewers ? plural(notified.interviewers, 'interviewer') : null,
  ].filter(Boolean);
  // Checked before the switch: with scheduling email off, notices are still
  // recorded to send later, and a half that failed has nothing recorded.
  const failed = notified.failed ?? [];
  if (failed.length && !notified.emailsOn) {
    return `Scheduling emails are switched off, and the ${failed.join(' and ')} could not be recorded to email later. Tell them yourself.`;
  }
  if (!notified.emailsOn) return 'Scheduling emails are switched off, so nobody was emailed.';
  if (failed.length === 2) return 'The update could not be sent. Try Send update again.';
  if (failed.length) {
    const lead = who.length ? `Emailing ${who.join(' and ')}, but the` : 'The';
    return `${lead} ${failed.join(' and ')} could not be emailed. Tell them yourself.`;
  }
  return who.length ? `Update sent to ${who.join(' and ')}.` : 'Nobody is in that session to email.';
};

const toSession = (slot) => ({
  id: slot.id,
  label: slot.label ?? '',
  day: asDayInput(slot.startTime),
  start: asTimeInput(slot.startTime),
  end: asTimeInput(slot.endTime),
  candidateCapacity: slot.candidateCapacity ?? '',
  interviewerCapacity: slot.interviewerCapacity ?? '',
  location: slot.location ?? '',
  savedLocation: slot.location ?? '',
  booked: slot.signups.filter((s) => s.status === 'CONFIRMED').length,
  interviewers: slot.interviewers?.length ?? 0,
  pending: Boolean(slot.updatePendingSince),
  dirty: false,
});

export default function InterviewEditDialog({ open, interview, onClose, onSaved }) {
  const [details, setDetails] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [moveTo, setMoveTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const fetchSlots = () =>
    apiClient.get(`/admin/interviews/${interview.id}/roster`).then((roster) => roster.slots ?? []);

  const loadSessions = () =>
    fetchSlots()
      .then((slots) => setSessions(slots.map(toSession)))
      .catch(() => setSessions([]));

  // A change to the interview's location or day marks sessions on the server.
  // Only the flag is taken, so edits not yet saved in other rows survive, and
  // only ever turned on: this read may be older than a session save that
  // marked a row, and only Send update in this dialog turns one off.
  const refreshPending = () =>
    fetchSlots()
      .then((slots) => {
        const pending = new Set(slots.filter((slot) => slot.updatePendingSince).map((slot) => slot.id));
        setSessions((current) => current.map((s) => (pending.has(s.id) ? { ...s, pending: true } : s)));
      })
      .catch(() => {});

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
    loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, interview]);

  const update = (index, changes) =>
    setSessions((current) =>
      current.map((s, i) => (i === index ? { ...s, ...changes, dirty: true } : s))
    );

  const run = async (fn, message) => {
    setBusy(true);
    setError('');
    try {
      const result = await fn();
      const text = typeof message === 'function' ? message(result) : message;
      if (text) setNotice(text);
      onSaved?.();
      return result ?? true;
    } catch (e) {
      setError(e.message || 'That did not save.');
      return null;
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
          startDate: details.startDate ? fromPacificInput(details.startDate)?.toISOString() : undefined,
          endDate: details.endDate ? fromPacificInput(details.endDate)?.toISOString() : undefined,
        }),
      'Interview updated.'
    ).then((saved) => saved && refreshPending());

  const saveSession = (index) => {
    const s = sessions[index];
    return run(
      () =>
        apiClient.patch(`/admin/interviews/slots/${s.id}`, {
          label: s.label,
          startTime: asInstant(s.day, s.start),
          endTime: asInstant(s.day, s.end),
          candidateCapacity: s.candidateCapacity === '' ? null : Number(s.candidateCapacity),
          interviewerCapacity: s.interviewerCapacity === '' ? null : Number(s.interviewerCapacity),
          // Sent only when it changed. The server refuses any location on a
          // virtual coffee chat (its link is edited from its own panel), so an
          // untouched field must not turn a seat change into a 409.
          ...(s.location !== s.savedLocation ? { location: s.location.trim() } : {}),
        }),
      (slot) =>
        slot?.updatePendingSince
          ? 'Session saved. Nobody has been emailed — press Send update when you are ready.'
          : 'Session saved.'
    ).then((saved) => {
      // Set directly rather than through update(), which marks a row dirty. A
      // failed save stays dirty, so the location is sent again on the retry.
      if (saved) {
        setSessions((current) =>
          current.map((x, i) =>
            i === index
              ? {
                  ...x,
                  dirty: false,
                  savedLocation: s.location,
                  pending: Boolean(saved.updatePendingSince),
                }
              : x
          )
        );
      }
    });
  };

  const sendUpdate = (index) => {
    const s = sessions[index];
    return run(
      () =>
        apiClient.post(`/admin/interviews/slots/${s.id}/send-update`, {}).catch((e) => {
          // Somebody else pressed it first: nothing is left to send from here.
          if (e.code === 'NO_PENDING_UPDATE') return { alreadySent: true };
          throw e;
        }),
      (result) => (result?.alreadySent ? 'That update had already been sent.' : updateSentMessage(result))
    ).then((result) => {
      if (!result) return;
      // The server says whether the button stays: when nothing could be queued.
      setSessions((current) => current.map((x) => (x.id === s.id ? { ...x, pending: Boolean(result.pending) } : x)));
    });
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
          startTime: asInstant(last?.day ?? asDayInput(interview.startDate), last?.end ?? '09:00'),
          endTime: asInstant(last?.day ?? asDayInput(interview.startDate), last?.end ?? '10:00'),
          candidateCapacity: last?.candidateCapacity || 4,
          interviewerCapacity: last?.interviewerCapacity || 2,
        }),
      'Session added — set its time below.'
    );
  };

  const shiftDay = () =>
    run(
      () => apiClient.post(`/admin/interviews/${interview.id}/reschedule`, { day: moveTo }),
      'Every session moved, keeping its time of day. Nobody has been emailed — send each session its update below.'
    ).then((moved) => moved && loadSessions());

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
                  fromPacificInput(`${session.day}T${session.start}`),
                  fromPacificInput(`${session.day}T${session.end}`)
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
              {/* Blank inherits the interview's location; a room of its own is
                  how two sessions at the same hour tell candidates apart. */}
              <TextField
                size="small"
                label="Location"
                placeholder={details.location || 'Same as interview'}
                value={session.location}
                onChange={(e) => update(index, { location: e.target.value })}
                InputLabelProps={{ shrink: true }}
                sx={{ width: 170 }}
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
              {session.pending && (
                <Alert
                  severity="warning"
                  sx={{ flexBasis: '100%', mt: -0.5, py: 0 }}
                  action={
                    <Button
                      size="small"
                      color="inherit"
                      startIcon={<SendIcon fontSize="small" />}
                      disabled={busy || session.dirty}
                      onClick={() => sendUpdate(index)}
                    >
                      Send update
                    </Button>
                  }
                >
                  {session.dirty
                    ? 'Save your changes first, then send the update.'
                    : `Time or place changed. ${
                        knownPeople(session)
                          ? `The ${knownPeople(session)} have not been told yet.`
                          : 'Nobody booked into it has been told yet.'
                      } Send update emails them the new details with an updated calendar invite.`}
                </Alert>
              )}
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
          {/* Refused with unsaved rows: the move reloads every session, which
              would throw those edits away. */}
          <Button
            variant="outlined"
            disabled={!moveTo || busy || sessions.length === 0 || sessions.some((s) => s.dirty)}
            onClick={shiftDay}
          >
            Move every session
          </Button>
          <Typography variant="caption" color="text.secondary">
            {sessions.some((s) => s.dirty)
              ? 'Save the session you changed first.'
              : 'Keeps each session at the same time of day.'}
          </Typography>
        </Stack>
        {sessions.length > 0 && (
          <Stack direction="row" spacing={0.5} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
            <Chip
              size="small"
              variant="outlined"
              label={`Currently ${formatDay(fromPacificInput(`${sessions[0].day}T${sessions[0].start}`))}`}
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
