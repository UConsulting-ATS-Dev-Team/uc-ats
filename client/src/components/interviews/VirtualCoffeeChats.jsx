import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Link,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  EditCalendar as EditIcon,
  EventBusy as CancelIcon,
  PersonAdd as PersonAddIcon,
  PlayArrow as PlayIcon,
  Videocam as VideoIcon,
} from '@mui/icons-material';
import apiClient from '../../utils/api';
import { formatDay, formatTimeRange, toPacificInput } from '../../utils/scheduleFormat';
import { useTutorialGate } from '../TutorialGate';
import { tutorialCategoryForInterviewType } from '../../utils/tutorialCategories';

/**
 * Virtual coffee chats: video calls recruitment schedules by hand.
 *
 * Each one is its own coffee chat interview with a single session that is
 * never open to signup. An admin picks who is in it, one applicant or a whole
 * group, and who runs it. Applicants and members cannot add or remove
 * themselves. Rules live server-side in services/virtualCoffeeChats.js.
 *
 * Applicants already holding an in-person seat are moved out of it, not given
 * a second one, and the picker says so before anyone clicks.
 */

const fullName = (person) => `${person.firstName ?? ''} ${person.lastName ?? ''}`.trim() || person.email || 'Applicant';

const placementText = (placement) => {
  if (!placement) return 'Not scheduled yet';
  const where = placement.label || placement.title;
  return placement.isVirtual ? `In virtual chat: ${where}` : `In ${where}`;
};

const placementGroup = (applicant) =>
  !applicant.placement
    ? 'Not scheduled yet'
    : applicant.placement.isVirtual
      ? 'In another virtual chat'
      : 'In an in-person session';

const GROUP_ORDER = ['Not scheduled yet', 'In an in-person session', 'In another virtual chat'];

/** "2 added · 1 moved from Morning Block · 1 skipped (Not advancing)" */
function describeOutcomes(applicants = [], interviewers = []) {
  const parts = [];
  const count = (list, outcome) => list.filter((o) => o.outcome === outcome);
  const placed = count(applicants, 'PLACED').length;
  const moved = count(applicants, 'MOVED');
  const assigned = count(interviewers, 'ASSIGNED').length;
  const skipped = [...count(applicants, 'SKIPPED'), ...count(interviewers, 'SKIPPED')];
  if (placed) parts.push(`${placed} applicant${placed === 1 ? '' : 's'} added`);
  if (moved.length) {
    const from = [...new Set(moved.map((o) => o.from).filter(Boolean))].join(', ');
    parts.push(`${moved.length} moved${from ? ` from ${from}` : ''}`);
  }
  if (assigned) parts.push(`${assigned} interviewer${assigned === 1 ? '' : 's'} added`);
  if (skipped.length) {
    const reasons = [...new Set(skipped.map((o) => o.reason).filter(Boolean))].join('; ');
    parts.push(`${skipped.length} skipped${reasons ? ` (${reasons})` : ''}`);
  }
  return parts.join(' · ');
}

const blankForm = () => ({ title: '', day: '', start: '', end: '', meetingUrl: '', notes: '' });

const formFromChat = (chat) => {
  const start = toPacificInput(chat.startTime);
  const end = toPacificInput(chat.endTime);
  return {
    title: chat.title ?? '',
    day: start.slice(0, 10),
    start: start.slice(11),
    end: end.slice(11),
    meetingUrl: chat.meetingUrl ?? '',
    notes: chat.notes ?? '',
  };
};

function ApplicantPicker({ options, value, onChange, label = 'Applicants' }) {
  const sorted = useMemo(
    () =>
      [...options].sort(
        (a, b) =>
          GROUP_ORDER.indexOf(placementGroup(a)) - GROUP_ORDER.indexOf(placementGroup(b)) ||
          fullName(a).localeCompare(fullName(b))
      ),
    [options]
  );
  const moving = value.filter((a) => a.placement);
  return (
    <>
      <Autocomplete
        multiple
        options={sorted}
        value={value}
        onChange={(event, next) => onChange(next)}
        groupBy={placementGroup}
        getOptionLabel={fullName}
        isOptionEqualToValue={(option, selected) => option.id === selected.id}
        filterSelectedOptions
        renderOption={(props, option) => (
          <li {...props} key={option.id}>
            <Box>
              <Typography variant="body2">{fullName(option)}</Typography>
              <Typography variant="caption" color="text.secondary">
                {option.email} · {placementText(option.placement)}
              </Typography>
            </Box>
          </li>
        )}
        renderInput={(params) => (
          <TextField {...params} label={label} placeholder="Search by name" helperText="Coffee chat round only" />
        )}
      />
      {moving.length > 0 && (
        <Alert severity="info" sx={{ mt: 1 }}>
          {moving.length === 1 ? `${fullName(moving[0])} is` : `${moving.length} of them are`} already scheduled
          elsewhere and will be moved into this chat. They are emailed about the change.
        </Alert>
      )}
    </>
  );
}

