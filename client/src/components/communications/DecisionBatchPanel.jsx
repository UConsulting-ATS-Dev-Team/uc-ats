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
  IconButton,
  LinearProgress,
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
import { ArrowBack as ArrowBackIcon, Edit as EditIcon, Send as SendIcon } from '@mui/icons-material';
import apiClient from '../../utils/api';

// Decision emails queued by Process All Decisions on Staging. Nothing here sends
// on its own: each outcome (advancing, accepted, not moving forward) is reviewed
// and approved separately. Approving queues them; the server sends them in the
// background (decisionSendQueue.js), so this page only follows along.

const STATUS_CHIPS = {
  PENDING: { label: 'Ready', color: 'default' },
  EXCLUDED: { label: 'Left out', color: 'default', variant: 'outlined' },
  QUEUED: { label: 'Queued', color: 'info', variant: 'outlined' },
  SENDING: { label: 'Sending…', color: 'info' },
  SENT: { label: 'Sent', color: 'success' },
  FAILED: { label: 'Failed', color: 'error' },
  UNCONFIRMED: { label: 'Unconfirmed', color: 'warning' }
};

// What SES reported after a SENT, once delivery reports are switched on.
const DELIVERY_CHIPS = {
  DELIVERED: { label: 'Delivered', color: 'success' },
  CLICKED: { label: 'Delivered', color: 'success' },
  DELAYED: { label: 'Delayed', color: 'warning' },
  BOUNCED: { label: 'Bounced', color: 'error' },
  COMPLAINED: { label: 'Marked spam', color: 'error' }
};

const chipFor = (message) =>
  (message.status === 'SENT' && DELIVERY_CHIPS[message.delivery?.status]) || STATUS_CHIPS[message.status];

// Same rule as isDeliverableAddress in server/src/services/decisionBatches.js.
const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const addressOk = (message) => message.addressOk ?? ADDRESS_PATTERN.test(String(message.email || '').trim());
const READDRESSABLE = new Set(['PENDING', 'EXCLUDED', 'FAILED']);
const IN_FLIGHT = new Set(['QUEUED', 'SENDING']);

