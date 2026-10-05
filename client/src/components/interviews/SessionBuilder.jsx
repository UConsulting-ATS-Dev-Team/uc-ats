import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  ListItemText,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  Add as AddIcon,
  ContentCopy as DuplicateIcon,
  DeleteOutline as DeleteIcon,
  ViewWeek as FillIcon,
} from '@mui/icons-material';
import apiClient from '../../utils/api';
import { formatTimeRange, toPacificInput } from '../../utils/scheduleFormat';
import {
  BUSY,
  FREE,
  MAX_ROOMS,
  MAX_SESSIONS,
  SESSION_LENGTHS,
  appendRows,
  buildPayload,
  duplicateRow,
  fillRange,
  fillShape,
  findClashes,
  makeRow,
  nextRow,
  pickerOptions,
  rowInstants,
  sharedRooms,
  summarize,
  typeDefaults,
  validateRows,
} from './sessionBuilderModel';

/**
 * Draft a day's sessions - times, rooms, seats and the people running them -
 * and create them all at once.
 *
 * Recruitment builds sessions by reading who is free and then writing them up,
 * room by room. Doing that one session at a time, and placing interviewers on
 * another tab afterwards, meant holding the availability grid in your head
 * while filling in a form that could not see it. Here each row's picker reads
 * the same availability, so the person free at 10:00 is offered first on the
 * 10:00 row.
 *
 * Nothing is saved until "Create". The arithmetic lives in sessionBuilderModel.js.
 */

const fullName = (u) => u?.fullName ?? 'Unknown';
const pacificDay = (value) => toPacificInput(value).slice(0, 10);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Why a picked interviewer is drawn in warning colour, or '' when they are not. */
const warningFor = (option, clashes) => {
  const reasons = [];
  if (option.group === BUSY) reasons.push('Said they are busy at this time.');
  else if (option.group !== FREE) reasons.push('Never sent availability.');
  if (clashes?.length) reasons.push(`Also on ${clashes.join(', ')} at the same time.`);
  return reasons.join(' ');
};

