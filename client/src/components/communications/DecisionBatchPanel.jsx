import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Grid,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography
} from '@mui/material';
import { ArrowBack as ArrowBackIcon, Send as SendIcon } from '@mui/icons-material';
import apiClient from '../../utils/api';

// Decision emails queued by Process All Decisions on Staging. Nothing here sends
// on its own: each outcome (advancing, accepted, not moving forward) is reviewed
// and approved separately.

const STATUS_CHIPS = {
  PENDING: { label: 'Ready', color: 'default' },
  EXCLUDED: { label: 'Left out', color: 'default', variant: 'outlined' },
  SENDING: { label: 'Sending…', color: 'info' },
  SENT: { label: 'Sent', color: 'success' },
  FAILED: { label: 'Failed', color: 'error' }
};

const MERGE_FIELDS_BY_OUTCOME = {
  ADVANCED: ['firstName', 'lastName', 'fullName', 'cycleName', 'nextRoundName'],
  ACCEPTED: ['firstName', 'lastName', 'fullName', 'cycleName', 'accountSetup'],
  REJECTED: ['firstName', 'lastName', 'fullName', 'cycleName']
};

const batchesUrl = '/master-communications/decision-batches';
const countBy = (messages, status) => messages.filter((message) => message.status === status).length;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const personName = (message) => [message.firstName, message.lastName].filter(Boolean).join(' ');

