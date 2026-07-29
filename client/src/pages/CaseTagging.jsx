import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Button,
  Paper,
  Grid,
  ToggleButton,
  ToggleButtonGroup,
  TextField,
  Chip,
  Alert,
  CircularProgress,
  IconButton,
  Tooltip,
} from '@mui/material';
import { ArrowBack as ArrowBackIcon, DeleteOutline as DeleteIcon } from '@mui/icons-material';
import AccessControl from '../components/AccessControl';
import apiClient from '../utils/api';
import CasePageImage from '../components/case/CasePageImage';

const PAGE_TYPES = [
  { value: 'NORMAL', label: 'Normal' },
  { value: 'EXHIBIT', label: 'Exhibit' },
  { value: 'INTERVIEWER_ONLY', label: 'Interviewer Only' },
];

const TYPE_CHIP = {
  NORMAL: null,
  EXHIBIT: { label: 'Exhibit', color: 'info' },
  INTERVIEWER_ONLY: { label: 'Interviewer only', color: 'warning' },
};

export default function CaseTagging() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [caseData, setCaseData] = useState(null);
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingPage, setSavingPage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiClient.get(`/cases/${id}`);
      setCaseData(data);
      setPages(data.pages);
    } catch (e) {
      setError(e.message || 'Failed to load case');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Suggest "Exhibit N" based on this page's position among exhibits.
  const suggestExhibitLabel = (pageId, current) => {
    const exhibits = current.filter((p) => p.pageType === 'EXHIBIT');
    const idx = exhibits.findIndex((p) => p.id === pageId);
    return `Exhibit ${idx >= 0 ? idx + 1 : exhibits.length + 1}`;
  };

  const savePage = async (pageId, patch) => {
    setSavingPage(pageId);
    setError('');
    // Optimistic update.
    setPages((prev) => prev.map((p) => (p.id === pageId ? { ...p, ...patch } : p)));
    try {
      await apiClient.patch(`/cases/${id}/pages/${pageId}`, patch);
    } catch (e) {
      setError(e.message || 'Failed to save tag');
      load(); // revert to server state
    } finally {
      setSavingPage('');
    }
  };

  const deletePage = async (page) => {
    if (!window.confirm(`Delete page ${page.pageNumber}? This can't be undone.`)) return;
    setSavingPage(page.id);
    setError('');
    // Optimistically remove the card and renumber locally so the change is
    // instant; reconcile with the server afterwards.
    setPages((prev) =>
      prev
        .filter((p) => p.id !== page.id)
        .map((p) => (p.pageNumber > page.pageNumber ? { ...p, pageNumber: p.pageNumber - 1 } : p))
    );
    try {
      await apiClient.delete(`/cases/${id}/pages/${page.id}`);
      await load();
    } catch (e) {
      setError(e.message || 'Failed to delete page');
      load(); // revert to server truth on failure
    } finally {
      setSavingPage('');
    }
  };

  const changeType = (page, newType) => {
    if (!newType || newType === page.pageType) return;
    const patch = { pageType: newType };
    if (newType === 'EXHIBIT' && !page.exhibitLabel) {
      patch.exhibitLabel = suggestExhibitLabel(page.id, pages);
    }
    if (newType !== 'EXHIBIT') {
      patch.exhibitLabel = null;
    }
    savePage(page.id, patch);
  };

  const content = () => {
    if (loading) {
      return (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
          <CircularProgress />
        </Box>
      );
    }
    if (!caseData) {
      return <Alert severity="error">Case not found.</Alert>;
    }
    return (
      <>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}
        {pages.length === 0 && (
          <Alert severity="info">
            No pages have been rendered for this case yet. Try re-uploading or replacing the PDF.
          </Alert>
        )}
        <Grid container spacing={2}>
          {pages.map((page) => {
            const chip = TYPE_CHIP[page.pageType];
            return (
              <Grid size={{ xs: 12, sm: 6, md: 4, lg: 3 }} key={page.id}>
                <Paper
                  sx={{
                    p: 1.5,
                    border:
                      page.pageType === 'INTERVIEWER_ONLY'
                        ? '2px solid #f59e0b'
                        : '1px solid #e5e7eb',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1,
                  }}
                >
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                      Page {page.pageNumber}
                    </Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      {chip && <Chip size="small" label={chip.label} color={chip.color} />}
                      <Tooltip title="Delete page">
                        <IconButton
                          size="small"
                          color="error"
                          disabled={savingPage === page.id}
                          onClick={() => deletePage(page)}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  </Box>
                  <Box
                    sx={{
                      position: 'relative',
                      background: '#f8fafc',
                      borderRadius: 1,
                      overflow: 'hidden',
                      aspectRatio: '3 / 4',
                    }}
                  >
                    <CasePageImage
                      src={`/api/cases/${id}/pages/${page.id}/image`}
                      alt={`Page ${page.pageNumber}`}
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                    />
                  </Box>

                  <ToggleButtonGroup
                    size="small"
                    exclusive
                    value={page.pageType}
                    onChange={(e, v) => changeType(page, v)}
                    fullWidth
                    disabled={savingPage === page.id}
                  >
                    {PAGE_TYPES.map((t) => (
                      <ToggleButton key={t.value} value={t.value} sx={{ fontSize: '0.7rem', px: 0.5 }}>
                        {t.label}
                      </ToggleButton>
                    ))}
                  </ToggleButtonGroup>

                  {page.pageType === 'EXHIBIT' && (
                    <TextField
                      size="small"
                      label="Exhibit label"
                      value={page.exhibitLabel || ''}
                      onChange={(e) =>
                        setPages((prev) =>
                          prev.map((p) => (p.id === page.id ? { ...p, exhibitLabel: e.target.value } : p))
                        )
                      }
                      onBlur={(e) => savePage(page.id, { exhibitLabel: e.target.value })}
                    />
                  )}
                </Paper>
              </Grid>
            );
          })}
        </Grid>
      </>
    );
  };

  return (
    <AccessControl allowedRoles={['ADMIN']}>
      <Box sx={{ p: 3 }}>
          <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/cases')} sx={{ mb: 1 }}>
            Back to Cases
          </Button>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            {caseData ? `Tag pages — ${caseData.title}` : 'Tag pages'}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Mark exhibits and interviewer-only pages. Changes save automatically and can be edited anytime.
          </Typography>
          {content()}
        </Box>
    </AccessControl>
  );
}
