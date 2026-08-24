import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Stack,
  Chip,
  Button,
  CircularProgress,
  Alert,
  Collapse,
  Divider,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  OpenInNew as OpenInNewIcon,
  DoneAll as DoneAllIcon,
  Newspaper as NewspaperIcon,
} from '@mui/icons-material';
import apiClient from '../utils/api';
import AccessControl from './AccessControl';

const CATEGORY_LABELS = {
  feature: 'Feature',
  enhancement: 'Enhancement',
  fix: 'Fix',
  'policy/operations': 'Policy / operations',
  'breaking change': 'Breaking change',
};

const STATUS_LABELS = {
  new: 'New',
  updated: 'Updated',
  resolved: 'Resolved',
};

const CATEGORY_COLORS = {
  feature: 'primary',
  enhancement: 'info',
  fix: 'success',
  'policy/operations': 'warning',
  'breaking change': 'error',
};

const STATUS_COLORS = {
  new: 'info',
  updated: 'warning',
  resolved: 'success',
};

const DEFAULT_NEW_CUTOFF_DAYS = 14;

function formatReleaseDate(dateString) {
  return new Date(dateString).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function isWithinDays(dateString, days) {
  const date = new Date(dateString);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  cutoff.setHours(0, 0, 0, 0);
  return date >= cutoff;
}

function loadReadIds(storageKey) {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        return new Set(parsed);
      }
    }
  } catch {
    // ignore corrupt storage
  }
  return new Set();
}

function saveReadIds(storageKey, readIds) {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...readIds]));
  } catch {
    // ignore storage errors
  }
}