function DraftRow({
  row,
  index,
  errors,
  isCoffeeChat,
  options,
  staffById,
  clashes,
  sharesRoom,
  loading,
  onChange,
  onDuplicate,
  onDelete,
}) {
  // A first round panel is known by its time; a name is the exception, so it
  // stays out of the way until somebody asks for it.
  const [naming, setNaming] = useState(Boolean(row.label));
  const showName = isCoffeeChat || naming;
  const { start, end } = rowInstants(row);
  const heading = start && end && end > start ? formatTimeRange(start, end) : 'Time not set';

  const picked = row.interviewerIds.map(
    (id) =>
      options.find((o) => o.user.id === id) ?? { user: staffById.get(id) ?? { id, fullName: 'Unknown' }, group: null }
  );
  const wanted = Number(row.interviewerCapacity) || 0;

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }} data-testid={`draft-row-${index}`}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <Typography variant="body2" fontWeight={700}>
          {index + 1}. {row.label || heading}
        </Typography>
        <Box sx={{ flex: 1 }} />
        {!isCoffeeChat && !naming && (
          <Button size="small" onClick={() => setNaming(true)}>
            Name it
          </Button>
        )}
        <Tooltip title="Duplicate">
          <IconButton size="small" aria-label={`Duplicate session ${index + 1}`} onClick={onDuplicate}>
            <DuplicateIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Remove">
          <IconButton size="small" aria-label={`Remove session ${index + 1}`} onClick={onDelete}>
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
        {showName && (
          <TextField
            size="small"
            label="Name"
            placeholder={isCoffeeChat ? 'Morning Session' : 'Group 1A'}
            value={row.label}
            onChange={(e) => onChange({ label: e.target.value })}
            sx={{ width: 180 }}
          />
        )}
        <TextField
          size="small"
          type="date"
          label="Date"
          value={row.day}
          onChange={(e) => onChange({ day: e.target.value })}
          InputLabelProps={{ shrink: true }}
          error={Boolean(errors?.day)}
          helperText={errors?.day}
          sx={{ width: 160 }}
        />
        <TextField
          size="small"
          type="time"
          label="Start"
          value={row.start}
          onChange={(e) => onChange({ start: e.target.value })}
          InputLabelProps={{ shrink: true }}
          error={Boolean(errors?.start)}
          helperText={errors?.start}
          sx={{ width: 130 }}
        />
        <TextField
          size="small"
          type="time"
          label="End"
          value={row.end}
          onChange={(e) => onChange({ end: e.target.value })}
          InputLabelProps={{ shrink: true }}
          error={Boolean(errors?.end)}
          helperText={errors?.end}
          sx={{ width: 130 }}
        />
        <TextField
          size="small"
          label="Location"
          value={row.location}
          onChange={(e) => onChange({ location: e.target.value })}
          helperText={sharesRoom ? 'Another session is here at the same time' : undefined}
          FormHelperTextProps={{ sx: { color: 'warning.main' } }}
          sx={{ flex: '1 1 180px', minWidth: 180 }}
        />
        <TextField
          size="small"
          type="number"
          label="Seats"
          value={row.candidateCapacity}
          onChange={(e) => onChange({ candidateCapacity: e.target.value })}
          error={Boolean(errors?.candidateCapacity)}
          helperText={errors?.candidateCapacity}
          inputProps={{ min: 0 }}
          sx={{ width: 90 }}
        />
        {isCoffeeChat && (
          <TextField
            size="small"
            type="number"
            label="Group size"
            value={row.groupSize}
            onChange={(e) => onChange({ groupSize: e.target.value })}
            error={Boolean(errors?.groupSize)}
            helperText={errors?.groupSize}
            inputProps={{ min: 1 }}
            sx={{ width: 110 }}
          />
        )}
        <TextField
          size="small"
          type="number"
          label="Interviewers wanted"
          value={row.interviewerCapacity}
          onChange={(e) => onChange({ interviewerCapacity: e.target.value })}
          error={Boolean(errors?.interviewerCapacity)}
          helperText={errors?.interviewerCapacity}
          inputProps={{ min: 0 }}
          sx={{ width: 160 }}
        />
      </Stack>

      {/* Anybody on the roster can be picked. Availability decides the order
          and the colour, never the list: exec who were always going to be
          there never fill the form in, and a yes from a meeting counts. */}
      <Autocomplete
        multiple
        size="small"
        loading={loading}
        options={options}
        value={picked}
        groupBy={(o) => o.group}
        getOptionLabel={(o) => fullName(o.user)}
        isOptionEqualToValue={(a, b) => a.user.id === b.user.id}
        filterSelectedOptions
        onChange={(_, next) => onChange({ interviewerIds: next.map((o) => o.user.id) })}
        renderOption={(props, o) => {
          const { key: _key, ...rest } = props;
          return (
            <li {...rest} key={o.user.id}>
              <ListItemText primary={fullName(o.user)} secondary={o.user.email} />
            </li>
          );
        }}
        renderValue={(value, getItemProps) =>
          value.map((o, i) => {
            const { key: _key, ...itemProps } = getItemProps({ index: i });
            const warning = warningFor(o, clashes?.[o.user.id]);
            return (
              <Tooltip key={o.user.id} title={warning}>
                <Chip
                  {...itemProps}
                  size="small"
                  color={warning ? 'warning' : 'default'}
                  variant={warning ? 'filled' : 'outlined'}
                  label={fullName(o.user)}
                />
              </Tooltip>
            );
          })
        }
        renderInput={(params) => (
          <TextField
            {...params}
            label="Interviewers"
            placeholder={picked.length === 0 ? 'Pick who runs it…' : ''}
            helperText={wanted ? `${picked.length} of ${wanted} wanted` : undefined}
          />
        )}
        sx={{ mt: 1.5 }}
      />
    </Paper>
  );
}

