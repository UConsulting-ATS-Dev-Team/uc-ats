import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  DeleteOutline as DeleteIcon,
  Schedule as ScheduleIcon,
  Send as SendIcon,
} from '@mui/icons-material';
import { LockClosedIcon } from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import { useExecUnlock } from '../context/ExecUnlockContext';

// Administration -> GM Recaps. The executive team's weekly general meeting
// recap, written from a template and sent to every active member and admin as
// "UConsulting Executive Team". Behind executive access; the rules (template,
// look, scheduling, who it reaches) live in server/src/services/gmRecaps.js.

const API = '/exec-access/gm-recaps';
const AUTOSAVE_MS = 800;
const PREVIEW_MS = 400;
const POLL_MS = 5000;
const FIELDS = ['subject', 'title', 'body', 'headerImageUrl', 'photoUrl'];

const STATUS_CHIP = {
  DRAFT: { label: 'Draft', color: 'default' },
  SCHEDULED: { label: 'Scheduled', color: 'info' },
  SENDING: { label: 'Sending', color: 'warning' },
  SENT: { label: 'Sent', color: 'success' },
  FAILED: { label: 'Failed', color: 'error' },
};

const formatWhen = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';

const errorText = (err) => err?.serverMessage || err?.message || 'Something went wrong.';

const pickFields = (recap) => Object.fromEntries(FIELDS.map((f) => [f, recap?.[f] ?? '']));

// <input type="datetime-local"> speaks local wall time without a zone.
const toLocalInput = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const nextHour = () => {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d;
};

function StatusChip({ recap }) {
  if (recap.interrupted) return <Chip size="small" color="error" label="Interrupted" />;
  const meta = STATUS_CHIP[recap.status] || STATUS_CHIP.DRAFT;
  return <Chip size="small" color={meta.color} label={meta.label} />;
}

