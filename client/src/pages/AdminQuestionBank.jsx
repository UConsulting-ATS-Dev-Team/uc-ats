import React, { useEffect, useMemo, useState } from 'react';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import {
  Box,
  Typography,
  Paper,
  Stack,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  Chip,
  CircularProgress,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  IconButton,
  Tooltip,
  Autocomplete,
  InputAdornment,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  QuizOutlined as QuizIcon,
  Search as SearchIcon,
} from '@mui/icons-material';

// `round` is a free-text column, so nothing stops two admins from typing "Round 1" and
// "ROUND_ONE" for the same round. The picker is constrained to the InterviewType values
// the rest of the app uses; any other value already in the data is still offered (and
// labelled) so existing questions stay editable rather than silently rewritten.
const ROUND_LABELS = {
  COFFEE_CHAT: 'Coffee Chat',
  ROUND_ONE: 'Round 1',
  ROUND_TWO: 'Round 2',
  FINAL_ROUND: 'Final Round',
  DELIBERATIONS: 'Deliberations',
};

const STATUS_COLORS = {
  DRAFT: 'default',
  PUBLISHED: 'success',
  ARCHIVED: 'warning',
};

const STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];

const emptyQuestion = {
  prompt: '',
  guidance: '',
  round: '',
  category: '',
  status: 'DRAFT',
};

function roundLabel(round) {
  return ROUND_LABELS[round] || round;
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Los_Angeles',
  });
}

