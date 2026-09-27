import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Grid,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import {
  CheckCircle as OkIcon,
  Warning as WarnIcon,
  Error as FailIcon,
  HelpOutline as UnknownIcon,
  Info as InfoIcon,
  Refresh as RefreshIcon,
  Send as SendIcon,
} from '@mui/icons-material';
import apiClient from '../utils/api';
import { useAuth } from '../context/AuthContext';
import AccessControl from '../components/AccessControl';

// Administration -> Email Deliverability. Everything shown is decided on the
// server (services/emailHealth.js); this page only lays it out.

const STATUS_META = {
  ok: { label: 'Healthy', color: 'success', Icon: OkIcon },
  info: { label: 'Note', color: 'info', Icon: InfoIcon },
  unknown: { label: 'Could not check', color: 'default', Icon: UnknownIcon },
  warn: { label: 'Needs attention', color: 'warning', Icon: WarnIcon },
  fail: { label: 'Failing', color: 'error', Icon: FailIcon },
};

const LOG_STATUS_COLOR = {
  SENT: 'default',
  DELIVERED: 'success',
  DELAYED: 'warning',
  BOUNCED: 'error',
  COMPLAINED: 'error',
  FAILED: 'error',
};

const SUPPRESSION_LABELS = {
  UNSUBSCRIBED: 'Unsubscribed',
  BOUNCED: 'Hard bounced',
  COMPLAINED: 'Marked as spam',
  ADMIN: 'Removed by an admin',
};

const formatWhen = (value) => (value ? new Date(value).toLocaleString() : '—');

function StatusIcon({ status }) {
  const { Icon, color } = STATUS_META[status] || STATUS_META.unknown;
  return <Icon color={color === 'default' ? 'disabled' : color} fontSize="small" />;
}

function CheckSection({ section }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
        {section.title}
      </Typography>
      <List dense disablePadding>
        {section.checks.map((check) => (
          <ListItem key={check.key} disableGutters alignItems="flex-start">
            <ListItemIcon sx={{ minWidth: 32, mt: 0.5 }}>
              <StatusIcon status={check.status} />
            </ListItemIcon>
            <ListItemText
              primary={check.label}
              secondary={check.detail}
              secondaryTypographyProps={{ sx: { wordBreak: 'break-word' } }}
            />
          </ListItem>
        ))}
      </List>
    </Paper>
  );
}

function Stat({ label, value, color }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, textAlign: 'center' }}>
      <Typography variant="h5" color={color}>
        {value}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
    </Paper>
  );
}

