import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Tabs,
  Tab,
  Button,
  Typography,
  Table,
  TableContainer,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Paper,
  Chip,
  IconButton,
  Menu,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  LinearProgress,
  Alert,
  CircularProgress,
  Select,
  FormControl,
  InputLabel,
  Stack,
  Tooltip,
} from '@mui/material';
import { MoreVert as MoreVertIcon, CloudUpload as UploadIcon } from '@mui/icons-material';
import AccessControl from '../components/AccessControl';
import apiClient from '../utils/api';
import { loadPdfDocument, renderPageToBlob } from '../utils/pdfRenderer';

const STATUS_COLORS = {
  DRAFT: 'default',
  ACTIVE: 'success',
  ARCHIVED: 'warning',
};

const FINAL_ROUND_TYPES = ['FINAL_ROUND', 'ROUND_TWO'];

function CaseLibraryTab({ onChanged }) {
  const navigate = useNavigate();
  const [cases, setCases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [menuCase, setMenuCase] = useState(null);
  const replaceInputRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiClient.get('/cases');
      setCases(data);
    } catch (e) {
      setError(e.message || 'Failed to load cases');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openMenu = (event, c) => {
    setMenuAnchor(event.currentTarget);
    setMenuCase(c);
  };
  const closeMenu = () => {
    setMenuAnchor(null);
    setMenuCase(null);
  };

  const setStatus = async (status) => {
    const c = menuCase;
    closeMenu();
    try {
      await apiClient.patch(`/cases/${c.id}`, { status });
      load();
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Failed to update case');
    }
  };

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="body2" color="text.secondary">
          {cases.length} case{cases.length === 1 ? '' : 's'} in the library
        </Typography>
        <Button variant="contained" startIcon={<UploadIcon />} onClick={() => setUploadOpen(true)}>
          Upload New Case
        </Button>
      </Box>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <TableContainer component={Paper} className="responsive-table">
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Title</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Pages</TableCell>
                <TableCell>Assigned</TableCell>
                <TableCell>Created by</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {cases.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ color: 'text.secondary', py: 4 }}>
                    No cases yet. Upload a case PDF to get started.
                  </TableCell>
                </TableRow>
              )}
              {cases.map((c) => (
                <TableRow key={c.id} hover>
                  <TableCell data-label="Title">
                    <Typography sx={{ fontWeight: 600 }}>{c.title}</Typography>
                    {c.description && (
                      <Typography variant="caption" color="text.secondary">
                        {c.description}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell data-label="Status">
                    <Chip size="small" label={c.status} color={STATUS_COLORS[c.status] || 'default'} />
                  </TableCell>
                  <TableCell data-label="Pages">{c.pagesUploaded}</TableCell>
                  <TableCell data-label="Assigned">{c.assignedCount}</TableCell>
                  <TableCell data-label="Created by">{c.createdBy || '—'}</TableCell>
                  <TableCell align="right" data-label="Actions">
                    <Button size="small" onClick={() => navigate(`/cases/${c.id}/tags`)}>
                      Edit Tags
                    </Button>
                    <IconButton size="small" onClick={(e) => openMenu(e, c)}>
                      <MoreVertIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu}>
        {menuCase?.status !== 'ACTIVE' && <MenuItem onClick={() => setStatus('ACTIVE')}>Activate</MenuItem>}
        {menuCase?.status !== 'DRAFT' && <MenuItem onClick={() => setStatus('DRAFT')}>Set to Draft</MenuItem>}
        {menuCase?.status !== 'ARCHIVED' && <MenuItem onClick={() => setStatus('ARCHIVED')}>Archive</MenuItem>}
        <MenuItem
          onClick={() => {
            const c = menuCase;
            closeMenu();
            replaceInputRef.current._case = c;
            replaceInputRef.current.click();
          }}
        >
          Replace PDF…
        </MenuItem>
      </Menu>

      {/* Hidden input for Replace PDF */}
      <input
        ref={replaceInputRef}
        type="file"
        accept="application/pdf"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          const c = replaceInputRef.current._case;
          e.target.value = '';
          if (!file || !c) return;
          setUploadOpen(false);
          try {
            await runRender(file, c.id, { replace: true, onError: setError });
            navigate(`/cases/${c.id}/tags`);
          } catch (err) {
            setError(err.message || 'Replace failed');
          }
        }}
      />

      <UploadCaseDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onDone={(caseId) => {
          setUploadOpen(false);
          load();
          onChanged?.();
          navigate(`/cases/${caseId}/tags`);
        }}
      />
    </Box>
  );
}

