import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { AttachFile as AttachFileIcon } from '@mui/icons-material';
import apiClient from '../../utils/api';

// Spelling shown to an admin, for the values the server records. Anything not
// listed is shown as-is rather than hidden, so a category added on the server
// needs no change here.
const CATEGORY_LABELS = {
  ACCOUNT: 'Account',
  APPLICATION_DECISION: 'Decision',
  OFFER_LETTER: 'Offer letter',
  EVENT: 'Event',
  MEETING: 'Coffee chat',
  INTERVIEW_SLOT: 'Interview slot',
  REVIEWER_REMINDER: 'Reviewer reminder',
  MASTER_COMMUNICATION: 'Master communication',
  DECISION_BATCH: 'Decision batch',
  TEST: 'Test send',
  OTHER: 'Other',
};

const CHANNEL_LABELS = { email: 'Email', slack: 'Slack', imessage: 'iMessage' };

const STATUS_STYLES = {
  SENT: { color: 'success', label: 'Sent' },
  FAILED: { color: 'error', label: 'Failed' },
  OPENED: { color: 'warning', label: 'Opened' },
};

const TRIGGERS = [
  { value: '', label: 'Automated and manual' },
  { value: 'AUTOMATED', label: 'Automated only' },
  { value: 'MANUAL', label: 'Sent by a person' },
];

const PAGE_SIZE = 50;

const labelFor = (map, value) => map[value] || value || '—';

const EMPTY_FILTERS = {
  search: '',
  channel: '',
  category: '',
  status: '',
  trigger: '',
  from: '',
  to: '',
};

/**
 * Every message this system has put in front of a person, newest first.
 *
 * Deliberately not scoped to a cycle by default. Password resets, account
 * verification and test sends belong to no cycle at all, and an admin asking
 * "did this person ever hear from us" is not asking about one recruiting round.
 * The cycle filter is there when they do want it.
 */
