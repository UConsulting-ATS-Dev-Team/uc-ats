import React, { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
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
  Tooltip,
  Typography,
} from '@mui/material';
import { PersonAdd as PersonAddIcon, Search as SearchIcon, Send as SendIcon } from '@mui/icons-material';
import { formatTimeRange } from '../../utils/scheduleFormat';
import PlaceCandidatesDialog from './PlaceCandidatesDialog';

/**
 * Signups - who in this round has booked a session, who has not, and a way to
 * nudge the ones who have not.
 *
 * The Sessions view answers "who is in the 9am"; this answers "who is missing",
 * which is the question recruitment actually asks two days before a round.
 */

const slotHeading = (slot) => slot.label || formatTimeRange(slot.startTime, slot.endTime);

// Lower wins when one person has several signups. A confirmed seat is what
// they will turn up to; a waitlist entry beside it is only a preference.
const STATUS_RANK = { CONFIRMED: 0, NEEDS_PLACEMENT: 1, WAITLISTED: 2 };

/**
 * One row per person in the round, from the slots' signups plus the round's
 * unassigned list.
 *
 * A candidate can hold a confirmed seat and sit on another session's waitlist
 * at once, so signups are collapsed by application: the best status is the
 * row's status and any waitlists ride along as `waitlistedFor`.
 *
 * `status` is BOOKED, WAITLISTED, NEEDS_PLACEMENT or NOT_BOOKED. Only
 * NOT_BOOKED rows can be reminded.
 */
export function buildSignupRows(round) {
  const slots = round?.slots ?? [];
  const multipleInterviews = new Set(slots.map((s) => s.interviewTitle).filter(Boolean)).size > 1;
  const sessionName = (slot) =>
    multipleInterviews && slot.interviewTitle ? `${slot.interviewTitle} · ${slotHeading(slot)}` : slotHeading(slot);

  const byApplication = new Map();
  for (const slot of slots) {
    for (const signup of slot.signups ?? []) {
      const key = signup.applicationId ?? signup.id;
      const entry = byApplication.get(key) ?? { candidate: signup.candidate, signups: [] };
      entry.signups.push({ signup, slot });
      byApplication.set(key, entry);
    }
  }

  const rows = [];
  for (const [applicationId, { candidate, signups }] of byApplication) {
    const sorted = [...signups].sort(
      (a, b) => (STATUS_RANK[a.signup.status] ?? 9) - (STATUS_RANK[b.signup.status] ?? 9)
    );
    const best = sorted[0];
    const status = best.signup.status === 'CONFIRMED' ? 'BOOKED' : best.signup.status;
    rows.push({
      applicationId,
      firstName: candidate?.firstName ?? '',
      lastName: candidate?.lastName ?? '',
      email: candidate?.email ?? '',
      status,
      session: status === 'BOOKED' ? sessionName(best.slot) : null,
      waitlistedFor: sorted
        .filter((s) => s.signup.status === 'WAITLISTED' && s !== best)
        .map((s) => sessionName(s.slot)),
      lastRemindedAt: null,
    });
  }

  for (const person of round?.unassigned ?? []) {
    if (byApplication.has(person.id)) continue;
    rows.push({
      applicationId: person.id,
      firstName: person.firstName ?? '',
      lastName: person.lastName ?? '',
      email: person.email ?? '',
      status: 'NOT_BOOKED',
      session: null,
      waitlistedFor: [],
      lastRemindedAt: person.lastRemindedAt ?? null,
    });
  }

  return rows.sort(
    (a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName)
  );
}

const fullName = (row) => `${row.firstName} ${row.lastName}`.trim() || 'Unknown';

/** "just now", "3h ago", "2d ago", else "Sep 14". */
export function formatReminded(iso, now = Date.now()) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function StatusChip({ row }) {
  if (row.status === 'BOOKED') {
    return <Chip size="small" color="success" variant="outlined" label={row.session} />;
  }
  if (row.status === 'WAITLISTED') return <Chip size="small" color="warning" variant="outlined" label="Waitlisted" />;
  if (row.status === 'NEEDS_PLACEMENT') return <Chip size="small" color="error" variant="outlined" label="Needs placing" />;
  return <Chip size="small" label="Not booked" />;
}