const MERGE_FIELDS_BY_OUTCOME = {
  ADVANCED: ['firstName', 'lastName', 'fullName', 'cycleName', 'nextRoundName', 'schedulingLink'],
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
  const [readdressing, setReaddressing] = useState(null);
  const [newAddress, setNewAddress] = useState('');

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
  const unreachable = ready.filter((message) => !addressOk(message));
  const inFlightMessages = messages.filter((message) => IN_FLIGHT.has(message.status));
  const inFlight = inFlightMessages.length;
  const unconfirmed = countBy(messages, 'UNCONFIRMED');
  // Progress of the send under way only. Its messages were approved together
  // and keep that time in nextAttemptAt (a retry only moves it later), so an
  // earlier send's messages, approved before, are left out.
  const sendStartedAt = Math.min(...inFlightMessages.map((message) => Date.parse(message.nextAttemptAt) || Infinity));
  const finished = messages.filter(
    (message) =>
      ['SENT', 'FAILED', 'UNCONFIRMED'].includes(message.status) &&
      Date.parse(message.nextAttemptAt) >= sendStartedAt
  ).length;

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
      (result) => `${plural(result.queued, 'email')} queued. They send in the background - you can leave this page.`
    );
    setSending(false);
    setConfirmOpen(false);
  };

  const stopSending = () =>
    run(
      () => apiClient.post(`${batchesUrl}/${batchId}/cancel`, { outcome }),
      (result) => `Stopped. ${plural(result.stopped, 'email')} not yet sent went back to Ready.`
    );

  const retryFailed = () =>
    run(
      () => apiClient.post(`${batchesUrl}/${batchId}/retry`, { outcome }),
      (result) => `${plural(result.requeued, 'email')} back to Ready. Review and send when ready.`
    );

  const resolve = (message, resolution) =>
    run(
      () => apiClient.post(`${batchesUrl}/${batchId}/resolve`, { messageIds: [message.id], resolution }),
      resolution === 'MARK_SENT'
        ? `${personName(message)} marked as sent.`
        : `${personName(message)} is back to Ready. Send when you are ready.`
    );

  const saveAddress = async () => {
    const target = readdressing;
    const result = await run(
      () => apiClient.patch(`${batchesUrl}/${batchId}/messages/${target.id}/email`, { email: newAddress }),
      `${personName(target)}'s email will go to ${newAddress.trim()}.`
    );
    if (result) setReaddressing(null);
  };

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
            {unconfirmed > 0 && <Chip size="small" color="warning" label={`${unconfirmed} unconfirmed`} />}
            {inFlight > 0 && <Chip size="small" color="info" label={`${inFlight} sending`} />}
            {countBy(messages, 'EXCLUDED') > 0 && (
              <Chip size="small" variant="outlined" label={`${countBy(messages, 'EXCLUDED')} left out`} />
            )}
          </Stack>
        </Box>
        <Stack direction="row" gap={1} flexWrap="wrap">
          {countBy(messages, 'QUEUED') > 0 && <Button color="warning" onClick={stopSending}>Stop sending</Button>}
          {countBy(messages, 'FAILED') > 0 && <Button onClick={retryFailed}>Retry failed</Button>}
          <Button variant="outlined" onClick={sendTest} disabled={testing || dirty || messages.length === 0}>
            {testing ? <CircularProgress size={18} /> : userEmail ? `Send test to ${userEmail}` : 'Send test to me'}
          </Button>
          <Button
            variant="contained"
            startIcon={<SendIcon />}
            onClick={() => setConfirmOpen(true)}
            disabled={ready.length === 0 || dirty || sending || unreachable.length > 0}
          >
            Approve & send {plural(ready.length, 'email')}
          </Button>
        </Stack>
      </Stack>

      {inFlight > 0 && (
        <Box sx={{ mt: 2 }}>
          <LinearProgress variant="determinate" value={(finished / (finished + inFlight)) * 100} />
          <Typography variant="caption" color="text.secondary">
            Sending: {plural(inFlight, 'email')} to go. This continues on the server if you close the page, and
            picks up again on its own after a restart.
          </Typography>
        </Box>
      )}

      {unreachable.length > 0 && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {plural(unreachable.length, 'address')} below cannot receive email. Fix {unreachable.length === 1 ? 'it' : 'them'} with
          the pencil, or leave {unreachable.length === 1 ? 'it' : 'them'} out, to turn sending back on.
        </Alert>
      )}

      {unconfirmed > 0 && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          {unconfirmed === 1 ? 'One send was' : `${unconfirmed} sends were`} cut off while the email was being handed to
          Amazon SES, so nobody can tell whether {unconfirmed === 1 ? 'it' : 'they'} arrived. For each, choose{' '}
          <strong>Mark sent</strong> if you know it arrived, or <strong>Send again</strong>.
        </Alert>
      )}

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
              {outcome === 'ADVANCED' && ' - {{schedulingLink}} becomes a link to pick an interview time, or "Scheduling details are on their way" if that round has no bookable times yet.'}
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
                <TableCell>
                  {message.email}
                  {!addressOk(message) && <Chip size="small" color="error" label="Not an address" sx={{ ml: 1 }} />}
                  {READDRESSABLE.has(message.status) && (
                    <IconButton
                      size="small"
                      aria-label={`Change ${personName(message)}'s email address`}
                      onClick={() => {
                        setReaddressing(message);
                        setNewAddress(message.email);
                      }}
                    >
                      <EditIcon fontSize="inherit" />
                    </IconButton>
                  )}
                </TableCell>
                <TableCell>
                  <Tooltip title={message.delivery?.error || message.error || ''}>
                    <Chip size="small" {...chipFor(message)} />
                  </Tooltip>
                  {message.status === 'UNCONFIRMED' && (
                    <Stack direction="row" gap={0.5} sx={{ mt: 0.5 }}>
                      <Button size="small" onClick={() => resolve(message, 'MARK_SENT')}>Mark sent</Button>
                      <Button size="small" onClick={() => resolve(message, 'SEND_AGAIN')}>Send again</Button>
                    </Stack>
                  )}
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

      <Dialog open={Boolean(readdressing)} onClose={() => setReaddressing(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Email address for {readdressing && personName(readdressing)}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="Email"
            value={newAddress}
            onChange={(event) => setNewAddress(event.target.value)}
            error={newAddress.trim() !== '' && !ADDRESS_PATTERN.test(newAddress.trim())}
          />
          <Typography variant="caption" color="text.secondary">
            Changes where this decision email goes. The application keeps the address it was submitted with.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReaddressing(null)}>Cancel</Button>
          <Button variant="contained" onClick={saveAddress} disabled={!ADDRESS_PATTERN.test(newAddress.trim())}>
            Save
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

  // Follow a send while the server works through it.
  const sendingNow = Boolean(
    batch?.groups?.some((group) => group.messages.some((message) => IN_FLIGHT.has(message.status)))
  );
  useEffect(() => {
    if (!sendingNow) return undefined;
    const timer = setInterval(loadBatch, 3000);
    return () => clearInterval(timer);
  }, [sendingNow, loadBatch]);

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
                <TableCell align="right">Sending</TableCell>
                <TableCell align="right">Sent</TableCell>
                <TableCell align="right">Needs attention</TableCell>
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
                  <TableCell align="right">{(row.counts.QUEUED ?? 0) + row.counts.SENDING}</TableCell>
                  <TableCell align="right">{row.counts.SENT}</TableCell>
                  <TableCell align="right">{row.counts.FAILED + (row.counts.UNCONFIRMED ?? 0)}</TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      variant={row.counts.PENDING > 0 || row.counts.UNCONFIRMED > 0 ? 'contained' : 'text'}
                      onClick={() => setBatchId(row.id)}
                    >
                      {row.counts.PENDING > 0 ? 'Review & send' : row.counts.UNCONFIRMED > 0 ? 'Resolve' : 'Open'}
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
