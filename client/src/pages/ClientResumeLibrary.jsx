import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormLabel,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import AccessControl from '../components/AccessControl';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import { useAuth } from '../context/AuthContext';
import apiClient from '../utils/api';
import '../styles/ClientResumeLibrary.css';

// The only page a Talent Partner Network client sees: their assigned resumes as
// a spreadsheet-style table they can filter, sort, select and export.
//
// There is deliberately no download control for the PDFs themselves. The file is
// shown through DocumentPreviewModal, which fetches a blob and renders it in an
// iframe with the viewer toolbar suppressed. That is deterrence plus an audit
// trail, not prevention - see the note in the branch README/plan.
//
// Export is the deliberate exception, and it is metadata only: the CSV carries
// exactly the columns this client's visibility already puts on screen, and the
// server records one access-log row per exported resume. What a client cannot
// export is a resume file.
//
// Column and control visibility is driven entirely by `account.filterableFields`
// / `account.sortableFields`, which the server derives from the same visibility
// level its projection uses. A BLIND client does not get a greyed-out Gender
// column - the column does not exist, matching the server's omit-don't-null rule.

const ROWS_PER_PAGE_OPTIONS = [25, 50, 100];

// Below this the columns stop shrinking and the table scrolls sideways inside
// its own container. Squeezing twelve columns into a phone-width viewport is
// what made cells collide in the first place.
const MIN_TABLE_WIDTH = 1080;

// Applied to the header cell and the body cell of each column so the two can
// never disagree about width or wrapping.
//
// Short columns are `nowrap`: a wrapped "2029" or "Applicant" costs a row of
// height and reads worse. Free text wraps inside its own cell instead.
// `anywhere` on email and phone is the load-bearing one - an address has no
// space to break at, so a long one overflows its cell and prints on top of the
// next column, which is exactly the overlap this fixes.
const COLUMNS = {
  // Wide enough for the checkbox plus its ripple target. Left at MUI's default
  // the box sat flush against the cell edge and clipped.
  select: { width: 52, minWidth: 52 },
  ref: { width: 120, whiteSpace: 'nowrap' },
  name: { minWidth: 160, whiteSpace: 'nowrap' },
  kind: { width: 110, whiteSpace: 'nowrap' },
  graduationYear: { width: 90, whiteSpace: 'nowrap' },
  major: { minWidth: 180 },
  major2: { minWidth: 180 },
  gender: { minWidth: 110, whiteSpace: 'nowrap' },
  // minWidth, not width: "Major GPA" plus its sort arrow is wider than the
  // numbers under it, and the header is what has to fit.
  gpa: { minWidth: 112, whiteSpace: 'nowrap' },
  phone: { minWidth: 140, overflowWrap: 'anywhere' },
  assignedAt: { minWidth: 120, whiteSpace: 'nowrap' },
  // Last column on purpose: an address is the longest value in the row and the
  // only one with no natural break point, so it gets the leftover width and
  // nothing sits to its right to be printed over.
  email: { minWidth: 220, overflowWrap: 'anywhere' },
};

const displayName = (item) => {
  if (item.firstName || item.lastName) {
    return [item.firstName, item.lastName].filter(Boolean).join(' ');
  }
  return null;
};

// Mirrors referenceFor() on the server so the on-screen handle and the CSV cell
// are the same string.
const referenceFor = (assignmentId) =>
  String(assignmentId || '').replace(/-/g, '').slice(0, 8).toUpperCase();

const filenameFromDisposition = (header) => {
  const match = /filename="?([^"]+)"?/.exec(header || '');
  return match ? match[1] : null;
};

// Both pools are included by default: a client's library is everything shared
// with them, and an unchecked box would hide rows they were never told about.
// Unchecking one is how you narrow to the other.
const DEFAULT_KINDS = { MEMBER: true, APPLICANT: true };

const EMPTY_FILTERS = {
  kinds: DEFAULT_KINDS,
  graduationYear: [],
  major: [],
  gender: [],
  gpaMin: '',
  gpaMax: '',
};

