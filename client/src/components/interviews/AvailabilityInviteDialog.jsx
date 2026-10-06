import React, { useEffect, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  ListItemText,
  TextField,
  Typography,
} from '@mui/material';
import apiClient from '../../utils/api';

/**
 * Pick the members to ask for availability on an invite-only round.
 *
 * Final round is staffed by people recruitment chooses, so instead of emailing
 * the roster the admin names who to ask. Those members are invited (only they
 * see the form on My Interviews) and emailed. People already invited are left
 * out of the list; "Chase" on the coverage panel re-asks them.
 */
export default function AvailabilityInviteDialog({ open, onClose, interviewId, staff, onSent }) {
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setPicked([]);
      setError('');
    }
  }, [open]);

  const options = (staff ?? []).filter((u) => !u.invited);

  const send = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await apiClient.post(`/admin/interviews/${interviewId}/request-availability`, {
        userIds: picked.map((u) => u.id),
      });
      onSent?.(result);
      onClose();
    } catch (e) {
      setError(e.message || 'Failed to send that request.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Ask members for final round availability</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Only the members you pick see this round on My Interviews, and only their answers count
          towards the grid. Each one gets an email asking when they are free.
        </Typography>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Autocomplete
          multiple
          disableCloseOnSelect
          options={options}
          value={picked}
          onChange={(_, value) => setPicked(value)}
          getOptionLabel={(u) => u.fullName ?? u.email}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          renderOption={(props, u) => (
            <li {...props} key={u.id}>
              <ListItemText primary={u.fullName ?? u.email} secondary={u.email} />
            </li>
          )}
          renderInput={(params) => <TextField {...params} label="Members to ask" autoFocus />}
          noOptionsText="Everyone has already been asked"
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={send} disabled={busy || picked.length === 0}>
          {picked.length === 0 ? 'Send request' : `Ask ${picked.length} ${picked.length === 1 ? 'member' : 'members'}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
