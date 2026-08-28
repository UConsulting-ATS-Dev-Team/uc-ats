import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  ListItemText,
  Chip,
  CircularProgress,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import apiClient from '../utils/api';

// Filter builder for assigning resumes to one partner client.
//
// Rows AND together; values within a row OR. That is the whole grammar, and it
// covers "class of 2030 AND female" without a nested boolean editor that is
// easy to misread and therefore easy to over-share with.
//
// Preview is an explicit button rather than live-per-keystroke: the codebase's
// own convention (ApplicationList's pending-vs-applied filters), and running a
// `contains` sweep over free-text major columns on every keystroke is a bad
// idea on a table this size.

// The three real pools. There is no "All pools" entry any more - selecting all
// three says the same thing, and an explicit list is what the server now takes.
// It still accepts the old single `pool`, which saved batches carry.
const POOLS = [
  { value: 'APPLICANTS', label: 'Applicants' },
  { value: 'MEMBERS', label: 'Members' },
  { value: 'EXTERNALS', label: 'UCLA students' },
];

// What an admin sees in the Type column. "UCLA student" rather than "external":
// the row is a person, and the word describes their relationship to
// UConsulting, not a system boundary.
const KIND_LABELS = {
  APPLICANT: 'Applicant',
  MEMBER: 'Member',
  EXTERNAL: 'UCLA student',
};

const NUMBER_OPS = [
  { value: 'gte', label: 'at least' },
  { value: 'lte', label: 'at most' },
];

const emptyRow = () => ({ field: '', values: [], op: 'gte', value: '', boolValue: true });