// Render all pages of `file` and upload them to caseId. Supports per-page retry.
async function runRender(file, caseId, { replace = false, onProgress } = {}) {
  const pdfDoc = await loadPdfDocument(file);
  const numPages = pdfDoc.numPages;

  if (replace) {
    // Replace endpoint clears existing pages first; send the new PDF.
    const fd = new FormData();
    fd.append('pdf', file);
    await apiClient.post(`/cases/${caseId}/replace-pdf`, fd);
  }

  for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
    onProgress?.({ phase: 'render', pageNumber, numPages });
    const { blob, width, height } = await renderPageToBlob(pdfDoc, pageNumber, 2);

    onProgress?.({ phase: 'upload', pageNumber, numPages });
    let lastErr;
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const fd = new FormData();
        fd.append('pageNumber', String(pageNumber));
        fd.append('width', String(Math.round(width)));
        fd.append('height', String(Math.round(height)));
        fd.append('image', blob, `page-${pageNumber}.webp`);
        await apiClient.post(`/cases/${caseId}/pages`, fd);
        ok = true;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!ok) {
      const e = new Error(`Page ${pageNumber} failed to upload: ${lastErr?.message || 'unknown error'}`);
      e.pageNumber = pageNumber;
      throw e;
    }
  }
  return numPages;
}

