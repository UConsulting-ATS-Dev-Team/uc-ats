import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { Delete as DeleteIcon, PeopleAlt as PeopleIcon, Save as SaveIcon, Send as SendIcon } from '@mui/icons-material';
import apiClient from '../../utils/api';
import TriggerFields, { defaultConfigFor } from './TriggerFields';

/**
 * Writing one automatic email: when it fires, what it says, how it looks.
 *
 * Saving never turns it on - that is the switch in the list, after "Who would
 * this reach?" - so an admin can save half-finished work safely.
 */

const TONES = [
  ['brand', 'Theme header'],
  ['success', 'Green'],
  ['danger', 'Red'],
  ['warning', 'Orange'],
  ['info', 'Blue'],
];

export const BLANK_EMAIL = {
  name: '',
  trigger: 'APPLICATION_STATUS',
  triggerConfig: defaultConfigFor('APPLICATION_STATUS'),
  subject: '',
  body: 'Hi {{firstName}},\n\n',
  marketing: false,
  format: 'DESIGNED',
  banner: 'brand',
  signatureId: null,
};

const STATUS_LABELS = { SENT: 'Sent', FAILED: 'Failed', SUPPRESSED: 'Unsubscribed', SENDING: 'Sending' };

const editable = (email) =>
  Object.fromEntries(Object.keys(BLANK_EMAIL).map((key) => [key, email?.[key] ?? BLANK_EMAIL[key]]));

