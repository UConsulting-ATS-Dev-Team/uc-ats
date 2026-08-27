import React, { useEffect, useState } from 'react';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import {
  Box,
  Typography,
  Paper,
  Stack,
  TextField,
  InputAdornment,
  Button,
  Chip,
  CircularProgress,
  Alert,
  Card,
  CardContent,
  IconButton,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  Grid,
  Divider,
  Tooltip,
} from '@mui/material';
import {
  Search as SearchIcon,
  Close as CloseIcon,
  PlayCircle as PlayCircleIcon,
  Article as ArticleIcon,
  ExpandMore as ExpandMoreIcon,
  NewReleases as NewReleasesIcon,
} from '@mui/icons-material';

const CATEGORY_LABELS = {
  DOCUMENT_GRADING: 'Document Grading',
  INTERVIEW_CONDUCT: 'Interviews',
  GTKUC: 'Get to Know UC',
  ATS_NAVIGATION: 'ATS Navigation',
  NEW_FEATURES: 'New Features',
};

const CATEGORY_COLORS = {
  DOCUMENT_GRADING: 'primary',
  INTERVIEW_CONDUCT: 'secondary',
  GTKUC: 'success',
  ATS_NAVIGATION: 'info',
  NEW_FEATURES: 'warning',
};

const TUTORIAL_CATEGORIES = Object.keys(CATEGORY_LABELS);

