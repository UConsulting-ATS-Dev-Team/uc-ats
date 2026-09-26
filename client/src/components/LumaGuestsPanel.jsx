// The Luma guests the hourly sync could not settle, and the one place they get
// settled.
//
// The sync writes an RSVP or an attendance row for every guest it can identify.
// When it cannot, or when it identified someone on evidence thin enough to be
// worth a second opinion, it holds the guest instead of guessing — and before
// this panel existed nothing in the app read those holds at all. An admin
// linking a guest here does not just label a row: the server re-runs the same
// reconcile a sync would, so the RSVP and attendance follow immediately.
//
// Everything shown about a guest is text they typed into Luma. React escapes
// it; nothing here interprets it.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Link,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import apiClient from '../utils/api';

// What each hold means, in the words an admin needs to act on it.
const HOLD_COPY = {
  unmatched: {
    label: 'Not matched',
    color: 'error',
    help: 'No candidate or member has this email address, and there was no usable UCLA UID to fall back on. Nothing has been recorded for this person.',
  },
  flagged: {
    label: 'Check this match',
    color: 'warning',
    help: 'Matched on the UID they typed alone — their Luma profile name does not look like the record it points at. The RSVP has been recorded; confirm it went to the right person.',
  },
  unknownStatus: {
    label: 'Status not understood',
    color: 'info',
    help: 'Luma sent a registration status the ATS does not read as going or not going, so this guest\'s RSVP was left exactly as it was rather than guessed at. Their attendance, if they were scanned at the door, is unaffected.',
  },
};

// The routine runs hourly, so anything past three hours is two missed runs and
// worth saying out loud rather than a slow one.
export const STALE_SYNC_MS = 3 * 60 * 60 * 1000;
export const staleSync = (lastSyncedAt, now = Date.now()) =>
  !lastSyncedAt || now - new Date(lastSyncedAt).getTime() > STALE_SYNC_MS;

const fullName = (person) =>
  [person?.firstName, person?.lastName].filter(Boolean).join(' ') || person?.email || 'Unnamed';

