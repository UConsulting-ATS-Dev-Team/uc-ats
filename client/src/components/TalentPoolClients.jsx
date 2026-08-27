import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import apiClient from '../utils/api';
import ClientAssignBuilder from './ClientAssignBuilder';

// Client accounts for the Talent Partner Network, rendered as a tab on the TPN
// page. Deliberately not a separate nav entry - a second "partner" concept next
// to the existing one would be confusing.

const VISIBILITY_HELP = {
  BLIND: 'Redacted resume only. No name, gender, contact details, or GPA. Applicants with no redacted resume on file cannot be shared with this client.',
  BASIC: 'Real resume, plus name, gender, major and graduation year. No contact details or GPA.',
  FULL: 'Everything: real resume, name, contact details, and GPA.',
};

const VISIBILITY_COLOR = { BLIND: 'default', BASIC: 'primary', FULL: 'warning' };

const emptyForm = {
  organization: '',
  fullName: '',
  email: '',
  password: '',
  visibility: 'BLIND',
  notes: '',
};

const TalentPoolClients = () => {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [assignFor, setAssignFor] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setClients(await apiClient.get('/admin/talent-pool/clients'));
      setError('');
    } catch (err) {
      setError(err.message || 'Failed to load partner clients');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!success) return undefined;
    const t = setTimeout(() => setSuccess(''), 4000);
    return () => clearTimeout(t);
  }, [success]);

  const handleCreate = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiClient.post('/admin/talent-pool/clients', form);
      setCreateOpen(false);
      setForm(emptyForm);
      setSuccess('Partner client created. Send them the email and password you just set.');
      await load();
    } catch (err) {
      setError(err.message || 'Failed to create partner client');
    } finally {
      setSaving(false);
    }
  };

  const handleVisibilityChange = async (client, visibility) => {
    try {
      const { warnings } = await apiClient.patch(`/admin/talent-pool/clients/${client.id}`, {
        visibility,
      });
      if (warnings?.blindUnavailable > 0) {
        setSuccess(
          `Visibility updated. ${warnings.blindUnavailable} already-shared resume(s) have no redacted version and will show as unavailable to this client.`
        );
      } else {
        setSuccess('Visibility updated.');
      }
      await load();
    } catch (err) {
      setError(err.message || 'Failed to update visibility');
    }
  };

  const handleDeactivate = async (client) => {
    const isActive = client.user?.isActive !== false;
    const message = isActive
      ? `Deactivate ${client.organization}? They will no longer be able to sign in. Their assignments are kept.`
      : `Reactivate ${client.organization}? They will be able to sign in again.`;
    if (!window.confirm(message)) return;

    try {
      await apiClient.patch(`/users/${client.user.id}/${isActive ? 'deactivate' : 'reactivate'}`, {});
      setSuccess(isActive ? 'Client deactivated.' : 'Client reactivated.');
      await load();
    } catch (err) {
      setError(err.message || 'Failed to update the account');
    }
  };

  if (assignFor) {
    return (
      <ClientAssignBuilder
        client={assignFor}
        onDone={() => {
          setAssignFor(null);
          load();
        }}
      />
    );
  }

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        justifyContent="space-between"
        alignItems={{ md: 'center' }}
        spacing={1}
        sx={{ mb: 2 }}
      >
        <Typography variant="body2" color="text.secondary">
          Outside organizations with portal access. Only resumes you explicitly assign are visible
          to them, and only from applicants who opted in.
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
          Add Client
        </Button>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>
          {success}
        </Alert>
      )}

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      )}

      {!loading && clients.length === 0 && (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="h6" gutterBottom>
            No partner clients yet
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Add one to give an outside organization access to a set of resumes.
          </Typography>
        </Paper>
      )}

      <Grid container spacing={2}>
        {clients.map((client) => {
          const inactive = client.user?.isActive === false;
          return (
            <Grid item xs={12} sm={6} lg={4} key={client.id}>
              <Card variant="outlined" sx={{ height: '100%', opacity: inactive ? 0.6 : 1 }}>
                <CardContent>
                  <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
                    <Typography variant="h6">{client.organization}</Typography>
                    {inactive && <Chip size="small" label="Deactivated" color="error" />}
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {client.user?.fullName}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {client.user?.email}
                  </Typography>

                  <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                    <Chip
                      size="small"
                      label={client.visibility}
                      color={VISIBILITY_COLOR[client.visibility] || 'default'}
                    />
                    <Chip size="small" variant="outlined" label={`${client.assignmentCount} resumes`} />
                  </Stack>

                  <Divider sx={{ my: 2 }} />

                  <FormControl fullWidth size="small">
                    <InputLabel id={`visibility-label-${client.id}`}>Visibility</InputLabel>
                    <Select
                      labelId={`visibility-label-${client.id}`}
                      value={client.visibility}
                      label="Visibility"
                      onChange={(e) => handleVisibilityChange(client, e.target.value)}
                    >
                      {Object.keys(VISIBILITY_HELP).map((v) => (
                        <MenuItem key={v} value={v}>
                          {v}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                    {VISIBILITY_HELP[client.visibility]}
                  </Typography>
                </CardContent>

                <CardActions>
                  <Button size="small" variant="contained" onClick={() => setAssignFor(client)}>
                    Assign resumes
                  </Button>
                  <Button size="small" color={inactive ? 'success' : 'error'} onClick={() => handleDeactivate(client)}>
                    {inactive ? 'Reactivate' : 'Deactivate'}
                  </Button>
                </CardActions>
              </Card>
            </Grid>
          );
        })}
      </Grid>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add Partner Client</DialogTitle>
        <form onSubmit={handleCreate}>
          <DialogContent>
            <Stack spacing={2}>
              <TextField
                fullWidth
                required
                label="Organization"
                value={form.organization}
                onChange={(e) => setForm({ ...form, organization: e.target.value })}
              />
              <TextField
                fullWidth
                required
                label="Contact name"
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
              />
              <TextField
                fullWidth
                required
                type="email"
                label="Login email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
              <TextField
                fullWidth
                required
                label="Password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                helperText="At least 12 characters. There is no self-service reset for these accounts, so send it to them securely."
              />
              <FormControl fullWidth>
                <InputLabel id="new-client-visibility-label">Visibility</InputLabel>
                <Select
                  labelId="new-client-visibility-label"
                  value={form.visibility}
                  label="Visibility"
                  onChange={(e) => setForm({ ...form, visibility: e.target.value })}
                >
                  {Object.keys(VISIBILITY_HELP).map((v) => (
                    <MenuItem key={v} value={v}>
                      {v}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Alert severity="info">{VISIBILITY_HELP[form.visibility]}</Alert>
              <TextField
                fullWidth
                multiline
                minRows={2}
                label="Notes (internal)"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={saving}>
              Create Client
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Box>
  );
};

export default TalentPoolClients;
