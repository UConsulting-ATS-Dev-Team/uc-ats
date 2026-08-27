import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Tabs,
  Tab,
  TextField,
  Button,
  IconButton,
  Tooltip,
  MenuItem,
  Grid,
  Stack,
  Chip,
  Alert,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  List,
  ListItem,
  ListItemText,
} from '@mui/material';
import {
  Send as SendIcon,
  Save as SaveIcon,
  ContentCopy as ContentCopyIcon,
  Preview as PreviewIcon,
  Delete as DeleteIcon,
  FormatBold as FormatBoldIcon,
  FormatItalic as FormatItalicIcon,
  FormatListBulleted as FormatListBulletedIcon,
  Link as LinkIcon,
} from '@mui/icons-material';
import { useAuth } from '../context/AuthContext';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';

const CHANNELS = [
  { key: 'email', label: 'Email' },
  { key: 'slack', label: 'Slack' },
  { key: 'imessage', label: 'iMessage' },
  { key: 'templates', label: 'Templates' },
  { key: 'logs', label: 'Logs' },
  { key: 'scheduled', label: 'Scheduled' },
];

const APPLICATION_STATUSES = ['SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'WAITLISTED'];
const INTERVIEW_ROUNDS = ['COFFEE_CHAT', 'ROUND_ONE', 'FINAL_ROUND'];
const DECISIONS = ['yes', 'no', 'maybe'];
const USER_ROLES = ['USER', 'MEMBER', 'ADMIN'];
const TEMPLATE_CHANNELS = ['email', 'slack', 'imessage'];

const MERGE_FIELDS = {
  applicants: ['firstName', 'lastName', 'fullName', 'email', 'phoneNumber'],
  members: ['firstName', 'lastName', 'fullName', 'email', 'role'],
  admins: ['firstName', 'lastName', 'fullName', 'email', 'role'],
};

const SELECT_PROPS = {
  MenuProps: {
    PaperProps: { style: { maxHeight: 300 } },
  },
};

function TabPanel({ children, value, index }) {
  if (value !== index) return null;
  return <Box sx={{ mt: 2 }}>{children}</Box>;
}

const MasterCommunications = () => {
  const { user } = useAuth();
  const messageRef = useRef(null);
  const [tab, setTab] = useState(0);
  const [cycles, setCycles] = useState([]);
  const [events, setEvents] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [logs, setLogs] = useState([]);
  const [scheduledMessages, setScheduledMessages] = useState([]);
  const [selectedCycles, setSelectedCycles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const channel = CHANNELS[tab].key;
  const primaryCycle = selectedCycles[0] || '';

  const [audience, setAudience] = useState('applicants');
  const [applicationStatus, setApplicationStatus] = useState('');
  const [interviewRound, setInterviewRound] = useState('');
  const [decision, setDecision] = useState('');
  const [eventRsvpId, setEventRsvpId] = useState('');
  const [eventAttendedId, setEventAttendedId] = useState('');
  const [roles, setRoles] = useState(['MEMBER']);

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [templateChannel, setTemplateChannel] = useState('email');
  const [scheduledAt, setScheduledAt] = useState('');

  const [preview, setPreview] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState(false);

  const filteredEvents = useMemo(
    () => events.filter((e) => selectedCycles.length === 0 || selectedCycles.includes(e.cycleId)),
    [events, selectedCycles]
  );

  useEffect(() => {
    fetchCycles();
    fetchEvents();
  }, []);

  useEffect(() => {
    if (primaryCycle) {
      fetchTemplates(primaryCycle);
      fetchLogs(primaryCycle);
    }
  }, [primaryCycle]);

  useEffect(() => {
    if (tab === 5 && primaryCycle) {
      fetchScheduled(primaryCycle);
    }
  }, [tab, primaryCycle]);

  const fetchCycles = async () => {
    try {
      const data = await apiClient.get('/admin/cycles');
      setCycles(data || []);
      if (data?.length > 0 && selectedCycles.length === 0) {
        const active = data.find((c) => c.isActive);
        setSelectedCycles(active ? [active.id] : [data[0].id]);
      }
    } catch (e) {
      setError(e.message || 'Failed to load cycles');
    }
  };

  const fetchEvents = async () => {
    try {
      const data = await apiClient.get('/admin/events');
      setEvents(data || []);
    } catch (e) {
      setError(e.message || 'Failed to load events');
    }
  };

  const fetchTemplates = async (cycleId) => {
    try {
      const data = await apiClient.get(`/master-communications/templates?cycleId=${cycleId}`);
      setTemplates(data || []);
    } catch (e) {
      setError(e.message || 'Failed to load templates');
    }
  };

  const fetchLogs = async (cycleId) => {
    try {
      const data = await apiClient.get(`/master-communications/logs?cycleId=${cycleId}`);
      setLogs(data || []);
    } catch (e) {
      setError(e.message || 'Failed to load logs');
    }
  };

  const fetchScheduled = async (cycleId) => {
    try {
      const data = await apiClient.get(`/master-communications/schedule?cycleId=${cycleId}`);
      setScheduledMessages(data || []);
    } catch (e) {
      setError(e.message || 'Failed to load scheduled messages');
    }
  };

  const clearMessages = () => {
    setError('');
    setSuccess('');
  };

  const buildFilters = () => {
    const filters = {};
    if (selectedCycles.length > 0) filters.cycleIds = selectedCycles;

    if (audience === 'applicants') {
      if (applicationStatus) filters.applicationStatus = applicationStatus;
      if (interviewRound && decision) {
        filters.interviewRound = interviewRound;
        filters.decision = decision;
      }
      if (eventRsvpId) filters.eventRsvpId = eventRsvpId;
      if (eventAttendedId) filters.eventAttendedId = eventAttendedId;
    }

    if (audience === 'members' || audience === 'users') {
      if (roles.length > 0) filters.roles = roles;
    }

    return filters;
  };

  const handlePreview = async () => {
    clearMessages();
    setLoading(true);
    setPreview(null);
    try {
      const result = await apiClient.post('/master-communications/preview', {
        audience,
        filters: buildFilters(),
      });
      setPreview(result);
    } catch (e) {
      setError(e.message || 'Failed to load preview');
    } finally {
      setLoading(false);
    }
  };

  const handlePacket = async () => {
    clearMessages();
    setLoading(true);
    setPreview(null);
    try {
      const result = await apiClient.post('/master-communications/packet', {
        filters: buildFilters(),
      });
      setPreview(result);
    } catch (e) {
      setError(e.message || 'Failed to build iMessage packet');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenSend = async () => {
    clearMessages();
    setSending(false);
    await handlePreview();
    setConfirmOpen(true);
  };

  const handleSend = async () => {
    setSending(true);
    try {
      const result = await apiClient.post('/master-communications/send', {
        audience,
        channel,
        filters: buildFilters(),
        subject,
        body,
        cycleId: primaryCycle,
        templateId: selectedTemplate || undefined,
      });
      setSuccess(`Sent ${result.sent} of ${result.total} ${channel} messages`);
      setConfirmOpen(false);
      setPreview(null);
      setScheduledAt('');
      fetchLogs(primaryCycle);
    } catch (e) {
      setError(e.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  const handleSendTest = async () => {
    clearMessages();
    setTesting(true);
    try {
      const result = await apiClient.post('/master-communications/test', {
        audience,
        filters: buildFilters(),
        subject,
        body,
      });
      setSuccess(
        result.usedFallback
          ? `Test email sent to ${result.sentTo}. No recipients matched the filters, so merge fields used your own account.`
          : `Test email sent to ${result.sentTo}, using ${result.mergeSource.fullName || result.mergeSource.email} for merge fields.`
      );
    } catch (e) {
      setError(e.message || 'Failed to send test email');
    } finally {
      setTesting(false);
    }
  };

  const handleSchedule = async () => {
    clearMessages();
    if (!scheduledAt) {
      setError('Pick a date and time to schedule');
      return;
    }
    setScheduling(true);
    try {
      const payload = {
        channel,
        audience,
        filters: buildFilters(),
        subject,
        body,
        cycleId: primaryCycle,
        templateId: selectedTemplate || undefined,
        scheduledAt: new Date(scheduledAt).toISOString(),
      };
      await apiClient.post('/master-communications/schedule', payload);
      setSuccess(`Message scheduled for ${new Date(scheduledAt).toLocaleString()}`);
      setScheduledAt('');
      if (tab === 5) fetchScheduled(primaryCycle);
    } catch (e) {
      setError(e.message || 'Failed to schedule');
    } finally {
      setScheduling(false);
    }
  };

  const handleCancelSchedule = async (id) => {
    clearMessages();
    try {
      await apiClient.delete(`/master-communications/schedule/${id}`);
      setSuccess('Scheduled message cancelled');
      fetchScheduled(primaryCycle);
    } catch (e) {
      setError(e.message || 'Failed to cancel');
    }
  };

  const insertMergeField = (field, target = 'body') => {
    const token = `{{${field}}}`;
    if (target === 'subject') {
      setSubject((prev) => (prev ? `${prev} ${token}` : token));
    } else {
      setBody((prev) => (prev ? `${prev} ${token}` : token));
    }
  };

  const insertMarkdown = (prefix, suffix = '') => {
    const el = messageRef.current;
    if (!el) return;
    const start = el.selectionStart || 0;
    const end = el.selectionEnd || 0;
    const selected = body.substring(start, end) || 'text';
    const before = body.substring(0, start);
    const after = body.substring(end);
    const replacement = `${prefix}${selected}${suffix}`;
    const newBody = before + replacement + after;
    setBody(newBody);
    setTimeout(() => {
      el.focus();
      const newStart = start + prefix.length;
      const newEnd = newStart + selected.length;
      el.setSelectionRange(newStart, newEnd);
    }, 0);
  };

  const handleSaveTemplate = async () => {
    clearMessages();
    if (!templateName || !body || !primaryCycle) {
      setError('Template name, body, and a selected cycle are required');
      return;
    }
    try {
      await apiClient.post('/master-communications/templates', {
        name: templateName,
        subject: templateChannel === 'email' ? subject : '',
        body,
        channel: templateChannel,
        cycleId: primaryCycle,
      });
      setSuccess('Template saved');
      setTemplateName('');
      fetchTemplates(primaryCycle);
    } catch (e) {
      setError(e.message || 'Failed to save template');
    }
  };

  const handleCopyPacket = () => {
    if (!preview?.recipients?.length) return;
    const text = preview.recipients.map((r) => r.label).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const onSelectTemplate = (id) => {
    setSelectedTemplate(id);
    const t = templates.find((x) => x.id === id);
    if (t) {
      setSubject(t.subject || '');
      setBody(t.body || '');
    }
  };

  const channelTemplates = useMemo(
    () => templates.filter((t) => t.channel === channel),
    [templates, channel]
  );

  const audienceOptions = useMemo(() => {
    if (channel === 'imessage') return [{ value: 'applicants', label: 'Applicants' }];
    if (channel === 'slack') return [
      { value: 'members', label: 'Members' },
      { value: 'admins', label: 'Admins' },
    ];
    return [
      { value: 'applicants', label: 'Applicants' },
      { value: 'members', label: 'Members' },
      { value: 'admins', label: 'Admins' },
    ];
  }, [channel]);

  useEffect(() => {
    const first = audienceOptions[0].value;
    if (!audienceOptions.find((o) => o.value === audience)) {
      setAudience(first);
    }
  }, [audienceOptions]);

  const cycleMenuItems = useMemo(
    () => cycles.map((c) => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>),
    [cycles]
  );

  const renderFilters = () => (
    <Grid container spacing={2} sx={{ mt: 1 }}>
      <Grid item xs={12} sm={6} md={4}>
        <TextField
          select
          fullWidth
          label="Audience"
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
        >
          {audienceOptions.map((o) => (
            <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
          ))}
        </TextField>
      </Grid>

      <Grid item xs={12} sm={6} md={4}>
        <TextField
          select
          fullWidth
          label="Recruiting Cycles"
          value={selectedCycles}
          onChange={(e) => setSelectedCycles(e.target.value)}
          SelectProps={{ multiple: true, ...SELECT_PROPS }}
          helperText={selectedCycles.length > 1 ? 'Recipients are de-duplicated across cycles.' : ''}
        >
          {cycleMenuItems}
        </TextField>
      </Grid>

      {audience === 'applicants' && (
        <>
          <Grid item xs={12} sm={6} md={4}>
            <TextField
              select
              fullWidth
              label="Application Status"
              value={applicationStatus}
              onChange={(e) => setApplicationStatus(e.target.value)}
            >
              <MenuItem value=""><em>Any</em></MenuItem>
              {APPLICATION_STATUSES.map((s) => (
                <MenuItem key={s} value={s}>{s.replace(/_/g, ' ')}</MenuItem>
              ))}
            </TextField>
          </Grid>

          <Grid item xs={12} sm={6} md={4}>
            <TextField
              select
              fullWidth
              label="RSVP to Event"
              value={eventRsvpId}
              onChange={(e) => setEventRsvpId(e.target.value)}
            >
              <MenuItem value=""><em>Any</em></MenuItem>
              {filteredEvents.map((e) => (
                <MenuItem key={e.id} value={e.id}>{e.eventName}</MenuItem>
              ))}
            </TextField>
          </Grid>

          <Grid item xs={12} sm={6} md={4}>
            <TextField
              select
              fullWidth
              label="Attended Event"
              value={eventAttendedId}
              onChange={(e) => setEventAttendedId(e.target.value)}
            >
              <MenuItem value=""><em>Any</em></MenuItem>
              {filteredEvents.map((e) => (
                <MenuItem key={e.id} value={e.id}>{e.eventName}</MenuItem>
              ))}
            </TextField>
          </Grid>

          <Grid item xs={12} sm={6} md={4}>
            <TextField
              select
              fullWidth
              label="Interview Round"
              value={interviewRound}
              onChange={(e) => {
                setInterviewRound(e.target.value);
                setDecision('');
              }}
            >
              <MenuItem value=""><em>Any</em></MenuItem>
              {INTERVIEW_ROUNDS.map((r) => (
                <MenuItem key={r} value={r}>{r.replace(/_/g, ' ')}</MenuItem>
              ))}
            </TextField>
          </Grid>

          <Grid item xs={12} sm={6} md={4}>
            <TextField
              select
              fullWidth
              label="Decision"
              value={decision}
              onChange={(e) => setDecision(e.target.value)}
              disabled={!interviewRound}
            >
              <MenuItem value=""><em>Any</em></MenuItem>
              {DECISIONS.map((d) => (
                <MenuItem key={d} value={d}>{d}</MenuItem>
              ))}
            </TextField>
          </Grid>
        </>
      )}

      {(audience === 'members' || audience === 'users') && (
        <Grid item xs={12} sm={6} md={4}>
          <TextField
            select
            fullWidth
            label="Roles"
            value={roles}
            onChange={(e) => setRoles(e.target.value)}
            SelectProps={{ multiple: true, renderValue: (selected) => selected.join(', ') }}
          >
            {USER_ROLES.map((r) => (
              <MenuItem key={r} value={r}>{r}</MenuItem>
            ))}
          </TextField>
        </Grid>
      )}
    </Grid>
  );

  const renderMessageComposer = () => (
    <Stack spacing={2} sx={{ mt: 2 }}>
      {channel !== 'imessage' && (
        <TextField
          select
          fullWidth
          label="Use Template"
          value={selectedTemplate}
          onChange={(e) => onSelectTemplate(e.target.value)}
        >
          <MenuItem value=""><em>None / Custom</em></MenuItem>
          {channelTemplates.map((t) => (
            <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>
          ))}
        </TextField>
      )}

      {channel === 'email' && (
        <TextField
          label="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          fullWidth
          required
        />
      )}

      {channel !== 'imessage' && (
        <TextField
          inputRef={messageRef}
          label="Message (Markdown supported)"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          fullWidth
          multiline
          rows={8}
          required
        />
      )}

      {channel !== 'imessage' && (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Tooltip title="Bold">
            <IconButton size="small" onClick={() => insertMarkdown('**', '**')}>
              <FormatBoldIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Italic">
            <IconButton size="small" onClick={() => insertMarkdown('*', '*')}>
              <FormatItalicIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Bulleted list">
            <IconButton size="small" onClick={() => insertMarkdown('- ', '')}>
              <FormatListBulletedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Link">
            <IconButton size="small" onClick={() => insertMarkdown('[', '](url)')}>
              <LinkIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Typography variant="caption" color="text.secondary">
            Use **bold**, *italic*, - lists, [links](url). Line breaks are preserved.
          </Typography>
        </Stack>
      )}

      {channel !== 'imessage' && (
        <Box>
          <Typography variant="caption" color="text.secondary" display="block" gutterBottom>
            Click a field to insert it into the message:
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap">
            {(MERGE_FIELDS[audience] || []).map((field) => (
              <Chip
                key={field}
                label={`{{${field}}}`}
                size="small"
                onClick={() => insertMergeField(field, 'body')}
                sx={{ cursor: 'pointer' }}
              />
            ))}
          </Stack>
        </Box>
      )}

      {channel !== 'imessage' && (
        <TextField
          label="Schedule for later (optional)"
          type="datetime-local"
          value={scheduledAt}
          onChange={(e) => setScheduledAt(e.target.value)}
          fullWidth
          InputLabelProps={{ shrink: true }}
          inputProps={{ step: 60 }}
        />
      )}
    </Stack>
  );

  const renderSendTab = () => (
    <Box>
      {renderFilters()}
      {renderMessageComposer()}

      <Box sx={{ mt: 2, display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <Button
          variant="outlined"
          startIcon={<PreviewIcon />}
          onClick={handlePreview}
          disabled={loading || selectedCycles.length === 0}
        >
          {loading ? <CircularProgress size={20} /> : 'Preview Recipients'}
        </Button>

        {channel !== 'imessage' && (
          <>
            <Button
              variant="contained"
              startIcon={<SendIcon />}
              onClick={handleOpenSend}
              disabled={!body || (channel === 'email' && !subject) || selectedCycles.length === 0}
            >
              Send {channel === 'email' ? 'Email' : 'Slack'}
            </Button>
            {channel === 'email' && (
              <Button
                variant="outlined"
                startIcon={testing ? <CircularProgress size={20} /> : <SendIcon />}
                onClick={handleSendTest}
                disabled={testing || !body || !subject || selectedCycles.length === 0}
              >
                {user?.email ? `Send Test to ${user.email}` : 'Send Test to Me'}
              </Button>
            )}
            <Button
              variant="outlined"
              color="secondary"
              startIcon={scheduling ? <CircularProgress size={20} /> : <SaveIcon />}
              onClick={handleSchedule}
              disabled={!body || (channel === 'email' && !subject) || !scheduledAt || selectedCycles.length === 0}
            >
              Schedule
            </Button>
          </>
        )}

        {channel === 'imessage' && (
          <Button
            variant="contained"
            startIcon={<PreviewIcon />}
            onClick={handlePacket}
            disabled={selectedCycles.length === 0}
          >
            Generate iMessage Packet
          </Button>
        )}
      </Box>

      {preview && (
        <Paper sx={{ mt: 3, p: 2 }}>
          <Typography variant="h6" gutterBottom>
            {channel === 'imessage' ? 'iMessage GC Packet' : `Recipients: ${preview.count}`}
          </Typography>

          {preview.count === 0 ? (
            <Alert severity="warning">No recipients match the selected filters.</Alert>
          ) : (
            <>
              {channel === 'imessage' ? (
                <>
                  <Box sx={{ mb: 1 }}>
                    <Button
                      size="small"
                      startIcon={<ContentCopyIcon />}
                      onClick={handleCopyPacket}
                    >
                      {copied ? 'Copied!' : 'Copy to Clipboard'}
                    </Button>
                  </Box>
                  <List dense>
                    {preview.recipients.map((r, i) => (
                      <ListItem key={`${r.phoneNumber}-${i}`} divider>
                        <ListItemText primary={r.label} />
                      </ListItem>
                    ))}
                  </List>
                </>
              ) : (
                <>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    A sample of up to 10 matching recipients:
                  </Typography>
                  <List dense>
                    {preview.sample.map((r) => (
                      <ListItem key={r.id} divider>
                        <ListItemText primary={`${r.fullName} (${r.email})`} />
                      </ListItem>
                    ))}
                  </List>
                </>
              )}
            </>
          )}
        </Paper>
      )}
    </Box>
  );

  const renderTemplatesTab = () => (
    <Box>
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="h6" gutterBottom>Save New Template</Typography>
        <Stack spacing={2}>
          <TextField
            label="Template Name"
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            fullWidth
            required
          />
          {templateChannel === 'email' && (
            <TextField label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} fullWidth />
          )}
          <TextField
            label="Body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            fullWidth
            multiline
            rows={4}
            required
          />
          <TextField
            select
            fullWidth
            label="Template Channel"
            value={templateChannel}
            onChange={(e) => setTemplateChannel(e.target.value)}
          >
            {TEMPLATE_CHANNELS.map((c) => (
              <MenuItem key={c} value={c}>{c}</MenuItem>
            ))}
          </TextField>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={handleSaveTemplate}
            disabled={!primaryCycle}
          >
            Save {templateChannel} Template
          </Button>
        </Stack>
      </Paper>

      <Typography variant="h6" gutterBottom>Existing Templates</Typography>
      {templates.length === 0 ? (
        <Alert severity="info">No templates saved for this cycle yet.</Alert>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Channel</TableCell>
              <TableCell>Subject</TableCell>
              <TableCell>Updated</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {templates.map((t) => (
              <TableRow key={t.id}>
                <TableCell>{t.name}</TableCell>
                <TableCell>{t.channel}</TableCell>
                <TableCell>{t.subject || '-'}</TableCell>
                <TableCell>{new Date(t.updatedAt).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  );

  const renderLogsTab = () => (
    <Box>
      {logs.length === 0 ? (
        <Alert severity="info">No sends logged for this cycle yet.</Alert>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Sent At</TableCell>
              <TableCell>Channel</TableCell>
              <TableCell>Recipients</TableCell>
              <TableCell>Template</TableCell>
              <TableCell>Subject</TableCell>
              <TableCell>Sender</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {logs.map((l) => (
              <TableRow key={l.id}>
                <TableCell>{new Date(l.sentAt).toLocaleString()}</TableCell>
                <TableCell>{l.channel}</TableCell>
                <TableCell>{l.recipientCount}</TableCell>
                <TableCell>{l.template?.name || '-'}</TableCell>
                <TableCell>{l.subject || '-'}</TableCell>
                <TableCell>{l.sender?.fullName || l.sentBy}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  );

  const renderScheduledTab = () => (
    <Box>
      {scheduledMessages.length === 0 ? (
        <Alert severity="info">No scheduled messages for this cycle yet.</Alert>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Scheduled For</TableCell>
              <TableCell>Channel</TableCell>
              <TableCell>Audience</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Subject / Body</TableCell>
              <TableCell></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {scheduledMessages.map((m) => (
              <TableRow key={m.id}>
                <TableCell>{new Date(m.scheduledAt).toLocaleString()}</TableCell>
                <TableCell>{m.channel}</TableCell>
                <TableCell>{m.audience}</TableCell>
                <TableCell>{m.status}</TableCell>
                <TableCell>{m.subject ? `${m.subject} — ` : ''}{m.body.slice(0, 60)}{m.body.length > 60 ? '…' : ''}</TableCell>
                <TableCell>
                  {m.status === 'PENDING' && (
                    <Button
                      size="small"
                      color="error"
                      startIcon={<DeleteIcon />}
                      onClick={() => handleCancelSchedule(m.id)}
                    >
                      Cancel
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  );

  return (
    <AccessControl allowedRoles={['ADMIN']}>
      <Box sx={{ p: 3 }}>
        <Typography variant="h4" gutterBottom fontWeight={600}>
          Master Communications
        </Typography>

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {success && <Alert severity="success" sx={{ mb: 2 }}>{success}</Alert>}

        <Paper sx={{ p: 2, mb: 2 }}>
          <TextField
            select
            fullWidth
            label="Recruiting Cycles"
            value={selectedCycles}
            onChange={(e) => setSelectedCycles(e.target.value)}
            SelectProps={{ multiple: true, ...SELECT_PROPS }}
            helperText="Select one or more cycles. Recipients are de-duplicated across them."
            sx={{ mb: 2 }}
          >
            {cycleMenuItems}
          </TextField>

          <Tabs value={tab} onChange={(e, v) => setTab(v)}>
            {CHANNELS.map((c) => (
              <Tab key={c.key} label={c.label} />
            ))}
          </Tabs>

          <TabPanel value={tab} index={0}>{renderSendTab()}</TabPanel>
          <TabPanel value={tab} index={1}>{renderSendTab()}</TabPanel>
          <TabPanel value={tab} index={2}>{renderSendTab()}</TabPanel>
          <TabPanel value={tab} index={3}>{renderTemplatesTab()}</TabPanel>
          <TabPanel value={tab} index={4}>{renderLogsTab()}</TabPanel>
          <TabPanel value={tab} index={5}>{renderScheduledTab()}</TabPanel>
        </Paper>

        <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="sm" fullWidth>
          <DialogTitle>Confirm Send</DialogTitle>
          <DialogContent>
            <Alert severity="warning" sx={{ mb: 2 }}>
              You are about to send {channel} to {preview?.count || 0} recipients. This cannot be undone.
            </Alert>
            {preview?.sample?.length > 0 && (
              <>
                <Typography variant="subtitle2" gutterBottom>Sample recipients:</Typography>
                <List dense>
                  {preview.sample.slice(0, 5).map((r) => (
                    <ListItem key={r.id} divider>
                      <ListItemText primary={`${r.fullName} (${r.email})`} />
                    </ListItem>
                  ))}
                </List>
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button onClick={handleSend} variant="contained" disabled={sending} startIcon={<SendIcon />}>
              {sending ? <CircularProgress size={20} /> : 'Send'}
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    </AccessControl>
  );
};

export default MasterCommunications;