export default function ReleaseNotesView({
  apiPath,
  storageKey,
  title = "What's new",
  subtitle = 'Release notes and updates',
  allowedRoles = [],
  emptyTitle = 'No release notes yet',
  emptyMessage = 'Check back later for updates.',
  fallbackMessage = 'Access Denied',
  fallbackDescription = "You don't have permission to access this page.",
  newCutoffDays = DEFAULT_NEW_CUTOFF_DAYS,
}) {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [readIds, setReadIds] = useState(() => loadReadIds(storageKey));

  useEffect(() => {
    let cancelled = false;

    async function fetchNotes() {
      setLoading(true);
      setError(null);
      try {
        const data = await apiClient.get(apiPath);
        if (!cancelled) {
          setNotes(Array.isArray(data) ? data : []);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e.message || 'Failed to load release notes.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchNotes();
    return () => {
      cancelled = true;
    };
  }, [apiPath]);

  useEffect(() => {
    saveReadIds(storageKey, readIds);
  }, [storageKey, readIds]);

  const handleToggle = (id) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleMarkRead = (id) => {
    setReadIds((prev) => new Set([...prev, id]));
  };

  const handleMarkAllRead = () => {
    setReadIds(new Set(notes.map((note) => note.id)));
  };

  const isUnreadNew = (note) => {
    if (readIds.has(note.id)) return false;
    return isWithinDays(note.releaseDate, newCutoffDays);
  };

  const allRead = notes.length > 0 && notes.every((note) => !isUnreadNew(note));

  return (
    <AccessControl allowedRoles={allowedRoles} fallbackMessage={fallbackMessage} fallbackDescription={fallbackDescription}>
      <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 900 }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          justifyContent="space-between"
          mb={3}
        >
          <Box>
            <Stack direction="row" spacing={1} alignItems="center" mb={0.5}>
              <NewspaperIcon color="primary" aria-hidden="true" />
              <Typography variant="h4" component="h1">
                {title}
              </Typography>
            </Stack>
            <Typography variant="body1" color="text.secondary">
              {subtitle}
            </Typography>
          </Box>
          <Button
            variant="outlined"
            size="small"
            startIcon={<DoneAllIcon />}
            onClick={handleMarkAllRead}
            disabled={allRead || notes.length === 0}
          >
            Mark all read
          </Button>
        </Stack>

        {loading && (
          <Box role="status" aria-live="polite" sx={{ textAlign: 'center', py: 8 }}>
            <CircularProgress aria-label="Loading release notes" />
            <Typography variant="body1" color="text.secondary" sx={{ mt: 2 }}>
              Loading release notes…
            </Typography>
          </Box>
        )}

        {!loading && error && (
          <Alert severity="error" sx={{ mb: 3 }} role="alert">
            {error}
          </Alert>
        )}

        {!loading && !error && notes.length === 0 && (
          <Paper sx={{ p: 4, textAlign: 'center' }} role="status" aria-live="polite">
            <Typography variant="h6" gutterBottom>
              {emptyTitle}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {emptyMessage}
            </Typography>
          </Paper>
        )}

        {!loading && !error && notes.length > 0 && (
          <Stack spacing={2}>
            {notes.map((note) => {
              const expandedForNote = !!expanded[note.id];
              const unreadNew = isUnreadNew(note);
              const category = note.category || 'feature';
              const status = note.status || 'new';

              return (
                <Paper
                  key={note.id}
                  component="article"
                  aria-labelledby={`note-title-${note.id}`}
                  sx={{ p: { xs: 2, md: 3 } }}
                >
                  <Stack spacing={1.5}>
                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      spacing={1}
                      alignItems={{ xs: 'flex-start', sm: 'center' }}
                      justifyContent="space-between"
                    >
                      <Typography
                        id={`note-title-${note.id}`}
                        variant="h6"
                        component="h2"
                        sx={{ fontWeight: 600 }}
                      >
                        {note.title}
                        {unreadNew && (
                          <>
                            {' '}
                            <Chip
                              size="small"
                              color="info"
                              label="New"
                              sx={{ ml: 0.5, verticalAlign: 'middle' }}
                              aria-label="New release"
                            />
                          </>
                        )}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {formatReleaseDate(note.releaseDate)}
                      </Typography>
                    </Stack>

                    <Stack
                      direction="row"
                      spacing={1}
                      flexWrap="wrap"
                      alignItems="center"
                    >
                      <Chip
                        size="small"
                        color={CATEGORY_COLORS[category] || 'default'}
                        label={CATEGORY_LABELS[category] || category}
                        aria-label={`Category: ${CATEGORY_LABELS[category] || category}`}
                      />
                      <Chip
                        size="small"
                        color={STATUS_COLORS[status] || 'default'}
                        label={STATUS_LABELS[status] || status}
                        aria-label={`Status: ${STATUS_LABELS[status] || status}`}
                      />
                      {note.affectedArea && (
                        <Typography variant="body2" color="text.secondary">
                          Affected area: {note.affectedArea}
                        </Typography>
                      )}
                    </Stack>

                    <Typography variant="body1">{note.summary}</Typography>

                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      spacing={1}
                      alignItems={{ xs: 'stretch', sm: 'center' }}
                    >
                      <Button
                        variant="text"
                        size="small"
                        onClick={() => handleToggle(note.id)}
                        aria-expanded={expandedForNote}
                        aria-controls={`note-details-${note.id}`}
                        endIcon={expandedForNote ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                        sx={{ justifyContent: { xs: 'flex-start', sm: 'center' } }}
                      >
                        {expandedForNote ? 'Hide details' : 'Show details'}
                      </Button>
                      {unreadNew && (
                        <Button
                          variant="text"
                          size="small"
                          onClick={() => handleMarkRead(note.id)}
                          aria-label={`Mark ${note.title} as read`}
                          sx={{ justifyContent: { xs: 'flex-start', sm: 'center' } }}
                        >
                          Mark as read
                        </Button>
                      )}
                    </Stack>

                    <Collapse in={expandedForNote} timeout="auto" unmountOnExit>
                      <Box id={`note-details-${note.id}`} sx={{ pt: 1 }}>
                        <Divider sx={{ mb: 2 }} />
                        <Typography
                          variant="body1"
                          sx={{ whiteSpace: 'pre-line', mb: note.links?.length ? 2 : 0 }}
                        >
                          {note.details}
                        </Typography>
                        {note.links && note.links.length > 0 && (
                          <Stack spacing={1} alignItems="flex-start">
                            <Typography variant="subtitle2">Related links</Typography>
                            {note.links.map((link, idx) => (
                              <Button
                                key={idx}
                                size="small"
                                href={link.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                startIcon={<OpenInNewIcon />}
                                sx={{ textTransform: 'none' }}
                              >
                                {link.label || link.url}
                              </Button>
                            ))}
                          </Stack>
                        )}
                      </Box>
                    </Collapse>
                  </Stack>
                </Paper>
              );
            })}
          </Stack>
        )}
      </Box>
    </AccessControl>
  );
}