function StaffPicker({ options, value, onChange }) {
  return (
    <Autocomplete
      multiple
      options={options}
      value={value}
      onChange={(event, next) => onChange(next)}
      getOptionLabel={(person) => person.fullName || person.email}
      isOptionEqualToValue={(option, selected) => option.id === selected.id}
      filterSelectedOptions
      renderInput={(params) => <TextField {...params} label="Interviewers" placeholder="Search members" />}
    />
  );
}

/** Create or edit. People are picked here only on create; afterwards each chat has its own add buttons. */
function ChatDialog({ open, chat, applicants, staff, busy, onClose, onSave }) {
  const [form, setForm] = useState(blankForm());
  const [pickedApplicants, setPickedApplicants] = useState([]);
  const [pickedStaff, setPickedStaff] = useState([]);

  useEffect(() => {
    if (!open) return;
    setForm(chat ? formFromChat(chat) : blankForm());
    setPickedApplicants([]);
    setPickedStaff([]);
  }, [open, chat]);

  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  const ready = form.day && form.start && form.end;

  const submit = () =>
    onSave({
      ...form,
      ...(chat
        ? {}
        : {
            applicationIds: pickedApplicants.map((a) => a.id),
            interviewerIds: pickedStaff.map((s) => s.id),
          }),
    });

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{chat ? 'Edit virtual coffee chat' : 'New virtual coffee chat'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Title"
            value={form.title}
            onChange={set('title')}
            placeholder="Virtual Coffee Chat"
            inputProps={{ maxLength: 120 }}
          />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Day"
              type="date"
              value={form.day}
              onChange={set('day')}
              InputLabelProps={{ shrink: true }}
              required
              fullWidth
            />
            <TextField
              label="Start (Pacific)"
              type="time"
              value={form.start}
              onChange={set('start')}
              InputLabelProps={{ shrink: true }}
              required
              fullWidth
            />
            <TextField
              label="End (Pacific)"
              type="time"
              value={form.end}
              onChange={set('end')}
              InputLabelProps={{ shrink: true }}
              required
              fullWidth
            />
          </Stack>
          <TextField
            label="Meeting link"
            value={form.meetingUrl}
            onChange={set('meetingUrl')}
            placeholder="https://ucla.zoom.us/j/..."
            helperText="Zoom, Meet or Teams. It goes in every email and calendar invite. You can add it later."
          />
          <TextField
            label="Notes for recruitment"
            value={form.notes}
            onChange={set('notes')}
            multiline
            minRows={2}
            inputProps={{ maxLength: 1000 }}
            helperText="Not shown to applicants."
          />
          {!chat && (
            <>
              <StaffPicker options={staff} value={pickedStaff} onChange={setPickedStaff} />
              <ApplicantPicker options={applicants} value={pickedApplicants} onChange={setPickedApplicants} />
            </>
          )}
          {chat && (
            <Typography variant="body2" color="text.secondary">
              Changing the time or the link emails everyone in this chat.
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Close
        </Button>
        <Button variant="contained" onClick={submit} disabled={busy || !ready}>
          {chat ? 'Save' : 'Create chat'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function AddPeopleDialog({ target, applicants, staff, busy, onClose, onAdd }) {
  const [picked, setPicked] = useState([]);
  useEffect(() => setPicked([]), [target]);
  if (!target) return null;

  const { chat, kind } = target;
  const inChat = new Set(
    kind === 'applicants' ? chat.applicants.map((a) => a.applicationId) : chat.interviewers.map((i) => i.user.id)
  );
  const available = (kind === 'applicants' ? applicants : staff).filter((person) => !inChat.has(person.id));

  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        {kind === 'applicants' ? 'Add applicants to' : 'Add interviewers to'} {chat.title}
      </DialogTitle>
      <DialogContent>
        <Box sx={{ mt: 1 }}>
          {kind === 'applicants' ? (
            <ApplicantPicker options={available} value={picked} onChange={setPicked} />
          ) : (
            <StaffPicker options={available} value={picked} onChange={setPicked} />
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Close
        </Button>
        <Button
          variant="contained"
          disabled={busy || picked.length === 0}
          onClick={() => onAdd(chat, kind, picked.map((p) => p.id))}
        >
          Add {picked.length || ''}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ChatRow({ chat, busy, onEdit, onAddPeople, onRemoveApplicant, onRemoveInterviewer, onRun, onCancel }) {
  // Only listed when a cancellation stopped part way and left people booked.
  // The one thing to do with it is finish cancelling.
  const stranded = chat.status === 'CANCELLED';
  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-testid="virtual-chat">
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" spacing={1}>
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <VideoIcon fontSize="small" color="secondary" />
            <Typography variant="subtitle1" fontWeight={600}>
              {chat.title}
            </Typography>
            {!stranded && chat.applicants.length === 1 && <Chip size="small" variant="outlined" label="1:1" />}
            {stranded && (
              <Chip
                size="small"
                color="error"
                label={`Cancelled · ${chat.applicants.length} still booked`}
              />
            )}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {formatDay(chat.startTime)} · {formatTimeRange(chat.startTime, chat.endTime)}
          </Typography>
          {chat.meetingUrl ? (
            <Link href={chat.meetingUrl} target="_blank" rel="noopener noreferrer" variant="body2" sx={{ wordBreak: 'break-all' }}>
              {chat.meetingUrl}
            </Link>
          ) : (
            <Typography variant="body2" color="warning.main">
              No meeting link yet. Emails say "link to follow".
            </Typography>
          )}
          {chat.notes && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }}>
              {chat.notes}
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1} sx={{ flexShrink: 0, alignSelf: { md: 'flex-start' } }}>
          {!stranded && (
            <>
              <Button
                size="small"
                startIcon={<PlayIcon />}
                disabled={busy || chat.applicants.length === 0}
                onClick={() => onRun(chat)}
              >
                Run
              </Button>
              <Button size="small" startIcon={<EditIcon />} disabled={busy} onClick={() => onEdit(chat)}>
                Edit
              </Button>
            </>
          )}
          <Button size="small" color="error" startIcon={<CancelIcon />} disabled={busy} onClick={() => onCancel(chat)}>
            {stranded ? 'Finish cancelling' : 'Cancel chat'}
          </Button>
        </Stack>
      </Stack>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} sx={{ mt: 1.5, ...(stranded && { opacity: 0.6, pointerEvents: 'none' }) }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
            Interviewers
          </Typography>
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75 }}>
            {chat.interviewers.map((interviewer) => (
              <Chip
                key={interviewer.assignmentId}
                size="small"
                label={interviewer.user.fullName}
                onDelete={busy ? undefined : () => onRemoveInterviewer(chat, interviewer)}
              />
            ))}
            {chat.interviewers.length === 0 && (
              <Chip size="small" color="warning" variant="outlined" label="Nobody assigned" />
            )}
            <Chip
              size="small"
              variant="outlined"
              icon={<PersonAddIcon />}
              label="Add"
              onClick={busy ? undefined : () => onAddPeople(chat, 'interviewers')}
            />
          </Stack>
        </Box>
        <Box sx={{ flex: 2, minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
            Applicants ({chat.applicants.length})
          </Typography>
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75 }}>
            {chat.applicants.map((applicant) => (
              <Chip
                key={applicant.signupId}
                size="small"
                color="primary"
                variant="outlined"
                label={fullName(applicant)}
                data-no-track
                onDelete={busy ? undefined : () => onRemoveApplicant(chat, applicant)}
              />
            ))}
            <Chip
              size="small"
              variant="outlined"
              icon={<PersonAddIcon />}
              label="Add"
              onClick={busy ? undefined : () => onAddPeople(chat, 'applicants')}
            />
          </Stack>
        </Box>
      </Stack>
    </Paper>
  );
}

export default function VirtualCoffeeChats({ onChanged }) {
  const navigate = useNavigate();
  const tutorialGate = useTutorialGate();
  const [data, setData] = useState(null);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState(null); // { chat } for edit, {} for create
  const [adding, setAdding] = useState(null); // { chat, kind }

  const load = useCallback(async () => {
    try {
      const [chats, members] = await Promise.all([
        apiClient.get('/admin/virtual-coffee-chats'),
        apiClient.get('/admin/interviews/staff').catch(() => []),
      ]);
      setData(chats);
      setStaff(members || []);
    } catch (e) {
      setError(e.message || 'Failed to load virtual coffee chats.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await fn();
      await load();
      onChanged?.();
      return result;
    } catch (e) {
      setError(e.message || 'That did not go through.');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const save = async (form) => {
    const editing = dialog?.chat;
    const result = await run(() =>
      editing
        ? apiClient.patch(`/admin/virtual-coffee-chats/${editing.id}`, form)
        : apiClient.post('/admin/virtual-coffee-chats', form)
    );
    if (!result) return;
    setDialog(null);
    setNotice(
      editing ? 'Saved.' : ['Virtual coffee chat created.', describeOutcomes(result.applicants, result.interviewers)].filter(Boolean).join(' ')
    );
  };

  const addPeople = async (chat, kind, ids) => {
    const result = await run(() =>
      apiClient.post(
        `/admin/virtual-coffee-chats/${chat.id}/${kind}`,
        kind === 'applicants' ? { applicationIds: ids } : { userIds: ids }
      )
    );
    if (!result) return;
    setAdding(null);
    setNotice(describeOutcomes(result.applicants, result.interviewers) || 'Nothing changed.');
  };

  const removeApplicant = async (chat, applicant) => {
    if (!window.confirm(`Take ${fullName(applicant)} out of "${chat.title}"? They are emailed that it is cancelled.`)) return;
    if (await run(() => apiClient.delete(`/admin/virtual-coffee-chats/${chat.id}/applicants/${applicant.signupId}`))) {
      setNotice(`${fullName(applicant)} removed.`);
    }
  };

  const removeInterviewer = async (chat, interviewer) => {
    if (await run(() => apiClient.delete(`/admin/virtual-coffee-chats/${chat.id}/interviewers/${interviewer.assignmentId}`))) {
      setNotice(`${interviewer.user.fullName} removed.`);
    }
  };

  const cancelChat = async (chat) => {
    const people = chat.applicants.length + chat.interviewers.length;
    if (
      !window.confirm(
        `Cancel "${chat.title}"?${people ? ` All ${people} people in it are emailed, and the applicants go back to unscheduled.` : ''}`
      )
    ) {
      return;
    }
    if (await run(() => apiClient.post(`/admin/virtual-coffee-chats/${chat.id}/cancel`, {}))) {
      setNotice(`"${chat.title}" cancelled.`);
    }
  };

  // Runs the session in the same interface as an in-person coffee chat, behind
  // the same once-a-cycle tutorial.
  const runChat = (chat) =>
    tutorialGate.run(async () => {
      await apiClient.post(`/admin/interviews/${chat.id}/start`, {}).catch(() => {});
      navigate(`/admin/interview-interface?interviewId=${chat.id}&groupIds=${chat.slotId}`);
    }, tutorialCategoryForInterviewType('COFFEE_CHAT'));

  const chats = data?.chats ?? [];
  const applicants = data?.applicants ?? [];

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }} data-testid="virtual-coffee-chats">
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} spacing={1}>
        <Box>
          <Typography variant="h6">Virtual coffee chats</Typography>
          <Typography variant="body2" color="text.secondary">
            Video calls you schedule by hand, one-on-one or in a group. Applicants cannot sign up for these;
            only admins add applicants and interviewers.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} disabled={busy || loading} onClick={() => setDialog({})} sx={{ flexShrink: 0 }}>
          New virtual coffee chat
        </Button>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" sx={{ mt: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      ) : chats.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          None yet.
        </Typography>
      ) : (
        <Stack spacing={1.5} sx={{ mt: 2 }}>
          {chats.map((chat) => (
            <ChatRow
              key={chat.id}
              chat={chat}
              busy={busy}
              onEdit={(c) => setDialog({ chat: c })}
              onAddPeople={(c, kind) => setAdding({ chat: c, kind })}
              onRemoveApplicant={removeApplicant}
              onRemoveInterviewer={removeInterviewer}
              onRun={runChat}
              onCancel={cancelChat}
            />
          ))}
        </Stack>
      )}

      <ChatDialog
        open={Boolean(dialog)}
        chat={dialog?.chat ?? null}
        applicants={applicants}
        staff={staff}
        busy={busy}
        onClose={() => setDialog(null)}
        onSave={save}
      />
      <AddPeopleDialog
        target={adding}
        applicants={applicants}
        staff={staff}
        busy={busy}
        onClose={() => setAdding(null)}
        onAdd={addPeople}
      />
      {tutorialGate.dialog}
    </Paper>
  );
}