function OutcomeGroup({ batchId, group, userEmail, onChanged, onNotice }) {
  const { outcome, template, messages } = group;
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [saving, setSaving] = useState(false);
  const [previewRecipientId, setPreviewRecipientId] = useState(messages[0]?.id || '');
  const [preview, setPreview] = useState(null);
  const [testing, setTesting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);

  // A reload after saving brings the stored wording back in.
  useEffect(() => {
    setSubject(template.subject);
    setBody(template.body);
  }, [template.subject, template.body]);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .post(`${batchesUrl}/${batchId}/preview`, { outcome, messageId: previewRecipientId || undefined })
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((error) => {
        if (!cancelled) onNotice({ severity: 'error', text: error.serverMessage || error.message });
      });
    return () => {
      cancelled = true;
    };
  }, [batchId, outcome, previewRecipientId, template.subject, template.body, onNotice]);

  const dirty = subject !== template.subject || body !== template.body;
  const ready = messages.filter((message) => message.status === 'PENDING');
  const reviewable = messages.filter((message) => message.status === 'PENDING' || message.status === 'EXCLUDED');
  const everythingSent = messages.length > 0 && reviewable.length === 0 && countBy(messages, 'FAILED') === 0;

  const run = async (work, successText) => {
    try {
      const result = await work();
      if (successText) onNotice({ severity: 'success', text: typeof successText === 'function' ? successText(result) : successText });
      return result;
    } catch (error) {
      onNotice({ severity: 'error', text: error.serverMessage || error.message });
      return null;
    } finally {
      await onChanged();
    }
  };

  const saveWording = async () => {
    setSaving(true);
    await run(() => apiClient.patch(`${batchesUrl}/${batchId}/templates`, { outcome, subject, body }), 'Wording saved.');
    setSaving(false);
  };

  const setIncluded = (targets, included) =>
    run(() => apiClient.patch(`${batchesUrl}/${batchId}/messages`, {
      messageIds: targets.map((message) => message.id),
      excluded: !included
    }));

  const sendTest = async () => {
    setTesting(true);
    try {
      const result = await apiClient.post(`${batchesUrl}/${batchId}/test`, { outcome });
      onNotice({ severity: 'success', text: `Test sent to ${result.sentTo}, filled in for ${result.sample.name || 'a sample recipient'}.` });
    } catch (error) {
      onNotice({ severity: 'error', text: error.serverMessage || error.message });
    } finally {
      setTesting(false);
    }
  };

  const confirmSend = async () => {
    setSending(true);
    await run(
      () => apiClient.post(`${batchesUrl}/${batchId}/send`, { outcome, expectedCount: ready.length }),
      (result) => result.failed
        ? `Sent ${plural(result.sent, 'email')}. ${result.failed} failed - they are marked below and can be retried.`
        : `Sent ${plural(result.sent, 'email')}.`
    );
    setSending(false);
    setConfirmOpen(false);
  };

  const retryFailed = () =>
    run(
      () => apiClient.post(`${batchesUrl}/${batchId}/retry`, { outcome }),
      (result) => `${plural(result.requeued, 'email')} back in the queue. Review and send when ready.`
    );

  const allIncluded = reviewable.length > 0 && reviewable.every((message) => message.status === 'PENDING');
  const someIncluded = reviewable.some((message) => message.status === 'PENDING') && !allIncluded;

  return (
    <Paper sx={{ p: 2, mt: 2 }} variant="outlined">
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ md: 'center' }} gap={1}>
        <Box>
          <Typography variant="subtitle1" fontWeight={600}>{group.label}</Typography>
          <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 0.5 }}>
            <Chip size="small" label={`${ready.length} ready`} />
            {countBy(messages, 'SENT') > 0 && <Chip size="small" color="success" label={`${countBy(messages, 'SENT')} sent`} />}
            {countBy(messages, 'FAILED') > 0 && <Chip size="small" color="error" label={`${countBy(messages, 'FAILED')} failed`} />}
            {countBy(messages, 'SENDING') > 0 && <Chip size="small" color="info" label={`${countBy(messages, 'SENDING')} sending`} />}
            {countBy(messages, 'EXCLUDED') > 0 && (
              <Chip size="small" variant="outlined" label={`${countBy(messages, 'EXCLUDED')} left out`} />
            )}
          </Stack>
        </Box>
        <Stack direction="row" gap={1} flexWrap="wrap">
          {countBy(messages, 'FAILED') > 0 && <Button onClick={retryFailed}>Retry failed</Button>}
          <Button variant="outlined" onClick={sendTest} disabled={testing || dirty || messages.length === 0}>
            {testing ? <CircularProgress size={18} /> : userEmail ? `Send test to ${userEmail}` : 'Send test to me'}
          </Button>
          <Button
            variant="contained"
            startIcon={<SendIcon />}
            onClick={() => setConfirmOpen(true)}
            disabled={ready.length === 0 || dirty || sending}
          >
            Approve & send {plural(ready.length, 'email')}
          </Button>
        </Stack>
      </Stack>

      {dirty && (
        <Alert severity="info" sx={{ mt: 2 }}>
          Save the wording to update the preview and turn sending back on.
        </Alert>
      )}

      <Grid container spacing={2} sx={{ mt: 1 }}>
        <Grid item xs={12} md={6}>
          <Stack spacing={2}>
            <TextField
              label="Subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              fullWidth
              disabled={everythingSent}
            />
            <TextField
              label="Message (Markdown)"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              fullWidth
              multiline
              minRows={10}
              disabled={everythingSent}
            />
            <Typography variant="caption" color="text.secondary">
              Merge fields: {MERGE_FIELDS_BY_OUTCOME[outcome].map((field) => `{{${field}}}`).join('  ')}
              {outcome === 'ACCEPTED' && ' - {{accountSetup}} becomes a set-password link for new accounts, or a sign-in link for existing ones.'}
            </Typography>
            <Box>
              <Button variant="outlined" onClick={saveWording} disabled={!dirty || saving}>
                {saving ? <CircularProgress size={18} /> : 'Save wording'}
              </Button>
            </Box>
          </Stack>
        </Grid>
        <Grid item xs={12} md={6}>
          {messages.length > 0 && (
            <TextField
              select
              size="small"
              label="Preview as"
              value={previewRecipientId}
              onChange={(event) => setPreviewRecipientId(event.target.value)}
              fullWidth
              sx={{ mb: 1 }}
            >
              {messages.map((message) => (
                <MenuItem key={message.id} value={message.id}>{personName(message)}</MenuItem>
              ))}
            </TextField>
          )}
          <Typography variant="body2" sx={{ mb: 1 }}>
            <strong>Subject:</strong> {preview?.subject || '…'}
          </Typography>
          <Box
            component="iframe"
            title={`${group.label} email preview`}
            sandbox=""
            srcDoc={preview?.html || ''}
            sx={{ width: '100%', minHeight: 320, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: '#fff' }}
          />
        </Grid>
      </Grid>

      <Divider sx={{ my: 2 }} />

      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox">
                <Checkbox
                  checked={allIncluded}
                  indeterminate={someIncluded}
                  disabled={reviewable.length === 0}
                  onChange={(event) => setIncluded(reviewable, event.target.checked)}
                  inputProps={{ 'aria-label': 'Include everyone not yet sent' }}
                />
              </TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Email</TableCell>
              <TableCell>Status</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {messages.map((message) => (
              <TableRow key={message.id}>
                <TableCell padding="checkbox">
                  <Checkbox
                    checked={message.status !== 'EXCLUDED'}
                    disabled={message.status !== 'PENDING' && message.status !== 'EXCLUDED'}
                    onChange={(event) => setIncluded([message], event.target.checked)}
                    inputProps={{ 'aria-label': `Include ${personName(message)}` }}
                  />
                </TableCell>
                <TableCell>
                  {personName(message)}
                  {message.needsInvite && (
                    <Chip size="small" variant="outlined" label="New account" sx={{ ml: 1 }} />
                  )}
                </TableCell>
                <TableCell>{message.email}</TableCell>
                <TableCell>
                  <Tooltip title={message.error || ''}>
                    <Chip size="small" {...STATUS_CHIPS[message.status]} />
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>

      <Dialog open={confirmOpen} onClose={() => !sending && setConfirmOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Send {plural(ready.length, 'email')}?</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            This sends “{template.subject}” to {plural(ready.length, 'person')}. It cannot be undone.
          </Alert>
          <List dense>
            {ready.slice(0, 8).map((message) => (
              <ListItem key={message.id} divider>
                <ListItemText primary={personName(message)} secondary={message.email} />
              </ListItem>
            ))}
          </List>
          {ready.length > 8 && (
            <Typography variant="caption" color="text.secondary">and {ready.length - 8} more</Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} disabled={sending}>Cancel</Button>
          <Button variant="contained" onClick={confirmSend} disabled={sending} startIcon={<SendIcon />}>
            {sending ? <CircularProgress size={18} /> : `Send ${ready.length}`}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}

export default function DecisionBatchPanel({ cycleId, initialBatchId = null, userEmail }) {
  const [batches, setBatches] = useState([]);
  const [listLoading, setListLoading] = useState(false);
  const [batchId, setBatchId] = useState(initialBatchId);
  const [batch, setBatch] = useState(null);
  const [notice, setNotice] = useState(null);

  const loadBatches = useCallback(async () => {
    setListLoading(true);
    try {
      const query = cycleId ? `?cycleId=${cycleId}` : '';
      const data = await apiClient.get(`${batchesUrl}${query}`);
      setBatches(Array.isArray(data) ? data : []);
    } catch (error) {
      setNotice({ severity: 'error', text: error.serverMessage || error.message });
    } finally {
      setListLoading(false);
    }
  }, [cycleId]);

  const loadBatch = useCallback(async () => {
    if (!batchId) return;
    try {
      setBatch(await apiClient.get(`${batchesUrl}/${batchId}`));
    } catch (error) {
      setNotice({ severity: 'error', text: error.serverMessage || error.message });
    }
  }, [batchId]);

  useEffect(() => {
    if (batchId) {
      loadBatch();
    } else {
      setBatch(null);
      loadBatches();
    }
  }, [batchId, loadBatch, loadBatches]);

  const noticeBanner = notice && (
    <Alert severity={notice.severity} onClose={() => setNotice(null)} sx={{ mb: 2 }}>{notice.text}</Alert>
  );

  if (batchId) {
    return (
      <Box>
        <Button startIcon={<ArrowBackIcon />} onClick={() => setBatchId(null)} sx={{ mb: 1 }}>
          All decision batches
        </Button>
        {noticeBanner}
        {!batch ? (
          <CircularProgress size={24} />
        ) : (
          <>
            <Typography variant="h6">{batch.roundLabel} decisions</Typography>
            <Typography variant="body2" color="text.secondary">
              Processed {new Date(batch.processedAt).toLocaleString()}
              {batch.processedBy ? ` by ${batch.processedBy.fullName}` : ''}
              {batch.cycle ? ` · ${batch.cycle.name}` : ''}. Each group sends separately, and only when you approve it.
            </Typography>
            {(batch.groups || []).map((group) => (
              <OutcomeGroup
                key={group.outcome}
                batchId={batch.id}
                group={group}
                userEmail={userEmail}
                onChanged={loadBatch}
                onNotice={setNotice}
              />
            ))}
          </>
        )}
      </Box>
    );
  }

  return (
    <Box>
      {noticeBanner}
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Processing decisions on Staging moves candidates along but sends nothing. Their emails wait here until
        you review the wording, check who is on the list, and send them.
      </Typography>
      {listLoading ? (
        <CircularProgress size={24} />
      ) : batches.length === 0 ? (
        <Alert severity="info">No decisions have been processed for this cycle yet.</Alert>
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Processed</TableCell>
                <TableCell>Round</TableCell>
                <TableCell>By</TableCell>
                <TableCell align="right">Ready</TableCell>
                <TableCell align="right">Sent</TableCell>
                <TableCell align="right">Failed</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {batches.map((row) => (
                <TableRow key={row.id} hover>
                  <TableCell>{new Date(row.processedAt).toLocaleString()}</TableCell>
                  <TableCell>{row.roundLabel}</TableCell>
                  <TableCell>{row.processedBy?.fullName || '—'}</TableCell>
                  <TableCell align="right">{row.counts.PENDING}</TableCell>
                  <TableCell align="right">{row.counts.SENT}</TableCell>
                  <TableCell align="right">{row.counts.FAILED}</TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      variant={row.counts.PENDING > 0 ? 'contained' : 'text'}
                      onClick={() => setBatchId(row.id)}
                    >
                      {row.counts.PENDING > 0 ? 'Review & send' : 'Open'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
    </Box>
  );
}