export default function AdminQuestionBank() {
  const [cycles, setCycles] = useState([]);
  const [cycleId, setCycleId] = useState('');
  const [questions, setQuestions] = useState([]);
  const [facets, setFacets] = useState({ categories: [], rounds: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [roundFilter, setRoundFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState('create');
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyQuestion);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);

  useEffect(() => {
    apiClient
      .get('/admin/cycles')
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setCycles(list);
      })
      .catch(() => setCycles([]));

    apiClient
      .get('/admin/cycles/active')
      .then((active) => {
        if (active?.id) setCycleId(active.id);
      })
      .catch(() => {});
  }, []);

  const fetchQuestions = () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (cycleId) params.set('cycleId', cycleId);
    if (roundFilter) params.set('round', roundFilter);
    if (categoryFilter) params.set('category', categoryFilter);
    if (statusFilter) params.set('status', statusFilter);
    const qs = params.toString();

    apiClient
      .get(`/admin/interview-questions${qs ? `?${qs}` : ''}`)
      .then((data) => setQuestions(Array.isArray(data) ? data : []))
      .catch((e) => setError(e.message || 'Failed to load questions.'))
      .finally(() => setLoading(false));
  };

  const fetchFacets = () => {
    const qs = cycleId ? `?cycleId=${encodeURIComponent(cycleId)}` : '';
    apiClient
      .get(`/admin/interview-questions/facets${qs}`)
      .then((data) =>
        setFacets({
          categories: Array.isArray(data?.categories) ? data.categories : [],
          rounds: Array.isArray(data?.rounds) ? data.rounds : [],
        })
      )
      .catch(() => setFacets({ categories: [], rounds: [] }));
  };

  useEffect(() => {
    fetchQuestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleId, roundFilter, categoryFilter, statusFilter]);

  useEffect(() => {
    fetchFacets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleId]);

  useEffect(() => {
    setPage(0);
  }, [cycleId, roundFilter, categoryFilter, statusFilter, search]);

  // The list endpoint has no server-side search or paging yet, so both are applied here.
  // That is fine at bank sizes of a few hundred; past that this needs to move server-side.
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return questions;
    return questions.filter(
      (q) =>
        (q.prompt || '').toLowerCase().includes(needle) ||
        (q.guidance || '').toLowerCase().includes(needle) ||
        (q.category || '').toLowerCase().includes(needle)
    );
  }, [questions, search]);

  const paged = useMemo(
    () => filtered.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage),
    [filtered, page, rowsPerPage]
  );

  const roundOptions = useMemo(() => {
    const known = Object.keys(ROUND_LABELS);
    const extra = facets.rounds.filter((r) => !known.includes(r));
    return [...known, ...extra];
  }, [facets.rounds]);

  const openCreate = () => {
    setDialogMode('create');
    setEditingId(null);
    setForm({ ...emptyQuestion, round: roundFilter || '' });
    setError(null);
    setDialogOpen(true);
  };

  const openEdit = (question) => {
    setDialogMode('edit');
    setEditingId(question.id);
    setForm({
      prompt: question.prompt || '',
      guidance: question.guidance || '',
      round: question.round || '',
      category: question.category || '',
      status: question.status || 'DRAFT',
    });
    setError(null);
    setDialogOpen(true);
  };

  const handleChange = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  const handleSave = async () => {
    if (!form.prompt.trim()) {
      setError('Prompt is required.');
      return;
    }
    if (!form.round) {
      setError('Round is required.');
      return;
    }
    if (dialogMode === 'create' && !cycleId) {
      setError('Select a cycle before adding a question.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const payload = {
        prompt: form.prompt.trim(),
        guidance: form.guidance.trim() || null,
        round: form.round,
        category: form.category.trim() || null,
      };

      if (dialogMode === 'create') {
        await apiClient.post('/admin/interview-questions', {
          ...payload,
          cycleId,
          status: form.status,
        });
      } else {
        // PUT does not accept status - it is moved through its own endpoint so a
        // publish is a deliberate action rather than a side effect of an edit.
        await apiClient.put(`/admin/interview-questions/${editingId}`, payload);
      }

      setDialogOpen(false);
      fetchQuestions();
      fetchFacets();
    } catch (e) {
      setError(e.message || 'Failed to save question.');
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (question, status) => {
    setError(null);
    try {
      await apiClient.patch(`/admin/interview-questions/${question.id}/status`, { status });
      fetchQuestions();
    } catch (e) {
      setError(e.message || 'Failed to update status.');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setError(null);
    try {
      await apiClient.delete(`/admin/interview-questions/${deleteTarget.id}`);
      setDeleteTarget(null);
      fetchQuestions();
      fetchFacets();
    } catch (e) {
      setError(e.message || 'Failed to delete question.');
    }
  };

  const publishedCount = questions.filter((q) => q.status === 'PUBLISHED').length;

  return (
    <AccessControl allowedRoles={['ADMIN']}>
      <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1400 }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          justifyContent="space-between"
          mb={3}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <QuizIcon color="primary" />
            <Box>
              <Typography variant="h4" component="h1">
                Question Bank
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Only published questions appear to interviewers.
              </Typography>
            </Box>
          </Stack>
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
            New question
          </Button>
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Paper sx={{ p: 2, mb: 2 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <FormControl size="small" sx={{ minWidth: 220 }}>
              <InputLabel id="qb-cycle-label">Cycle</InputLabel>
              <Select
                labelId="qb-cycle-label"
                id="qb-cycle"
                value={cycleId}
                label="Cycle"
                onChange={(e) => setCycleId(e.target.value)}
              >
                {cycles.map((c) => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel id="qb-round-filter-label">Round</InputLabel>
              <Select
                labelId="qb-round-filter-label"
                id="qb-round-filter"
                value={roundFilter}
                label="Round"
                onChange={(e) => setRoundFilter(e.target.value)}
              >
                <MenuItem value="">All rounds</MenuItem>
                {facets.rounds.map((r) => (
                  <MenuItem key={r} value={r}>
                    {roundLabel(r)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel id="qb-category-filter-label">Category</InputLabel>
              <Select
                labelId="qb-category-filter-label"
                id="qb-category-filter"
                value={categoryFilter}
                label="Category"
                onChange={(e) => setCategoryFilter(e.target.value)}
              >
                <MenuItem value="">All categories</MenuItem>
                {facets.categories.map((c) => (
                  <MenuItem key={c} value={c}>
                    {c}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 150 }}>
              <InputLabel id="qb-status-filter-label">Status</InputLabel>
              <Select
                labelId="qb-status-filter-label"
                id="qb-status-filter"
                value={statusFilter}
                label="Status"
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <MenuItem value="">All statuses</MenuItem>
                {STATUSES.map((s) => (
                  <MenuItem key={s} value={s}>
                    {s.charAt(0) + s.slice(1).toLowerCase()}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <TextField
              size="small"
              placeholder="Search prompt, guidance, category"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              sx={{ flexGrow: 1, minWidth: 240 }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              }}
            />
          </Stack>
        </Paper>

        <Paper>
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
              <CircularProgress />
            </Box>
          ) : filtered.length === 0 ? (
            <Box sx={{ p: 6, textAlign: 'center' }}>
              <Typography variant="body1" color="text.secondary">
                {questions.length === 0
                  ? 'No questions in this cycle yet.'
                  : 'No questions match these filters.'}
              </Typography>
            </Box>
          ) : (
            <>
              <TableContainer>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableCell>Prompt</TableCell>
                      <TableCell sx={{ width: 140 }}>Round</TableCell>
                      <TableCell sx={{ width: 150 }}>Category</TableCell>
                      <TableCell sx={{ width: 160 }}>Status</TableCell>
                      <TableCell sx={{ width: 110 }}>Updated</TableCell>
                      <TableCell sx={{ width: 110 }} align="right">
                        Actions
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {paged.map((q) => (
                      <TableRow key={q.id} hover>
                        <TableCell>
                          <Typography variant="body2">{q.prompt}</Typography>
                          {q.guidance && (
                            <Typography variant="caption" color="text.secondary">
                              {q.guidance}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell>
                          <Chip size="small" label={roundLabel(q.round)} variant="outlined" />
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary">
                            {q.category || '—'}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Select
                            size="small"
                            inputProps={{ 'aria-label': `Status for: ${q.prompt}` }}
                            value={q.status}
                            onChange={(e) => handleStatusChange(q, e.target.value)}
                            variant="standard"
                            disableUnderline
                            renderValue={(value) => (
                              <Chip
                                size="small"
                                label={value.charAt(0) + value.slice(1).toLowerCase()}
                                color={STATUS_COLORS[value] || 'default'}
                              />
                            )}
                          >
                            {STATUSES.map((s) => (
                              <MenuItem key={s} value={s}>
                                {s.charAt(0) + s.slice(1).toLowerCase()}
                              </MenuItem>
                            ))}
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption" color="text.secondary">
                            {formatDate(q.updatedAt || q.createdAt)}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">
                          <Tooltip title="Edit">
                            <IconButton size="small" onClick={() => openEdit(q)}>
                              <EditIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Delete">
                            <IconButton size="small" onClick={() => setDeleteTarget(q)}>
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
              <TablePagination
                component="div"
                count={filtered.length}
                page={page}
                onPageChange={(e, next) => setPage(next)}
                rowsPerPage={rowsPerPage}
                onRowsPerPageChange={(e) => {
                  setRowsPerPage(parseInt(e.target.value, 10));
                  setPage(0);
                }}
                rowsPerPageOptions={[10, 25, 50, 100]}
              />
            </>
          )}
        </Paper>

        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          {questions.length} question{questions.length === 1 ? '' : 's'} in this cycle ·{' '}
          {publishedCount} visible to interviewers
        </Typography>

        <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
          <DialogTitle>{dialogMode === 'create' ? 'New question' : 'Edit question'}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              <TextField
                label="Prompt"
                value={form.prompt}
                onChange={(e) => handleChange('prompt', e.target.value)}
                multiline
                minRows={2}
                fullWidth
                required
              />
              <TextField
                label="Guidance for the interviewer"
                value={form.guidance}
                onChange={(e) => handleChange('guidance', e.target.value)}
                multiline
                minRows={3}
                fullWidth
                helperText="Shown alongside the question during the interview. Optional."
              />
              <FormControl fullWidth required>
                <InputLabel id="qb-form-round-label">Round</InputLabel>
                <Select
                  labelId="qb-form-round-label"
                  id="qb-form-round"
                  value={form.round}
                  label="Round"
                  onChange={(e) => handleChange('round', e.target.value)}
                >
                  {roundOptions.map((r) => (
                    <MenuItem key={r} value={r}>
                      {roundLabel(r)}
                      {!ROUND_LABELS[r] && ' (legacy value)'}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Autocomplete
                freeSolo
                options={facets.categories}
                value={form.category}
                onChange={(e, value) => handleChange('category', value || '')}
                onInputChange={(e, value) => handleChange('category', value || '')}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Category"
                    helperText="Pick an existing category or type a new one. Optional."
                  />
                )}
              />
              {dialogMode === 'create' && (
                <FormControl fullWidth>
                  <InputLabel id="qb-form-status-label">Status</InputLabel>
                  <Select
                    labelId="qb-form-status-label"
                    id="qb-form-status"
                    value={form.status}
                    label="Status"
                    onChange={(e) => handleChange('status', e.target.value)}
                  >
                    {STATUSES.map((s) => (
                      <MenuItem key={s} value={s}>
                        {s.charAt(0) + s.slice(1).toLowerCase()}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button variant="contained" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogActions>
        </Dialog>

        <Dialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)}>
          <DialogTitle>Delete this question?</DialogTitle>
          <DialogContent>
            <DialogContentText component="div">
              <Typography variant="body2" sx={{ mb: 2 }}>
                “{deleteTarget?.prompt}”
              </Typography>
              <Typography variant="body2">
                This removes it from the bank permanently. Interviews that already used it
                keep their own copy of the wording, so past sessions are unaffected. To take
                a question out of circulation without deleting it, set it to Archived
                instead.
              </Typography>
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button color="error" variant="contained" onClick={handleDelete}>
              Delete
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    </AccessControl>
  );
}
