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
} from '@mui/material';
import { Edit as EditIcon } from '@mui/icons-material';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import { useAuth } from '../context/AuthContext';
import CycleOfferLetterDialog from '../components/CycleOfferLetterDialog';
import CycleTimelineBootstrapDialog from '../components/CycleTimelineBootstrapDialog';

export default function CycleManagement() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [cycles, setCycles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [bootstrapOpen, setBootstrapOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingCycle, setEditingCycle] = useState(null);
  const [offerLetterCycleId, setOfferLetterCycleId] = useState(null);
  const [form, setForm] = useState({ name: '', formUrl: '', startDate: '', endDate: '', isActive: false });
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

    try {
      setError('');
      setSubmitting(true);
      const created = await apiClient.post('/admin/cycles', form);
      setCreateOpen(false);
      setForm({ name: '', formUrl: '', startDate: '', endDate: '', isActive: false });
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

    try {
      setError('');
      setSubmitting(true);
      const wasActive = editingCycle.isActive;
      await apiClient.patch(`/admin/cycles/${editingCycle.id}`, form);
      setEditOpen(false);
      setEditingCycle(null);
      setForm({ name: '', formUrl: '', startDate: '', endDate: '', isActive: false });
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
      isActive: cycle.isActive
    });
    setEditOpen(true);
  };

  const closeEditDialog = () => {
    if (submitting) return; // Prevent closing during submission
    setEditOpen(false);
    setEditingCycle(null);
    setForm({ name: '', formUrl: '', startDate: '', endDate: '', isActive: false });
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

  useEffect(() => {
    // Non-admins get the access-denied panel, so don't fire admin requests.
    if (isAdmin) fetchCycles();
  }, [isAdmin]);

  return (
    // Every endpoint this page calls is requireAdmin, so the surface is ADMIN-only.
    <AccessControl allowedRoles={['ADMIN']}>
      <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}>
        <Typography variant="h4">Cycle Management</Typography>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" onClick={() => setCreateOpen(true)}>New Cycle (dates only)</Button>
          <Button variant="contained" onClick={() => setBootstrapOpen(true)}>New Cycle from Timeline</Button>
        </Stack>
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
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeEditDialog} disabled={submitting}>Cancel</Button>
          <Button onClick={editCycle} variant="contained" disabled={submitting}>
            {submitting ? 'Updating...' : 'Update'}
          </Button>
        </DialogActions>
      </Dialog>

      <CycleTimelineBootstrapDialog
        open={bootstrapOpen}
        cycles={cycles}
        onClose={() => setBootstrapOpen(false)}
        onCommitted={async (result) => {
          setBootstrapOpen(false);
          await fetchCycles();
          if (result?.cycle?.isActive) {
            window.dispatchEvent(new CustomEvent('cycleActivated', { detail: { cycleId: result.cycle.id } }));
          }
        }}
      />

      <CycleOfferLetterDialog
        cycleId={offerLetterCycleId}
        open={Boolean(offerLetterCycleId)}
        onClose={() => setOfferLetterCycleId(null)}
      />
    </Box>
    </AccessControl>
  );
}