const CommunicationsLog = ({ cycleId = '', cycleName = '' }) => {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [scopeToCycle, setScopeToCycle] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(null);
  const [facets, setFacets] = useState({ known: {}, categories: [], channels: [], statuses: [] });

  // Typing in the search box should not fire a request per keystroke.
  const [searchInput, setSearchInput] = useState('');
  const debounce = useRef(null);
  useEffect(() => {
    debounce.current = setTimeout(() => {
      setFilters((f) => (f.search === searchInput ? f : { ...f, search: searchInput }));
      setOffset(0);
    }, 300);
    return () => clearTimeout(debounce.current);
  }, [searchInput]);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (scopeToCycle && cycleId) params.set('cycleId', cycleId);
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset));
    return params.toString();
  }, [filters, scopeToCycle, cycleId, offset]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiClient.get(`/master-communications/communications?${query}`);
      const page = Array.isArray(data?.rows) ? data.rows : [];
      const at = Number.isFinite(data?.offset) ? data.offset : 0;
      setRows((current) => (at === 0 ? page : [...current, ...page]));
      setTotal(Number.isFinite(data?.total) ? data.total : 0);
      setError('');
    } catch (e) {
      setError(e.message || 'Failed to load the communications log');
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get('/master-communications/communications/facets')
      .then((data) => {
        if (!cancelled && data) setFacets(data);
      })
      .catch(() => {
        // The filters fall back to the full vocabulary below; a facet count is
        // a convenience, not a reason to fail the page.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Changing a filter starts the list again from the top.
  const set = (key) => (e) => {
    setFilters((f) => ({ ...f, [key]: e.target.value }));
    setOffset(0);
  };

  const countFor = (list, value) => list?.find((f) => f.value === value)?.count;

  const options = (knownKey, presentList, labels) => {
    const known = facets.known?.[knownKey] || [];
    const present = (presentList || []).map((f) => f.value);
    // Show everything the server can record, plus anything it has recorded that
    // this build does not know about yet.
    return [...new Set([...known, ...present])].map((value) => {
      const count = countFor(presentList, value);
      return (
        <MenuItem key={value} value={value}>
          {labelFor(labels, value)}
          {count ? ` (${count})` : ''}
        </MenuItem>
      );
    });
  };

  const filtersActive =
    scopeToCycle || Object.values(filters).some(Boolean) || Boolean(searchInput);

  const clearAll = () => {
    setFilters(EMPTY_FILTERS);
    setSearchInput('');
    setScopeToCycle(false);
    setOffset(0);
  };

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Every message this system sent, automated or written by hand: email, Slack and the
        iMessage hand-off. One row per recipient.
      </Typography>

      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        <TextField
          size="small"
          label="Search recipient or subject"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          sx={{ minWidth: 260 }}
        />
        <TextField
          select
          size="small"
          label="Channel"
          value={filters.channel}
          onChange={set('channel')}
          sx={{ minWidth: 140 }}
        >
          <MenuItem value="">All channels</MenuItem>
          {options('channels', facets.channels, CHANNEL_LABELS)}
        </TextField>
        <TextField
          select
          size="small"
          label="Type"
          value={filters.category}
          onChange={set('category')}
          sx={{ minWidth: 200 }}
        >
          <MenuItem value="">All types</MenuItem>
          {options('categories', facets.categories, CATEGORY_LABELS)}
        </TextField>
        <TextField
          select
          size="small"
          label="Status"
          value={filters.status}
          onChange={set('status')}
          sx={{ minWidth: 140 }}
        >
          <MenuItem value="">Any status</MenuItem>
          {options('statuses', facets.statuses, {
            SENT: 'Sent',
            FAILED: 'Failed',
            OPENED: 'Opened',
          })}
        </TextField>
        <TextField
          select
          size="small"
          label="Sent by"
          value={filters.trigger}
          onChange={set('trigger')}
          sx={{ minWidth: 190 }}
        >
          {TRIGGERS.map((t) => (
            <MenuItem key={t.value || 'any'} value={t.value}>
              {t.label}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          type="date"
          label="From"
          value={filters.from}
          onChange={set('from')}
          InputLabelProps={{ shrink: true }}
        />
        <TextField
          size="small"
          type="date"
          label="To"
          value={filters.to}
          onChange={set('to')}
          InputLabelProps={{ shrink: true }}
        />
        {cycleId && (
          <Button
            size="small"
            variant={scopeToCycle ? 'contained' : 'outlined'}
            onClick={() => {
              setScopeToCycle((v) => !v);
              setOffset(0);
            }}
          >
            {scopeToCycle ? `Only ${cycleName || 'this cycle'}` : 'All cycles'}
          </Button>
        )}
        {filtersActive && (
          <Button size="small" onClick={clearAll}>
            Clear
          </Button>
        )}
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading && rows.length === 0 ? (
        <Stack alignItems="center" sx={{ py: 4 }}>
          <CircularProgress size={28} />
        </Stack>
      ) : rows.length === 0 ? (
        <Alert severity="info">
          {filtersActive
            ? 'Nothing matches these filters.'
            : 'Nothing has been sent yet. Every message from here on is recorded automatically.'}
        </Alert>
      ) : (
        <>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Sent at</TableCell>
                <TableCell>Channel</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Recipient</TableCell>
                <TableCell>Subject</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Triggered by</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => {
                const status = STATUS_STYLES[row.status] || { color: 'default', label: row.status };
                return (
                  <TableRow
                    key={row.id}
                    hover
                    sx={{ cursor: 'pointer' }}
                    onClick={() => setSelected(row)}
                  >
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {new Date(row.sentAt).toLocaleString()}
                    </TableCell>
                    <TableCell>{labelFor(CHANNEL_LABELS, row.channel)}</TableCell>
                    <TableCell>{labelFor(CATEGORY_LABELS, row.category)}</TableCell>
                    <TableCell>
                      {row.recipientName ? (
                        <>
                          {row.recipientName}
                          <Typography variant="caption" color="text.secondary" display="block">
                            {row.recipient}
                          </Typography>
                        </>
                      ) : (
                        row.recipient
                      )}
                    </TableCell>
                    <TableCell>
                      {row.subject || <em>no subject</em>}
                      {row.hasAttachments && (
                        <Tooltip title="Sent with an attachment">
                          <AttachFileIcon
                            fontSize="inherit"
                            sx={{ ml: 0.5, verticalAlign: 'middle' }}
                          />
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip size="small" color={status.color} label={status.label} />
                      {row.status === 'OPENED' && (
                        // The same caveat the bulk-send log carries: the server
                        // opens Messages, it cannot watch what happens after.
                        <Typography variant="caption" color="text.secondary" display="block">
                          opened, not confirmed sent
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.triggeredBy?.fullName || (row.trigger === 'MANUAL' ? '—' : 'System')}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          <Stack direction="row" alignItems="center" spacing={2} sx={{ mt: 2 }}>
            <Typography variant="caption" color="text.secondary">
              Showing {rows.length} of {total}
            </Typography>
            {rows.length < total && (
              <Button size="small" disabled={loading} onClick={() => setOffset(rows.length)}>
                {loading ? 'Loading…' : 'Load more'}
              </Button>
            )}
          </Stack>
        </>
      )}

      <Dialog open={Boolean(selected)} onClose={() => setSelected(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{selected?.subject || 'Message'}</DialogTitle>
        <DialogContent dividers>
          {selected && (
            <Stack spacing={1.5}>
              <Typography variant="body2">
                <strong>To:</strong>{' '}
                {selected.recipientName
                  ? `${selected.recipientName} <${selected.recipient}>`
                  : selected.recipient}
              </Typography>
              <Typography variant="body2">
                <strong>Sent:</strong> {new Date(selected.sentAt).toLocaleString()}
              </Typography>
              <Typography variant="body2">
                <strong>Channel:</strong> {labelFor(CHANNEL_LABELS, selected.channel)} ·{' '}
                <strong>Type:</strong> {labelFor(CATEGORY_LABELS, selected.category)} ·{' '}
                <strong>{selected.trigger === 'MANUAL' ? 'Sent by a person' : 'Automated'}</strong>
              </Typography>
              {selected.cycle?.name && (
                <Typography variant="body2">
                  <strong>Cycle:</strong> {selected.cycle.name}
                </Typography>
              )}
              {selected.error && <Alert severity="error">{selected.error}</Alert>}
              <Typography variant="caption" color="text.secondary">
                Message (first 2000 characters, formatting removed)
              </Typography>
              <Box
                component="pre"
                sx={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'inherit',
                  bgcolor: 'action.hover',
                  borderRadius: 1,
                  p: 1.5,
                  m: 0,
                }}
              >
                {selected.bodyPreview || 'No body recorded.'}
              </Box>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelected(null)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default CommunicationsLog;
