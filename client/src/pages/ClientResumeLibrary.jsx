import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  CircularProgress,
  Grid,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import AccessControl from '../components/AccessControl';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import apiClient from '../utils/api';

// The only page a Talent Partner Network client sees.
//
// There is deliberately no download control anywhere in here. The PDF is shown
// through DocumentPreviewModal, which fetches a blob and renders it in an
// iframe with the viewer toolbar suppressed. That is deterrence plus an audit
// trail, not prevention - see the note in the branch README/plan.

const PAGE_SIZE = 24;

// Under BLIND the server omits identity keys entirely rather than nulling them,
// so presence is the signal.
const displayName = (item) => {
  if (item.firstName || item.lastName) {
    return [item.firstName, item.lastName].filter(Boolean).join(' ');
  }
  return null;
};

const ResumeCard = ({ item, onOpen }) => {
  const name = displayName(item);
  const majors = [item.major1, item.major2].filter(Boolean).join(' · ');

  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardActionArea
        onClick={() => onOpen(item)}
        disabled={!item.available}
        sx={{ height: '100%', alignItems: 'flex-start' }}
      >
        <CardContent sx={{ width: '100%' }}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
            <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
              {name || 'Candidate'}
            </Typography>
            <Chip
              size="small"
              label={item.kind === 'MEMBER' ? 'Member' : 'Applicant'}
              variant="outlined"
            />
          </Stack>

          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {majors || 'Major not recorded'}
          </Typography>

          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
            {item.graduationYear && (
              <Chip size="small" label={`Class of ${item.graduationYear}`} />
            )}
            {item.gender && <Chip size="small" label={item.gender} variant="outlined" />}
            {item.cumulativeGpa && (
              <Chip size="small" label={`GPA ${item.cumulativeGpa}`} variant="outlined" />
            )}
          </Stack>

          {item.email && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              {item.email}
            </Typography>
          )}

          {!item.available && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5, display: 'block' }}>
              Resume not available
            </Typography>
          )}
        </CardContent>
      </CardActionArea>
    </Card>
  );
};

const ClientResumeLibrary = () => {
  const [account, setAccount] = useState(null);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [pendingSearch, setPendingSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get('/client/me')
      .then((data) => {
        if (!cancelled) setAccount(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load your account');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchResumes = useCallback(async (nextOffset, search) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(nextOffset) });
      if (search) params.set('q', search);
      const data = await apiClient.get(`/client/resumes?${params.toString()}`);
      setItems(data.items || []);
      setTotal(data.total || 0);
      setOffset(nextOffset);
    } catch (err) {
      setError(err.message || 'Failed to load your resume library');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchResumes(0, '');
  }, [fetchResumes]);

  const applySearch = () => {
    setAppliedSearch(pendingSearch.trim());
    fetchResumes(0, pendingSearch.trim());
  };

  const clearSearch = () => {
    setPendingSearch('');
    setAppliedSearch('');
    fetchResumes(0, '');
  };

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  return (
    <AccessControl allowedRoles={['CLIENT']}>
      <Box sx={{ p: 3 }}>
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
                ? `${account.organization} — ${total} resume${total === 1 ? '' : 's'} shared with you`
                : 'Loading your account…'}
            </Typography>
          </Box>
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        <Paper sx={{ p: 1.5, mb: 3 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="center">
            <TextField
              size="small"
              fullWidth
              placeholder={
                account?.visibility === 'BLIND'
                  ? 'Search by major or graduation year'
                  : 'Search by name, major, or graduation year'
              }
              value={pendingSearch}
              onChange={(e) => setPendingSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applySearch();
              }}
              InputProps={{ startAdornment: <SearchIcon fontSize="small" sx={{ mr: 1 }} /> }}
            />
            <Button variant="contained" onClick={applySearch} disabled={loading}>
              Search
            </Button>
            {appliedSearch && (
              <Button onClick={clearSearch} disabled={loading}>
                Clear
              </Button>
            )}
          </Stack>
        </Paper>

        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {!loading && items.length === 0 && (
          <Paper sx={{ p: 4, textAlign: 'center' }}>
            <Typography variant="h6" gutterBottom>
              {appliedSearch ? 'No resumes match that search' : 'No resumes have been shared yet'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {appliedSearch
                ? 'Try a different major or graduation year.'
                : 'UConsulting will add resumes to your library. Check back shortly.'}
            </Typography>
          </Paper>
        )}

        {!loading && items.length > 0 && (
          <>
            <Grid container spacing={2}>
              {items.map((item) => (
                <Grid item xs={12} sm={6} lg={4} key={item.assignmentId}>
                  <ResumeCard item={item} onOpen={setPreview} />
                </Grid>
              ))}
            </Grid>

            {total > PAGE_SIZE && (
              <Stack direction="row" spacing={2} justifyContent="center" alignItems="center" sx={{ mt: 3 }}>
                <Button
                  disabled={offset === 0}
                  onClick={() => fetchResumes(Math.max(offset - PAGE_SIZE, 0), appliedSearch)}
                >
                  Previous
                </Button>
                <Typography variant="body2" color="text.secondary">
                  Page {page} of {pageCount}
                </Typography>
                <Button
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => fetchResumes(offset + PAGE_SIZE, appliedSearch)}
                >
                  Next
                </Button>
              </Stack>
            )}
          </>
        )}

        {preview && (
          <DocumentPreviewModal
            src={preview.pdfUrl}
            kind="pdf"
            title={displayName(preview) || 'Resume'}
            onClose={() => setPreview(null)}
          />
        )}
      </Box>
    </AccessControl>
  );
};

export default ClientResumeLibrary;