function formatDate(dateString) {
  return new Date(dateString).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function getVideoEmbedUrl(url) {
  if (!url) return null;
  try {
    const youtubeMatch = url.match(
      /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/
    );
    if (youtubeMatch) {
      return `https://www.youtube.com/embed/${youtubeMatch[1]}`;
    }
    const loomMatch = url.match(/loom\.com\/share\/([A-Za-z0-9_-]+)/);
    if (loomMatch) {
      return `https://www.loom.com/embed/${loomMatch[1]}`;
    }
    const vimeoMatch = url.match(/vimeo\.com\/(\d+)/);
    if (vimeoMatch) {
      return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
    }
  } catch {
    return null;
  }
  return url;
}

export default function MemberHelp() {
  const [announcements, setAnnouncements] = useState([]);
  const [tutorials, setTutorials] = useState([]);
  const [loadingAnnouncements, setLoadingAnnouncements] = useState(true);
  const [loadingTutorials, setLoadingTutorials] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [dismissing, setDismissing] = useState({});

  useEffect(() => {
    let cancelled = false;
    setLoadingAnnouncements(true);
    apiClient
      .get('/member/help/announcements')
      .then((data) => {
        if (!cancelled) setAnnouncements(Array.isArray(data) ? data : []);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Failed to load announcements.');
      })
      .finally(() => {
        if (!cancelled) setLoadingAnnouncements(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (category) params.set('category', category);
    const qs = params.toString() ? `?${params.toString()}` : '';

    let cancelled = false;
    setLoadingTutorials(true);
    apiClient
      .get(`/member/help/tutorials${qs}`)
      .then((data) => {
        if (!cancelled) setTutorials(Array.isArray(data) ? data : []);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Failed to load tutorials.');
      })
      .finally(() => {
        if (!cancelled) setLoadingTutorials(false);
      });
    return () => {
      cancelled = true;
    };
  }, [search, category]);

  const handleDismiss = async (id) => {
    setDismissing((prev) => ({ ...prev, [id]: true }));
    try {
      await apiClient.post(`/member/help/announcements/${id}/dismiss`);
      setAnnouncements((prev) => prev.map((a) => (a.id === id ? { ...a, isRead: true } : a)));
    } catch (e) {
      setError(e.message || 'Failed to dismiss announcement.');
    } finally {
      setDismissing((prev) => ({ ...prev, [id]: false }));
    }
  };

  const unreadAnnouncements = announcements.filter((a) => !a.isRead);

  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1200 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Help & Tutorials
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {/* What's New */}
        <Paper sx={{ p: { xs: 2, md: 3 }, mb: 4 }}>
          <Stack direction="row" spacing={1} alignItems="center" mb={2}>
            <NewReleasesIcon color="primary" />
            <Typography variant="h5" component="h2">
              What's New
            </Typography>
          </Stack>

          {loadingAnnouncements ? (
            <Box sx={{ textAlign: 'center', py: 4 }}>
              <CircularProgress />
            </Box>
          ) : unreadAnnouncements.length === 0 ? (
            <Typography variant="body1" color="text.secondary">
              You're all caught up! There are no new announcements.
            </Typography>
          ) : (
            <Stack spacing={2}>
              {unreadAnnouncements.map((announcement) => (
                <Card key={announcement.id} variant="outlined">
                  <CardContent>
                    <Stack spacing={1}>
                      <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        spacing={1}
                        alignItems={{ xs: 'flex-start', sm: 'center' }}
                        justifyContent="space-between"
                      >
                        <Typography variant="h6" component="h3" sx={{ fontWeight: 600 }}>
                          {announcement.title}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {formatDate(announcement.publishedAt)}
                        </Typography>
                      </Stack>
                      <Typography
                        variant="body1"
                        sx={{ whiteSpace: 'pre-line' }}
                      >
                        {announcement.body}
                      </Typography>
                      <Box>
                        <Button
                          variant="outlined"
                          size="small"
                          onClick={() => handleDismiss(announcement.id)}
                          disabled={dismissing[announcement.id]}
                        >
                          Dismiss
                        </Button>
                      </Box>
                    </Stack>
                  </CardContent>
                </Card>
              ))}
            </Stack>
          )}
        </Paper>

        {/* Tutorial library */}
        <Paper sx={{ p: { xs: 2, md: 3 } }}>
          <Typography variant="h5" component="h2" gutterBottom>
            Tutorials
          </Typography>

          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid item xs={12} md={7}>
              <TextField
                fullWidth
                label="Search tutorials"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon />
                    </InputAdornment>
                  ),
                  endAdornment: search ? (
                    <InputAdornment position="end">
                      <IconButton size="small" onClick={() => setSearch('')} edge="end">
                        <CloseIcon />
                      </IconButton>
                    </InputAdornment>
                  ) : null,
                }}
              />
            </Grid>
            <Grid item xs={12} md={5}>
              <FormControl fullWidth>
                <InputLabel id="category-filter-label">Category</InputLabel>
                <Select
                  labelId="category-filter-label"
                  value={category}
                  label="Category"
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <MenuItem value="">All categories</MenuItem>
                  {TUTORIAL_CATEGORIES.map((cat) => (
                    <MenuItem key={cat} value={cat}>
                      {CATEGORY_LABELS[cat]}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
          </Grid>

          {loadingTutorials ? (
            <Box sx={{ textAlign: 'center', py: 6 }}>
              <CircularProgress />
            </Box>
          ) : tutorials.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 4 }}>
              <Typography variant="h6" gutterBottom>
                No tutorials found
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {search || category
                  ? 'Try adjusting your search or category filter.'
                  : 'Check back later for new guides.'}
              </Typography>
            </Box>
          ) : (
            <Grid container spacing={3}>
              {tutorials.map((tutorial) => {
                const embedUrl = getVideoEmbedUrl(tutorial.videoUrl);
                const hasMedia = Boolean(tutorial.videoUrl);
                const hasBody = Boolean(tutorial.body && tutorial.body.trim());

                return (
                  <Grid item xs={12} md={6} lg={4} key={tutorial.id}>
                    <Card variant="outlined" sx={{ height: '100%' }}>
                      <CardContent>
                        <Stack spacing={1.5}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            {hasMedia ? (
                              <PlayCircleIcon color="primary" />
                            ) : (
                              <ArticleIcon color="action" />
                            )}
                            <Typography variant="h6" component="h3" sx={{ fontWeight: 600 }}>
                              {tutorial.title}
                            </Typography>
                          </Stack>

                          {tutorial.description && (
                            <Typography variant="body2" color="text.secondary">
                              {tutorial.description}
                            </Typography>
                          )}

                          <Chip
                            size="small"
                            color={CATEGORY_COLORS[tutorial.category] || 'default'}
                            label={CATEGORY_LABELS[tutorial.category] || tutorial.category}
                          />

                          {(hasMedia || hasBody) && (
                            <Accordion
                              variant="outlined"
                              sx={{ '&:before': { display: 'none' } }}
                            >
                              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                                  {hasMedia ? 'Watch tutorial' : 'Read tutorial'}
                                </Typography>
                              </AccordionSummary>
                              <AccordionDetails>
                                {hasMedia && embedUrl && (
                                  <Box sx={{ mb: hasBody ? 2 : 0 }}>
                                    <Box
                                      sx={{
                                        position: 'relative',
                                        paddingBottom: '56.25%',
                                        height: 0,
                                        overflow: 'hidden',
                                        borderRadius: 1,
                                        bgcolor: 'background.default',
                                      }}
                                    >
                                      <iframe
                                        src={embedUrl}
                                        title={tutorial.title}
                                        style={{
                                          position: 'absolute',
                                          top: 0,
                                          left: 0,
                                          width: '100%',
                                          height: '100%',
                                          border: 0,
                                          borderRadius: 4,
                                        }}
                                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                        allowFullScreen
                                      />
                                    </Box>
                                  </Box>
                                )}
                                {hasBody && (
                                  <Typography
                                    variant="body1"
                                    sx={{ whiteSpace: 'pre-line' }}
                                  >
                                    {tutorial.body}
                                  </Typography>
                                )}
                              </AccordionDetails>
                            </Accordion>
                          )}
                        </Stack>
                      </CardContent>
                    </Card>
                  </Grid>
                );
              })}
            </Grid>
          )}
        </Paper>
      </Box>
    </AccessControl>
  );
}