function UploadCaseDialog({ open, onClose, onDone }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // { phase, pageNumber, numPages }
  const [error, setError] = useState('');

  const reset = () => {
    setTitle('');
    setDescription('');
    setFile(null);
    setBusy(false);
    setProgress(null);
    setError('');
  };

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const submit = async () => {
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    if (!file) {
      setError('Please choose a PDF');
      return;
    }
    setBusy(true);
    setError('');
    try {
      // 1. Create the case (stores the original PDF).
      const fd = new FormData();
      fd.append('title', title.trim());
      if (description.trim()) fd.append('description', description.trim());
      fd.append('pdf', file);
      const created = await apiClient.post('/cases', fd);

      // 2. Render + upload each page.
      await runRender(file, created.id, { onProgress: setProgress });

      reset();
      onDone(created.id);
    } catch (e) {
      setError(e.message || 'Upload failed');
      setBusy(false);
    }
  };

  const pct = progress ? Math.round(((progress.pageNumber - (progress.phase === 'render' ? 1 : 0)) / progress.numPages) * 100) : 0;

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Upload New Case</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Case Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            fullWidth
            required
            disabled={busy}
          />
          <TextField
            label="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            fullWidth
            multiline
            minRows={2}
            disabled={busy}
          />
          <Button variant="outlined" component="label" disabled={busy}>
            {file ? file.name : 'Choose PDF…'}
            <input
              type="file"
              accept="application/pdf"
              hidden
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </Button>

          {busy && progress && (
            <Box>
              <Typography variant="body2" sx={{ mb: 0.5 }}>
                {progress.phase === 'render' ? 'Rendering' : 'Uploading'} page {progress.pageNumber} of{' '}
                {progress.numPages}…
              </Typography>
              <LinearProgress variant="determinate" value={pct} />
            </Box>
          )}
          {busy && !progress && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={18} />
              <Typography variant="body2">Preparing…</Typography>
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={busy}>
          Upload &amp; Continue
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function AssignmentsTab() {
  const [interviews, setInterviews] = useState([]);
  const [interviewId, setInterviewId] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [activeCases, setActiveCases] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [savingApp, setSavingApp] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [ivs, cs] = await Promise.all([
          apiClient.get('/admin/interviews'),
          apiClient.get('/cases/active'),
        ]);
        setInterviews((ivs || []).filter((i) => FINAL_ROUND_TYPES.includes(i.interviewType)));
        setActiveCases(cs || []);
      } catch (e) {
        setError(e.message || 'Failed to load');
      }
    })();
  }, []);

  const loadCandidates = useCallback(async (id) => {
    if (!id) {
      setCandidates([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await apiClient.get(`/cases/assignments/for-interview?interviewId=${id}`);
      setCandidates(data);
    } catch (e) {
      setError(e.message || 'Failed to load candidates');
    } finally {
      setLoading(false);
    }
  }, []);

  const assign = async (applicationId, caseId) => {
    setSavingApp(applicationId);
    setError('');
    try {
      await apiClient.post('/cases/assignments', { interviewId, applicationId, caseId });
      await loadCandidates(interviewId);
    } catch (e) {
      setError(e.message || 'Failed to assign case');
    } finally {
      setSavingApp('');
    }
  };

  const unassignedCount = candidates.filter((c) => !c.assignment).length;

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      <FormControl sx={{ minWidth: 320, mb: 2 }} size="small">
        <InputLabel id="fr-interview-label">Final-round interview</InputLabel>
        <Select
          labelId="fr-interview-label"
          label="Final-round interview"
          value={interviewId}
          onChange={(e) => {
            setInterviewId(e.target.value);
            loadCandidates(e.target.value);
          }}
        >
          {interviews.length === 0 && <MenuItem disabled>No final-round interviews</MenuItem>}
          {interviews.map((i) => (
            <MenuItem key={i.id} value={i.id}>
              {i.title}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {interviewId && !loading && candidates.length > 0 && unassignedCount > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {unassignedCount} candidate{unassignedCount === 1 ? '' : 's'} with no case assigned.
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      ) : interviewId ? (
        <TableContainer component={Paper} className="responsive-table">
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Candidate</TableCell>
                <TableCell>Major / Year</TableCell>
                <TableCell>Assigned Case</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {candidates.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} align="center" sx={{ color: 'text.secondary', py: 4 }}>
                    No candidates found for this interview.
                  </TableCell>
                </TableRow>
              )}
              {candidates.map((c) => (
                <TableRow key={c.applicationId} hover>
                  <TableCell data-label="Candidate">
                    <Typography sx={{ fontWeight: 600 }}>{c.name}</Typography>
                  </TableCell>
                  <TableCell data-label="Major / Year">
                    {c.major || '—'} {c.year ? `· ${c.year}` : ''}
                  </TableCell>
                  <TableCell data-label="Assigned Case">
                    <FormControl size="small" sx={{ minWidth: 220 }}>
                      <Select
                        displayEmpty
                        value={c.assignment?.caseId || ''}
                        onChange={(e) => assign(c.applicationId, e.target.value)}
                        disabled={savingApp === c.applicationId}
                      >
                        <MenuItem value="" disabled>
                          <em>Select a case…</em>
                        </MenuItem>
                        {activeCases.map((ac) => (
                          <MenuItem key={ac.id} value={ac.id}>
                            {ac.title}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    {savingApp === c.applicationId && <CircularProgress size={16} sx={{ ml: 1 }} />}
                  </TableCell>
                  <TableCell data-label="Status">
                    {c.assignment ? (
                      c.assignment.overriddenAt ? (
                        <Tooltip title={`Overridden ${new Date(c.assignment.overriddenAt).toLocaleString()}`}>
                          <Chip size="small" color="info" label="Overridden" />
                        </Tooltip>
                      ) : (
                        <Chip size="small" color="success" label="Assigned" />
                      )
                    ) : (
                      <Chip size="small" color="warning" label="Unassigned" />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <Typography color="text.secondary">Select a final-round interview to assign cases.</Typography>
      )}
    </Box>
  );
}

export default function Cases() {
  const [tab, setTab] = useState(0);

  return (
    <AccessControl allowedRoles={['ADMIN']}>
      <Box sx={{ p: 3 }}>
          <Typography variant="h4" sx={{ fontWeight: 700, mb: 1 }}>
            Cases
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Upload case decks, tag pages, and assign a case to each final-round candidate.
          </Typography>

          <Tabs value={tab} onChange={(e, v) => setTab(v)} sx={{ mb: 3 }}>
            <Tab label="Library" />
            <Tab label="Assignments" />
          </Tabs>

          {tab === 0 && <CaseLibraryTab />}
          {tab === 1 && <AssignmentsTab />}
        </Box>
    </AccessControl>
  );
}
