// Setting up the hourly Luma sync, without leaving the app.
//
// The sync needs a bearer token that the routine and the ATS both know. It used
// to be an environment variable on Render, which meant the one step nobody
// could do from the ATS was also the step that gated the whole integration.
// Here an admin generates the token and copies a prompt that already carries
// it, so the only thing left to do is paste it into a Claude routine.
//
// The prompt is therefore a secret, and the dialog says so rather than leaving
// it to be worked out: it is the token in a form that looks like documentation.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Link,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import apiClient from '../utils/api';

const SETTINGS = [
  ['Schedule', 'Hourly — the shortest interval routines allow.'],
  ['Connectors', 'Luma only, signed in as the club account (uconsultingla@gmail.com).'],
  ['Network', 'Custom, allowing only this ATS host.'],
  ['Prompt', 'The text below, pasted whole.'],
];

/**
 * Copy text, reporting whether it worked.
 *
 * navigator.clipboard is absent on an insecure origin and can be refused even
 * on a secure one, and the prompt is long enough that "select it by hand" is a
 * bad outcome — so a failure says so and leaves the text selectable rather than
 * pretending it copied.
 */
async function copyText(value) {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export default function LumaSyncSetupDialog({ open, onClose }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [confirmingRotate, setConfirmingRotate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setState(await apiClient.get('/admin/luma/sync-token'));
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not load the sync token.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setCopied('');
    setConfirmingRotate(false);
    load();
  }, [open, load]);

  const generate = async () => {
    setWorking(true);
    setError('');
    try {
      setState(await apiClient.post('/admin/luma/sync-token'));
      setConfirmingRotate(false);
      setCopied('');
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not generate a token.');
    } finally {
      setWorking(false);
    }
  };

  const copy = async (what, value) => {
    const ok = await copyText(value);
    setCopied(ok ? what : '');
    if (!ok) setError('Could not reach the clipboard — select the text and copy it by hand.');
  };

  const hasToken = Boolean(state?.token);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Luma sync setup</DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress /></Stack>
        ) : (
          <Stack spacing={2}>
            {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

            {!state?.configured && (
              <Alert severity="warning">
                No sync token exists, so <code>/api/integrations/luma</code> answers 503 and nothing
                syncs. Generate one to start.
              </Alert>
            )}

            {state?.envTokenSet && (
              <Alert severity="info">
                A <code>LUMA_SYNC_TOKEN</code> is also set in the server environment, and it keeps
                working. A routine already using it does not need changing.
              </Alert>
            )}

            <Box>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <Typography variant="subtitle2">Sync token</Typography>
                {hasToken && <Chip size="small" color="success" label="Generated" />}
              </Stack>
              <TextField
                fullWidth
                size="small"
                value={state?.token || 'None generated'}
                InputProps={{ readOnly: true, sx: { fontFamily: 'monospace' } }}
                helperText={
                  state?.tokenSetAt
                    ? `Generated ${new Date(state.tokenSetAt).toLocaleString()}. It is stored so it can be shown here.`
                    : 'Generated tokens are stored so they can be read back into the routine prompt.'
                }
              />
              <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                {hasToken && (
                  <Button size="small" onClick={() => copy('token', state.token)}>
                    {copied === 'token' ? 'Copied' : 'Copy token'}
                  </Button>
                )}
                {hasToken && !confirmingRotate && (
                  <Button size="small" color="warning" onClick={() => setConfirmingRotate(true)}>
                    Generate a new one
                  </Button>
                )}
                {!hasToken && (
                  <Button size="small" variant="contained" onClick={generate} disabled={working}>
                    {working ? <CircularProgress size={18} /> : 'Generate token'}
                  </Button>
                )}
              </Stack>
              {confirmingRotate && (
                <Alert
                  severity="warning"
                  sx={{ mt: 1 }}
                  action={
                    <Stack direction="row" spacing={1}>
                      <Button size="small" onClick={() => setConfirmingRotate(false)}>Cancel</Button>
                      <Button size="small" color="warning" variant="contained" onClick={generate} disabled={working}>
                        Replace it
                      </Button>
                    </Stack>
                  }
                >
                  The current token stops working immediately. The routine will fail every hour with
                  401 until you paste the new prompt into it.
                </Alert>
              )}
            </Box>

            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>Routine settings</Typography>
              <Stack spacing={0.5}>
                {SETTINGS.map(([label, detail]) => (
                  <Typography key={label} variant="body2" color="text.secondary">
                    <strong>{label}:</strong> {detail}
                  </Typography>
                ))}
              </Stack>
            </Box>

            <Box>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
                <Typography variant="subtitle2">Routine prompt</Typography>
                <Button size="small" variant="contained" onClick={() => copy('prompt', state?.prompt || '')}>
                  {copied === 'prompt' ? 'Copied' : 'Copy prompt'}
                </Button>
              </Stack>
              {hasToken && (
                <Alert severity="warning" sx={{ mb: 1 }}>
                  This prompt contains the token. Treat it like a password: paste it into the routine
                  and nowhere else.
                </Alert>
              )}
              <TextField
                fullWidth
                multiline
                minRows={10}
                maxRows={18}
                value={state?.prompt || ''}
                InputProps={{ readOnly: true, sx: { fontFamily: 'monospace', fontSize: 12 } }}
              />
            </Box>

            <Typography variant="body2" color="text.secondary">
              Each event still needs creating under the club account, a required question whose label
              contains “UID”, and its Luma link pasted into the ATS event. Full setup and what the
              routine may do is in <Link href="https://github.com/UConsulting-ATS-Dev-Team/uc-ats/blob/main/docs/luma-sync-routine.md" target="_blank" rel="noopener noreferrer">docs/luma-sync-routine.md</Link>.
            </Typography>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
