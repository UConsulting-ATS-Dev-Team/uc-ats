import React, { useState, useEffect } from 'react';
import {
  Box,
  Paper,
  Typography,
  CircularProgress,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Button,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Stack,
  IconButton,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import api from '../utils/api';

const STATUS_COLORS = {
  PENDING: 'default',
  PROCESSING: 'warning',
  SENDING: 'warning',
  SENT: 'success',
  FAILED: 'error',
  CANCELLED: 'default',
  UNKNOWN: 'warning',
};

export default function AdminFeedbackJobs() {
  const [jobs, setJobs] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [cycleId, setCycleId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [total, setTotal] = useState(0);
  const [reconcileJob, setReconcileJob] = useState(null);
  const [reconcileStatus, setReconcileStatus] = useState('SENT');
  const [reconcileMessageId, setReconcileMessageId] = useState('');
  const [reconcileReason, setReconcileReason] = useState('');

  useEffect(() => {
    const loadCycles = async () => {
      try {
        const data = await api.get('/admin/cycles');
        setCycles(data || []);
      } catch (e) {
        console.error('Failed to load cycles:', e);
      }
    };
    loadCycles();
  }, []);

  const loadJobs = async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (cycleId) params.set('cycleId', cycleId);
      if (statusFilter) params.set('status', statusFilter);
      params.set('page', page + 1);
      params.set('limit', rowsPerPage);
      const data = await api.get(`/admin/feedback-jobs?${params.toString()}`);
      setJobs(data.jobs || []);
      setTotal(data.total || 0);
    } catch (e) {
      setError(e.message || 'Failed to load feedback jobs.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadJobs();
  }, [cycleId, statusFilter, page, rowsPerPage]);

  const handleChangePage = (_, newPage) => setPage(newPage);
  const handleChangeRowsPerPage = (e) => {
    setRowsPerPage(parseInt(e.target.value, 10));
    setPage(0);
  };

  const handleProcess = async () => {
    setProcessing(true);
    setActionError('');
    try {
      await api.post('/admin/feedback-jobs/process');
      await loadJobs();
    } catch (e) {
      setActionError(e.message || 'Failed to process jobs.');
    } finally {
      setProcessing(false);
    }
  };

  const handleRetry = async (id) => {
    setActionError('');
    try {
      await api.post(`/admin/feedback-jobs/${id}/retry`);
      await loadJobs();
    } catch (e) {
      setActionError(e.message || 'Failed to retry job.');
    }
  };

  const openReconcile = (job) => {
    setReconcileJob(job);
    setReconcileStatus('SENT');
    setReconcileMessageId('');
    setReconcileReason('');
  };

  const handleReconcile = async () => {
    setActionError('');
    try {
      await api.post(`/admin/feedback-jobs/${reconcileJob.id}/reconcile`, {
        status: reconcileStatus,
        messageId: reconcileMessageId || undefined,
        reason: reconcileReason || undefined,
      });
      setReconcileJob(null);
      await loadJobs();
    } catch (e) {
      setActionError(e.message || 'Failed to reconcile job.');
    }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>
        Feedback Request Jobs
      </Typography>

      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
          <FormControl sx={{ minWidth: 240 }}>
            <InputLabel id="cycle-filter-label">Recruiting Cycle</InputLabel>
            <Select
              labelId="cycle-filter-label"
              value={cycleId}
              label="Recruiting Cycle"
              onChange={(e) => setCycleId(e.target.value)}
            >
              <MenuItem value="">All cycles</MenuItem>
              {cycles.map((c) => (
                <MenuItem key={c.id} value={c.id}>
                  {c.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl sx={{ minWidth: 160 }}>
            <InputLabel id="status-filter-label">Status</InputLabel>
            <Select
              labelId="status-filter-label"
              value={statusFilter}
              label="Status"
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <MenuItem value="">All</MenuItem>
              <MenuItem value="PENDING">PENDING</MenuItem>
              <MenuItem value="PROCESSING">PROCESSING</MenuItem>
              <MenuItem value="SENDING">SENDING</MenuItem>
              <MenuItem value="SENT">SENT</MenuItem>
              <MenuItem value="FAILED">FAILED</MenuItem>
              <MenuItem value="CANCELLED">CANCELLED</MenuItem>
              <MenuItem value="UNKNOWN">UNKNOWN</MenuItem>
            </Select>
          </FormControl>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={handleProcess}
            disabled={processing}
          >
            {processing ? 'Processing...' : 'Process Due Jobs'}
          </Button>
        </Stack>
      </Paper>

      {(error || actionError) && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error || actionError}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Paper>
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Candidate</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Due At</TableCell>
                  <TableCell>Sent At</TableCell>
                  <TableCell>Attempts</TableCell>
                  <TableCell>Last Error</TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {jobs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} align="center">
                      No feedback jobs found.
                    </TableCell>
                  </TableRow>
                )}
                {jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>
                      {job.application
                        ? `${job.application.firstName} ${job.application.lastName}`
                        : 'Unknown'}
                      <br />
                      <Typography variant="caption" color="text.secondary">
                        {job.application?.email}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip label={job.status} color={STATUS_COLORS[job.status] || 'default'} size="small" />
                    </TableCell>
                    <TableCell>{job.dueAt ? new Date(job.dueAt).toLocaleString() : '-'}</TableCell>
                    <TableCell>{job.sentAt ? new Date(job.sentAt).toLocaleString() : '-'}</TableCell>
                    <TableCell>{job.attempts}</TableCell>
                    <TableCell>{job.lastError || '-'}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1}>
                        {(job.status === 'FAILED' || job.status === 'CANCELLED' || job.status === 'PENDING') && (
                          <Button size="small" variant="outlined" onClick={() => handleRetry(job.id)}>
                            Retry
                          </Button>
                        )}
                        {(job.status === 'UNKNOWN' || job.status === 'SENDING' || job.status === 'PROCESSING') && (
                          <Button size="small" variant="contained" onClick={() => openReconcile(job)}>
                            Reconcile
                          </Button>
                        )}
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={total}
            page={page}
            onPageChange={handleChangePage}
            rowsPerPage={rowsPerPage}
            onRowsPerPageChange={handleChangeRowsPerPage}
            rowsPerPageOptions={[10, 25, 50, 100]}
          />
        </Paper>
      )}

      <Dialog open={!!reconcileJob} onClose={() => setReconcileJob(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Reconcile Feedback Job</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <FormControl fullWidth>
              <InputLabel id="reconcile-status-label">Verified Status</InputLabel>
              <Select
                labelId="reconcile-status-label"
                value={reconcileStatus}
                label="Verified Status"
                onChange={(e) => setReconcileStatus(e.target.value)}
              >
                <MenuItem value="SENT">SENT</MenuItem>
                <MenuItem value="FAILED">FAILED</MenuItem>
              </Select>
            </FormControl>
            {reconcileStatus === 'SENT' && (
              <TextField
                label="Provider Message ID"
                value={reconcileMessageId}
                onChange={(e) => setReconcileMessageId(e.target.value)}
                fullWidth
                required
                helperText="The message id from the email provider proves delivery."
              />
            )}
            {reconcileStatus === 'FAILED' && (
              <TextField
                label="Reason"
                value={reconcileReason}
                onChange={(e) => setReconcileReason(e.target.value)}
                fullWidth
                multiline
                rows={2}
              />
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReconcileJob(null)}>Cancel</Button>
          <Button
            onClick={handleReconcile}
            variant="contained"
            disabled={reconcileStatus === 'SENT' && !reconcileMessageId.trim()}
          >
            Confirm
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