export default function SessionBuilder({
  open,
  onClose,
  interviewId,
  interviewType,
  defaultLocation,
  defaultDay,
  initialRows,
  onCreated,
}) {
  const theme = useTheme();
  const small = useMediaQuery(theme.breakpoints.down('sm'));

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [fillOpen, setFillOpen] = useState(false);
  const [fill, setFill] = useState({});

  const type = interviewType ?? data?.interview?.interviewType;
  const isCoffeeChat = type === 'COFFEE_CHAT';

  // Fresh on every open, so a draft abandoned with Cancel does not come back
  // half-filled the next time someone means to start over.
  useEffect(() => {
    if (!open) return undefined;
    const context = { interviewType, location: defaultLocation ?? '', day: defaultDay ?? '' };
    const defaults = typeDefaults(interviewType);
    setError('');
    setShowErrors(false);
    setFillOpen(false);
    setData(null);
    setRows(
      initialRows?.length
        ? initialRows.map((partial) => makeRow(partial, context))
        : [{ ...nextRow([], context), pristine: true }]
    );
    setFill({
      day: context.day,
      start: '09:00',
      end: '17:00',
      minutes: defaults.minutes,
      rooms: 1,
      seats: defaults.candidateCapacity,
    });

    let cancelled = false;
    setLoading(true);
    apiClient
      .get(`/admin/interviews/${interviewId}/availability`)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        // The interview's own place and day stand in for whatever the caller
        // could not supply, on rows nobody has filled in yet.
        const location = defaultLocation || result?.interview?.location || '';
        const day = defaultDay || (result?.interview?.startDate ? pacificDay(result.interview.startDate) : '');
        setRows((current) =>
          current.map((row) => ({ ...row, location: row.location || location, day: row.day || day }))
        );
        setFill((current) => ({ ...current, day: current.day || day }));
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Failed to load who is available, so the interviewer lists are empty.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, interviewId, interviewType, defaultLocation, defaultDay, initialRows]);

  const context = useMemo(
    () => ({
      interviewType: type,
      location: defaultLocation || data?.interview?.location || '',
      day: defaultDay || (data?.interview?.startDate ? pacificDay(data.interview.startDate) : ''),
    }),
    [type, defaultLocation, defaultDay, data]
  );

  const staffById = useMemo(() => new Map((data?.staff ?? []).map((u) => [u.id, u])), [data]);
  const windowsByUser = useMemo(
    () => new Map((data?.interviewers ?? []).map((i) => [i.user.id, i.windows])),
    [data]
  );
  const clashes = useMemo(() => findClashes(rows, data?.sessions ?? []), [rows, data]);
  const shared = useMemo(() => sharedRooms(rows), [rows]);
  const errors = useMemo(() => validateRows(rows), [rows]);
  const totals = summarize(rows);
  const shape = fillShape(fill);
  const tooMany = rows.length > MAX_SESSIONS;

  const updateRow = (key, changes) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...changes, pristine: false } : row)));

  const submit = async () => {
    if (tooMany) return;
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      setError('Some sessions need fixing first. They are marked below.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = await apiClient.post(
        `/admin/interviews/${interviewId}/slots/generate`,
        buildPayload(rows, { interviewType: type, location: context.location })
      );
      onCreated?.(result);
      onClose?.();
    } catch (e) {
      setError(e.message || 'Failed to create those sessions.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="lg" fullScreen={small}>
      <DialogTitle>Build sessions</DialogTitle>
      {loading && <LinearProgress />}
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Draft every session for the day, including ones that run side by side in different rooms. Each
          interviewer list puts the people free at that time first. Nothing is created until you press Create.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
          {/* The opening row stays: asking for the next session means the first one was wanted. */}
          <Button
            size="small"
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={() =>
              setRows((cur) => [...cur.map((r) => ({ ...r, pristine: false })), nextRow(cur, context)])
            }
          >
            Add session
          </Button>
          <Button
            size="small"
            startIcon={<FillIcon />}
            onClick={() => setFillOpen((v) => !v)}
            aria-expanded={fillOpen}
          >
            Fill a time range
          </Button>
        </Stack>

        <Collapse in={fillOpen} unmountOnExit>
          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              Back-to-back sessions from the first start to the last end. With more than one room, each time
              gets that many sessions at once. Give each its own location afterwards.
            </Typography>
            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }} alignItems="center">
              <TextField
                size="small"
                type="date"
                label="Fill date"
                value={fill.day ?? ''}
                onChange={(e) => setFill({ ...fill, day: e.target.value })}
                InputLabelProps={{ shrink: true }}
                sx={{ width: 160 }}
              />
              <TextField
                size="small"
                type="time"
                label="First starts"
                value={fill.start ?? ''}
                onChange={(e) => setFill({ ...fill, start: e.target.value })}
                InputLabelProps={{ shrink: true }}
                sx={{ width: 130 }}
              />
              <TextField
                size="small"
                type="time"
                label="Last ends"
                value={fill.end ?? ''}
                onChange={(e) => setFill({ ...fill, end: e.target.value })}
                InputLabelProps={{ shrink: true }}
                sx={{ width: 130 }}
              />
              <TextField
                size="small"
                select
                label="Each runs"
                value={fill.minutes ?? 60}
                onChange={(e) => setFill({ ...fill, minutes: Number(e.target.value) })}
                sx={{ width: 140 }}
              >
                {SESSION_LENGTHS.map((m) => (
                  <MenuItem key={m} value={m}>
                    {m} minutes
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                size="small"
                select
                label="Rooms at once"
                value={fill.rooms ?? 1}
                onChange={(e) => setFill({ ...fill, rooms: Number(e.target.value) })}
                sx={{ width: 130 }}
              >
                {Array.from({ length: MAX_ROOMS }, (_, i) => i + 1).map((n) => (
                  <MenuItem key={n} value={n}>
                    {n}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                size="small"
                type="number"
                label="Seats each"
                value={fill.seats ?? ''}
                onChange={(e) => setFill({ ...fill, seats: e.target.value })}
                inputProps={{ min: 0 }}
                sx={{ width: 110 }}
              />
              <Button
                variant="contained"
                size="small"
                disabled={shape.total === 0}
                onClick={() => {
                  setRows((cur) => appendRows(cur, fillRange(fill, context)));
                  setFillOpen(false);
                }}
              >
                Add {plural(shape.total, 'session')}
              </Button>
            </Stack>
            {/* Shown before the click: three rooms over a long day is a lot of
                rows, and the server takes at most MAX_SESSIONS at once. */}
            <Typography
              variant="caption"
              color={rows.length + shape.total > MAX_SESSIONS ? 'error' : 'text.secondary'}
              display="block"
              sx={{ mt: 1 }}
            >
              {shape.total === 0
                ? 'Nothing fits between those times.'
                : `Adds ${plural(shape.total, 'session')} (${plural(shape.times, 'time')} × ${plural(shape.rooms, 'room')})`}
            </Typography>
          </Paper>
        </Collapse>

        {rows.length === 0 ? (
          <Alert severity="info">No sessions drafted. Add one, or fill a time range.</Alert>
        ) : (
          <Stack spacing={1.5}>
            {rows.map((row, index) => {
              const { start, end } = rowInstants(row);
              return (
                <DraftRow
                  key={row.key}
                  row={row}
                  index={index}
                  errors={showErrors ? errors[row.key] : undefined}
                  isCoffeeChat={isCoffeeChat}
                  options={pickerOptions(data?.staff, windowsByUser, start, end)}
                  staffById={staffById}
                  clashes={clashes[row.key]}
                  sharesRoom={shared.has(row.key)}
                  loading={loading}
                  onChange={(changes) => updateRow(row.key, changes)}
                  onDuplicate={() =>
                    setRows((cur) => {
                      const at = cur.findIndex((r) => r.key === row.key);
                      return [...cur.slice(0, at + 1), duplicateRow(row), ...cur.slice(at + 1)];
                    })
                  }
                  onDelete={() => setRows((cur) => cur.filter((r) => r.key !== row.key))}
                />
              );
            })}
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5, flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ mr: 'auto' }}>
          <Typography variant="body2" color="text.secondary">
            {plural(totals.sessions, 'session')} · {plural(totals.seats, 'seat')} ·{' '}
            {plural(totals.placements, 'interviewer placement')}
          </Typography>
          {tooMany && (
            <Typography variant="body2" color="error">
              At most {MAX_SESSIONS} sessions at once — create these in two batches
            </Typography>
          )}
        </Box>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={saving || rows.length === 0 || tooMany}>
          {saving ? 'Creating…' : `Create ${plural(rows.length, 'session')}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
