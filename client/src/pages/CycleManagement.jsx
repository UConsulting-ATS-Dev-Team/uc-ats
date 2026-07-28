import React, { useEffect, useState } from 'react';
import {
  Box,
  Button,
  TextField,
  Typography,
  Paper,
  Stack,
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
  Checkbox,
  IconButton,
  Tooltip,
  Switch,
  FormControlLabel,
  Divider,
} from '@mui/material';
import { Edit as EditIcon, Add as AddIcon, Delete as DeleteIcon } from '@mui/icons-material';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import CycleOfferLetterDialog from '../components/CycleOfferLetterDialog';

export default function CycleManagement() {
  const [cycles, setCycles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingCycle, setEditingCycle] = useState(null);
  const [offerLetterCycleId, setOfferLetterCycleId] = useState(null);
  const [form, setForm] = useState({
    name: '',
    formUrl: '',
    startDate: '',
    endDate: '',
    isActive: false,
    feedbackEnabled: false,
    feedbackCadenceHours: 48,
    feedbackPrompt: '',
    feedbackQuestions: [],
    feedbackPrivacyPolicy: '',
    feedbackRetentionDays: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const fetchCycles = async () => {
    try {
      setLoading(true);
      const data = await apiClient.get('/admin/cycles');
      setCycles(data);
    } catch (e) {
      setError(e.message || 'Failed to load cycles');
    } finally {
      setLoading(false);
    }
  };

  const createCycle = async () => {
    if (!form.name || !form.name.trim()) {
      setError('Cycle name is required');
      return;
    }

    if (form.startDate && form.endDate && new Date(form.startDate) > new Date(form.endDate)) {
      setError('End date must be after start date');
      return;
    }

    if (form.feedbackEnabled && (!form.feedbackPrivacyPolicy || !form.feedbackPrivacyPolicy.trim())) {
      setError('A feedback privacy/retention policy is required when feedback is enabled');
      return;
    }
    if (form.feedbackEnabled && (!form.feedbackRetentionDays || Number(form.feedbackRetentionDays) <= 0)) {
      setError('A positive feedback retention period (days) is required when feedback is enabled');
      return;
    }

    try {
      setError('');
      setSubmitting(true);
      const created = await apiClient.post('/admin/cycles', form);
      setCreateOpen(false);
      setForm({
        name: '', formUrl: '', startDate: '', endDate: '', isActive: false,
        feedbackEnabled: false, feedbackCadenceHours: 48, feedbackPrompt: '', feedbackQuestions: [],
        feedbackPrivacyPolicy: '', feedbackRetentionDays: '',
      });
      await fetchCycles();
      
      // If the cycle was created as active, notify other components
      if (form.isActive && created) {
        window.dispatchEvent(new CustomEvent('cycleActivated', { detail: { cycleId: created.id } }));
      }
    } catch (e) {
      setError(e.message || 'Failed to create cycle');
    } finally {
      setSubmitting(false);
    }
  };

  const editCycle = async () => {
    if (!form.name || !form.name.trim()) {
      setError('Cycle name is required');
      return;
    }

    if (form.startDate && form.endDate && new Date(form.startDate) > new Date(form.endDate)) {
      setError('End date must be after start date');
      return;
    }

    if (form.feedbackEnabled && (!form.feedbackPrivacyPolicy || !form.feedbackPrivacyPolicy.trim())) {
      setError('A feedback privacy/retention policy is required when feedback is enabled');
      return;
    }
    if (form.feedbackEnabled && (!form.feedbackRetentionDays || Number(form.feedbackRetentionDays) <= 0)) {
      setError('A positive feedback retention period (days) is required when feedback is enabled');
      return;
    }

    try {
      setError('');
      setSubmitting(true);
      const wasActive = editingCycle.isActive;
      await apiClient.patch(`/admin/cycles/${editingCycle.id}`, form);
      setEditOpen(false);
      setEditingCycle(null);
      setForm({
        name: '', formUrl: '', startDate: '', endDate: '', isActive: false,
        feedbackEnabled: false, feedbackCadenceHours: 48, feedbackPrompt: '', feedbackQuestions: [],
        feedbackPrivacyPolicy: '', feedbackRetentionDays: '',
      });
      await fetchCycles();
      
      // If the cycle was activated (either newly activated or was already active), notify other components
      if (form.isActive && !wasActive) {
        window.dispatchEvent(new CustomEvent('cycleActivated', { detail: { cycleId: editingCycle.id } }));
      }
    } catch (e) {
      setError(e.message || 'Failed to update cycle');
    } finally {
      setSubmitting(false);
    }
  };

  const openEditDialog = (cycle) => {
    setEditingCycle(cycle);
    setForm({
      name: cycle.name,
      formUrl: cycle.formUrl || '',
      startDate: cycle.startDate ? new Date(cycle.startDate).toISOString().split('T')[0] : '',
      endDate: cycle.endDate ? new Date(cycle.endDate).toISOString().split('T')[0] : '',
      isActive: cycle.isActive,
      feedbackEnabled: cycle.feedbackEnabled === true,
      feedbackCadenceHours: cycle.feedbackCadenceHours || 48,
      feedbackPrompt: cycle.feedbackPrompt || '',
      feedbackQuestions: Array.isArray(cycle.feedbackQuestions) ? cycle.feedbackQuestions : [],
      feedbackPrivacyPolicy: cycle.feedbackPrivacyPolicy || '',
      feedbackRetentionDays: cycle.feedbackRetentionDays || '',
    });
    setEditOpen(true);
  };

  const closeEditDialog = () => {
    if (submitting) return; // Prevent closing during submission
    setEditOpen(false);
    setEditingCycle(null);
    setForm({
      name: '', formUrl: '', startDate: '', endDate: '', isActive: false,
      feedbackEnabled: false, feedbackCadenceHours: 48, feedbackPrompt: '', feedbackQuestions: [],
      feedbackPrivacyPolicy: '', feedbackRetentionDays: '',
    });
    setError('');
  };

  const activateCycle = async (id) => {
    await apiClient.post(`/admin/cycles/${id}/activate`, {});
    await fetchCycles();
    
    // Dispatch event to notify other components (like EventManagement) that a cycle was activated
    window.dispatchEvent(new CustomEvent('cycleActivated', { detail: { cycleId: id } }));
  };

  const deleteCycle = async (id) => {
    await apiClient.delete(`/admin/cycles/${id}`);
    await fetchCycles();
  };

  const addFeedbackQuestion = () => {
    setForm((prev) => ({
      ...prev,
      feedbackQuestions: [...(prev.feedbackQuestions || []), { id: `q-${Date.now()}`, label: '', required: false }],
    }));
  };

  const updateFeedbackQuestion = (index, updates) => {
    setForm((prev) => {
      const next = [...(prev.feedbackQuestions || [])];
      next[index] = { ...next[index], ...updates };
      return { ...prev, feedbackQuestions: next };
    });
  };

  const removeFeedbackQuestion = (index) => {
    setForm((prev) => ({
      ...prev,
      feedbackQuestions: prev.feedbackQuestions.filter((_, i) => i !== index),
    }));
  };

  useEffect(() => {
    fetchCycles();
  }, []);

  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}>
        <Typography variant="h4">Cycle Management</Typography>
        <Button variant="contained" onClick={() => setCreateOpen(true)}>New Cycle</Button>
      </Stack>

      {error && (
        <Paper sx={{ p: 2, mb: 2, color: 'error.main' }}>{error}</Paper>
      )}

      <TableContainer component={Paper} className="responsive-table">
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Form URL</TableCell>
              <TableCell>Start</TableCell>
              <TableCell>End</TableCell>
              <TableCell>Active</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {cycles.map((c) => (
              <TableRow key={c.id}>
                <TableCell data-label="Name">{c.name}</TableCell>
                <TableCell data-label="Form URL" sx={{ maxWidth: { xs: 'none', md: 320 }, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: { xs: 'normal', md: 'nowrap' }, wordBreak: 'break-all' }}>{c.formUrl || '-'}</TableCell>
                <TableCell data-label="Start">{c.startDate ? new Date(c.startDate).toLocaleDateString() : '-'}</TableCell>
                <TableCell data-label="End">{c.endDate ? new Date(c.endDate).toLocaleDateString() : '-'}</TableCell>
                <TableCell data-label="Active">{c.isActive ? 'Yes' : 'No'}</TableCell>
                <TableCell data-label="Actions" align="right">
                  <Stack direction="row" spacing={1} justifyContent="flex-end">
                    <Tooltip title="Edit cycle">
                      <IconButton size="small" onClick={() => openEditDialog(c)}>
                        <EditIcon />
                      </IconButton>
                    </Tooltip>
                    <Button size="small" variant="outlined" onClick={() => setOfferLetterCycleId(c.id)}>
                      Offer Letters
                    </Button>
                    {!c.isActive && (
                      <Button size="small" variant="outlined" onClick={() => activateCycle(c.id)}>Activate</Button>
                    )}
                    <Button size="small" color="error" variant="outlined" onClick={() => deleteCycle(c.id)}>Delete</Button>
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Create Dialog */}
      <Dialog open={createOpen} onClose={() => !submitting && setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New Recruiting Cycle</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField 
              label="Name" 
              value={form.name} 
              onChange={(e) => setForm({ ...form, name: e.target.value })} 
              fullWidth 
              required
              error={!form.name || !form.name.trim()}
              helperText={!form.name || !form.name.trim() ? 'Cycle name is required' : ''}
            />
            <TextField 
              label="Form URL" 
              value={form.formUrl} 
              onChange={(e) => setForm({ ...form, formUrl: e.target.value })} 
              fullWidth 
              placeholder="https://example.com/form"
            />
            <TextField 
              label="Start Date" 
              type="date" 
              value={form.startDate} 
              onChange={(e) => setForm({ ...form, startDate: e.target.value })} 
              fullWidth 
              InputLabelProps={{ shrink: true }} 
            />
            <TextField 
              label="End Date" 
              type="date" 
              value={form.endDate} 
              onChange={(e) => setForm({ ...form, endDate: e.target.value })} 
              fullWidth 
              InputLabelProps={{ shrink: true }}
              error={form.startDate && form.endDate && new Date(form.startDate) > new Date(form.endDate)}
              helperText={form.startDate && form.endDate && new Date(form.startDate) > new Date(form.endDate) ? 'End date must be after start date' : ''}
            />
            <Stack direction="row" alignItems="center" spacing={1}>
              <Checkbox 
                checked={form.isActive} 
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })} 
                disabled={submitting}
              />
              <Typography>Set as active</Typography>
            </Stack>

            <Divider sx={{ my: 1 }} />
            <Typography variant="h6">Feedback Configuration</Typography>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Switch
                checked={form.feedbackEnabled}
                onChange={(e) => setForm({ ...form, feedbackEnabled: e.target.checked })}
                disabled={submitting}
              />
              <Typography>Enable feedback requests</Typography>
            </Stack>
            <TextField
              label="Feedback cadence (hours)"
              type="number"
              value={form.feedbackCadenceHours}
              onChange={(e) => setForm({ ...form, feedbackCadenceHours: parseInt(e.target.value, 10) || 0 })}
              fullWidth
              inputProps={{ min: 1 }}
              disabled={!form.feedbackEnabled}
            />
            <TextField
              label="Feedback prompt"
              value={form.feedbackPrompt}
              onChange={(e) => setForm({ ...form, feedbackPrompt: e.target.value })}
              fullWidth
              placeholder="We would greatly appreciate your confidential feedback."
              disabled={!form.feedbackEnabled}
            />
            {form.feedbackEnabled && (
              <TextField
                label="Feedback privacy / retention policy"
                value={form.feedbackPrivacyPolicy}
                onChange={(e) => setForm({ ...form, feedbackPrivacyPolicy: e.target.value })}
                fullWidth
                multiline
                minRows={3}
                placeholder="Candidates will see this before submitting feedback. State who can view responses and how long they are retained."
                disabled={!form.feedbackEnabled}
                required={form.feedbackEnabled}
              />
            )}
            {form.feedbackEnabled && (
              <TextField
                label="Retention period (days)"
                type="number"
                value={form.feedbackRetentionDays}
                onChange={(e) => setForm({ ...form, feedbackRetentionDays: e.target.value })}
                fullWidth
                inputProps={{ min: 1 }}
                disabled={!form.feedbackEnabled}
                required={form.feedbackEnabled}
              />
            )}
            <Box>
              <Typography variant="subtitle2" gutterBottom>Questions</Typography>
              {(form.feedbackQuestions || []).map((q, index) => (
                <Stack key={q.id || index} direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                  <TextField
                    label={`Question ${index + 1}`}
                    value={q.label}
                    onChange={(e) => updateFeedbackQuestion(index, { label: e.target.value })}
                    fullWidth
                    disabled={!form.feedbackEnabled}
                  />
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={q.required}
                        onChange={(e) => updateFeedbackQuestion(index, { required: e.target.checked })}
                        disabled={!form.feedbackEnabled}
                      />
                    }
                    label="Required"
                  />
                  <IconButton onClick={() => removeFeedbackQuestion(index)} disabled={!form.feedbackEnabled} color="error">
                    <DeleteIcon />
                  </IconButton>
                </Stack>
              ))}
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={addFeedbackQuestion}
                disabled={!form.feedbackEnabled || submitting}
              >
                Add question
              </Button>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={createCycle} variant="contained" disabled={submitting}>
            {submitting ? 'Creating...' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onClose={closeEditDialog} fullWidth maxWidth="sm" disableEscapeKeyDown={submitting}>
        <DialogTitle>Edit Recruiting Cycle</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField 
              label="Name" 
              value={form.name} 
              onChange={(e) => setForm({ ...form, name: e.target.value })} 
              fullWidth 
              required
              error={!form.name || !form.name.trim()}
              helperText={!form.name || !form.name.trim() ? 'Cycle name is required' : ''}
            />
            <TextField 
              label="Form URL" 
              value={form.formUrl} 
              onChange={(e) => setForm({ ...form, formUrl: e.target.value })} 
              fullWidth 
              placeholder="https://example.com/form"
            />
            <TextField 
              label="Start Date" 
              type="date" 
              value={form.startDate} 
              onChange={(e) => setForm({ ...form, startDate: e.target.value })} 
              fullWidth 
              InputLabelProps={{ shrink: true }} 
            />
            <TextField 
              label="End Date" 
              type="date" 
              value={form.endDate} 
              onChange={(e) => setForm({ ...form, endDate: e.target.value })} 
              fullWidth 
              InputLabelProps={{ shrink: true }}
              error={form.startDate && form.endDate && new Date(form.startDate) > new Date(form.endDate)}
              helperText={form.startDate && form.endDate && new Date(form.startDate) > new Date(form.endDate) ? 'End date must be after start date' : ''}
            />
            <Stack direction="row" alignItems="center" spacing={1}>
              <Checkbox 
                checked={form.isActive} 
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })} 
                disabled={submitting}
              />
              <Typography>Set as active</Typography>
            </Stack>

            <Divider sx={{ my: 1 }} />
            <Typography variant="h6">Feedback Configuration</Typography>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Switch
                checked={form.feedbackEnabled}
                onChange={(e) => setForm({ ...form, feedbackEnabled: e.target.checked })}
                disabled={submitting}
              />
              <Typography>Enable feedback requests</Typography>
            </Stack>
            <TextField
              label="Feedback cadence (hours)"
              type="number"
              value={form.feedbackCadenceHours}
              onChange={(e) => setForm({ ...form, feedbackCadenceHours: parseInt(e.target.value, 10) || 0 })}
              fullWidth
              inputProps={{ min: 1 }}
              disabled={!form.feedbackEnabled}
            />
            <TextField
              label="Feedback prompt"
              value={form.feedbackPrompt}
              onChange={(e) => setForm({ ...form, feedbackPrompt: e.target.value })}
              fullWidth
              placeholder="We would greatly appreciate your confidential feedback."
              disabled={!form.feedbackEnabled}
            />
            {form.feedbackEnabled && (
              <TextField
                label="Feedback privacy / retention policy"
                value={form.feedbackPrivacyPolicy}
                onChange={(e) => setForm({ ...form, feedbackPrivacyPolicy: e.target.value })}
                fullWidth
                multiline
                minRows={3}
                placeholder="Candidates will see this before submitting feedback. State who can view responses and how long they are retained."
                disabled={!form.feedbackEnabled}
                required={form.feedbackEnabled}
              />
            )}
            {form.feedbackEnabled && (
              <TextField
                label="Retention period (days)"
                type="number"
                value={form.feedbackRetentionDays}
                onChange={(e) => setForm({ ...form, feedbackRetentionDays: e.target.value })}
                fullWidth
                inputProps={{ min: 1 }}
                disabled={!form.feedbackEnabled}
                required={form.feedbackEnabled}
              />
            )}
            <Box>
              <Typography variant="subtitle2" gutterBottom>Questions</Typography>
              {(form.feedbackQuestions || []).map((q, index) => (
                <Stack key={q.id || index} direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                  <TextField
                    label={`Question ${index + 1}`}
                    value={q.label}
                    onChange={(e) => updateFeedbackQuestion(index, { label: e.target.value })}
                    fullWidth
                    disabled={!form.feedbackEnabled}
                  />
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={q.required}
                        onChange={(e) => updateFeedbackQuestion(index, { required: e.target.checked })}
                        disabled={!form.feedbackEnabled}
                      />
                    }
                    label="Required"
                  />
                  <IconButton onClick={() => removeFeedbackQuestion(index)} disabled={!form.feedbackEnabled} color="error">
                    <DeleteIcon />
                  </IconButton>
                </Stack>
              ))}
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={addFeedbackQuestion}
                disabled={!form.feedbackEnabled || submitting}
              >
                Add question
              </Button>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeEditDialog} disabled={submitting}>Cancel</Button>
          <Button onClick={editCycle} variant="contained" disabled={submitting}>
            {submitting ? 'Updating...' : 'Update'}
          </Button>
        </DialogActions>
      </Dialog>

      <CycleOfferLetterDialog
        cycleId={offerLetterCycleId}
        open={Boolean(offerLetterCycleId)}
        onClose={() => setOfferLetterCycleId(null)}
      />
    </Box>
    </AccessControl>
  );
}