const ClientAssignBuilder = ({ client, onDone }) => {
  const [fields, setFields] = useState([]);
  const [options, setOptions] = useState({});
  const [pools, setPools] = useState(['APPLICANTS']);
  const [rows, setRows] = useState([emptyRow()]);
  const [preview, setPreview] = useState(null);
  const [checked, setChecked] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    apiClient
      .get('/admin/talent-pool/filter-fields')
      .then((data) => {
        setFields(data.fields || []);
        setOptions(data.options || {});
      })
      .catch((err) => setError(err.message || 'Failed to load filter options'));
  }, []);

  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);

  const buildFilter = useCallback(
    () => ({
      pools,
      rows: rows
        .filter((r) => r.field)
        .map((r) => {
          const field = fieldByKey.get(r.field);
          if (!field) return null;
          if (field.type === 'number') return { field: r.field, op: r.op, value: r.value };
          if (field.type === 'bool') return { field: r.field, value: r.boolValue };
          return { field: r.field, values: r.values };
        })
        .filter(Boolean),
    }),
    [pools, rows, fieldByKey]
  );

  const runPreview = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiClient.post(`/admin/talent-pool/clients/${client.id}/preview`, {
        filter: buildFilter(),
      });
      setPreview(data);
      // Everything eligible starts checked; the admin trims down rather than up.
      // The exception is a row the filter could not fully narrow - an uploaded
      // resume that has no recruiting cycle or GPA to test. Those are real
      // matches for the part of the filter that does apply, but sharing them is
      // a decision the admin has not made yet, so they start unticked.
      setChecked(
        new Set(
          (data.rows || [])
            .filter((r) => !r.alreadyAssigned && !r.unnarrowedBy?.length)
            .map((r) => r.key)
        )
      );
    } catch (err) {
      setError(err.message || 'Failed to preview matches');
      setPreview(null);
    } finally {
      setLoading(false);
    }
  };

  const commit = async () => {
    setLoading(true);
    setError('');
    try {
      // Only the keys still checked are sent. The server never re-runs the
      // filter, so this trim is what actually gets assigned.
      const data = await apiClient.post(`/admin/talent-pool/clients/${client.id}/assign`, {
        keys: [...checked],
        filter: buildFilter(),
        note: note || null,
      });
      const skippedNote = data.skipped?.length ? ` ${data.skipped.length} skipped.` : '';
      window.alert(`Assigned ${data.created} resume(s) to ${client.organization}.${skippedNote}`);
      onDone();
    } catch (err) {
      setError(err.message || 'Failed to assign resumes');
    } finally {
      setLoading(false);
    }
  };

  const updateRow = (index, patch) =>
    setRows(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const usedFields = new Set(rows.map((r) => r.field).filter(Boolean));

  const toggle = (key) => {
    const next = new Set(checked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setChecked(next);
  };

  // "Select all" acts on everything still assignable, including the rows the
  // filter could not fully narrow: ticking the header box is itself the
  // deliberate act those rows were waiting for.
  const eligibleRows = (preview?.rows || []).filter((r) => !r.alreadyAssigned);
  const allChecked = eligibleRows.length > 0 && eligibleRows.every((r) => checked.has(r.key));

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
        <IconButton onClick={onDone} size="small">
          <ArrowBackIcon />
        </IconButton>
        <Box>
          <Typography variant="h6">Assign resumes to {client.organization}</Typography>
          <Typography variant="body2" color="text.secondary">
            Visibility: {client.visibility}. Applicants who opted out of the Talent Partner
            Network are never assignable; everyone else in these pools is.
          </Typography>
        </Box>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <Paper sx={{ p: 2, mb: 3 }}>
        <Stack spacing={2}>
          <FormControl size="small" sx={{ maxWidth: 360 }}>
            <InputLabel id="assign-pool-label">Pools</InputLabel>
            <Select
              labelId="assign-pool-label"
              id="assign-pools"
              multiple
              value={pools}
              label="Pools"
              onChange={(e) => {
                const next = typeof e.target.value === 'string'
                  ? e.target.value.split(',')
                  : e.target.value;
                // Clearing every box would send an empty list, which the server
                // rejects. Refusing the last uncheck keeps the control honest
                // rather than letting it reach a state that cannot be previewed.
                if (next.length > 0) setPools(next);
              }}
              renderValue={(picked) =>
                picked.length === POOLS.length
                  ? 'All pools'
                  : POOLS.filter((p) => picked.includes(p.value)).map((p) => p.label).join(', ')
              }
            >
              {POOLS.map((p) => (
                <MenuItem key={p.value} value={p.value}>
                  <Checkbox size="small" checked={pools.includes(p.value)} />
                  <ListItemText primary={p.label} />
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {rows.map((row, index) => {
            const field = fieldByKey.get(row.field);
            return (
              <Stack key={index} direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems="center">
                <FormControl size="small" sx={{ minWidth: 200 }}>
                  <InputLabel id={`assign-field-label-${index}`}>Field</InputLabel>
                  <Select
                    labelId={`assign-field-label-${index}`}
                    value={row.field}
                    label="Field"
                    onChange={(e) => updateRow(index, { field: e.target.value, values: [], value: '' })}
                  >
                    {fields.map((f) => (
                      <MenuItem key={f.key} value={f.key} disabled={usedFields.has(f.key) && f.key !== row.field}>
                        {f.label}
                        {f.pool === 'applicants' ? ' (applicants only)' : ''}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>

                {field && (field.type === 'multiText' || field.type === 'multiId') && (
                  <Autocomplete
                    multiple
                    size="small"
                    sx={{ flex: 1, minWidth: 260 }}
                    options={(options[field.key] || []).map((o) =>
                      typeof o === 'string' ? o : o.value
                    )}
                    getOptionLabel={(opt) => {
                      const list = options[field.key] || [];
                      const match = list.find((o) => typeof o !== 'string' && o.value === opt);
                      return match ? match.label : String(opt);
                    }}
                    value={row.values}
                    onChange={(_, v) => updateRow(index, { values: v })}
                    renderInput={(params) => (
                      <TextField {...params} label="Any of" placeholder="Select one or more" />
                    )}
                  />
                )}

                {field && field.type === 'number' && (
                  <>
                    <FormControl size="small" sx={{ minWidth: 140 }}>
                      <InputLabel id={`assign-op-label-${index}`}>Comparison</InputLabel>
                      <Select
                        labelId={`assign-op-label-${index}`}
                        value={row.op}
                        label="Comparison"
                        onChange={(e) => updateRow(index, { op: e.target.value })}
                      >
                        {NUMBER_OPS.map((o) => (
                          <MenuItem key={o.value} value={o.value}>
                            {o.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <TextField
                      size="small"
                      label="Value"
                      placeholder="3.50"
                      value={row.value}
                      onChange={(e) => updateRow(index, { value: e.target.value })}
                    />
                  </>
                )}

                {field && field.type === 'bool' && (
                  <FormControl size="small" sx={{ minWidth: 140 }}>
                    <InputLabel id={`assign-bool-label-${index}`}>Is</InputLabel>
                    <Select
                      labelId={`assign-bool-label-${index}`}
                      value={row.boolValue ? 'yes' : 'no'}
                      label="Is"
                      onChange={(e) => updateRow(index, { boolValue: e.target.value === 'yes' })}
                    >
                      <MenuItem value="yes">Yes</MenuItem>
                      <MenuItem value="no">No</MenuItem>
                    </Select>
                  </FormControl>
                )}

                <IconButton
                  onClick={() => setRows(rows.length === 1 ? [emptyRow()] : rows.filter((_, i) => i !== index))}
                  size="small"
                  aria-label="Remove filter row"
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Stack>
            );
          })}

          <Stack direction="row" spacing={1}>
            <Button size="small" startIcon={<AddIcon />} onClick={() => setRows([...rows, emptyRow()])}>
              Add filter
            </Button>
            <Button variant="contained" onClick={runPreview} disabled={loading}>
              Preview matches
            </Button>
          </Stack>

          <Typography variant="caption" color="text.secondary">
            Filters combine with AND. Multiple values in one filter combine with OR.
          </Typography>
        </Stack>
      </Paper>

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      )}

      {preview && !loading && (
        <Paper sx={{ p: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="subtitle1">
              {preview.total} match{preview.total === 1 ? '' : 'es'}
              {preview.truncated ? ` (showing the first ${preview.rows.length})` : ''}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {checked.size} selected
            </Typography>
          </Stack>

          {(preview.excluded?.optedOut > 0 ||
            preview.excluded?.noBlindResume > 0 ||
            preview.excluded?.memberNoConsent > 0 ||
            preview.excluded?.externalNotAssignable > 0) && (
            <Alert severity="info" sx={{ mb: 2 }}>
              <AlertTitle>Excluded from these matches</AlertTitle>
              <Stack spacing={0.5}>
                {preview.excluded.optedOut > 0 && (
                  <Typography variant="body2">
                    {preview.excluded.optedOut} opted out of the Talent Partner Network.
                  </Typography>
                )}
                {preview.excluded.noBlindResume > 0 && (
                  <Typography variant="body2">
                    {preview.excluded.noBlindResume} have no redacted resume, and this client is
                    blind-visibility.
                  </Typography>
                )}
                {preview.excluded.memberNoConsent > 0 && (
                  <Typography variant="body2">
                    {preview.excluded.memberNoConsent} member(s) have not consented to sharing.
                  </Typography>
                )}
                {preview.excluded.externalNotAssignable > 0 && (
                  <Typography variant="body2">
                    {preview.excluded.externalNotAssignable} UCLA student(s) have not consented to
                    sharing, or have not verified their UCLA email.
                  </Typography>
                )}
              </Stack>
            </Alert>
          )}

          {preview.notes?.length > 0 && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              <Stack spacing={0.5}>
                {preview.notes.map((n, i) => (
                  <Typography variant="body2" key={i}>
                    {n}
                  </Typography>
                ))}
              </Stack>
            </Alert>
          )}

          <TableContainer sx={{ maxHeight: 460 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Checkbox
                      checked={allChecked}
                      indeterminate={checked.size > 0 && !allChecked}
                      onChange={() =>
                        setChecked(allChecked ? new Set() : new Set(eligibleRows.map((r) => r.key)))
                      }
                      inputProps={{ 'aria-label': 'Select all matches' }}
                    />
                  </TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Class</TableCell>
                  <TableCell>Major</TableCell>
                  <TableCell>Gender</TableCell>
                  <TableCell>GPA</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {preview.rows.map((row) => (
                  <TableRow key={row.key} hover selected={checked.has(row.key)}>
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={checked.has(row.key)}
                        disabled={row.alreadyAssigned}
                        onChange={() => toggle(row.key)}
                        inputProps={{ 'aria-label': `Select ${row.name}` }}
                      />
                    </TableCell>
                    <TableCell>
                      {row.name}
                      {row.alreadyAssigned && (
                        <Chip size="small" label="Already shared" sx={{ ml: 1 }} variant="outlined" />
                      )}
                      {!row.alreadyAssigned && row.unnarrowedBy?.length > 0 && (
                        <Chip
                          size="small"
                          color="warning"
                          variant="outlined"
                          sx={{ ml: 1 }}
                          label={`Not filtered by ${row.unnarrowedBy.join(', ')}`}
                        />
                      )}
                    </TableCell>
                    <TableCell>{KIND_LABELS[row.kind] || 'Applicant'}</TableCell>
                    <TableCell>{row.graduationYear || '—'}</TableCell>
                    <TableCell>{[row.major1, row.major2].filter(Boolean).join(', ') || '—'}</TableCell>
                    <TableCell>{row.gender || '—'}</TableCell>
                    <TableCell>{row.cumulativeGpa || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center" sx={{ mt: 2 }}>
            <TextField
              size="small"
              label="Batch note (internal)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              sx={{ flex: 1 }}
            />
            <Button variant="contained" disabled={checked.size === 0 || loading} onClick={commit}>
              Assign {checked.size} resume{checked.size === 1 ? '' : 's'}
            </Button>
          </Stack>
        </Paper>
      )}
    </Box>
  );
};

export default ClientAssignBuilder;