function TestSend({ defaultTo, recentTests, onSent }) {
  const [to, setTo] = useState(defaultTo || '');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  const send = async () => {
    setSending(true);
    setResult(null);
    try {
      const data = await apiClient.post('/admin/email-health/test', { to });
      setResult({
        severity: 'success',
        message: `Sent to ${data.to}. Refresh in a minute to see whether it was delivered.`,
      });
      onSent();
    } catch (err) {
      setResult({ severity: 'error', message: err.serverMessage || 'The test email could not be sent' });
    } finally {
      setSending(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        Send a test email
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Goes out exactly like real mail. Check that it lands in the inbox rather than spam, and that its status below
        turns Delivered. Sending to a checker such as mail-tester.com also gets you a spam score.
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: result ? 2 : 0 }}>
        <TextField size="small" label="Send to" value={to} onChange={(e) => setTo(e.target.value)} sx={{ flex: 1 }} />
        <Button variant="contained" startIcon={<SendIcon />} onClick={send} disabled={sending || !to.trim()}>
          {sending ? 'Sending…' : 'Send test'}
        </Button>
      </Stack>
      {result && <Alert severity={result.severity}>{result.message}</Alert>}
      {recentTests?.length > 0 && (
        <TableContainer sx={{ mt: 2 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Recent test sends</TableCell>
                <TableCell>Sent</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {recentTests.map((row) => (
                <TableRow key={row.id}>
                  <TableCell sx={{ wordBreak: 'break-all' }}>
                    {row.recipient}
                    {row.error && (
                      <Typography variant="caption" color="error" display="block">
                        {row.error}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>{formatWhen(row.sentAt)}</TableCell>
                  <TableCell>
                    <Chip size="small" label={row.status} color={LOG_STATUS_COLOR[row.status] || 'default'} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Paper>
  );
}

function AdminEmailHealthContent() {
  const { user } = useAuth();
  const [days, setDays] = useState(7);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // A check takes seconds (SES and DNS round trips), so switching windows
  // mid-check is easy. Only the latest request may touch the page, or a slow
  // older one would show one window's numbers under another's toggle.
  const latestRequest = useRef(0);

  const load = useCallback(() => {
    const request = ++latestRequest.current;
    const isLatest = () => request === latestRequest.current;
    setLoading(true);
    setError('');
    return apiClient
      .get(`/admin/email-health?days=${days}`)
      .then((data) => isLatest() && setReport(data))
      .catch((err) => isLatest() && setError(err.serverMessage || 'Failed to run the email health check'))
      .finally(() => isLatest() && setLoading(false));
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  const overall = STATUS_META[report?.overall] || STATUS_META.unknown;
  const delivery = report?.delivery;
  const totals = delivery?.totals;
  const suppressions = Object.entries(delivery?.suppressions || {});

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        justifyContent="space-between"
        sx={{ mb: 3 }}
      >
        <Box>
          <Typography variant="h4">Email deliverability</Typography>
          <Typography variant="body2" color="text.secondary">
            Whether mail from {report?.fromAddress || 'the ATS'} is reaching inboxes, and what to fix if not.
            {report && ` Checked ${formatWhen(report.checkedAt)}.`}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          {report && <Chip icon={<StatusIcon status={report.overall} />} label={overall.label} color={overall.color} />}
          <ToggleButtonGroup
            size="small"
            exclusive
            value={days}
            onChange={(_e, value) => value && setDays(value)}
            aria-label="Window"
          >
            <ToggleButton value={1}>24h</ToggleButton>
            <ToggleButton value={7}>7d</ToggleButton>
            <ToggleButton value={30}>30d</ToggleButton>
          </ToggleButtonGroup>
          <Button startIcon={<RefreshIcon />} onClick={load} disabled={loading}>
            Recheck
          </Button>
        </Stack>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading && !report ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
          <CircularProgress />
        </Box>
      ) : (
        report && (
          <Stack spacing={3} sx={{ opacity: loading ? 0.6 : 1, transition: 'opacity 0.2s' }}>
            {totals && (
              <Grid container spacing={2}>
                {[
                  ['Sent', totals.attempted],
                  ['Delivered', totals.delivered, 'success.main'],
                  ['No report yet', totals.awaiting],
                  ['Delayed', totals.delayed, totals.delayed ? 'warning.main' : undefined],
                  ['Bounced', totals.bounced, totals.bounced ? 'error.main' : undefined],
                  ['Spam complaints', totals.complained, totals.complained ? 'error.main' : undefined],
                  ['Failed to send', totals.failed, totals.failed ? 'error.main' : undefined],
                ].map(([label, value, color]) => (
                  <Grid key={label} size={{ xs: 6, sm: 4, md: 'grow' }}>
                    <Stat label={label} value={value} color={color} />
                  </Grid>
                ))}
              </Grid>
            )}

            <Grid container spacing={2}>
              {report.sections.map((section) => (
                <Grid key={section.key} size={{ xs: 12, md: 6 }}>
                  <CheckSection section={section} />
                </Grid>
              ))}
            </Grid>

            <Grid container spacing={2}>
              <Grid size={{ xs: 12, md: 7 }}>
                <TestSend defaultTo={user?.email} recentTests={report.recentTests} onSent={load} />
              </Grid>
              <Grid size={{ xs: 12, md: 5 }}>
                <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                    Suppression list
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    Addresses Master Communications marketing mail skips. Manage it in Master Communications.
                  </Typography>
                  {suppressions.length === 0 ? (
                    <Typography variant="body2">Nobody is suppressed.</Typography>
                  ) : (
                    <List dense disablePadding>
                      {suppressions.map(([reason, count]) => (
                        <ListItem key={reason} disableGutters secondaryAction={<Chip size="small" label={count} />}>
                          <ListItemText primary={SUPPRESSION_LABELS[reason] || reason} />
                        </ListItem>
                      ))}
                    </List>
                  )}
                  {delivery && (
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                      Last confirmed delivery: {formatWhen(delivery.lastDeliveredAt)}
                    </Typography>
                  )}
                </Paper>
              </Grid>
            </Grid>

            {delivery && (
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
                  Recent problems
                </Typography>
                {delivery.problems.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No bounces, complaints, delays or failed sends in this window.
                  </Typography>
                ) : (
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Recipient</TableCell>
                          <TableCell>Subject</TableCell>
                          <TableCell>Status</TableCell>
                          <TableCell>Reason</TableCell>
                          <TableCell>Sent</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {delivery.problems.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell sx={{ wordBreak: 'break-all' }}>
                              {row.recipientName && <div>{row.recipientName}</div>}
                              <Typography variant="caption" color="text.secondary">
                                {row.recipient}
                              </Typography>
                            </TableCell>
                            <TableCell>{row.subject || '—'}</TableCell>
                            <TableCell>
                              <Chip size="small" label={row.status} color={LOG_STATUS_COLOR[row.status] || 'default'} />
                            </TableCell>
                            <TableCell sx={{ maxWidth: 360, wordBreak: 'break-word' }}>{row.error || '—'}</TableCell>
                            <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatWhen(row.sentAt)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}
              </Paper>
            )}
          </Stack>
        )
      )}
    </Box>
  );
}

export default function AdminEmailHealth() {
  return (
    <AccessControl allowedRoles={['ADMIN']}>
      <AdminEmailHealthContent />
    </AccessControl>
  );
}