function recapSummary(recap) {
  switch (recap.status) {
    case 'SCHEDULED':
      return `Goes out ${formatWhen(recap.scheduledAt)}`;
    case 'SENT':
      return `Sent ${formatWhen(recap.sentAt)}`;
    case 'SENDING':
      return 'Sending now';
    case 'FAILED':
      return 'Not sent';
    default:
      return `Edited ${formatWhen(recap.updatedAt)}`;
  }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

function ImageField({ label, help, value, onChange, disabled }) {
  const inputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const upload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      form.append('image', file);
      const { url } = await apiClient.post(`${API}/images`, form);
      onChange(url);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{label}</Typography>
      <Stack direction="row" spacing={2} alignItems="center">
        <Box
          sx={{
            width: 96,
            height: 64,
            flexShrink: 0,
            borderRadius: 1,
            border: 1,
            borderColor: 'divider',
            bgcolor: 'grey.50',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          {value ? (
            <img src={value} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          ) : (
            <Typography variant="caption" color="text.secondary">None</Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button size="small" variant="outlined" disabled={disabled || uploading} onClick={() => inputRef.current?.click()}>
            {uploading ? <CircularProgress size={16} /> : value ? 'Replace' : 'Upload'}
          </Button>
          {value && (
            <Button size="small" color="inherit" disabled={disabled} onClick={() => onChange('')}>
              Remove
            </Button>
          )}
        </Stack>
        <input ref={inputRef} type="file" accept="image/*" hidden onChange={upload} />
      </Stack>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>{help}</Typography>
      {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function RecapEditor({ recap, audience, unlocked, onChanged, onDeleted }) {
  const editable = recap.status === 'DRAFT' || recap.status === 'SCHEDULED';
  const [form, setForm] = useState(() => pickFields(recap));
  const [saveState, setSaveState] = useState('saved'); // saved | dirty | saving | error
  const [saveError, setSaveError] = useState('');
  const [preview, setPreview] = useState({ subject: '', html: '' });
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [confirmSend, setConfirmSend] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState(() => toLocalInput(nextHour()));
  const formRef = useRef(form);
  formRef.current = form;
  const savingRef = useRef(null);

  const setField = (field) => (value) => {
    setForm((current) => ({ ...current, [field]: value }));
    setSaveState('dirty');
  };

  const save = useCallback(async () => {
    if (!editable) return true;
    // One save at a time; a save started meanwhile waits and sends the latest.
    if (savingRef.current) await savingRef.current;
    const snapshot = formRef.current;
    setSaveState('saving');
    const run = apiClient
      .patch(`${API}/${recap.id}`, snapshot)
      .then((updated) => {
        setSaveState(formRef.current === snapshot ? 'saved' : 'dirty');
        setSaveError('');
        // Updates the list entry only: the form is this editor's own state, so
        // typing done while the save was in flight is not overwritten.
        onChanged(updated);
        return true;
      })
      .catch((err) => {
        setSaveState('error');
        setSaveError(errorText(err));
        return false;
      })
      .finally(() => {
        savingRef.current = null;
      });
    savingRef.current = run;
    return run;
  }, [editable, recap.id, onChanged]);

  // Autosave. Paused while executive access is closed, so the edits stay on
  // the page and are saved once the password is entered again.
  useEffect(() => {
    if (saveState !== 'dirty' || !unlocked) return undefined;
    const timer = setTimeout(save, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [form, saveState, unlocked, save]);

  // Opening another recap unmounts this editor, which would cancel the pending
  // autosave and drop the form. Send what is unsaved on the way out instead.
  const pendingRef = useRef(false);
  pendingRef.current = editable && unlocked && (saveState === 'dirty' || saveState === 'error');
  useEffect(() => () => {
    if (!pendingRef.current) return;
    const send = () => apiClient.patch(`${API}/${recap.id}`, formRef.current).then(onChanged);
    (savingRef.current ? savingRef.current.then(send) : send()).catch(() => {});
  }, [recap.id, onChanged]);

  // Live preview, rendered by the server from the unsaved fields.
  useEffect(() => {
    if (!unlocked) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      apiClient
        .post(`${API}/preview`, form)
        .then((result) => {
          if (!cancelled) setPreview(result);
        })
        .catch(() => {});
    }, PREVIEW_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [form, unlocked]);

  // Sends and tests save first, so what goes out is what is on screen.
  // Cancelling does not: an edit a scheduled recap refuses (an emptied
  // message) must never stand in the way of taking it off the schedule.
  const act = async (label, fn, { saveFirst = true } = {}) => {
    setBusy(label);
    setNotice(null);
    try {
      if (saveFirst && !(await save())) return;
      await fn();
    } catch (err) {
      setNotice({ severity: 'error', text: errorText(err) });
    } finally {
      setBusy('');
    }
  };

  const sendTest = () =>
    act('test', async () => {
      const { sentTo } = await apiClient.post(`${API}/${recap.id}/test`, {});
      setNotice({ severity: 'success', text: `Test sent to ${sentTo}. Only you received it.` });
    });

  const sendNow = () =>
    act('send', async () => {
      setConfirmSend(false);
      onChanged(await apiClient.post(`${API}/${recap.id}/schedule`, {}));
    });

  const schedule = () =>
    act('schedule', async () => {
      const when = new Date(scheduleAt);
      if (Number.isNaN(when.getTime())) throw new Error('Pick a date and time.');
      const updated = await apiClient.post(`${API}/${recap.id}/schedule`, { scheduledAt: when.toISOString() });
      setScheduleOpen(false);
      onChanged(updated);
      setNotice({ severity: 'success', text: `Scheduled for ${formatWhen(updated.scheduledAt)}.` });
    });

  const unschedule = () =>
    act('unschedule', async () => {
      onChanged(await apiClient.post(`${API}/${recap.id}/unschedule`, {}));
      setNotice({ severity: 'info', text: 'Schedule cancelled. It is a draft again.' });
      // An edit the schedule refused is allowed on a draft: save it now.
      setSaveState((state) => (state === 'error' ? 'dirty' : state));
    }, { saveFirst: false });

  const markFailed = () =>
    act('markFailed', async () => {
      onChanged(await apiClient.post(`${API}/${recap.id}/mark-failed`, {}));
    }, { saveFirst: false });

  const remove = () =>
    act('delete', async () => {
      await apiClient.delete(`${API}/${recap.id}`);
      setConfirmDelete(false);
      onDeleted(recap.id);
    });

  const saveLabel = {
    saved: 'All changes saved',
    dirty: unlocked ? 'Saving soon…' : 'Not saved: enter the executive password to save',
    saving: 'Saving…',
    error: `Not saved: ${saveError}`,
  }[saveState];

  const members = audience?.count;
  const disabled = !unlocked || Boolean(busy);

  return (
    <Stack spacing={2}>
      {recap.status === 'SCHEDULED' && (
        <Alert
          severity="info"
          action={<Button color="inherit" size="small" disabled={disabled} onClick={unschedule}>Cancel schedule</Button>}
        >
          Scheduled for <strong>{formatWhen(recap.scheduledAt)}</strong>. Edits made before then go out with it.
        </Alert>
      )}
      {recap.status === 'SENDING' && !recap.interrupted && (
        <Alert severity="warning" icon={<CircularProgress size={18} />}>
          Sending to every member now. You can leave this page; it keeps going.
        </Alert>
      )}
      {recap.interrupted && (
        <Alert
          severity="error"
          action={<Button color="inherit" size="small" disabled={disabled} onClick={markFailed}>Mark as failed</Button>}
        >
          This send stopped partway and will not restart on its own, so nobody gets it twice.
          Master Communications → Logs shows who received it.
        </Alert>
      )}
      {recap.status === 'SENT' && (
        <Alert severity={recap.failedCount ? 'warning' : 'success'}>
          Sent {formatWhen(recap.sentAt)} to {recap.sentCount} {recap.sentCount === 1 ? 'person' : 'people'}
          {recap.failedCount ? `; ${recap.failedCount} could not be delivered` : ''}.
        </Alert>
      )}
      {recap.status === 'FAILED' && !recap.interrupted && (
        <Alert severity="error">This recap was not sent. Start a new recap to try again.</Alert>
      )}
      {notice && <Alert severity={notice.severity} onClose={() => setNotice(null)}>{notice.text}</Alert>}

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) minmax(0, 1fr)' } }}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={2}>
            <TextField
              label="Subject"
              value={form.subject}
              onChange={(e) => setField('subject')(e.target.value)}
              disabled={!editable}
              fullWidth
              size="small"
            />
            <TextField
              label="Banner title"
              value={form.title}
              onChange={(e) => setField('title')(e.target.value)}
              disabled={!editable}
              fullWidth
              size="small"
              helperText="The white text on the blue bar, e.g. RECAP: FALL WEEK 4"
            />
            <TextField
              label="Message"
              value={form.body}
              onChange={(e) => setField('body')(e.target.value)}
              disabled={!editable}
              fullWidth
              multiline
              minRows={16}
              helperText="**bold**, numbered lists with 1. 2. 3., and pasted links work. {{firstName}} becomes each member's first name."
              InputProps={{ sx: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 14 } }}
            />
            <ImageField
              label="Logo"
              help="Shown above the banner. Carries over to next week's recap."
              value={form.headerImageUrl}
              onChange={setField('headerImageUrl')}
              disabled={!editable || !unlocked}
            />
            <ImageField
              label="Photo"
              help="Shown at the bottom. Carries over to next week's recap."
              value={form.photoUrl}
              onChange={setField('photoUrl')}
              disabled={!editable || !unlocked}
            />
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2, display: 'flex', flexDirection: 'column', minHeight: 480 }}>
          <Typography variant="body2" color="text.secondary">
            From <strong>{audience?.fromName || 'UConsulting Executive Team'}</strong> · Replies to {audience?.replyTo || 'uconsultingla@gmail.com'}
          </Typography>
          <Typography variant="body2" sx={{ mb: 1 }}>
            Subject: <strong>{preview.subject || form.subject}</strong>
          </Typography>
          <Box
            component="iframe"
            title="Email preview"
            srcDoc={preview.html}
            sandbox=""
            sx={{ flex: 1, width: '100%', minHeight: 560, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: '#f2f2f2' }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
            Preview uses your name for {'{{firstName}}'}.
          </Typography>
        </Paper>
      </Box>

      {editable && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
            <Typography variant="body2" color={saveState === 'error' ? 'error' : 'text.secondary'} sx={{ flex: 1 }}>
              {saveLabel}
            </Typography>
            {recap.status === 'DRAFT' && (
              <Tooltip title="Delete draft">
                <span>
                  <IconButton disabled={disabled} onClick={() => setConfirmDelete(true)} aria-label="Delete draft">
                    <DeleteIcon />
                  </IconButton>
                </span>
              </Tooltip>
            )}
            <Button variant="outlined" disabled={disabled} onClick={sendTest}>
              {busy === 'test' ? <CircularProgress size={18} /> : 'Send test to me'}
            </Button>
            <Button variant="outlined" startIcon={<ScheduleIcon />} disabled={disabled} onClick={() => setScheduleOpen(true)}>
              {recap.status === 'SCHEDULED' ? 'Reschedule' : 'Schedule'}
            </Button>
            <Button variant="contained" startIcon={<SendIcon />} disabled={disabled} onClick={() => setConfirmSend(true)}>
              Send now
            </Button>
          </Stack>
        </Paper>
      )}

      <Dialog open={confirmSend} onClose={() => setConfirmSend(false)}>
        <DialogTitle>Send this recap now?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            It goes to {members != null ? <strong>{members} members and admins</strong> : 'every active member and admin'} from
            UConsulting Executive Team. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmSend(false)}>Cancel</Button>
          <Button variant="contained" onClick={sendNow} disabled={Boolean(busy)}>
            {busy === 'send' ? <CircularProgress size={18} /> : 'Send'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={scheduleOpen} onClose={() => setScheduleOpen(false)}>
        <DialogTitle>Schedule this recap</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            It goes to {members != null ? `${members} members and admins` : 'every active member and admin'} at this time
            (your computer's time zone). You can keep editing until then.
          </DialogContentText>
          <TextField
            type="datetime-local"
            label="Send at"
            value={scheduleAt}
            onChange={(e) => setScheduleAt(e.target.value)}
            fullWidth
            InputLabelProps={{ shrink: true }}
            inputProps={{ min: toLocalInput(new Date()) }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setScheduleOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={schedule} disabled={Boolean(busy) || !scheduleAt}>
            {busy === 'schedule' ? <CircularProgress size={18} /> : 'Schedule'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <DialogTitle>Delete this draft?</DialogTitle>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={remove} disabled={Boolean(busy)}>Delete</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function GmRecapsContent() {
  const { unlocked, version, openUnlockDialog } = useExecUnlock();
  const [recaps, setRecaps] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [audience, setAudience] = useState(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const rows = await apiClient.get(API);
      setRecaps(rows);
      setError('');
      setSelectedId((current) => (current && rows.some((r) => r.id === current) ? current : rows[0]?.id ?? null));
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    if (!unlocked) return;
    load();
    apiClient.get(`${API}/audience`).then(setAudience).catch(() => {});
  }, [unlocked, version, load]);

  // While anything is waiting to go or going, follow it.
  const active = recaps?.some((r) => r.status === 'SCHEDULED' || r.status === 'SENDING');
  useEffect(() => {
    if (!unlocked || !active) return undefined;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [unlocked, active, load]);

  const onChanged = useCallback((updated) => {
    setRecaps((rows) => rows?.map((r) => (r.id === updated.id ? updated : r)) ?? rows);
  }, []);

  const onDeleted = useCallback((id) => {
    setRecaps((rows) => {
      const next = rows.filter((r) => r.id !== id);
      setSelectedId(next[0]?.id ?? null);
      return next;
    });
  }, []);

  const create = async () => {
    setCreating(true);
    try {
      const recap = await apiClient.post(API, {});
      setRecaps((rows) => [recap, ...(rows || [])]);
      setSelectedId(recap.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setCreating(false);
    }
  };

  const selected = recaps?.find((r) => r.id === selectedId) ?? null;

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <Typography variant="h4" sx={{ fontWeight: 600 }}>GM Recaps</Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        The weekly general meeting recap, sent to every active member as UConsulting Executive Team.
      </Typography>

      {!unlocked && (
        <Alert
          severity="info"
          icon={<LockClosedIcon style={{ width: 20, height: 20 }} />}
          action={<Button color="inherit" size="small" onClick={openUnlockDialog}>Enter executive password</Button>}
          sx={{ mb: 2 }}
        >
          {selected
            ? 'Executive access has closed. Enter the password to keep saving; your edits are still here.'
            : 'GM recaps are for the executive committee. Enter the executive password to write or send one.'}
        </Alert>
      )}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {recaps && (
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '260px minmax(0, 1fr)' }, alignItems: 'start' }}>
          <Paper variant="outlined">
            <Box sx={{ p: 1.5 }}>
              <Button fullWidth variant="contained" startIcon={<AddIcon />} onClick={create} disabled={!unlocked || creating}>
                New recap
              </Button>
            </Box>
            <List dense disablePadding>
              {recaps.map((recap) => (
                <ListItemButton key={recap.id} selected={recap.id === selectedId} onClick={() => setSelectedId(recap.id)}>
                  <ListItemText
                    primary={
                      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                        <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>{recap.title || 'Untitled'}</Typography>
                        <StatusChip recap={recap} />
                      </Stack>
                    }
                    secondary={recapSummary(recap)}
                  />
                </ListItemButton>
              ))}
              {!recaps.length && (
                <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                  No recaps yet. Start one from the template.
                </Typography>
              )}
            </List>
          </Paper>

          {selected ? (
            <RecapEditor
              key={selected.id}
              recap={selected}
              audience={audience}
              unlocked={unlocked}
              onChanged={onChanged}
              onDeleted={onDeleted}
            />
          ) : (
            <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
              <Typography color="text.secondary">Start a new recap to fill in this week's updates.</Typography>
            </Paper>
          )}
        </Box>
      )}
      {unlocked && !recaps && !error && <CircularProgress />}
    </Box>
  );
}

export default function GmRecaps() {
  return (
    <AccessControl allowedRoles={['ADMIN']}>
      <GmRecapsContent />
    </AccessControl>
  );
}
