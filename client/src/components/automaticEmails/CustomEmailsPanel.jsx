import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import { Add as AddIcon } from '@mui/icons-material';
import apiClient from '../../utils/api';
import CustomEmailEditor, { BLANK_EMAIL } from './CustomEmailEditor';

/**
 * Automatic emails an admin wrote. The switch is the only way one starts
 * sending, and it shows "who would this reach" before it does.
 */
export default function CustomEmailsPanel() {
  const [emails, setEmails] = useState(null);
  const [options, setOptions] = useState({});
  const [signatures, setSignatures] = useState([]);
  const [selected, setSelected] = useState(null); // full email, or BLANK for new
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(null); // { email, reach }
  const [toggling, setToggling] = useState('');

  const loadList = () =>
    apiClient
      .get('/admin/automatic-emails')
      .then(setEmails)
      .catch((err) => setError(err.serverMessage || 'Failed to load custom emails'));

  useEffect(() => {
    loadList();
    apiClient.get('/admin/automatic-emails/options').then(setOptions).catch(() => {});
    apiClient
      .get('/admin/email-templates/signatures')
      .then((data) => setSignatures(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  const open = (id) =>
    apiClient
      .get(`/admin/automatic-emails/${id}`)
      .then(setSelected)
      .catch((err) => setError(err.serverMessage || 'Failed to open that email'));

  const askToEnable = (email) => {
    setToggling(email.id);
    apiClient
      .post('/admin/automatic-emails/dry-run', { email })
      .then((reach) => setConfirm({ email, reach }))
      .catch((err) => setError(err.serverMessage || 'Could not check who this reaches'))
      .finally(() => setToggling(''));
  };

  const setEnabled = (email, enabled) => {
    setConfirm(null);
    setToggling(email.id);
    apiClient
      .put(`/admin/automatic-emails/${email.id}/enabled`, { enabled })
      .then((updated) => {
        loadList();
        if (selected?.id === email.id) setSelected(updated);
      })
      .catch((err) => setError(err.serverMessage || 'Could not turn it on or off'))
      .finally(() => setToggling(''));
  };

  if (!emails) {
    return error ? (
      <Alert severity="error">{error}</Alert>
    ) : (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '300px 1fr' }, gap: 3, alignItems: 'start' }}>
      <Box>
        <Button fullWidth variant="outlined" startIcon={<AddIcon />} onClick={() => setSelected({ ...BLANK_EMAIL })} sx={{ mb: 1 }}>
          New automatic email
        </Button>
        {emails.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            None yet. Write one to email people when something happens: an application reaches a status, someone RSVPs,
            an interview is tomorrow.
          </Typography>
        ) : (
          <List dense disablePadding>
            {emails.map((email) => (
              <ListItemButton key={email.id} selected={selected?.id === email.id} onClick={() => open(email.id)} sx={{ alignItems: 'flex-start' }}>
                <ListItemText
                  primary={email.name}
                  secondary={
                    <>
                      {email.triggerSummary}
                      <br />
                      {(email.stats?.SENT ?? 0)} sent
                      {email.stats?.FAILED ? `, ${email.stats.FAILED} failed` : ''}
                    </>
                  }
                  slotProps={{ primary: { variant: 'body2' } }}
                />
                <Stack alignItems="flex-end" onClick={(e) => e.stopPropagation()}>
                  <Switch
                    size="small"
                    checked={email.enabled}
                    disabled={toggling === email.id}
                    onChange={(e) => (e.target.checked ? askToEnable(email) : setEnabled(email, false))}
                    slotProps={{ input: { 'aria-label': `${email.enabled ? 'Turn off' : 'Turn on'} ${email.name}` } }}
                  />
                  {email.marketing && <Chip size="small" variant="outlined" label="Marketing" />}
                </Stack>
              </ListItemButton>
            ))}
          </List>
        )}
      </Box>

      <Box sx={{ minWidth: 0 }}>
        {error && (
          <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {selected ? (
          <CustomEmailEditor
            key={selected.id ?? 'new'}
            email={selected.id ? selected : null}
            options={options}
            signatures={signatures}
            onSaved={(saved) => {
              setSelected(saved);
              loadList();
            }}
            onDeleted={() => {
              setSelected(null);
              loadList();
            }}
          />
        ) : (
          <Typography variant="body2" color="text.secondary">
            Pick an email, or write a new one. New emails stay off until you turn them on.
          </Typography>
        )}
      </Box>

      <Dialog open={Boolean(confirm)} onClose={() => setConfirm(null)}>
        <DialogTitle>Turn on &quot;{confirm?.email.name}&quot;?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            It will send {confirm?.email.triggerSummary?.toLowerCase()}, starting now, without anyone pressing send.
          </DialogContentText>
          <Alert severity="info" sx={{ mt: 2 }}>
            {confirm?.reach.note}
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>Not yet</Button>
          <Button variant="contained" onClick={() => setEnabled(confirm.email, true)}>
            Turn on
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
