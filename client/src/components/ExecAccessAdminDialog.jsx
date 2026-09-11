import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography
} from '@mui/material';
import apiClient from '../utils/api';
import { useExecUnlock } from '../context/ExecUnlockContext';

const ACTION_LABELS = {
  UNLOCK_OK: 'Opened executive access',
  UNLOCK_FAILED: 'Entered a wrong password',
  UNLOCK_RATE_LIMITED: 'Blocked after repeated wrong passwords',
  LOCK_RECORD: 'Sealed a record',
  UNLOCK_RECORD: 'Unsealed a record',
  AUTO_LOCK: 'Sealed on becoming a member',
  BACKFILL_LOCK: 'Sealed by the one-time backfill',
  PASSWORD_SET: 'Changed the executive password'
};

// Password rotation and the audit trail for sealed records. Both need executive
// access, not just the admin role - otherwise any recruitment-committee admin
// could change the password out from under the executive committee.
export default function ExecAccessAdminDialog({ open, onClose }) {
  const { unlocked, version, openUnlockDialog } = useExecUnlock();
  const [logs, setLogs] = useState([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logError, setLogError] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState(null);

  useEffect(() => {
    if (!open || !unlocked) return undefined;
    let cancelled = false;
    setLoadingLogs(true);
    setLogError('');
    apiClient
      .get('/exec-access/logs?limit=100')
      .then((rows) => {
        if (!cancelled) setLogs(rows);
      })
      .catch((err) => {
        if (!cancelled) setLogError(err.serverMessage || err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingLogs(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, unlocked, version]);

  const changePassword = async (event) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setPasswordMessage({ severity: 'error', text: 'The two passwords do not match.' });
      return;
    }

    setSaving(true);
    setPasswordMessage(null);
    try {
      await apiClient.put('/exec-access/password', { newPassword });
      setNewPassword('');
      setConfirmPassword('');
      setPasswordMessage({
        severity: 'success',
        text: 'Executive password changed. Share the new one with the executive committee.'
      });
    } catch (err) {
      setPasswordMessage({ severity: 'error', text: err.serverMessage || err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Executive access</DialogTitle>
      <DialogContent dividers>
        {!unlocked ? (
          <Box sx={{ textAlign: 'center', py: 3 }}>
            <Typography sx={{ mb: 2 }}>
              Changing the executive password and reading the access log both need executive access.
            </Typography>
            <Button variant="contained" onClick={openUnlockDialog}>Enter executive password</Button>
          </Box>
        ) : (
          <>
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
              Change the executive password
            </Typography>
            <Box
              component="form"
              onSubmit={changePassword}
              sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start', mb: 2 }}
            >
              <TextField
                type="password"
                size="small"
                label="New password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                helperText="At least 12 characters"
              />
              <TextField
                type="password"
                size="small"
                label="Type it again"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
              />
              <Button type="submit" variant="outlined" disabled={saving || !newPassword}>
                {saving ? <CircularProgress size={18} /> : 'Change password'}
              </Button>
            </Box>
            {passwordMessage && (
              <Alert severity={passwordMessage.severity} sx={{ mb: 2 }}>{passwordMessage.text}</Alert>
            )}

            <Divider sx={{ my: 2 }} />

            <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>Access log</Typography>
            {logError && <Alert severity="error" sx={{ mb: 2 }}>{logError}</Alert>}
            {loadingLogs ? (
              <CircularProgress size={24} />
            ) : (
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>When</TableCell>
                      <TableCell>Who</TableCell>
                      <TableCell>What</TableCell>
                      <TableCell>Record</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {logs.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell>{new Date(log.createdAt).toLocaleString()}</TableCell>
                        <TableCell>{log.user?.fullName || (log.userId ? 'Unknown user' : 'System')}</TableCell>
                        <TableCell>{ACTION_LABELS[log.action] || log.action}</TableCell>
                        <TableCell>
                          {log.candidate ? `${log.candidate.firstName} ${log.candidate.lastName}` : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                    {!logs.length && (
                      <TableRow>
                        <TableCell colSpan={4}>No activity yet.</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </Box>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