export function relativeAge(from, now = Date.now()) {
  if (!from) return null;
  const minutes = Math.round((now - new Date(from).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export default function LumaGuestsPanel({ eventId, eventName, open, onClose, onChanged }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [showAll, setShowAll] = useState(false);
  // Which guest's picker is open, and who is selected in it. Keyed by guest so
  // two rows cannot share one selection.
  const [choice, setChoice] = useState({});
  const [saving, setSaving] = useState('');

  const load = useCallback(async () => {
    if (!eventId) return;
    try {
      setLoading(true);
      setError('');
      setData(await apiClient.get(`/admin/luma/events/${eventId}/guests${showAll ? '?all=true' : ''}`));
    } catch (e) {
      setError(e.message || 'Failed to load Luma guests');
    } finally {
      setLoading(false);
    }
  }, [eventId, showAll]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const link = async (guest, person) => {
    try {
      setSaving(guest.lumaGuestId);
      setError('');
      await apiClient.post(`/admin/luma/events/${eventId}/guests/${guest.lumaGuestId}/link`, {
        ...(person?.kind === 'candidate' && { candidateId: person.id }),
        ...(person?.kind === 'member' && { userId: person.id }),
      });
      setChoice((current) => ({ ...current, [guest.lumaGuestId]: null }));
      await load();
      // The RSVP and attendance counts on the event row have just moved.
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Failed to link that guest');
    } finally {
      setSaving('');
    }
  };

  const counts = data?.counts;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle>Luma guests — {eventName}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} mt={1}>
          <SyncState event={data?.event} />

          {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

          {counts && (
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Chip size="small" label={`${counts.total} guests synced`} variant="outlined" />
              {['unmatched', 'flagged', 'unknownStatus'].map((hold) =>
                counts[hold] > 0 ? (
                  <Tooltip key={hold} title={HOLD_COPY[hold].help}>
                    <Chip
                      size="small"
                      color={HOLD_COPY[hold].color}
                      label={`${counts[hold]} ${HOLD_COPY[hold].label.toLowerCase()}`}
                    />
                  </Tooltip>
                ) : null
              )}
              <Box flexGrow={1} />
              <FormControlLabel
                control={<Switch size="small" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />}
                label="Show every guest"
              />
            </Stack>
          )}

          {loading && <CircularProgress size={24} />}

          {!loading && data?.guests.length === 0 && (
            <Alert severity="success">
              {showAll
                ? 'No Luma guests have been synced for this event yet.'
                : 'Nothing is waiting. Every guest the sync has seen was matched to someone.'}
            </Alert>
          )}

          {!loading && data?.guests.length > 0 && (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Guest</TableCell>
                    <TableCell>UID</TableCell>
                    <TableCell>Registration</TableCell>
                    <TableCell>Held because</TableCell>
                    <TableCell>Recorded as</TableCell>
                    <TableCell sx={{ minWidth: 320 }}>Link to</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.guests.map((guest) => (
                    <GuestRow
                      key={guest.lumaGuestId}
                      guest={guest}
                      selected={choice[guest.lumaGuestId] ?? null}
                      onSelect={(person) =>
                        setChoice((current) => ({ ...current, [guest.lumaGuestId]: person }))
                      }
                      onLink={(person) => link(guest, person)}
                      saving={saving === guest.lumaGuestId}
                    />
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

// The event's own sync state, which is the first thing to check when the list
// looks wrong: a link that has never been resolved, or a sync that stopped,
// explains an empty panel far more often than the matching does.
function SyncState({ event }) {
  if (!event) return null;
  if (!event.lumaUrl) {
    return <Alert severity="info">This event has no Luma link, so nothing syncs from Luma.</Alert>;
  }
  if (!event.lumaEventId) {
    return (
      <Alert severity="warning">
        The Luma link is saved but the sync routine has not resolved it yet. That happens on its
        next hourly run; if it has not after a couple of hours, check that the link opens and that
        the routine is still running.
      </Alert>
    );
  }
  const age = relativeAge(event.lumaLastSyncedAt);
  return (
    <Alert severity={staleSync(event.lumaLastSyncedAt) ? 'warning' : 'success'}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <span>
          {age ? `Last full sync ${age}.` : 'Linked, but no sync has finished yet.'}
        </span>
        <Link href={event.lumaUrl} target="_blank" rel="noopener noreferrer">
          Open in Luma
        </Link>
      </Stack>
    </Alert>
  );
}

function GuestRow({ guest, selected, onSelect, onLink, saving }) {
  const recorded = guest.candidate
    ? { label: fullName(guest.candidate), kind: 'candidate' }
    : guest.member
      ? { label: fullName(guest.member), kind: 'member' }
      : null;

  return (
    <TableRow>
      <TableCell>
        <Typography variant="body2">{guest.name || '—'}</Typography>
        <Typography variant="caption" color="text.secondary">{guest.email}</Typography>
      </TableCell>
      <TableCell>{guest.uid || '—'}</TableCell>
      <TableCell>
        <Stack spacing={0.5} alignItems="flex-start">
          <Chip size="small" variant="outlined" label={guest.approvalStatus} />
          {guest.checkedInAt && <Chip size="small" color="success" label="Checked in" />}
        </Stack>
      </TableCell>
      <TableCell>
        <Stack spacing={0.5} alignItems="flex-start">
          {guest.holds.length === 0 && (
            <Typography variant="caption" color="text.secondary">Settled</Typography>
          )}
          {guest.holds.map((hold) => (
            <Tooltip key={hold} title={HOLD_COPY[hold].help}>
              <Chip size="small" color={HOLD_COPY[hold].color} label={HOLD_COPY[hold].label} />
            </Tooltip>
          ))}
          {guest.matchNote && (
            <Typography variant="caption" color="text.secondary">{guest.matchNote}</Typography>
          )}
        </Stack>
      </TableCell>
      <TableCell>
        {recorded ? (
          <Stack spacing={0.5} alignItems="flex-start">
            <Typography variant="body2">{recorded.label}</Typography>
            <Chip size="small" variant="outlined" label={recorded.kind} />
          </Stack>
        ) : (
          <Typography variant="caption" color="text.secondary">Nobody</Typography>
        )}
      </TableCell>
      <TableCell>
        <Stack direction="row" spacing={1} alignItems="center">
          <PeoplePicker value={selected} onChange={onSelect} />
          <Button
            size="small"
            variant="contained"
            disabled={!selected || saving}
            onClick={() => onLink(selected)}
          >
            {saving ? <CircularProgress size={16} /> : 'Link'}
          </Button>
          {recorded && (
            <Tooltip title="Take this guest off that person and remove the rows this guest gave them. Rows from a Google Form are left alone.">
              <span>
                <Button size="small" color="error" disabled={saving} onClick={() => onLink(null)}>
                  Unlink
                </Button>
              </span>
            </Tooltip>
          )}
        </Stack>
      </TableCell>
    </TableRow>
  );
}

// Searches candidates and members together, because a Luma guest can turn out
// to be either and an admin should not have to know which before they look.
function PeoplePicker({ value, onChange }) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) {
      setOptions([]);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        setLoading(true);
        const { people } = await apiClient.get(`/admin/luma/people?q=${encodeURIComponent(query.trim())}`);
        if (!cancelled) setOptions(people);
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const groupBy = useMemo(() => (option) => (option.kind === 'member' ? 'Members' : 'Candidates'), []);

  return (
    <Autocomplete
      sx={{ minWidth: 240 }}
      size="small"
      value={value}
      onChange={(_e, person) => onChange(person)}
      onInputChange={(_e, text) => setQuery(text)}
      options={options}
      groupBy={groupBy}
      loading={loading}
      isOptionEqualToValue={(a, b) => a.id === b.id && a.kind === b.kind}
      getOptionLabel={(option) => `${fullName(option)} (${option.email})`}
      filterOptions={(x) => x}
      noOptionsText={query.trim().length < 2 ? 'Type a name or email' : 'Nobody found'}
      renderInput={(params) => <TextField {...params} label="Search people" />}
    />
  );
}