export default function CustomEmailEditor({ email, options, signatures = [], onSaved, onDeleted }) {
  const [draft, setDraft] = useState(() => editable(email));
  const [mergeFields, setMergeFields] = useState([]);
  const [preview, setPreview] = useState({ loading: false, error: '', data: null });
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState({ severity: 'success', text: '' });
  const [reach, setReach] = useState(null);

  const saved = useMemo(() => editable(email), [email]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const forcedMarketing = draft.trigger === 'CYCLE_DATE';

  const update = (patch) => {
    setDraft((d) => ({ ...d, ...patch }));
    setMessage({ severity: 'success', text: '' });
    setReach(null);
  };

  // The fill-ins this trigger can supply.
  useEffect(() => {
    let cancelled = false;
    apiClient
      .post('/admin/automatic-emails/merge-fields', { trigger: draft.trigger, triggerConfig: draft.triggerConfig })
      .then((data) => !cancelled && setMergeFields(data.mergeFields ?? []))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [draft.trigger, draft.triggerConfig]);

  // The email as the server would render it, with sample values.
  const previewBody = JSON.stringify(draft);
  useEffect(() => {
    if (!draft.subject.trim() || !draft.body.trim()) return undefined;
    let cancelled = false;
    setPreview((p) => ({ ...p, loading: true }));
    const timer = setTimeout(() => {
      apiClient
        .post('/admin/automatic-emails/preview', { email: JSON.parse(previewBody) })
        .then((data) => !cancelled && setPreview({ loading: false, error: '', data }))
        .catch((err) => !cancelled && setPreview({ loading: false, error: err.serverMessage || 'Could not preview this', data: null }));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [previewBody, draft.subject, draft.body]);

  const run = (label, request, onDone) => {
    setBusy(label);
    setMessage({ severity: 'success', text: '' });
    request()
      .then(onDone)
      .catch((err) => setMessage({ severity: 'error', text: err.serverMessage || 'Something went wrong' }))
      .finally(() => setBusy(''));
  };

  const save = () =>
    run(
      'save',
      () => (email?.id ? apiClient.put(`/admin/automatic-emails/${email.id}`, { email: draft }) : apiClient.post('/admin/automatic-emails', { email: draft })),
      (data) => {
        // What the server stored (trimmed, normalised), so Save goes quiet
        // rather than offering to send the same thing again.
        setDraft(editable(data));
        setMessage({ severity: 'success', text: email?.enabled ? 'Saved. The next send uses this.' : 'Saved. It stays off until you turn it on.' });
        onSaved?.(data);
      }
    );

  const checkReach = () => run('reach', () => apiClient.post('/admin/automatic-emails/dry-run', { email: draft }), setReach);

  const sendTest = () =>
    run('test', () => apiClient.post('/admin/automatic-emails/test', { email: draft }), (data) =>
      setMessage({ severity: 'success', text: `Test sent to ${data.sentTo}. Only you received it.` })
    );

  const remove = () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete "${email.name}"? It stops sending, and its send history goes with it.`)) return;
    run('delete', () => apiClient.delete(`/admin/automatic-emails/${email.id}`), () => onDeleted?.());
  };

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(320px, 1fr) minmax(340px, 1fr)' }, gap: 3, alignItems: 'start' }}>
      <Stack spacing={2.5}>
        <TextField label="Name" value={draft.name} onChange={(e) => update({ name: e.target.value })} helperText="Only admins see this." />

        <Divider textAlign="left">
          <Typography variant="overline">When it sends</Typography>
        </Divider>
        <TextField
          select
          fullWidth
          label="Trigger"
          value={draft.trigger}
          onChange={(e) => update({ trigger: e.target.value, triggerConfig: defaultConfigFor(e.target.value) })}
        >
          {(options.triggers ?? []).map((t) => (
            <MenuItem key={t.id} value={t.id}>{t.label}</MenuItem>
          ))}
        </TextField>
        <TriggerFields trigger={draft.trigger} config={draft.triggerConfig} options={options} onChange={(triggerConfig) => update({ triggerConfig })} />
        <FormControlLabel
          control={<Checkbox checked={forcedMarketing || draft.marketing} disabled={forcedMarketing} onChange={(e) => update({ marketing: e.target.checked })} />}
          label={
            <Box>
              <Typography variant="body2">Marketing email</Typography>
              <Typography variant="caption" color="text.secondary">
                {forcedMarketing
                  ? 'Always on for a send to a saved audience.'
                  : 'Skips people who unsubscribed and adds an unsubscribe link. Leave off for emails about their own application or booking.'}
              </Typography>
            </Box>
          }
          sx={{ alignItems: 'flex-start' }}
        />

        <Divider textAlign="left">
          <Typography variant="overline">What it says</Typography>
        </Divider>
        <TextField label="Subject" value={draft.subject} onChange={(e) => update({ subject: e.target.value })} />
        <TextField
          label="Email"
          multiline
          minRows={8}
          value={draft.body}
          onChange={(e) => update({ body: e.target.value })}
          helperText="**bold**, *italics*, [links](https://…) and - lists work."
        />
        {mergeFields.length > 0 && (
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5, mt: 0.4 }}>
              Fill-ins:
            </Typography>
            {mergeFields.map((f) => (
              <Chip key={f} size="small" variant="outlined" label={`{{${f}}}`} sx={{ fontFamily: 'monospace' }} />
            ))}
          </Stack>
        )}

        <Divider textAlign="left">
          <Typography variant="overline">How it looks</Typography>
        </Divider>
        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
          <TextField select size="small" label="Format" value={draft.format} onChange={(e) => update({ format: e.target.value })} sx={{ minWidth: 150 }}>
            <MenuItem value="DESIGNED">Designed</MenuItem>
            <MenuItem value="PLAIN">Plain</MenuItem>
          </TextField>
          <TextField select size="small" label="Header colour" value={draft.banner} disabled={draft.format === 'PLAIN'} onChange={(e) => update({ banner: e.target.value })} sx={{ minWidth: 160 }}>
            {TONES.map(([id, label]) => (
              <MenuItem key={id} value={id}>{label}</MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="Signature"
            value={draft.signatureId ?? '__default__'}
            onChange={(e) => update({ signatureId: e.target.value === '__default__' ? null : e.target.value })}
            sx={{ minWidth: 200 }}
          >
            <MenuItem value="__default__">Default signature</MenuItem>
            <MenuItem value="OWN">No signature</MenuItem>
            {signatures.map((s) => (
              <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>
            ))}
          </TextField>
        </Stack>

        {message.text && <Alert severity={message.severity}>{message.text}</Alert>}

        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center">
          <Button variant="contained" startIcon={<SaveIcon />} disabled={Boolean(busy) || (email?.id && !dirty)} onClick={save}>
            {email?.id ? 'Save' : 'Create (stays off)'}
          </Button>
          <Button variant="outlined" startIcon={<PeopleIcon />} disabled={Boolean(busy)} onClick={checkReach}>
            Who would this reach?
          </Button>
          <Button startIcon={<SendIcon />} disabled={Boolean(busy)} onClick={sendTest}>
            Send test to me
          </Button>
          {email?.id && (
            <Button color="error" startIcon={<DeleteIcon />} disabled={Boolean(busy)} onClick={remove}>
              Delete
            </Button>
          )}
          {busy && <CircularProgress size={20} />}
        </Stack>

        {reach && (
          <Alert severity="info">
            {reach.note}
            {reach.sample?.length > 0 && (
              <Box component="ul" sx={{ m: 0, mt: 1, pl: 2.5 }}>
                {reach.sample.map((p) => (
                  <li key={p.email}>
                    {p.name} ({p.email})
                  </li>
                ))}
              </Box>
            )}
          </Alert>
        )}

        {email?.recent?.length > 0 && (
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Recent sends
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>To</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>When</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {email.recent.map((r) => (
                  <TableRow key={`${r.email}-${r.createdAt}`}>
                    <TableCell sx={{ wordBreak: 'break-all' }}>{r.email}</TableCell>
                    <TableCell title={r.reason ?? ''}>{STATUS_LABELS[r.status] ?? r.status}</TableCell>
                    <TableCell>{new Date(r.sentAt ?? r.createdAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
      </Stack>

      <Stack spacing={1} sx={{ minWidth: 0, position: { lg: 'sticky' }, top: { lg: 16 } }}>
        <Box sx={{ height: 4 }}>{preview.loading && <LinearProgress />}</Box>
        {preview.error && <Alert severity="warning">{preview.error}</Alert>}
        {preview.data ? (
          <>
            <Typography variant="caption" color="text.secondary" noWrap title={preview.data.subject}>
              Subject: {preview.data.subject}
            </Typography>
            <Box
              component="iframe"
              title="Custom email preview"
              srcDoc={preview.data.html}
              sandbox=""
              sx={{ width: '100%', height: { xs: 420, lg: '64vh' }, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: '#fff' }}
            />
          </>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Write a subject and an email to see it here, with sample names and dates.
          </Typography>
        )}
      </Stack>
    </Box>
  );
}
