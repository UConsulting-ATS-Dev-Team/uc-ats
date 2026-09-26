import React, { useEffect, useMemo, useState } from 'react';
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
  FormControlLabel,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { Add as AddIcon, Delete as DeleteIcon, Save as SaveIcon } from '@mui/icons-material';
import apiClient from '../utils/api';
import useDraftPreview from '../hooks/useDraftPreview';
import EmailPreviewFrame from './EmailPreviewFrame';

/**
 * Named sign-offs any automatic email can end with.
 *
 * The default one replaces every email's own sign-off unless that email's
 * Style tab says otherwise. With none marked default, nothing changes until
 * an email is pointed at one - so creating a signature is safe on its own.
 */

const EMPTY = { name: '', body: '', imageUrl: '', isDefault: false };

// An email with a plain sign-off, to preview a signature against.
const PREVIEW_KEY = 'password-reset';

export default function EmailSignaturesEditor({ onSaved }) {
  const [signatures, setSignatures] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(EMPTY);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = (keepId) =>
    apiClient
      .get('/admin/email-templates/signatures')
      .then((data) => {
        setSignatures(data);
        const next = data.find((s) => s.id === keepId) ?? null;
        setSelectedId(next?.id ?? null);
        setDraft(next ? { ...next, imageUrl: next.imageUrl ?? '' } : EMPTY);
      })
      .catch((err) => setLoadError(err.serverMessage || 'Failed to load signatures'));

  useEffect(() => {
    load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = signatures?.find((s) => s.id === selectedId) ?? null;
  const dirty = useMemo(() => {
    const base = selected ? { ...selected, imageUrl: selected.imageUrl ?? '' } : EMPTY;
    return ['name', 'body', 'imageUrl', 'isDefault'].some((field) => draft[field] !== base[field]);
  }, [draft, selected]);

  const preview = useDraftPreview(PREVIEW_KEY, draft.body.trim() ? { signature: { body: draft.body, imageUrl: draft.imageUrl || null } } : null);

  const pick = (signature) => {
    setSelectedId(signature?.id ?? null);
    setDraft(signature ? { ...signature, imageUrl: signature.imageUrl ?? '' } : EMPTY);
    setError('');
    setNotice('');
  };

  const update = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setError('');
    setNotice('');
  };

  const save = () => {
    setSaving(true);
    setError('');
    const payload = { signature: { ...draft, imageUrl: draft.imageUrl || null } };
    const request = selectedId
      ? apiClient.put(`/admin/email-templates/signatures/${selectedId}`, payload)
      : apiClient.post('/admin/email-templates/signatures', payload);
    request
      .then((saved) => load(saved.id).then(() => setNotice(draft.isDefault ? 'Saved. Every email without its own choice now ends with this signature.' : 'Saved.')))
      .then(() => onSaved?.())
      .catch((err) => setError(err.serverMessage || 'Failed to save the signature'))
      .finally(() => setSaving(false));
  };

  const remove = () => {
    setConfirmDelete(false);
    setSaving(true);
    apiClient
      .delete(`/admin/email-templates/signatures/${selectedId}`)
      .then(() => load(null))
      .then(() => {
        setNotice('Deleted. Emails that used it now use the default, or their own sign-off.');
        onSaved?.();
      })
      .catch((err) => setError(err.serverMessage || 'Failed to delete the signature'))
      .finally(() => setSaving(false));
  };

  if (loadError) return <Alert severity="error">{loadError}</Alert>;
  if (!signatures) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', lg: '240px minmax(280px, 380px) 1fr' },
        gap: 3,
        alignItems: 'start',
      }}
    >
      <Box>
        <Button fullWidth variant="outlined" startIcon={<AddIcon />} onClick={() => pick(null)} sx={{ mb: 1 }}>
          New signature
        </Button>
        {signatures.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            None yet. Every email ends with its own sign-off.
          </Typography>
        ) : (
          <List dense disablePadding>
            {signatures.map((signature) => (
              <ListItemButton key={signature.id} selected={signature.id === selectedId} onClick={() => pick(signature)}>
                <ListItemText primary={signature.name} slotProps={{ primary: { variant: 'body2' } }} />
                {signature.isDefault && <Chip size="small" color="primary" variant="outlined" label="Default" />}
              </ListItemButton>
            ))}
          </List>
        )}
      </Box>

      <Stack spacing={2.5}>
        <Typography variant="subtitle1">{selected ? `Edit "${selected.name}"` : 'New signature'}</Typography>
        <TextField label="Name" value={draft.name} onChange={(event) => update('name', event.target.value)} helperText="Only admins see this." />
        <TextField
          label="Signature"
          multiline
          minRows={4}
          value={draft.body}
          onChange={(event) => update('body', event.target.value)}
          helperText="One line per line. **bold**, *italics* and [links](https://…) work."
        />
        <TextField
          label="Image URL"
          value={draft.imageUrl}
          placeholder="https://…"
          onChange={(event) => update('imageUrl', event.target.value.trim())}
          helperText="Optional. An https:// image under the text, about 48px tall."
        />
        <FormControlLabel
          control={<Switch checked={draft.isDefault} onChange={(event) => update('isDefault', event.target.checked)} />}
          label="Default: use on every email that has not picked its own"
        />

        {error && <Alert severity="error">{error}</Alert>}
        {notice && !dirty && <Alert severity="success">{notice}</Alert>}

        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <Button variant="contained" startIcon={<SaveIcon />} disabled={saving || !dirty || !draft.name.trim() || !draft.body.trim()} onClick={save}>
            {selected ? 'Save signature' : 'Create signature'}
          </Button>
          {selected && (
            <Button color="error" startIcon={<DeleteIcon />} disabled={saving} onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
          {saving && <CircularProgress size={20} />}
        </Stack>
      </Stack>

      <Stack spacing={1} sx={{ minWidth: 0 }}>
        <Typography variant="caption" color="text.secondary">
          How it looks at the end of an email
        </Typography>
        {draft.body.trim() ? (
          <EmailPreviewFrame preview={preview} />
        ) : (
          <Typography variant="body2" color="text.secondary">
            Write a signature to see it here.
          </Typography>
        )}
      </Stack>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <DialogTitle>Delete &quot;{selected?.name}&quot;?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Emails that use it will end with the default signature instead, or their own sign-off if there is no
            default. Nothing already sent changes.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(false)}>Keep it</Button>
          <Button color="error" onClick={remove}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
