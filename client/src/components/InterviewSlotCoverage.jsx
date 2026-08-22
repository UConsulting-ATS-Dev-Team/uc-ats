import React, { useEffect, useState, useCallback } from 'react';
import {
  Box,
  Typography,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Alert,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  IconButton,
  Tooltip,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Refresh as RefreshIcon,
  PersonRemove as PersonRemoveIcon,
  Event as EventIcon,
} from '@mui/icons-material';
import apiClient from '../utils/api';

function formatInLA(date, options = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) {
  if (!date) return 'TBD';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', ...options }).format(new Date(date));
}

function formatTimeOnly(date) {
  return formatInLA(date, { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatInterviewType(type) {
  return String(type || 'Interview').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function toLocalInputValue(date) {
  const d = new Date(date);
  if (isNaN(d)) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export default function InterviewSlotCoverage() {
  const [interviews, setInterviews] = useState([]);
  const [selectedInterviewId, setSelectedInterviewId] = useState('');
  const [coverage, setCoverage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [interviewsLoading, setInterviewsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editSlot, setEditSlot] = useState(null);
  const [slotForm, setSlotForm] = useState({ startTime: '', endTime: '', capacity: 2 });

  const [confirmDeleteSlot, setConfirmDeleteSlot] = useState(null);
  const [confirmRemoveSignup, setConfirmRemoveSignup] = useState(null);

  const fetchInterviews = useCallback(async () => {
    try {
      setInterviewsLoading(true);
      const result = await apiClient.get('/admin/interviews');
      const supported = (result || []).filter((i) =>
        ['COFFEE_CHAT', 'ROUND_ONE', 'ROUND_TWO'].includes(i.interviewType)
      );
      setInterviews(supported);
      if (supported.length > 0 && !selectedInterviewId) {
        setSelectedInterviewId(supported[0].id);
      }
    } catch (err) {
      setError(err.message || 'Failed to load interviews');
    } finally {
      setInterviewsLoading(false);
    }
  }, [selectedInterviewId]);

  const fetchCoverage = useCallback(async () => {
    if (!selectedInterviewId) return;
    try {
      setLoading(true);
      setError(null);
      const result = await apiClient.get(`/admin/interviews/${selectedInterviewId}/slots`);
      setCoverage(result);
    } catch (err) {
      setError(err.message || 'Failed to load slot coverage');
    } finally {
      setLoading(false);
    }
  }, [selectedInterviewId]);

  useEffect(() => {
    fetchInterviews();
  }, [fetchInterviews]);

  useEffect(() => {
    fetchCoverage();
  }, [fetchCoverage]);

  const handleCreateOrUpdate = async () => {
    try {
      setActionLoading('save');
      setActionError(null);
      const payload = {
        startTime: slotForm.startTime,
        endTime: slotForm.endTime,
        capacity: Number(slotForm.capacity),
      };
      if (editSlot) {
        await apiClient.put(`/admin/interviews/slots/${editSlot.id}`, payload);
      } else {
        await apiClient.post(`/admin/interviews/${selectedInterviewId}/slots`, { slots: [payload] });
      }
      setCreateOpen(false);
      setEditSlot(null);
      setSlotForm({ startTime: '', endTime: '', capacity: 2 });
      await fetchCoverage();
    } catch (err) {
      setActionError(err.message || 'Failed to save slot');
    } finally {
      setActionLoading(null);
    }
  };

  const openCreate = () => {
    setEditSlot(null);
    setSlotForm({ startTime: '', endTime: '', capacity: 2 });
    setActionError(null);
    setCreateOpen(true);
  };

  const openEdit = (slot) => {
    setEditSlot(slot);
    setSlotForm({
      startTime: toLocalInputValue(slot.startTime),
      endTime: toLocalInputValue(slot.endTime),
      capacity: slot.capacity,
    });
    setActionError(null);
    setCreateOpen(true);
  };

  const handleDeleteSlot = async () => {
    if (!confirmDeleteSlot) return;
    try {
      setActionLoading('delete-slot');
      setActionError(null);
      await apiClient.delete(`/admin/interviews/slots/${confirmDeleteSlot.id}`);
      setConfirmDeleteSlot(null);
      await fetchCoverage();
    } catch (err) {
      setActionError(err.message || 'Failed to delete slot');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemoveSignup = async () => {
    if (!confirmRemoveSignup) return;
    try {
      setActionLoading('remove-signup');
      setActionError(null);
      await apiClient.delete(`/admin/interviews/signups/${confirmRemoveSignup.id}`);
      setConfirmRemoveSignup(null);
      await fetchCoverage();
    } catch (err) {
      setActionError(err.message || 'Failed to remove signup');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRetryEmail = async (signupId) => {
    try {
      setActionLoading(`retry-${signupId}`);
      setActionError(null);
      await apiClient.post(`/admin/interviews/signups/${signupId}/retry-confirmation`);
      await fetchCoverage();
    } catch (err) {
      setActionError(err.message || 'Failed to retry confirmation');
    } finally {
      setActionLoading(null);
    }
  };

  const canSubmit =
    slotForm.startTime &&
    slotForm.endTime &&
    Number.isInteger(Number(slotForm.capacity)) &&
    Number(slotForm.capacity) > 0;

  if (interviewsLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (interviews.length === 0 && !interviewsLoading) {
    return (
      <Card sx={{ mb: 4 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <EventIcon /> Interview Slot Coverage
          </Typography>
          <Typography variant="body2" color="text.secondary">
            No Coffee Chat / Round 1 / Round 2 interviews exist in the active cycle yet.
          </Typography>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card sx={{ mb: 4 }}>
      <CardContent>
        <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <EventIcon /> Interview Slot Coverage
        </Typography>

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {actionError && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
            {actionError}
          </Alert>
        )}

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center" sx={{ mb: 2 }}>
          <FormControl fullWidth size="small" sx={{ maxWidth: 400 }}>
            <InputLabel>Interview round</InputLabel>
            <Select
              value={selectedInterviewId}
              label="Interview round"
              onChange={(e) => setSelectedInterviewId(e.target.value)}
            >
              {interviews.map((i) => (
                <MenuItem key={i.id} value={i.id}>
                  {formatInterviewType(i.interviewType)} - {i.title}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
            Add slot
          </Button>
        </Stack>

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
            <CircularProgress />
          </Box>
        ) : coverage?.slots?.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
            No slots configured for this interview. Click &quot;Add slot&quot; to get started.
          </Typography>
        ) : (
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Time (LA)</TableCell>
                  <TableCell>Capacity</TableCell>
                  <TableCell>Filled</TableCell>
                  <TableCell>Signed-up members</TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {coverage?.slots?.map((slot) => (
                  <TableRow key={slot.id}>
                    <TableCell>
                      {formatInLA(slot.startTime)} - {formatTimeOnly(slot.endTime)}
                    </TableCell>
                    <TableCell>{slot.capacity}</TableCell>
                    <TableCell>
                      <Chip
                        label={`${slot._count?.signups || 0} / ${slot.capacity}`}
                        color={(slot._count?.signups || 0) >= slot.capacity ? 'error' : 'success'}
                        size="small"
                      />
                    </TableCell>
                    <TableCell>
                      {slot.signups?.length === 0 ? (
                        <Typography variant="body2" color="text.secondary">
                          None
                        </Typography>
                      ) : (
                        <Stack spacing={0.5} alignItems="flex-start">
                          {slot.signups.map((s) => (
                            <Box key={s.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                              <Typography variant="body2">{s.user?.fullName || s.user?.email}</Typography>
                              <Chip
                                label={s.confirmationStatus}
                                color={s.confirmationStatus === 'SENT' ? 'success' : s.confirmationStatus === 'FAILED' ? 'error' : 'default'}
                                size="small"
                              />
                              {s.confirmationStatus === 'FAILED' && (
                                <Tooltip title="Retry confirmation email">
                                  <IconButton
                                    size="small"
                                    aria-label="Retry confirmation email"
                                    onClick={() => handleRetryEmail(s.id)}
                                    disabled={actionLoading === `retry-${s.id}`}
                                  >
                                    <RefreshIcon fontSize="small" />
                                  </IconButton>
                                </Tooltip>
                              )}
                              <Tooltip title="Remove member from slot">
                                <IconButton
                                  size="small"
                                  color="error"
                                  aria-label="Remove member from slot"
                                  onClick={() => setConfirmRemoveSignup(s)}
                                  disabled={actionLoading === `remove-${s.id}`}
                                >
                                  <PersonRemoveIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                            </Box>
                          ))}
                        </Stack>
                      )}
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1}>
                        <Button size="small" variant="outlined" onClick={() => openEdit(slot)}>
                          Edit
                        </Button>
                        <Button size="small" variant="outlined" color="error" onClick={() => setConfirmDeleteSlot(slot)}>
                          Delete
                        </Button>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
          <DialogTitle>{editSlot ? 'Edit slot' : 'Add slot'}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              <TextField
                label="Start time"
                type="datetime-local"
                size="small"
                fullWidth
                value={slotForm.startTime}
                onChange={(e) => setSlotForm((f) => ({ ...f, startTime: e.target.value }))}
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                label="End time"
                type="datetime-local"
                size="small"
                fullWidth
                value={slotForm.endTime}
                onChange={(e) => setSlotForm((f) => ({ ...f, endTime: e.target.value }))}
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                label="Capacity"
                type="number"
                size="small"
                fullWidth
                value={slotForm.capacity}
                onChange={(e) => setSlotForm((f) => ({ ...f, capacity: e.target.value }))}
                inputProps={{ min: 1, step: 1 }}
              />
              {actionError && <Alert severity="error">{actionError}</Alert>}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="contained" onClick={handleCreateOrUpdate} disabled={!canSubmit || actionLoading === 'save'}>
              {actionLoading === 'save' ? 'Saving...' : editSlot ? 'Save' : 'Create'}
            </Button>
          </DialogActions>
        </Dialog>

        <Dialog open={Boolean(confirmDeleteSlot)} onClose={() => setConfirmDeleteSlot(null)}>
          <DialogTitle>Delete slot?</DialogTitle>
          <DialogContent>
            <Typography variant="body2">
              This will remove the slot and all signups. This cannot be undone.
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmDeleteSlot(null)}>Cancel</Button>
            <Button color="error" onClick={handleDeleteSlot} disabled={actionLoading === 'delete-slot'}>
              {actionLoading === 'delete-slot' ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogActions>
        </Dialog>

        <Dialog open={Boolean(confirmRemoveSignup)} onClose={() => setConfirmRemoveSignup(null)}>
          <DialogTitle>Remove member from slot?</DialogTitle>
          <DialogContent>
            <Typography variant="body2">
              Remove {confirmRemoveSignup?.user?.fullName || confirmRemoveSignup?.user?.email || 'this member'} from the slot?
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmRemoveSignup(null)}>Cancel</Button>
            <Button color="error" onClick={handleRemoveSignup} disabled={actionLoading === 'remove-signup'}>
              {actionLoading === 'remove-signup' ? 'Removing...' : 'Remove'}
            </Button>
          </DialogActions>
        </Dialog>
      </CardContent>
    </Card>
  );
}