const ClientResumeLibrary = () => {
  const { token } = useAuth();

  const [account, setAccount] = useState(null);
  const [facets, setFacets] = useState({});
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [notes, setNotes] = useState([]);

  const [pendingSearch, setPendingSearch] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [sort, setSort] = useState({ field: 'assignedAt', dir: 'desc' });
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(ROWS_PER_PAGE_OPTIONS[0]);

  const [selected, setSelected] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);

  const canFilter = useCallback(
    (field) => account?.filterableFields?.includes(field) ?? false,
    [account]
  );
  const canSort = useCallback(
    (field) => account?.sortableFields?.includes(field) ?? false,
    [account]
  );

  const showsIdentity = account?.visibility === 'BASIC' || account?.visibility === 'FULL';
  const showsContact = account?.visibility === 'FULL';

  useEffect(() => {
    let cancelled = false;
    Promise.all([apiClient.get('/client/me'), apiClient.get('/client/facets')])
      .then(([me, facetValues]) => {
        if (cancelled) return;
        setAccount(me);
        setFacets(facetValues || {});
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load your account');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Both boxes ticked is the same set as no kind filter at all, so it sends no
  // `kind` param rather than an impossible "APPLICANT and MEMBER".
  const selectedKinds = useMemo(
    () => Object.keys(filters.kinds).filter((kind) => filters.kinds[kind]),
    [filters.kinds]
  );
  const noKindSelected = selectedKinds.length === 0;

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set('limit', String(rowsPerPage));
    params.set('offset', String(page * rowsPerPage));
    params.set('sort', sort.field);
    params.set('dir', sort.dir);
    if (search) params.set('q', search);
    if (selectedKinds.length === 1) params.set('kind', selectedKinds[0]);
    for (const field of ['graduationYear', 'major', 'gender']) {
      if (filters[field]?.length) params.set(field, filters[field].join(','));
    }
    if (filters.gpaMin) params.set('gpaMin', filters.gpaMin);
    if (filters.gpaMax) params.set('gpaMax', filters.gpaMax);
    return params.toString();
  }, [rowsPerPage, page, sort, search, filters, selectedKinds]);

  // Only fetch once the account is known: the server drops filters and sorts the
  // client's visibility disallows, and firing before then would render one page
  // under the default sort and then immediately replace it.
  const ready = Boolean(account);

  useEffect(() => {
    if (!ready) return undefined;

    // Neither type ticked matches nothing. Answering that locally rather than
    // asking the server keeps it from coming back as an unfiltered 500-row page,
    // which is what an empty `kind` param means to /client/resumes.
    if (noKindSelected) {
      setItems([]);
      setTotal(0);
      setNotes([]);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setError('');
    apiClient
      .get(`/client/resumes?${queryString}`)
      .then((data) => {
        if (cancelled) return;
        setItems(data.items || []);
        setTotal(data.total || 0);
        setNotes(data.notes || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load your resume library');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, queryString, noKindSelected]);

  // Any change to what is being matched resets to the first page. Without this,
  // narrowing a filter while on page 4 lands on an empty page that reads as "no
  // results" when there are plenty.
  const resetPage = () => setPage(0);

  const applySearch = () => {
    setSearch(pendingSearch.trim());
    resetPage();
  };

  const updateFilter = (field, value) => {
    setFilters((prev) => ({ ...prev, [field]: value }));
    resetPage();
  };

  const clearAll = () => {
    setPendingSearch('');
    setSearch('');
    setFilters(EMPTY_FILTERS);
    resetPage();
  };

  const toggleKind = (kind) => {
    setFilters((prev) => ({
      ...prev,
      kinds: { ...prev.kinds, [kind]: !prev.kinds[kind] },
    }));
    resetPage();
  };

  const activeFilterCount =
    // Only a narrowed type counts: both boxes ticked is the unfiltered set.
    (selectedKinds.length === Object.keys(filters.kinds).length ? 0 : 1) +
    filters.graduationYear.length +
    filters.major.length +
    filters.gender.length +
    (filters.gpaMin ? 1 : 0) +
    (filters.gpaMax ? 1 : 0);

  const toggleSort = (field) => {
    setSort((prev) =>
      prev.field === field
        ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { field, dir: 'asc' }
    );
    resetPage();
  };

  const toggleRow = (assignmentId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(assignmentId)) next.delete(assignmentId);
      else next.add(assignmentId);
      return next;
    });
  };

  const pageIds = items.map((item) => item.assignmentId);
  const pageSelectedCount = pageIds.filter((id) => selected.has(id)).length;
  const allPageSelected = pageIds.length > 0 && pageSelectedCount === pageIds.length;

  // Selection spans pages, so the header checkbox acts on the current page only
  // and the toolbar reports the running total. A header box that silently
  // cleared selections made on other pages would lose work without saying so.
  const togglePage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const exportSelected = async () => {
    if (selected.size === 0) return;
    setExporting(true);
    setError('');
    try {
      // Raw fetch rather than apiClient: the response is a CSV body, and
      // apiClient always parses JSON.
      const response = await fetch('/api/client/resumes/export', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ assignmentIds: [...selected] }),
      });

      if (!response.ok) {
        let message = `Export failed (${response.status})`;
        try {
          const body = await response.json();
          if (body?.error) message = body.error;
        } catch {
          // A non-JSON error body tells us nothing more than the status did.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download =
        filenameFromDisposition(response.headers.get('content-disposition')) || 'resumes.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || 'Failed to export your selection');
    } finally {
      setExporting(false);
    }
  };

  const sortLabel = (field, label, extraProps = {}) => (
    <TableCell {...extraProps}>
      {canSort(field) ? (
        <TableSortLabel
          active={sort.field === field}
          direction={sort.field === field ? sort.dir : 'asc'}
          onClick={() => toggleSort(field)}
        >
          {label}
        </TableSortLabel>
      ) : (
        label
      )}
    </TableCell>
  );

  const multiSelectFilter = (field, label) => (
    <Autocomplete
      multiple
      size="small"
      options={facets[field] || []}
      value={filters[field]}
      onChange={(_, value) => updateFilter(field, value)}
      disableCloseOnSelect
      sx={{ minWidth: 220, flex: 1 }}
      renderInput={(params) => <TextField {...params} label={label} placeholder="Any of" />}
      renderTags={(value, getTagProps) =>
        value.map((option, index) => (
          <Chip size="small" label={option} {...getTagProps({ index })} key={option} />
        ))
      }
    />
  );

  const columnCount =
    2 + // checkbox + reference
    (showsIdentity ? 2 : 0) + // name, gender
    4 + // type, class, major, second major
    (showsContact ? 4 : 0) + // cumulative gpa, major gpa, phone, email
    1; // shared on

  return (
    <AccessControl allowedRoles={['CLIENT']}>
      {/* The class is load-bearing, not cosmetic - see ClientResumeLibrary.css. */}
      <Box className="client-resume-library" sx={{ p: 3 }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          justifyContent="space-between"
          alignItems={{ md: 'center' }}
          spacing={1}
          sx={{ mb: 3 }}
        >
          <Box>
            <Typography variant="h4">Resume Library</Typography>
            <Typography variant="body2" color="text.secondary">
              {account?.organization
                ? `${account.organization} — ${total} resume${total === 1 ? '' : 's'}${
                    activeFilterCount > 0 || search ? ' matching your filters' : ' shared with you'
                  }`
                : 'Loading your account…'}
            </Typography>
          </Box>

          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body2" color="text.secondary">
              {selected.size} selected
            </Typography>
            <Tooltip
              title={
                selected.size === 0
                  ? 'Select one or more rows to export'
                  : 'Downloads a spreadsheet of the columns shown here. Resume files are not included.'
              }
            >
              <span>
                <Button
                  variant="contained"
                  startIcon={<FileDownloadOutlinedIcon />}
                  disabled={selected.size === 0 || exporting}
                  onClick={exportSelected}
                >
                  {exporting ? 'Preparing…' : 'Export CSV'}
                </Button>
              </span>
            </Tooltip>
          </Stack>
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        {notes.map((note) => (
          <Alert severity="info" sx={{ mb: 2 }} key={note}>
            {note}
          </Alert>
        ))}

        <Paper sx={{ p: 2, mb: 3 }}>
          <Stack spacing={2}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="center">
              <TextField
                size="small"
                fullWidth
                placeholder={
                  showsIdentity
                    ? 'Search by name, major, or graduation year'
                    : 'Search by major or graduation year'
                }
                value={pendingSearch}
                onChange={(e) => setPendingSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applySearch();
                }}
                InputProps={{ startAdornment: <SearchIcon fontSize="small" sx={{ mr: 1 }} /> }}
              />
              <Button variant="outlined" onClick={applySearch} disabled={loading}>
                Search
              </Button>
              {(search || activeFilterCount > 0) && (
                <Button onClick={clearAll} disabled={loading}>
                  Clear all
                </Button>
              )}
            </Stack>

            <Divider flexItem />

            <Stack
              direction={{ xs: 'column', md: 'row' }}
              spacing={2}
              alignItems={{ md: 'center' }}
              useFlexGap
              flexWrap="wrap"
            >
              {multiSelectFilter('graduationYear', 'Graduation year')}
              {multiSelectFilter('major', 'Major')}
              {canFilter('gender') && multiSelectFilter('gender', 'Gender')}

              <FormControl component="fieldset" sx={{ minWidth: 210 }}>
                <FormLabel component="legend" sx={{ fontSize: 12 }}>
                  Type
                </FormLabel>
                <FormGroup row>
                  <FormControlLabel
                    control={
                      <Checkbox
                        size="small"
                        checked={filters.kinds.MEMBER}
                        onChange={() => toggleKind('MEMBER')}
                      />
                    }
                    label="Members"
                  />
                  <FormControlLabel
                    control={
                      <Checkbox
                        size="small"
                        checked={filters.kinds.APPLICANT}
                        onChange={() => toggleKind('APPLICANT')}
                      />
                    }
                    label="Applicants"
                  />
                </FormGroup>
              </FormControl>

              {canFilter('gpa') && (
                <Stack direction="row" spacing={1}>
                  <TextField
                    size="small"
                    label="Min GPA"
                    placeholder="3.50"
                    value={filters.gpaMin}
                    onChange={(e) => updateFilter('gpaMin', e.target.value)}
                    sx={{ width: 110 }}
                  />
                  <TextField
                    size="small"
                    label="Max GPA"
                    placeholder="4.00"
                    value={filters.gpaMax}
                    onChange={(e) => updateFilter('gpaMax', e.target.value)}
                    sx={{ width: 110 }}
                  />
                </Stack>
              )}
            </Stack>
          </Stack>
        </Paper>

        <Paper>
          <TableContainer sx={{ maxHeight: '65vh', overflowX: 'auto' }}>
            <Table size="small" stickyHeader sx={{ minWidth: MIN_TABLE_WIDTH }}>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox" sx={COLUMNS.select}>
                    <Checkbox
                      checked={allPageSelected}
                      indeterminate={pageSelectedCount > 0 && !allPageSelected}
                      onChange={togglePage}
                      inputProps={{ 'aria-label': 'Select all rows on this page' }}
                    />
                  </TableCell>
                  <TableCell sx={COLUMNS.ref}>Ref</TableCell>
                  {showsIdentity && sortLabel('name', 'Name', { sx: COLUMNS.name })}
                  {sortLabel('kind', 'Type', { sx: COLUMNS.kind })}
                  {sortLabel('graduationYear', 'Class', { sx: COLUMNS.graduationYear })}
                  {sortLabel('major', 'Major', { sx: COLUMNS.major })}
                  <TableCell sx={COLUMNS.major2}>Second Major</TableCell>
                  {showsIdentity && sortLabel('gender', 'Gender', { sx: COLUMNS.gender })}
                  {showsContact &&
                    sortLabel('cumulativeGpa', 'GPA', { align: 'right', sx: COLUMNS.gpa })}
                  {showsContact &&
                    sortLabel('majorGpa', 'Major GPA', { align: 'right', sx: COLUMNS.gpa })}
                  {showsContact && <TableCell sx={COLUMNS.phone}>Phone</TableCell>}
                  {sortLabel('assignedAt', 'Shared', { sx: COLUMNS.assignedAt })}
                  {showsContact && <TableCell sx={COLUMNS.email}>Email</TableCell>}
                </TableRow>
              </TableHead>

              <TableBody>
                {loading && (
                  <TableRow>
                    <TableCell colSpan={columnCount} align="center" sx={{ py: 6 }}>
                      <CircularProgress size={28} />
                    </TableCell>
                  </TableRow>
                )}

                {!loading && items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={columnCount} align="center" sx={{ py: 6 }}>
                      <Typography variant="subtitle1" gutterBottom>
                        {noKindSelected
                          ? 'No type selected'
                          : search || activeFilterCount > 0
                            ? 'No resumes match those filters'
                            : 'No resumes have been shared yet'}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {noKindSelected
                          ? 'Tick Members or Applicants to see resumes.'
                          : search || activeFilterCount > 0
                            ? 'Try widening the graduation year or major.'
                            : 'UConsulting will add resumes to your library. Check back shortly.'}
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}

                {!loading &&
                  items.map((item) => {
                    const isSelected = selected.has(item.assignmentId);
                    const name = displayName(item);
                    return (
                      <TableRow
                        key={item.assignmentId}
                        hover
                        selected={isSelected}
                        sx={{ cursor: item.available ? 'pointer' : 'default' }}
                        onClick={() => item.available && setPreview(item)}
                      >
                        <TableCell
                          padding="checkbox"
                          sx={COLUMNS.select}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Checkbox
                            checked={isSelected}
                            onChange={() => toggleRow(item.assignmentId)}
                            inputProps={{
                              'aria-label': `Select ${name || referenceFor(item.assignmentId)}`,
                            }}
                          />
                        </TableCell>

                        <TableCell sx={COLUMNS.ref}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                              {referenceFor(item.assignmentId)}
                            </Typography>
                            {!item.available && (
                              <Tooltip title="No resume file is available for this entry">
                                <Chip size="small" variant="outlined" label="No file" />
                              </Tooltip>
                            )}
                          </Stack>
                        </TableCell>

                        {showsIdentity && <TableCell sx={COLUMNS.name}>{name || '—'}</TableCell>}
                        <TableCell sx={COLUMNS.kind}>
                          {item.kind === 'MEMBER' ? 'Member' : 'Applicant'}
                        </TableCell>
                        <TableCell sx={COLUMNS.graduationYear}>
                          {item.graduationYear || '—'}
                        </TableCell>
                        <TableCell sx={COLUMNS.major}>{item.major1 || '—'}</TableCell>
                        <TableCell sx={COLUMNS.major2}>{item.major2 || '—'}</TableCell>
                        {showsIdentity && (
                          <TableCell sx={COLUMNS.gender}>{item.gender || '—'}</TableCell>
                        )}
                        {showsContact && (
                          <TableCell align="right" sx={COLUMNS.gpa}>
                            {item.cumulativeGpa || '—'}
                          </TableCell>
                        )}
                        {showsContact && (
                          <TableCell align="right" sx={COLUMNS.gpa}>
                            {item.majorGpa || '—'}
                          </TableCell>
                        )}
                        {showsContact && (
                          <TableCell sx={COLUMNS.phone}>{item.phoneNumber || '—'}</TableCell>
                        )}
                        <TableCell sx={COLUMNS.assignedAt}>
                          {item.assignedAt ? item.assignedAt.slice(0, 10) : '—'}
                        </TableCell>
                        {showsContact && (
                          <TableCell sx={COLUMNS.email}>{item.email || '—'}</TableCell>
                        )}
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </TableContainer>

          <TablePagination
            component="div"
            count={total}
            page={page}
            onPageChange={(_, next) => setPage(next)}
            rowsPerPage={rowsPerPage}
            rowsPerPageOptions={ROWS_PER_PAGE_OPTIONS}
            onRowsPerPageChange={(e) => {
              setRowsPerPage(parseInt(e.target.value, 10));
              resetPage();
            }}
          />
        </Paper>

        {preview && (
          <DocumentPreviewModal
            src={preview.pdfUrl}
            kind="pdf"
            title={displayName(preview) || `Resume ${referenceFor(preview.assignmentId)}`}
            onClose={() => setPreview(null)}
          />
        )}
      </Box>
    </AccessControl>
  );
};

export default ClientResumeLibrary;
