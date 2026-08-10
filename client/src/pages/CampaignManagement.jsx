import React, { useEffect, useState } from 'react';
import {
  Box,
  Button,
  TextField,
  Typography,
  Paper,
  Stack,
  Tabs,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Select,
  MenuItem,
  InputLabel,
  FormControl,
  Chip,
  IconButton,
  Tooltip,
  FormControlLabel,
  Checkbox,
  Alert,
} from '@mui/material';
import { Delete as DeleteIcon, Edit as EditIcon, Send as SendIcon, Refresh as RefreshIcon, CheckCircle as CheckCircleIcon } from '@mui/icons-material';
import apiClient from '../utils/api';

function TabPanel({ children, value, index }) {
  if (value !== index) return null;
  return <Box sx={{ pt: 2 }}>{children}</Box>;
}

const DEFAULT_BODY = `<p>Dear {{name}},</p>
<p>Thanks for your interest in UConsulting.</p>
<p>Best,<br />UConsulting Recruitment Team</p>`;

const STATUS_OPTIONS = ['SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'WAITLISTED'];
const ROUND_OPTIONS = ['COFFEE_CHAT', 'ROUND_ONE', 'ROUND_TWO', 'FINAL_ROUND', 'DELIBERATIONS'];

export default function CampaignManagement() {
  const [tab, setTab] = useState(0);
  const [cycles, setCycles] = useState([]);
  const [selectedCycle, setSelectedCycle] = useState('');

  // Templates
  const [templates, setTemplates] = useState([]);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [templateForm, setTemplateForm] = useState({
    name: '', category: '', subject: '', body: DEFAULT_BODY, mergeFields: [], firstOfCycleGate: false,
  });

  // Audiences
  const [audiences, setAudiences] = useState([]);
  const [audienceOpen, setAudienceOpen] = useState(false);
  const [editingAudience, setEditingAudience] = useState(null);
  const [audienceForm, setAudienceForm] = useState({
    name: '', statuses: [], rounds: [], excludeSuppressed: true,
  });
  const [preview, setPreview] = useState(null);

  // Sends
  const [sends, setSends] = useState([]);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendForm, setSendForm] = useState({
    name: '', templateId: '', audienceId: '', scheduledAt: '',
  });
  const [sendResult, setSendResult] = useState(null);

  // Suppressions
  const [suppressions, setSuppressions] = useState([]);
  const [suppressionEmail, setSuppressionEmail] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    fetchCycles();
    fetchSuppressions();
  }, []);

  useEffect(() => {
    if (tab === 0) fetchTemplates();
    if (tab === 1) fetchAudiences();
    if (tab === 2) fetchSends();
  }, [tab, selectedCycle]);

  const fetchCycles = async () => {
    try {
      const data = await apiClient.get('/admin/cycles');
      setCycles(data);
      const active = data.find((c) => c.isActive);
      if (active) setSelectedCycle(active.id);
    } catch (e) {
      setError(e.message || 'Failed to load cycles');
    }
  };

  const fetchTemplates = async () => {
    try {
      const data = await apiClient.get(`/admin/campaigns/templates?cycleId=${selectedCycle || ''}`);
      setTemplates(data);
    } catch (e) {
      setError(e.message || 'Failed to load templates');
    }
  };

  const fetchAudiences = async () => {
    try {
      const data = await apiClient.get(`/admin/campaigns/audiences?cycleId=${selectedCycle || ''}`);
      setAudiences(data);
    } catch (e) {
      setError(e.message || 'Failed to load audiences');
    }
  };

  const fetchSends = async () => {
    try {
      const data = await apiClient.get(`/admin/campaigns/sends?cycleId=${selectedCycle || ''}`);
      setSends(data);
    } catch (e) {
      setError(e.message || 'Failed to load sends');
    }
  };

  const fetchSuppressions = async () => {
    try {
      const data = await apiClient.get('/admin/campaigns/suppressions');
      setSuppressions(data);
    } catch (e) {
      setError(e.message || 'Failed to load suppressions');
    }
  };

  const handleSaveTemplate = async () => {
    try {
      setError('');
      const payload = { ...templateForm, cycleId: selectedCycle || null };
      if (editingTemplate) {
        await apiClient.patch(`/admin/campaigns/templates/${editingTemplate.id}`, payload);
      } else {
        await apiClient.post('/admin/campaigns/templates', payload);
      }
      setTemplateOpen(false);
      setEditingTemplate(null);
      setTemplateForm({ name: '', category: '', subject: '', body: DEFAULT_BODY, mergeFields: [], firstOfCycleGate: false });
      await fetchTemplates();
    } catch (e) {
      setError(e.message || 'Failed to save template');
    }
  };

  const handleDeleteTemplate = async (id) => {
    if (!confirm('Delete this template?')) return;
    try {
      await apiClient.delete(`/admin/campaigns/templates/${id}`);
      await fetchTemplates();
    } catch (e) {
      setError(e.message || 'Failed to delete template');
    }
  };

  const handlePreviewAudience = async () => {
    try {
      setError('');
      const filters = {
        cycleId: selectedCycle || undefined,
        statuses: audienceForm.statuses,
        rounds: audienceForm.rounds,
        excludeSuppressed: audienceForm.excludeSuppressed,
      };
      const data = await apiClient.post('/admin/campaigns/audiences/preview', filters);
      setPreview(data);
    } catch (e) {
      setError(e.message || 'Failed to preview audience');
    }
  };

  const handleSaveAudience = async () => {
    try {
      setError('');
      const filters = {
        cycleId: selectedCycle || undefined,
        statuses: audienceForm.statuses,
        rounds: audienceForm.rounds,
        excludeSuppressed: audienceForm.excludeSuppressed,
      };
      const payload = { name: audienceForm.name, cycleId: selectedCycle || null, filters };
      if (editingAudience) {
        await apiClient.patch(`/admin/campaigns/audiences/${editingAudience.id}`, payload);
      } else {
        await apiClient.post('/admin/campaigns/audiences', payload);
      }
      setAudienceOpen(false);
      setEditingAudience(null);
      setAudienceForm({ name: '', statuses: [], rounds: [], excludeSuppressed: true });
      setPreview(null);
      await fetchAudiences();
    } catch (e) {
      setError(e.message || 'Failed to save audience');
    }
  };

  const handleDeleteAudience = async (id) => {
    if (!confirm('Delete this audience?')) return;
    try {
      await apiClient.delete(`/admin/campaigns/audiences/${id}`);
      await fetchAudiences();
    } catch (e) {
      setError(e.message || 'Failed to delete audience');
    }
  };

  const handleCreateSend = async () => {
    try {
      setError('');
      const payload = {
        name: sendForm.name,
        cycleId: selectedCycle || null,
        templateId: sendForm.templateId,
        audienceId: sendForm.audienceId,
        scheduledAt: sendForm.scheduledAt || null,
      };
      await apiClient.post('/admin/campaigns/sends', payload);
      setSendOpen(false);
      setSendForm({ name: '', templateId: '', audienceId: '', scheduledAt: '' });
      await fetchSends();
    } catch (e) {
      setError(e.message || 'Failed to create campaign send');
    }
  };

  const handleApprove = async (id) => {
    try {
      setError('');
      const result = await apiClient.post(`/admin/campaigns/sends/${id}/approve`, {});
      setSendResult({ approved: true, fingerprint: result.approvalFingerprint });
      await fetchSends();
    } catch (e) {
      setError(e.message || 'Failed to approve send');
    }
  };

  const handleSendNow = async (id) => {
    try {
      setError('');
      const result = await apiClient.post(`/admin/campaigns/sends/${id}/send`, {});
      setSendResult(result);
      await fetchSends();
    } catch (e) {
      setError(e.message || 'Failed to send campaign');
    }
  };

  const handleRetry = async (id) => {
    try {
      setError('');
      const result = await apiClient.post(`/admin/campaigns/sends/${id}/retry`, {});
      setSendResult(result);
      await fetchSends();
    } catch (e) {
      setError(e.message || 'Failed to retry campaign');
    }
  };

  const handleAddSuppression = async () => {
    try {
      setError('');
      await apiClient.post('/admin/campaigns/suppressions', { email: suppressionEmail, reason: 'manual' });
      setSuppressionEmail('');
      await fetchSuppressions();
    } catch (e) {
      setError(e.message || 'Failed to add suppression');
    }
  };

  const handleDeleteSuppression = async (email) => {
    if (!confirm(`Remove suppression for ${email}?`)) return;
    try {
      await apiClient.delete(`/admin/campaigns/suppressions/${encodeURIComponent(email)}`);
      await fetchSuppressions();
    } catch (e) {
      setError(e.message || 'Failed to remove suppression');
    }
  };

  const openTemplate = (template = null) => {
    if (template) {
      setEditingTemplate(template);
      setTemplateForm({
        name: template.name,
        category: template.category || '',
        subject: template.subject,
        body: template.body,
        mergeFields: template.mergeFields || [],
        firstOfCycleGate: template.firstOfCycleGate || false,
      });
    } else {
      setEditingTemplate(null);
      setTemplateForm({ name: '', category: '', subject: '', body: DEFAULT_BODY, mergeFields: [], firstOfCycleGate: false });
    }
    setTemplateOpen(true);
  };

  const openAudience = (audience = null) => {
    if (audience) {
      setEditingAudience(audience);
      const filters = typeof audience.filters === 'string' ? JSON.parse(audience.filters) : audience.filters || {};
      setAudienceForm({
        name: audience.name,
        statuses: filters.statuses || [],
        rounds: filters.rounds || [],
        excludeSuppressed: filters.excludeSuppressed !== false,
      });
    } else {
      setEditingAudience(null);
      setAudienceForm({ name: '', statuses: [], rounds: [], excludeSuppressed: true });
    }
    setPreview(null);
    setAudienceOpen(true);
  };

  return (
    <Box sx={{ p: 3, maxWidth: 1200, mx: 'auto' }}>
      <Typography variant="h4" gutterBottom>Recruitment Communications</Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {sendResult && (
        <Alert severity="info" sx={{ mb: 2 }} onClose={() => setSendResult(null)}>
          {JSON.stringify(sendResult)}
        </Alert>
      )}

      <FormControl fullWidth sx={{ mb: 2 }}>
        <InputLabel id="cycle-select-label">Recruiting Cycle</InputLabel>
        <Select
          labelId="cycle-select-label"
          value={selectedCycle}
          label="Recruiting Cycle"
          onChange={(e) => setSelectedCycle(e.target.value)}
        >
          <MenuItem value=""><em>All cycles</em></MenuItem>
          {cycles.map((c) => (
            <MenuItem key={c.id} value={c.id}>{c.name}{c.isActive ? ' (active)' : ''}</MenuItem>
          ))}
        </Select>
      </FormControl>

      <Tabs value={tab} onChange={(_, v) => setTab(v)}>
        <Tab label="Templates" />
        <Tab label="Audiences" />
        <Tab label="Sends" />
        <Tab label="Suppressions" />
      </Tabs>

      <TabPanel value={tab} index={0}>
        <Button variant="contained" onClick={() => openTemplate()} sx={{ mb: 2 }}>New Template</Button>
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Category</TableCell>
                <TableCell>Subject</TableCell>
                <TableCell>Version</TableCell>
                <TableCell>First-cycle gate</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {templates.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>{t.name}</TableCell>
                  <TableCell>{t.category}</TableCell>
                  <TableCell>{t.subject}</TableCell>
                  <TableCell>{t.version}</TableCell>
                  <TableCell>{t.firstOfCycleGate ? 'Yes' : 'No'}</TableCell>
                  <TableCell>
                    <IconButton onClick={() => openTemplate(t)}><EditIcon /></IconButton>
                    <IconButton onClick={() => handleDeleteTemplate(t.id)}><DeleteIcon /></IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </TabPanel>

      <TabPanel value={tab} index={1}>
        <Button variant="contained" onClick={() => openAudience()} sx={{ mb: 2 }}>New Audience</Button>
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Filters</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {audiences.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{a.name}</TableCell>
                  <TableCell>
                    {typeof a.filters === 'string'
                      ? a.filters
                      : JSON.stringify(a.filters)}
                  </TableCell>
                  <TableCell>
                    <IconButton onClick={() => openAudience(a)}><EditIcon /></IconButton>
                    <IconButton onClick={() => handleDeleteAudience(a.id)}><DeleteIcon /></IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </TabPanel>

      <TabPanel value={tab} index={2}>
        <Button variant="contained" onClick={() => setSendOpen(true)} sx={{ mb: 2 }}>New Send</Button>
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Template</TableCell>
                <TableCell>Audience</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Scheduled</TableCell>
                <TableCell>Sent</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sends.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{s.name}</TableCell>
                  <TableCell>{s.template?.name}</TableCell>
                  <TableCell>{s.audience?.name}</TableCell>
                  <TableCell>{s.status}</TableCell>
                  <TableCell>{s.scheduledAt ? new Date(s.scheduledAt).toLocaleString() : '—'}</TableCell>
                  <TableCell>{s.recipientCount ?? '—'}</TableCell>
                  <TableCell>
                    {s.status === 'PENDING_APPROVAL' && (
                      <Tooltip title="Approve rendered content and audience"><IconButton onClick={() => handleApprove(s.id)}><CheckCircleIcon /></IconButton></Tooltip>
                    )}
                    {(s.status === 'APPROVED' || s.status === 'SCHEDULED') && s.status !== 'SENDING' && (
                      <Tooltip title="Send now"><IconButton onClick={() => handleSendNow(s.id)}><SendIcon /></IconButton></Tooltip>
                    )}
                    {(s.status === 'SENT' || s.status === 'FAILED') && (
                      <Tooltip title="Retry failed"><IconButton onClick={() => handleRetry(s.id)}><RefreshIcon /></IconButton></Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </TabPanel>

      <TabPanel value={tab} index={3}>
        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          <TextField
            label="Email to suppress"
            value={suppressionEmail}
            onChange={(e) => setSuppressionEmail(e.target.value)}
            size="small"
            sx={{ minWidth: 300 }}
          />
          <Button variant="contained" onClick={handleAddSuppression}>Add</Button>
        </Stack>
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow><TableCell>Email</TableCell><TableCell>Reason</TableCell><TableCell>Added</TableCell><TableCell>Actions</TableCell></TableRow>
            </TableHead>
            <TableBody>
              {suppressions.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{s.email}</TableCell>
                  <TableCell>{s.reason}</TableCell>
                  <TableCell>{new Date(s.createdAt).toLocaleString()}</TableCell>
                  <TableCell>
                    <IconButton onClick={() => handleDeleteSuppression(s.email)}><DeleteIcon /></IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </TabPanel>

      <Dialog open={templateOpen} onClose={() => setTemplateOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>{editingTemplate ? 'Edit Template' : 'New Template'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Name" value={templateForm.name} onChange={(e) => setTemplateForm({ ...templateForm, name: e.target.value })} fullWidth />
            <TextField label="Category" value={templateForm.category} onChange={(e) => setTemplateForm({ ...templateForm, category: e.target.value })} fullWidth />
            <TextField label="Subject" value={templateForm.subject} onChange={(e) => setTemplateForm({ ...templateForm, subject: e.target.value })} fullWidth />
            <TextField label="Body (HTML)" value={templateForm.body} onChange={(e) => setTemplateForm({ ...templateForm, body: e.target.value })} fullWidth multiline rows={10} />
            <Typography variant="caption" color="text.secondary">
              Merge fields: {'{{firstName}} {{lastName}} {{name}} {{cycle}} {{stage}} {{status}}'}
            </Typography>
            <FormControlLabel
              control={<Checkbox checked={templateForm.firstOfCycleGate} onChange={(e) => setTemplateForm({ ...templateForm, firstOfCycleGate: e.target.checked })} />}
              label="Require first-of-cycle human gate before sending"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTemplateOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSaveTemplate}>Save</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={audienceOpen} onClose={() => setAudienceOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingAudience ? 'Edit Audience' : 'New Audience'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Name" value={audienceForm.name} onChange={(e) => setAudienceForm({ ...audienceForm, name: e.target.value })} fullWidth />
            <FormControl fullWidth>
              <InputLabel id="statuses-label">Application Statuses</InputLabel>
              <Select
                labelId="statuses-label"
                multiple
                value={audienceForm.statuses}
                onChange={(e) => setAudienceForm({ ...audienceForm, statuses: e.target.value })}
                renderValue={(selected) => (
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                    {selected.map((v) => <Chip key={v} label={v} size="small" />)}
                  </Box>
                )}
              >
                {STATUS_OPTIONS.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
              </Select>
            </FormControl>
            <FormControl fullWidth>
              <InputLabel id="rounds-label">Current Round</InputLabel>
              <Select
                labelId="rounds-label"
                multiple
                value={audienceForm.rounds}
                onChange={(e) => setAudienceForm({ ...audienceForm, rounds: e.target.value })}
                renderValue={(selected) => (
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                    {selected.map((v) => <Chip key={v} label={v} size="small" />)}
                  </Box>
                )}
              >
                {ROUND_OPTIONS.map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
              </Select>
            </FormControl>
            <FormControlLabel
              control={<Checkbox checked={audienceForm.excludeSuppressed} onChange={(e) => setAudienceForm({ ...audienceForm, excludeSuppressed: e.target.checked })} />}
              label="Exclude suppressed emails"
            />
            <Button variant="outlined" onClick={handlePreviewAudience}>Preview recipient count</Button>
            {preview && (
              <Alert severity="info">
                Estimated recipients: {preview.count}
                {preview.sample.length > 0 && (
                  <Box component="span" display="block" sx={{ mt: 1 }}>
                    Sample: {preview.sample.map((r) => r.email).join(', ')}
                  </Box>
                )}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAudienceOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSaveAudience}>Save</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={sendOpen} onClose={() => setSendOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>New Campaign Send</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Name" value={sendForm.name} onChange={(e) => setSendForm({ ...sendForm, name: e.target.value })} fullWidth />
            <FormControl fullWidth>
              <InputLabel>Template</InputLabel>
              <Select value={sendForm.templateId} onChange={(e) => setSendForm({ ...sendForm, templateId: e.target.value })}>
                {templates.map((t) => <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>)}
              </Select>
            </FormControl>
            <FormControl fullWidth>
              <InputLabel>Audience</InputLabel>
              <Select value={sendForm.audienceId} onChange={(e) => setSendForm({ ...sendForm, audienceId: e.target.value })}>
                {audiences.map((a) => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
              </Select>
            </FormControl>
            <TextField
              label="Schedule (optional)"
              type="datetime-local"
              value={sendForm.scheduledAt}
              onChange={(e) => setSendForm({ ...sendForm, scheduledAt: e.target.value })}
              fullWidth
              InputLabelProps={{ shrink: true }}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSendOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleCreateSend}>
            {sendForm.scheduledAt ? 'Schedule' : 'Send'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