export default function RoundSignupStatus({ round, reminderDefaults, busy, onRemind, onPlace }) {
  // null while closed, else the ids to open the add dialog with ticked.
  const [placing, setPlacing] = useState(null);
  const rows = useMemo(() => buildSignupRows(round), [round]);
  const notBooked = useMemo(() => rows.filter((r) => r.status === 'NOT_BOOKED'), [rows]);
  const count = (status) => rows.filter((r) => r.status === status).length;

  const [filter, setFilter] = useState(() => (notBooked.length > 0 ? 'not-booked' : 'all'));
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  // `ids` null means everyone not booked, decided by the server at send time.
  const [reminder, setReminder] = useState(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === 'not-booked' && r.status !== 'NOT_BOOKED') return false;
      if (filter === 'booked' && r.status === 'NOT_BOOKED') return false;
      if (!term) return true;
      return fullName(r).toLowerCase().includes(term) || r.email.toLowerCase().includes(term);
    });
  }, [rows, filter, search]);

  // A selection can outlive the row it pointed at: someone books, the page
  // reloads, and they are no longer remindable.
  const selectedIds = notBooked.filter((r) => selected.has(r.applicationId)).map((r) => r.applicationId);
  const visibleSelectable = visible.filter((r) => r.status === 'NOT_BOOKED');
  const allVisibleSelected =
    visibleSelectable.length > 0 && visibleSelectable.every((r) => selected.has(r.applicationId));

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAllVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of visibleSelectable) {
        if (allVisibleSelected) next.delete(r.applicationId);
        else next.add(r.applicationId);
      }
      return next;
    });

  const noOpenSessions = (round?.stats?.bookableSessions ?? 0) === 0;
  const remindDisabledReason = noOpenSessions
    ? 'No session in this round is open for signup, so there is nothing to book yet.'
    : '';

  const openReminder = (ids) => {
    setSendError('');
    setReminder({
      ids,
      count: ids ? ids.length : notBooked.length,
      subject: reminderDefaults?.subject ?? '',
      message: reminderDefaults?.message ?? '',
    });
  };

  const send = async () => {
    setSending(true);
    setSendError('');
    try {
      await onRemind(reminder.ids, reminder.subject, reminder.message);
      setReminder(null);
      setSelected(new Set());
    } catch (e) {
      setSendError(e?.serverMessage || e?.message || 'The reminder did not go out.');
    } finally {
      setSending(false);
    }
  };

  const remindButton = (label, onClick, disabled, track) => {
    const button = (
      <span>
        <Button
          size="small"
          variant="outlined"
          startIcon={<SendIcon />}
          onClick={onClick}
          disabled={busy || noOpenSessions || disabled}
          data-track={track}
        >
          {label}
        </Button>
      </span>
    );
    return remindDisabledReason ? (
      <Tooltip title={remindDisabledReason} describeChild>
        {button}
      </Tooltip>
    ) : (
      button
    );
  };

  if (rows.length === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="h6" gutterBottom>
          Nobody is in this round yet
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Candidates show up here once they advance to this round.
        </Typography>
      </Paper>
    );
  }

  const mergeFields = reminderDefaults?.mergeFields ?? [];

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'flex-start', md: 'center' }}
        spacing={1}
        sx={{ mb: 2 }}
      >
        {/* One part per status, so the parts always add up to the total.
            Waitlisted and need placing are left out at zero. */}
        <Typography variant="body2" data-testid="signup-summary">
          {[
            [rows.length, 'in this round'],
            [count('BOOKED'), 'booked'],
            [count('WAITLISTED'), 'waitlisted', true],
            [count('NEEDS_PLACEMENT'), 'need placing', true],
            [notBooked.length, 'not booked'],
          ]
            .filter(([n, , optional]) => !optional || n > 0)
            .map(([n, label], i) => (
              <React.Fragment key={label}>
                {i > 0 && ' · '}
                <strong>{n}</strong> {label}
              </React.Fragment>
            ))}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
          {onPlace && (
            <Button
              size="small"
              variant="outlined"
              startIcon={<PersonAddIcon />}
              onClick={() => setPlacing(selectedIds)}
              disabled={busy || notBooked.length === 0}
              data-track="add-unbooked-to-session"
            >
              {selectedIds.length > 0 ? `Add selected to a session (${selectedIds.length})` : 'Add to a session'}
            </Button>
          )}
          {remindButton(
            `Remind selected (${selectedIds.length})`,
            () => openReminder(selectedIds),
            selectedIds.length === 0,
            'remind-selected-signups'
          )}
          {remindButton(
            `Remind all not booked (${notBooked.length})`,
            () => openReminder(null),
            notBooked.length === 0,
            'remind-all-not-booked'
          )}
        </Stack>
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 1.5 }} alignItems={{ sm: 'center' }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={filter}
          onChange={(e, next) => next && setFilter(next)}
        >
          <ToggleButton value="not-booked">Not booked</ToggleButton>
          <ToggleButton value="booked">Booked</ToggleButton>
          <ToggleButton value="all">All</ToggleButton>
        </ToggleButtonGroup>
        <TextField
          size="small"
          placeholder="Search name or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          inputProps={{ 'data-no-track': true }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
          sx={{ minWidth: 240 }}
        />
      </Stack>

      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox">
                <Checkbox
                  size="small"
                  checked={allVisibleSelected}
                  indeterminate={!allVisibleSelected && visibleSelectable.some((r) => selected.has(r.applicationId))}
                  disabled={visibleSelectable.length === 0}
                  onChange={toggleAllVisible}
                  inputProps={{ 'aria-label': 'Select everyone shown who has not booked' }}
                />
              </TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Email</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Last reminded</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {visible.map((row) => {
              const remindable = row.status === 'NOT_BOOKED';
              return (
                <TableRow key={row.applicationId} hover data-testid={`signup-row-${row.applicationId}`}>
                  <TableCell padding="checkbox">
                    <Checkbox
                      size="small"
                      disabled={!remindable}
                      checked={remindable && selected.has(row.applicationId)}
                      onChange={() => toggle(row.applicationId)}
                      inputProps={{ 'aria-label': `Select ${fullName(row)}` }}
                    />
                  </TableCell>
                  <TableCell>{fullName(row)}</TableCell>
                  <TableCell>{row.email}</TableCell>
                  <TableCell>
                    <StatusChip row={row} />
                    {row.waitlistedFor.length > 0 && (
                      <Typography variant="caption" color="text.secondary" display="block">
                        Waitlisted for {row.waitlistedFor.join(', ')}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    {row.lastRemindedAt ? (
                      <Tooltip title={new Date(row.lastRemindedAt).toLocaleString()}>
                        <span>{formatReminded(row.lastRemindedAt)}</span>
                      </Tooltip>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={5}>
                  <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
                    {filter === 'not-booked' && !search ? 'Everyone in this round has booked.' : 'Nobody matches.'}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={Boolean(reminder)} onClose={() => !sending && setReminder(null)} fullWidth maxWidth="sm">
        <DialogTitle>
          {reminder?.ids
            ? `Remind ${reminder.count} selected candidate${reminder.count === 1 ? '' : 's'}`
            : `Remind everyone not booked (${reminder?.count ?? 0})`}
        </DialogTitle>
        {reminder && (
          <DialogContent>
            <Typography variant="body2" color="text.secondary" mb={2}>
              Each person gets their own email with this message and a link to book. Anyone who books before
              you send is skipped.
            </Typography>
            {sendError && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {sendError}
              </Alert>
            )}
            <Stack spacing={2}>
              <TextField
                label="Subject"
                size="small"
                value={reminder.subject}
                onChange={(e) => setReminder((r) => ({ ...r, subject: e.target.value }))}
              />
              <TextField
                label="Message"
                multiline
                minRows={4}
                value={reminder.message}
                onChange={(e) => setReminder((r) => ({ ...r, message: e.target.value }))}
                helperText={
                  mergeFields.length > 0
                    ? `Markdown works. Merge fields: ${mergeFields.map((f) => `{{${f}}}`).join(' ')}`
                    : 'Markdown works.'
                }
              />
            </Stack>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setReminder(null)} disabled={sending}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={send}
            data-track="send-signup-reminder"
            disabled={sending || !reminder?.subject.trim() || !reminder?.message.trim()}
          >
            {sending ? <CircularProgress size={16} /> : `Send ${reminder?.count ?? ''}`}
          </Button>
        </DialogActions>
      </Dialog>

      {onPlace && (
        <PlaceCandidatesDialog
          open={placing !== null}
          candidates={round?.unassigned ?? []}
          slots={round?.slots ?? []}
          initialSelected={placing}
          slotHeading={slotHeading}
          onClose={() => setPlacing(null)}
          onPlace={(applications, slot, options) => {
            setPlacing(null);
            setSelected(new Set());
            onPlace(applications, slot, options);
          }}
        />
      )}
    </Paper>
  );
}
