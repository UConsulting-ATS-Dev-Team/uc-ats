import React, { useEffect, useState } from 'react';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import {
  Box,
  Typography,
  Paper,
  Stack,
  Button,
  Tabs,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  CircularProgress,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  IconButton,
  Tooltip,
  Grid,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Help as HelpIcon,
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

const emptyAnnouncement = {
  title: '',
  body: '',
  publishedAt: '',
  cycleId: '',
};

const emptyTutorial = {
  title: '',
  description: '',
  category: '',
  videoUrl: '',
  body: '',
  order: 0,
};

function toLocalInput(dateTime) {
  if (!dateTime) return '';
  const laTimeStr = new Date(dateTime).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [datePart, timePart] = laTimeStr.split(', ');
  const [month, day, year] = datePart.split('/');
  const [hours, minutes] = timePart.split(':');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function formatDateTime(dateTime) {
  if (!dateTime) return '—';
  return new Date(dateTime).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Los_Angeles',
  });
}

export default function AdminHelpManagement() {
  const [tab, setTab] = useState(0);
  const [cycles, setCycles] = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [tutorials, setTutorials] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState('create');
  const [dialogType, setDialogType] = useState('announcement');
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyAnnouncement);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteItem, setDeleteItem] = useState(null);

  const fetchCycles = () => {
    apiClient
      .get('/admin/cycles')
      .then((data) => setCycles(Array.isArray(data) ? data : []))
      .catch(() => setCycles([]));
  };

  const fetchAnnouncements = () => {
    setLoading(true);
    apiClient
      .get('/admin/help/announcements')
      .then((data) => setAnnouncements(Array.isArray(data) ? data : []))
      .catch((e) => setError(e.message || 'Failed to load announcements.'))
      .finally(() => setLoading(false));
  };

  const fetchTutorials = () => {
    setLoading(true);
    apiClient
      .get('/admin/help/tutorials')
      .then((data) => setTutorials(Array.isArray(data) ? data : []))
      .catch((e) => setError(e.message || 'Failed to load tutorials.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchCycles();
  }, []);

  useEffect(() => {
    setError(null);
    if (tab === 0) {
      fetchAnnouncements();
    } else {
      fetchTutorials();
    }
  }, [tab]);

  const openCreate = (type) => {
    setDialogType(type);
    setDialogMode('create');
    setEditingId(null);
    setForm(type === 'announcement' ? emptyAnnouncement : emptyTutorial);
    setDialogOpen(true);
  };

  const openEdit = (type, item) => {
    setDialogType(type);
    setDialogMode('edit');
    setEditingId(item.id);
    if (type === 'announcement') {
      setForm({
        title: item.title || '',
        body: item.body || '',
        publishedAt: toLocalInput(item.publishedAt),
        cycleId: item.cycleId || '',
      });
    } else {
      setForm({
        title: item.title || '',
        description: item.description || '',
        category: item.category || '',
        videoUrl: item.videoUrl || '',
        body: item.body || '',
        order: item.order === undefined || item.order === null ? 0 : item.order,
      });
    }
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingId(null);
  };

  const handleSave = async () => {
    setError(null);
    try {
      const base = dialogType === 'announcement' ? '/admin/help/announcements' : '/admin/help/tutorials';
      const payload = { ...form };

      if (dialogType === 'announcement') {
        if (!payload.title.trim()) {
          setError('Title is required.');
          return;
        }
        if (payload.publishedAt) {
          payload.publishedAt = new Date(payload.publishedAt).toISOString();
        } else {
          delete payload.publishedAt;
        }
        if (payload.cycleId === '') {
          payload.cycleId = null;
        }
      } else {
        if (!payload.title.trim()) {
          setError('Title is required.');
          return;
        }
        if (!payload.category) {
          setError('Category is required.');
          return;
        }
        payload.order = parseInt(payload.order, 10) || 0;
        if (payload.videoUrl === '') payload.videoUrl = null;
        if (payload.description === '') payload.description = null;
        if (payload.body === '') payload.body = null;
      }

      if (dialogMode === 'create') {
        await apiClient.post(base, payload);
      } else {
        await apiClient.put(`${base}/${editingId}`, payload);
      }

      closeDialog();
      if (dialogType === 'announcement') {
        fetchAnnouncements();
      } else {
        fetchTutorials();
      }
    } catch (e) {
      setError(e.message || 'Failed to save.');
    }
  };

  const confirmDelete = (type, item) => {
    setDeleteItem({ type, item });
    setDeleteDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteItem) return;
    setError(null);
    try {
      const base =
        deleteItem.type === 'announcement' ? '/admin/help/announcements' : '/admin/help/tutorials';
      await apiClient.delete(`${base}/${deleteItem.item.id}`);
      setDeleteDialogOpen(false);
      setDeleteItem(null);
      if (deleteItem.type === 'announcement') {
        fetchAnnouncements();
      } else {
        fetchTutorials();
      }
    } catch (e) {
      setError(e.message || 'Failed to delete.');
    }
  };

  const handleChange = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <AccessControl allowedRoles={['ADMIN']}>
      <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1200 }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          justifyContent="space-between"
          mb={3}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <HelpIcon color="primary" />
            <Typography variant="h4" component="h1">
              Help Management
            </Typography>
          </Stack>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => openCreate(tab === 0 ? 'announcement' : 'tutorial')}
          >
            {tab === 0 ? 'New announcement' : 'New tutorial'}
          </Button>
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Paper sx={{ mb: 3 }}>
          <Tabs value={tab} onChange={(_, v) => setTab(v)} aria-label="Help management tabs">
            <Tab label="Announcements" />
            <Tab label="Tutorials" />
          </Tabs>
        </Paper>

        {tab === 0 && (
          <Paper>
            {loading ? (
              <Box sx={{ textAlign: 'center', py: 6 }}>
                <CircularProgress />
              </Box>
            ) : announcements.length === 0 ? (
              <Box sx={{ textAlign: 'center', p: 4 }}>
                <Typography variant="h6" gutterBottom>
                  No announcements yet
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Create announcements to show members what's new.
                </Typography>
              </Box>
            ) : (
              <TableContainer>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableCell>Title</TableCell>
                      <TableCell>Published</TableCell>
                      <TableCell>Cycle</TableCell>
                      <TableCell align="right">Reads</TableCell>
                      <TableCell align="right">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {announcements.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          <Typography fontWeight={500}>{item.title}</Typography>
                        </TableCell>
                        <TableCell>{formatDateTime(item.publishedAt)}</TableCell>
                        <TableCell>{item.cycle ? item.cycle.name : 'Global'}</TableCell>
                        <TableCell align="right">{item._count?.reads || 0}</TableCell>
                        <TableCell align="right">
                          <Tooltip title="Edit">
                            <IconButton onClick={() => openEdit('announcement', item)}>
                              <EditIcon />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Delete">
                            <IconButton onClick={() => confirmDelete('announcement', item)}>
                              <DeleteIcon />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>
        )}

        {tab === 1 && (
          <Paper>
            {loading ? (
              <Box sx={{ textAlign: 'center', py: 6 }}>
                <CircularProgress />
              </Box>
            ) : tutorials.length === 0 ? (
              <Box sx={{ textAlign: 'center', p: 4 }}>
                <Typography variant="h6" gutterBottom>
                  No tutorials yet
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Create tutorials to help members learn ATS workflows.
                </Typography>
              </Box>
            ) : (
              <TableContainer>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableCell>Title</TableCell>
                      <TableCell>Category</TableCell>
                      <TableCell>Order</TableCell>
                      <TableCell>Media</TableCell>
                      <TableCell align="right">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {tutorials.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          <Typography fontWeight={500}>{item.title}</Typography>
                          {item.description && (
                            <Typography variant="body2" color="text.secondary" noWrap>
                              {item.description}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            color={CATEGORY_COLORS[item.category] || 'default'}
                            label={CATEGORY_LABELS[item.category] || item.category}
                          />
                        </TableCell>
                        <TableCell>{item.order}</TableCell>
                        <TableCell>{item.videoUrl ? 'Video' : 'Written'}</TableCell>
                        <TableCell align="right">
                          <Tooltip title="Edit">
                            <IconButton onClick={() => openEdit('tutorial', item)}>
                              <EditIcon />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Delete">
                            <IconButton onClick={() => confirmDelete('tutorial', item)}>
                              <DeleteIcon />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>
        )}

        {/* Create / Edit Dialog */}
        <Dialog open={dialogOpen} onClose={closeDialog} fullWidth maxWidth="sm">
          <DialogTitle>
            {dialogMode === 'create' ? 'Create' : 'Edit'}{' '}
            {dialogType === 'announcement' ? 'Announcement' : 'Tutorial'}
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              <TextField
                label="Title"
                value={form.title}
                onChange={(e) => handleChange('title', e.target.value)}
                fullWidth
                required
              />

              {dialogType === 'announcement' ? (
                <>
                  <TextField
                    label="Body"
                    value={form.body}
                    onChange={(e) => handleChange('body', e.target.value)}
                    fullWidth
                    multiline
                    rows={6}
                  />
                  <TextField
                    label="Publish date"
                    type="datetime-local"
                    value={form.publishedAt}
                    onChange={(e) => handleChange('publishedAt', e.target.value)}
                    fullWidth
                    InputLabelProps={{ shrink: true }}
                  />
                  <FormControl fullWidth>
                    <InputLabel id="cycle-label">Cycle scope</InputLabel>
                    <Select
                      labelId="cycle-label"
                      value={form.cycleId}
                      label="Cycle scope"
                      onChange={(e) => handleChange('cycleId', e.target.value)}
                    >
                      <MenuItem value="">All cycles</MenuItem>
                      {cycles.map((cycle) => (
                        <MenuItem key={cycle.id} value={cycle.id}>
                          {cycle.name}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </>
              ) : (
                <>
                  <TextField
                    label="Description"
                    value={form.description}
                    onChange={(e) => handleChange('description', e.target.value)}
                    fullWidth
                  />
                  <FormControl fullWidth required>
                    <InputLabel id="category-label">Category</InputLabel>
                    <Select
                      labelId="category-label"
                      value={form.category}
                      label="Category"
                      onChange={(e) => handleChange('category', e.target.value)}
                    >
                      {TUTORIAL_CATEGORIES.map((cat) => (
                        <MenuItem key={cat} value={cat}>
                          {CATEGORY_LABELS[cat]}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <TextField
                    label="Video URL (Loom / YouTube / Vimeo)"
                    value={form.videoUrl}
                    onChange={(e) => handleChange('videoUrl', e.target.value)}
                    fullWidth
                    helperText="Leave blank if this is a written-only tutorial."
                  />
                  <TextField
                    label="Written steps"
                    value={form.body}
                    onChange={(e) => handleChange('body', e.target.value)}
                    fullWidth
                    multiline
                    rows={6}
                    helperText="Optional step-by-step written guide."
                  />
                  <TextField
                    label="Order"
                    type="number"
                    value={form.order}
                    onChange={(e) => handleChange('order', e.target.value)}
                    fullWidth
                    helperText="Lower numbers appear first."
                  />
                </>
              )}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeDialog}>Cancel</Button>
            <Button variant="contained" onClick={handleSave}>
              Save
            </Button>
          </DialogActions>
        </Dialog>

        {/* Delete confirmation */}
        <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)} maxWidth="xs" fullWidth>
          <DialogTitle>Confirm delete</DialogTitle>
          <DialogContent>
            <Typography>
              Are you sure you want to delete "{deleteItem?.item?.title}"? This cannot be undone.
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
            <Button variant="contained" color="error" onClick={handleDelete}>
              Delete
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    </AccessControl>
  );
}
