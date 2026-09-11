import React, { useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography
} from '@mui/material';
import { LockClosedIcon } from '@heroicons/react/24/outline';

export default function ExecUnlockDialog({ open, onClose, onUnlock }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const close = () => {
    if (submitting) return;
    setPassword('');
    setError('');
    onClose();
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!password) return;

    setSubmitting(true);
    setError('');
    try {
      await onUnlock(password);
      setPassword('');
      onClose();
    } catch (err) {
      setError(err.serverMessage || err.message || 'Could not unlock executive access.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
      <form onSubmit={submit}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <LockClosedIcon style={{ width: 20, height: 20 }} aria-hidden="true" />
          Executive access
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Sealed records hold members' recruiting scores, feedback and applications.
            Enter the executive committee password to view them for the next 30 minutes.
            Every unlock is logged.
          </Typography>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          <TextField
            autoFocus
            fullWidth
            type="password"
            label="Executive password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="off"
            disabled={submitting}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={close} disabled={submitting}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={!password || submitting}>
            {submitting ? <CircularProgress size={18} /> : 'Unlock'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
