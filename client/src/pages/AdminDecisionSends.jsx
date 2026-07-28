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
  Button,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Stack,
} from '@mui/material';
import api from '../utils/api';

const STATUS_COLORS = {
  SENDING: 'warning',
  UNKNOWN: 'warning',
  SENT: 'success',
  FAILED: 'error',
};

export default function AdminDecisionSends() {
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [total, setTotal] = useState(0);
  const [reconcileApp, setReconcileApp] = useState(null);
  const [reconcileStatus, setReconcileStatus] = useState('SENT');
  const [reconcileMessageId, setReconcileMessageId] = useState('');
  const [reconcileReason, setReconcileReason] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('page', page + 1);
      params.set('limit', rowsPerPage);
      const data = await api.get(`/admin/decision-sends?${params.toString()}`);
      setApplications(data.applications || []);
      setTotal(data.total || 0);
    } catch (e) {
      setError(e.message || 'Failed to load decision sends.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [page, rowsPerPage]);

  const handleChangePage = (_, newPage) => setPage(newPage);
  const handleChangeRowsPerPage = (e) => {
    setRowsPerPage(parseInt(e.target.value, 10));
    setPage(0);
  };

  const openReconcile = (app) => {
    setReconcileApp(app);
    setReconcileStatus('SENT');
    setReconcileMessageId('');
    setReconcileReason('');
  };

  const handleReconcile = async () => {
    setActionError('');
    try {
      await api.post(`/admin/decision-sends/${reconcileApp.id}/reconcile`, {
        status: reconcileStatus,
        messageId: reconcileMessageId || undefined,
        reason: reconcileReason || undefined,
      });
      setReconcileApp(null);
      await load();
    } catch (e) {
      setActionError(e.message || 'Failed to reconcile decision send.');
    }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>
        Final Decision Sends
      </Typography>

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
                  <TableCell>Attempted At</TableCell>
                  <TableCell>Message ID</TableCell>
                  <TableCell>Reconciled</TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {applications.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} align="center">
                      No ambiguous final-decision sends found.
                    </TableCell>
                  </TableRow>
                )}
                {applications.map((app) => (
                  <TableRow key={app.id}>
                    <TableCell>
                      {app.firstName} {app.lastName}
                      <br />
                      <Typography variant="caption" color="text.secondary">
                        {app.email}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={app.decisionSendStatus || 'UNKNOWN'}
                        color={STATUS_COLORS[app.decisionSendStatus] || 'default'}
                        size="small"
                      />
                    </TableCell>
                    <TableCell>
                      {app.decisionSendAttemptedAt
                        ? new Date(app.decisionSendAttemptedAt).toLocaleString()
                        : '-'}
                    </TableCell>
                    <TableCell>{app.decisionSendMessageId || '-'}</TableCell>
                    <TableCell>
                      {app.decisionSendReconciledBy ? (
                        <Typography variant="caption" display="block">
                          {app.decisionSendReconciledBy}
                          <br />
                          {new Date(app.decisionSendReconciledAt).toLocaleString()}
                        </Typography>
                      ) : (
                        '-'
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="small"
                        variant="contained"
                        onClick={() => openReconcile(app)}
                      >
                        Reconcile
                      </Button>
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

      <Dialog open={!!reconcileApp} onClose={() => setReconcileApp(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Reconcile Final Decision Send</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <FormControl fullWidth>
              <InputLabel id="decision-reconcile-status-label">Verified Status</InputLabel>
              <Select
                labelId="decision-reconcile-status-label"
                value={reconcileStatus}
                label="Verified Status"
                onChange={(e) => setReconcileStatus(e.target.value)}
              >
                <MenuItem value="SENT">SENT (provider confirmed delivery)</MenuItem>
                <MenuItem value="FAILED">FAILED (provider confirmed not sent)</MenuItem>
              </Select>
            </FormControl>
            {reconcileStatus === 'SENT' && (
              <TextField
                label="Provider Message ID"
                value={reconcileMessageId}
                onChange={(e) => setReconcileMessageId(e.target.value)}
                fullWidth
                required
                helperText="The provider-assigned message id proves delivery."
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
          <Button onClick={() => setReconcileApp(null)}>Cancel</Button>
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
