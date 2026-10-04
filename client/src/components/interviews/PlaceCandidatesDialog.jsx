import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

const fullName = (candidate) => `${candidate?.firstName ?? ''} ${candidate?.lastName ?? ''}`.trim() || 'Unknown';

const seatsLabel = (slot) =>
  slot.candidateCapacity == null ? `${slot.confirmedCount ?? 0} booked` : `${slot.confirmedCount ?? 0} / ${slot.candidateCapacity}`;

/**
 * Put people who are in the round but never booked into a session of the
 * admin's choosing. Several at once, because the usual case is a handful of
 * stragglers the day before, all going to whichever block has room.
 *
 * Over capacity is allowed, as it is everywhere else on this page, but only
 * once the button says so.
 */
export default function PlaceCandidatesDialog({ open, candidates, slots, initialSelected, slotHeading, onClose, onPlace }) {
  const [selected, setSelected] = useState(() => new Set());
  const [slotId, setSlotId] = useState('');
  const [filter, setFilter] = useState('');

  // An ended session is refused by the server anyway; offering it would only
  // set up an error.
  const bookable = useMemo(
    () => slots.filter((slot) => slot.isBookable !== false && new Date(slot.endTime) > new Date()),
    [slots]
  );
  const spansInterviews = new Set(bookable.map((slot) => slot.interviewId).filter(Boolean)).size > 1;

  useEffect(() => {
    if (!open) return;
    setSelected(new Set(initialSelected ?? []));
    setFilter('');
    // Default to the first session with a free seat, which is what the old
    // one-click placement picked silently.
    const withRoom = bookable.find(
      (slot) => slot.candidateCapacity == null || (slot.confirmedCount ?? 0) < slot.candidateCapacity
    );
    setSlotId((withRoom ?? bookable[0])?.id ?? '');
    // Reset only when the dialog opens, not every time the roster reloads.
  }, [open]);

  const visible = candidates.filter((c) => {
    const needle = filter.trim().toLowerCase();
    return !needle || `${fullName(c)} ${c.email ?? ''}`.toLowerCase().includes(needle);
  });

  const slot = bookable.find((s) => s.id === slotId) ?? null;
  const freeSeats = slot?.candidateCapacity == null ? Infinity : slot.candidateCapacity - (slot.confirmedCount ?? 0);
  const overBy = slot ? Math.max(0, selected.size - Math.max(0, freeSeats)) : 0;

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allVisibleSelected = visible.length > 0 && visible.every((c) => selected.has(c.id));
  const toggleAllVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      visible.forEach((c) => (allVisibleSelected ? next.delete(c.id) : next.add(c.id)));
      return next;
    });

  const submit = () => {
    const chosen = candidates.filter((c) => selected.has(c.id));
    onPlace(chosen, slot, { force: overBy > 0 });
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Add to a session</DialogTitle>
      <DialogContent dividers>
        {bookable.length === 0 ? (
          <Alert severity="info">There are no bookable sessions in this round yet. Add some first.</Alert>
        ) : (
          <Stack spacing={2}>
            <FormControl size="small" fullWidth>
              <InputLabel id="place-session-label">Session</InputLabel>
              <Select
                labelId="place-session-label"
                label="Session"
                value={slotId}
                onChange={(e) => setSlotId(e.target.value)}
              >
                {bookable.map((s) => (
                  <MenuItem key={s.id} value={s.id}>
                    {slotHeading(s)}
                    {spansInterviews && s.interviewTitle ? ` · ${s.interviewTitle}` : ''} ({seatsLabel(s)})
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Box>
              <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
                <Typography variant="subtitle2">
                  Who ({selected.size} of {candidates.length} selected)
                </Typography>
                <Button size="small" onClick={toggleAllVisible} disabled={visible.length === 0}>
                  {allVisibleSelected ? 'Clear' : 'Select all'}
                </Button>
              </Stack>
              <TextField
                size="small"
                fullWidth
                placeholder="Filter by name or email"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                inputProps={{ 'aria-label': 'Filter people to add' }}
              />
              <List dense sx={{ maxHeight: 280, overflowY: 'auto', mt: 1 }}>
                {visible.map((c) => (
                  <ListItemButton key={c.id} onClick={() => toggle(c.id)} dense>
                    <ListItemIcon sx={{ minWidth: 36 }}>
                      <Checkbox
                        edge="start"
                        size="small"
                        checked={selected.has(c.id)}
                        tabIndex={-1}
                        disableRipple
                        inputProps={{ 'aria-label': fullName(c) }}
                      />
                    </ListItemIcon>
                    <ListItemText primary={fullName(c)} secondary={c.email} />
                  </ListItemButton>
                ))}
                {visible.length === 0 && (
                  <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
                    Nobody matches that.
                  </Typography>
                )}
              </List>
            </Box>

            {overBy > 0 && (
              <Alert severity="warning">
                {slotHeading(slot)} has {Math.max(0, freeSeats)} seat{freeSeats === 1 ? '' : 's'} left. Adding{' '}
                {selected.size} puts it {overBy} over capacity.
              </Alert>
            )}
            <Typography variant="caption" color="text.secondary">
              Each person gets the same confirmation email as if they had booked it themselves.
            </Typography>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          color={overBy > 0 ? 'warning' : 'primary'}
          disabled={!slot || selected.size === 0}
          onClick={submit}
        >
          {overBy > 0 ? `Add ${selected.size} anyway` : `Add ${selected.size || ''}`.trim()}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
