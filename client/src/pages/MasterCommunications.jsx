import React, { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Tabs,
  Tab,
  TextField,
  Button,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Grid,
  Chip,
  Stack,
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
  IconButton,
  List,
  ListItem,
  ListItemText,
  Divider,
} from '@mui/material';
import {
  Send as SendIcon,
  Save as SaveIcon,
  ContentCopy as ContentCopyIcon,
  Preview as PreviewIcon,
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
];

const APPLICATION_STATUSES = ['SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'WAITLISTED'];
const INTERVIEW_ROUNDS = ['COFFEE_CHAT', 'ROUND_ONE', 'FINAL_ROUND'];
const DECISIONS = ['yes', 'no', 'maybe'];
const USER_ROLES = ['USER', 'MEMBER', 'ADMIN'];

function TabPanel({ children, value, index }) {
  if (value !== index) return null;
  return <Box sx={{ mt: 2 }}>{children}</Box>;
}

const MasterCommunications = () => {
  const { user } = useAuth();
  const [tab, setTab] = useState(0);
  const [cycles, setCycles] = useState([]);
  const [events, setEvents] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [logs, setLogs] = useState([]);
  const [selectedCycle, setSelectedCycle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const channel = CHANNELS[tab].key;

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

  const [preview, setPreview] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchCycles();
    fetchEvents();
  }, []);

  useEffect(() => {
    if (selectedCycle) {
      fetchTemplates(selectedCycle);
      fetchLogs(selectedCycle);
    }
  }, [selectedCycle]);

  const fetchCycles = async () => {
    try {
      const data = await apiClient.get('/admin/cycles');
      setCycles(data || []);
      if (data?.length > 0 && !selectedCycle) {
        setSelectedCycle(data.find((c) => c.isActive)?.id || data[0].id);
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

  const clearMessages = () => {
    setError('');
    setSuccess('');
  };

  const buildFilters = () => {
    const filters = {};
    if (selectedCycle) filters.cycleId = selectedCycle;

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
        cycleId: selectedCycle,
        templateId: selectedTemplate || undefined,
      });
      setSuccess(`Sent ${result.sent} of ${result.total} ${channel} messages`);
      setConfirmOpen(false);
      setPreview(null);
      fetchLogs(selectedCycle);
    } catch (e) {
      setError(e.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  const handleSaveTemplate = async () => {
    clearMessages();
    if (!templateName || !body) {
      setError('Template name and body are required');
      return;
    }
    try {
      await apiClient.post('/master-communications/templates', {
        name: templateName,
        subject: channel === 'email' ? subject : '',
        body,
        channel: templateChannel,
        cycleId: selectedCycle,
      });
      setSuccess('Template saved');
      setTemplateName('');
      fetchTemplates(selectedCycle);
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

  const renderFilters = () => (
    <Grid container spacing={2} sx={{ mt: 1 }}>
      <Grid item xs={12} md={4}>
        <FormControl fullWidth>
          <InputLabel>Audience</InputLabel>
          <Select value={audience} label="Audience" onChange={(e) => setAudience(e.target.value)}>
            {audienceOptions.map((o) => (
              <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
            ))}
          </Select>
        </FormControl>
      </Grid>

      {audience === 'applicants' && (
        <>
          <Grid item xs={12} md={4}>
            <FormControl fullWidth>
              <InputLabel>Application Status</InputLabel>
              <Select value={applicationStatus} label="Application Status" onChange={(e) => setApplicationStatus(e.target.value)}>
                <MenuItem value=""><em>Any</em></MenuItem>
                {APPLICATION_STATUSES.map((s) => (
                  <MenuItem key={s} value={s}>{s}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>

          <Grid item xs={12} md={4}>
            <FormControl fullWidth>
              <InputLabel>RSVP to Event</InputLabel>
              <Select value={eventRsvpId} label="RSVP to Event" onChange={(e) => setEventRsvpId(e.target.value)}>
                <MenuItem value=""><em>Any</em></MenuItem>
                {events.map((e) => (
                  <MenuItem key={e.id} value={e.id}>{e.eventName}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>

          <Grid item xs={12} md={4}>
            <FormControl fullWidth>
              <InputLabel>Attended Event</InputLabel>
              <Select value={eventAttendedId} label="Attended Event" onChange={(e) => setEventAttendedId(e.target.value)}>
                <MenuItem value=""><em>Any</em></MenuItem>
                {events.map((e) => (
                  <MenuItem key={e.id} value={e.id}>{e.eventName}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>

          <Grid item xs={12} md={4}>
            <FormControl fullWidth>
              <InputLabel>Interview Round</InputLabel>
              <Select value={interviewRound} label="Interview Round" onChange={(e) => setInterviewRound(e.target.value)}>
                <MenuItem value=""><em>Any</em></MenuItem>
                {INTERVIEW_ROUNDS.map((r) => (
                  <MenuItem key={r} value={r}>{r.replace(/_/g, ' ')}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>

          <Grid item xs={12} md={4}>
            <FormControl fullWidth disabled={!interviewRound}>
              <InputLabel>Decision</InputLabel>
              <Select value={decision} label="Decision" onChange={(e) => setDecision(e.target.value)}>
                <MenuItem value=""><em>Any</em></MenuItem>
                {DECISIONS.map((d) => (
                  <MenuItem key={d} value={d}>{d}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
        </>
      )}

      {(audience === 'members' || audience === 'users') && (
        <Grid item xs={12} md={8}>
          <FormControl fullWidth>
            <InputLabel>Roles</InputLabel>
            <Select multiple value={roles} onChange={(e) => setRoles(typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value)}>
              {USER_ROLES.map((r) => (
                <MenuItem key={r} value={r}>{r}</MenuItem>
              ))}
            </Select>
          </FormControl>
        </Grid>
      )}
    </Grid>
  );

  const renderMessageComposer = () => (
    <Stack spacing={2} sx={{ mt: 2 }}>
      {channel !== 'imessage' && (
        <FormControl fullWidth>
          <InputLabel>Use Template</InputLabel>
          <Select value={selectedTemplate} label="Use Template" onChange={(e) => onSelectTemplate(e.target.value)}>
            <MenuItem value=""><em>None / Custom</em></MenuItem>
            {channelTemplates.map((t) => (
              <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>
            ))}
          </Select>
        </FormControl>
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
          label="Message"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          fullWidth
          multiline
          rows={8}
          required
        />
      )}
    </Stack>
  );

  const renderSendTab = () => (
    <Box>
      {renderFilters()}
      {renderMessageComposer()}

      <Box sx={{ mt: 2, display: 'flex', gap: 2 }}>
        <Button
          variant="outlined"
          startIcon={<PreviewIcon />}
          onClick={handlePreview}
          disabled={loading}
        >
          {loading ? <CircularProgress size={20} /> : 'Preview Recipients'}
        </Button>

        {channel !== 'imessage' && (
          <Button
            variant="contained"
            startIcon={<SendIcon />}
            onClick={handleOpenSend}
            disabled={!body || (channel === 'email' && !subject)}
          >
            Send {channel === 'email' ? 'Email' : 'Slack'}
          </Button>
        )}

        {channel === 'imessage' && (
          <Button
            variant="contained"
            startIcon={<PreviewIcon />}
            onClick={handlePacket}
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
                    {preview.recipients.map((r) => (
                      <ListItem key={r.phoneNumber} divider>
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
          {channel === 'email' && (
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
          <FormControl fullWidth>
            <InputLabel>Template Channel</InputLabel>
            <Select value={templateChannel} label="Template Channel" onChange={(e) => setTemplateChannel(e.target.value)}>
              <MenuItem value="email">Email</MenuItem>
              <MenuItem value="slack">Slack</MenuItem>
              <MenuItem value="imessage">iMessage</MenuItem>
            </Select>
          </FormControl>
          <Button variant="contained" startIcon={<SaveIcon />} onClick={handleSaveTemplate}>
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

  return (
    <AccessControl allowedRoles={['ADMIN']}>
      <Box sx={{ p: 3 }}>
        <Typography variant="h4" gutterBottom fontWeight={600}>
          Master Communications
        </Typography>

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {success && <Alert severity="success" sx={{ mb: 2 }}>{success}</Alert>}

        <Paper sx={{ p: 2, mb: 2 }}>
          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel>Recruiting Cycle</InputLabel>
            <Select value={selectedCycle} label="Recruiting Cycle" onChange={(e) => setSelectedCycle(e.target.value)}>
              {cycles.map((c) => (
                <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>
              ))}
            </Select>
          </FormControl>

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
