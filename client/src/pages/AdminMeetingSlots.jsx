import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
import AccessControl from '../components/AccessControl';
import {
  Box,
  Typography,
  Paper,
  TextField,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Checkbox,
  Chip,
  Stack,
  Alert,
  CircularProgress,
  Grid,
  Card,
  CardContent,
  Divider,
  IconButton,
  Tooltip,
  Tabs,
  Tab,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Avatar,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  InputAdornment
} from '@mui/material';
import {
  Add as AddIcon,
  Schedule as ScheduleIcon,
  LocationOn as LocationIcon,
  People as PeopleIcon,
  CheckCircle as CheckCircleIcon,
  Edit as EditIcon,
  Visibility as VisibilityIcon,
  Delete as DeleteIcon,
  Email as EmailIcon,
  Search as SearchIcon,
  EventAvailable as EventAvailableIcon,
  PercentOutlined as PercentIcon,
  OpenInNew as OpenInNewIcon
} from '@mui/icons-material';

// ---- helpers -------------------------------------------------------------

// UTC ISO -> "YYYY-MM-DDTHH:mm" datetime-local string in LA time (for editing).
const toLocalInput = (dateTime) => {
  if (!dateTime) return '';
  const laTimeStr = new Date(dateTime).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const [datePart, timePart] = laTimeStr.split(', ');
  const [month, day, year] = datePart.split('/');
  const [hours, minutes] = timePart.split(':');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

const formatDateTime = (dateTime) => {
  if (!dateTime) return '—';
  return new Date(dateTime).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Los_Angeles'
  });
};

const getSlotStatus = (slot) => {
  const now = new Date();
  const startTime = new Date(slot.startTime);
  const endTime = slot.endTime ? new Date(slot.endTime) : new Date(startTime.getTime() + 60 * 60 * 1000);
  if (now < startTime) return 'upcoming';
  if (now > endTime) return 'past';
  return 'active';
};

const STATUS_META = {
  upcoming: { label: 'Upcoming', color: 'primary' },
  active: { label: 'Now', color: 'success' },
  past: { label: 'Past', color: 'default' }
};

const COMM_TYPE_META = {
  CONFIRMATION: { label: 'Signup confirmation', color: 'info' },
  HOST_NOTIFICATION: { label: 'Host notified', color: 'default' },
  CANCELLATION: { label: 'Cancellation', color: 'warning' },
  REMINDER: { label: 'Reminder', color: 'secondary' }
};

const emptyForm = { memberId: '', location: '', startTime: '', endTime: '', capacity: 2 };

export default function AdminMeetingSlots() {
  const { token, user } = useAuth();

  const [slots, setSlots] = useState([]);
  const [members, setMembers] = useState([]);
  const [activeCycle, setActiveCycle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [tab, setTab] = useState(0);
  const [cycleScope, setCycleScope] = useState('cycle'); // 'cycle' | 'all'

  // Time Slots tab filters
  const [hostFilter, setHostFilter] = useState('all'); // 'all' | 'mine' | memberId
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'upcoming' | 'active' | 'past'
  const [slotSearch, setSlotSearch] = useState('');

  // Attendance tab filters
  const [attSearch, setAttSearch] = useState('');
  const [attFilter, setAttFilter] = useState('all'); // 'all' | 'attended' | 'not'

  const [detailSlot, setDetailSlot] = useState(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { api.setToken(token); }, [token]);

  const load = async () => {
    try {
      setLoading(true);
      setError('');
      const [data, cycle, users] = await Promise.all([
        api.get('/admin/meeting-slots'),
        api.get('/active-cycle').catch(() => null),
        api.get('/admin/users').catch(() => [])
      ]);
      setSlots(data?.slots || []);
      setActiveCycle(cycle || null);
      setMembers((users || []).filter((u) => u.role === 'MEMBER' || u.role === 'ADMIN'));
    } catch (e) {
      setError(e.message || 'Failed to load meeting slots');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const flash = (msg) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(''), 4000);
  };

  // Host dropdown options — always include the signed-in admin so "you" appears
  // by name even if the user list hasn't loaded them.
  const hostOptions = useMemo(() => {
    const list = [...members];
    if (user?.id && !list.some((m) => m.id === user.id)) {
      list.unshift({ id: user.id, fullName: user.fullName, email: user.email, role: user.role });
    }
    return list;
  }, [members, user]);

  const hostLabel = (m) => `${m.fullName || 'Member'}${m.id === user?.id ? ' (You)' : ''}${m.email ? ` · ${m.email}` : ''}`;

  // Cycle-scoped set — drives the summary cards and both tabs.
  const cycleSlots = useMemo(() => {
    if (cycleScope === 'all') return slots;
    if (!activeCycle || !activeCycle.startDate) return slots;
    const cutoff = new Date(activeCycle.startDate);
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setMonth(cutoff.getMonth() - 1);
    return slots.filter((s) => new Date(s.createdAt) >= cutoff);
  }, [slots, cycleScope, activeCycle]);

  const stats = useMemo(() => {
    const totalSlots = cycleSlots.length;
    const allSignups = cycleSlots.flatMap((s) => s.signups || []);
    const totalSignups = allSignups.length;
    const attended = allSignups.filter((s) => s.attended).length;
    const totalCapacity = cycleSlots.reduce((sum, s) => sum + (s.capacity || 0), 0);
    const upcoming = cycleSlots.filter((s) => getSlotStatus(s) === 'upcoming').length;
    return {
      totalSlots, totalSignups, attended, totalCapacity, upcoming,
      attendanceRate: totalSignups > 0 ? Math.round((attended / totalSignups) * 100) : 0
    };
  }, [cycleSlots]);

  // Time Slots tab — apply host / status / search filters.
  const visibleSlots = useMemo(() => {
    const q = slotSearch.trim().toLowerCase();
    return cycleSlots.filter((slot) => {
      if (hostFilter === 'mine' && slot.memberId !== user?.id) return false;
      if (hostFilter !== 'all' && hostFilter !== 'mine' && slot.memberId !== hostFilter) return false;
      if (statusFilter !== 'all' && getSlotStatus(slot) !== statusFilter) return false;
      if (!q) return true;
      return (
        slot.location?.toLowerCase().includes(q) ||
        slot.member?.fullName?.toLowerCase().includes(q)
      );
    });
  }, [cycleSlots, hostFilter, statusFilter, slotSearch, user]);

  // Attendance tab — flattened signup rows.
  const attendanceRows = useMemo(() => {
    const rows = cycleSlots.flatMap((slot) => (slot.signups || []).map((su) => ({ ...su, slot })));
    const q = attSearch.trim().toLowerCase();
    return rows.filter((r) => {
      if (attFilter === 'attended' && !r.attended) return false;
      if (attFilter === 'not' && r.attended) return false;
      if (!q) return true;
      return (
        r.fullName?.toLowerCase().includes(q) ||
        r.email?.toLowerCase().includes(q) ||
        r.studentId?.toLowerCase().includes(q) ||
        r.slot?.member?.fullName?.toLowerCase().includes(q)
      );
    });
  }, [cycleSlots, attSearch, attFilter]);

  // Keep the detail dialog in sync with freshly loaded data.
  useEffect(() => {
    if (!detailSlot) return;
    const fresh = slots.find((s) => s.id === detailSlot.id);
    setDetailSlot(fresh || null);
    // eslint-disable-next-line
  }, [slots]);

  // ---- actions -----------------------------------------------------------

  const setAttendance = async (signupId, attended) => {
    try {
      await api.patch(`/admin/meeting-signups/${signupId}/attendance`, { attended });
      await load();
    } catch (e) {
      setError(e.message || 'Failed to update attendance');
    }
  };

  const deleteSignup = async (signup) => {
    if (!window.confirm(`Remove ${signup.fullName} from this slot? This sends a cancellation email.`)) return;
    try {
      await api.delete(`/admin/meeting-signups/${signup.id}`);
      flash('Signup removed and cancellation email sent.');
      await load();
    } catch (e) {
      setError(e.message || 'Failed to remove signup');
    }
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...emptyForm, memberId: user?.id || '' });
    setFormError('');
    setFormOpen(true);
  };

  const openEdit = (slot) => {
    setEditingId(slot.id);
    setForm({
      memberId: slot.member?.id || slot.memberId || '',
      location: slot.location || '',
      startTime: toLocalInput(slot.startTime),
      endTime: slot.endTime ? toLocalInput(slot.endTime) : '',
      capacity: slot.capacity ?? 2
    });
    setFormError('');
    setFormOpen(true);
  };

  const submitForm = async (e) => {
    e?.preventDefault();
    if (!form.location || !form.startTime) {
      setFormError('Location and start time are required.');
      return;
    }
    if (form.endTime && new Date(form.endTime) <= new Date(form.startTime)) {
      setFormError('End time must be after start time.');
      return;
    }
    try {
      setSubmitting(true);
      setFormError('');
      const payload = {
        memberId: form.memberId || undefined,
        location: form.location,
        startTime: form.startTime,
        endTime: form.endTime || null,
        capacity: Number.isFinite(Number(form.capacity)) ? parseInt(form.capacity, 10) : 2
      };
      if (editingId) {
        await api.put(`/admin/meeting-slots/${editingId}`, payload);
        flash('Meeting slot updated.');
      } else {
        await api.post('/admin/meeting-slots', payload);
        flash('Meeting slot created.');
      }
      setFormOpen(false);
      await load();
    } catch (e) {
      setFormError(e.message || 'Failed to save meeting slot');
    } finally {
      setSubmitting(false);
    }
  };

  const deleteSlot = async (slot) => {
    const n = slot.signups?.length || 0;
    const warn = n > 0
      ? `Delete this slot? ${n} signup(s) will be notified with a cancellation email.`
      : 'Delete this slot?';
    if (!window.confirm(warn)) return;
    try {
      await api.delete(`/admin/meeting-slots/${slot.id}`);
      flash('Meeting slot deleted.');
      if (detailSlot?.id === slot.id) setDetailSlot(null);
      await load();
    } catch (e) {
      setError(e.message || 'Failed to delete meeting slot');
    }
  };

  // ---- render ------------------------------------------------------------

  const StatCard = ({ icon, label, value, sub }) => (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardContent>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Avatar sx={{ bgcolor: 'action.hover', color: 'primary.main' }}>{icon}</Avatar>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h5" fontWeight={700}>{value}</Typography>
            <Typography variant="body2" color="text.secondary" noWrap>{label}</Typography>
            {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );

  return (
    <AccessControl allowedRoles={['ADMIN']}>
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ md: 'center' }} spacing={2} mb={3}>
          <Box>
            <Typography variant="h4" fontWeight={700}>Get to Know UC</Typography>
            <Typography variant="body2" color="text.secondary">
              Manage every member's meeting slots, attendance, and communications.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <FormControl size="small" sx={{ minWidth: 140 }}>
              <InputLabel>Cycle</InputLabel>
              <Select value={cycleScope} label="Cycle" onChange={(e) => setCycleScope(e.target.value)}>
                <MenuItem value="cycle">This cycle</MenuItem>
                <MenuItem value="all">All time</MenuItem>
              </Select>
            </FormControl>
            <Button
              variant="outlined"
              startIcon={<VisibilityIcon />}
              endIcon={<OpenInNewIcon />}
              onClick={() => window.open('/meet', '_blank')}
              sx={{
                borderColor: 'primary.main',
                color: 'primary.main',
                '&:hover': { borderColor: 'primary.dark', backgroundColor: 'primary.50' }
              }}
            >
              View Public Page
            </Button>
            <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>New Slot</Button>
          </Stack>
        </Stack>

        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
        {success && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>{success}</Alert>}

        {/* Summary cards */}
        <Grid container spacing={2} mb={3}>
          <Grid item xs={6} md={3}>
            <StatCard icon={<ScheduleIcon />} label="Time slots" value={stats.totalSlots} sub={`${stats.upcoming} upcoming`} />
          </Grid>
          <Grid item xs={6} md={3}>
            <StatCard icon={<PeopleIcon />} label="Signups" value={stats.totalSignups} sub={`of ${stats.totalCapacity} capacity`} />
          </Grid>
          <Grid item xs={6} md={3}>
            <StatCard icon={<PercentIcon />} label="Attendance rate" value={`${stats.attendanceRate}%`} sub={`${stats.attended} attended`} />
          </Grid>
          <Grid item xs={6} md={3}>
            <StatCard icon={<EventAvailableIcon />} label="Attended" value={stats.attended} sub={`${stats.totalSignups - stats.attended} not marked`} />
          </Grid>
        </Grid>

        <Paper variant="outlined">
          <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ borderBottom: 1, borderColor: 'divider', px: 2 }}>
            <Tab label={`Time Slots (${stats.totalSlots})`} />
            <Tab label={`Attendance (${stats.totalSignups})`} />
          </Tabs>

          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}><CircularProgress /></Box>
          ) : tab === 0 ? (
            <TimeSlotsTab
              slots={visibleSlots}
              totalInScope={cycleSlots.length}
              hostOptions={hostOptions}
              hostLabel={hostLabel}
              hostFilter={hostFilter}
              setHostFilter={setHostFilter}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              search={slotSearch}
              setSearch={setSlotSearch}
              onView={setDetailSlot}
              onEdit={openEdit}
              onDelete={deleteSlot}
            />
          ) : (
            <AttendanceTab
              rows={attendanceRows}
              search={attSearch}
              setSearch={setAttSearch}
              filter={attFilter}
              setFilter={setAttFilter}
              onToggle={setAttendance}
              onView={setDetailSlot}
            />
          )}
        </Paper>
      </Box>

      {/* Detail dialog */}
      <SlotDetailDialog
        slot={detailSlot}
        currentUserId={user?.id}
        onClose={() => setDetailSlot(null)}
        onToggleAttendance={setAttendance}
        onDeleteSignup={deleteSignup}
        onEdit={(s) => { setDetailSlot(null); openEdit(s); }}
      />

      {/* Create/Edit dialog */}
      <Dialog open={formOpen} onClose={() => setFormOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingId ? 'Edit meeting slot' : 'New meeting slot'}</DialogTitle>
        <form onSubmit={submitForm}>
          <DialogContent dividers>
            {formError && <Alert severity="error" sx={{ mb: 2 }}>{formError}</Alert>}
            <Stack spacing={2.5} sx={{ mt: 1 }}>
              <FormControl fullWidth>
                <InputLabel id="host-label">Host (UC member)</InputLabel>
                <Select
                  labelId="host-label"
                  label="Host (UC member)"
                  value={form.memberId}
                  onChange={(e) => setForm({ ...form, memberId: e.target.value })}
                >
                  {hostOptions.map((m) => (
                    <MenuItem key={m.id} value={m.id}>{hostLabel(m)}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <TextField
                label="Location"
                fullWidth
                required
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
              />
              <TextField
                label="Start time"
                type="datetime-local"
                fullWidth
                required
                InputLabelProps={{ shrink: true }}
                value={form.startTime}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value && !form.endTime) {
                    const end = new Date(new Date(value).getTime() + 30 * 60 * 1000);
                    const pad = (n) => String(n).padStart(2, '0');
                    const endStr = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T${pad(end.getHours())}:${pad(end.getMinutes())}`;
                    setForm({ ...form, startTime: value, endTime: endStr });
                  } else {
                    setForm({ ...form, startTime: value });
                  }
                }}
              />
              <TextField
                label="End time"
                type="datetime-local"
                fullWidth
                InputLabelProps={{ shrink: true }}
                value={form.endTime}
                onChange={(e) => setForm({ ...form, endTime: e.target.value })}
              />
              <TextField
                label="Capacity"
                type="number"
                fullWidth
                inputProps={{ min: 1, max: 50 }}
                value={form.capacity}
                onChange={(e) => setForm({ ...form, capacity: e.target.value })}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setFormOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={submitting}>
              {submitting ? 'Saving…' : editingId ? 'Save changes' : 'Create slot'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </AccessControl>
  );
}

// ---- Time Slots tab ------------------------------------------------------

function TimeSlotsTab({
  slots, totalInScope, hostOptions, hostLabel,
  hostFilter, setHostFilter, statusFilter, setStatusFilter,
  search, setSearch, onView, onEdit, onDelete
}) {
  return (
    <Box>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ p: 2 }} alignItems={{ md: 'center' }} flexWrap="wrap" useFlexGap>
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel>Host</InputLabel>
          <Select value={hostFilter} label="Host" onChange={(e) => setHostFilter(e.target.value)}>
            <MenuItem value="all">All hosts</MenuItem>
            <MenuItem value="mine">My slots</MenuItem>
            <Divider />
            {hostOptions.map((m) => (
              <MenuItem key={m.id} value={m.id}>{hostLabel(m)}</MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 150 }}>
          <InputLabel>Status</InputLabel>
          <Select value={statusFilter} label="Status" onChange={(e) => setStatusFilter(e.target.value)}>
            <MenuItem value="all">All statuses</MenuItem>
            <MenuItem value="upcoming">Upcoming</MenuItem>
            <MenuItem value="active">Happening now</MenuItem>
            <MenuItem value="past">Past</MenuItem>
          </Select>
        </FormControl>
        <TextField
          size="small"
          placeholder="Search location or host…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ minWidth: 240, flexGrow: 1 }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
        />
        <Typography variant="body2" color="text.secondary" sx={{ ml: { md: 'auto' } }}>
          {slots.length} of {totalInScope}
        </Typography>
      </Stack>
      <Divider />
      {slots.length === 0 ? (
        <Box sx={{ p: 6, textAlign: 'center', color: 'text.secondary' }}>No meeting slots match these filters.</Box>
      ) : (
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Host</TableCell>
                <TableCell>Location</TableCell>
                <TableCell>Start</TableCell>
                <TableCell align="center">Status</TableCell>
                <TableCell align="center">Signups</TableCell>
                <TableCell align="center">Attended</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {slots.map((slot) => {
                const signups = slot.signups || [];
                const attended = signups.filter((s) => s.attended).length;
                const status = getSlotStatus(slot);
                return (
                  <TableRow key={slot.id} hover sx={{ cursor: 'pointer' }} onClick={() => onView(slot)}>
                    <TableCell>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Avatar src={slot.member?.profileImage || undefined} sx={{ width: 28, height: 28, fontSize: 13 }}>
                          {slot.member?.fullName?.[0] || '?'}
                        </Avatar>
                        <Typography variant="body2">{slot.member?.fullName || 'Unknown'}</Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>{slot.location}</TableCell>
                    <TableCell>{formatDateTime(slot.startTime)}</TableCell>
                    <TableCell align="center">
                      <Chip size="small" label={STATUS_META[status].label} color={STATUS_META[status].color} variant={status === 'past' ? 'outlined' : 'filled'} />
                    </TableCell>
                    <TableCell align="center">
                      <Chip size="small" variant="outlined" label={`${signups.length}/${slot.capacity}`} />
                    </TableCell>
                    <TableCell align="center">{attended}</TableCell>
                    <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                      <Tooltip title="View details"><IconButton size="small" onClick={() => onView(slot)}><VisibilityIcon fontSize="small" /></IconButton></Tooltip>
                      <Tooltip title="Edit"><IconButton size="small" onClick={() => onEdit(slot)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                      <Tooltip title="Delete"><IconButton size="small" color="error" onClick={() => onDelete(slot)}><DeleteIcon fontSize="small" /></IconButton></Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}

// ---- Attendance tab ------------------------------------------------------

function AttendanceTab({ rows, search, setSearch, filter, setFilter, onToggle, onView }) {
  return (
    <Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ p: 2 }} alignItems={{ sm: 'center' }} flexWrap="wrap" useFlexGap>
        <TextField
          size="small"
          placeholder="Search name, email, student ID, host…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ minWidth: 280, flexGrow: 1 }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
        />
        <FormControl size="small" sx={{ minWidth: 170 }}>
          <InputLabel>Attendance</InputLabel>
          <Select value={filter} label="Attendance" onChange={(e) => setFilter(e.target.value)}>
            <MenuItem value="all">All signups</MenuItem>
            <MenuItem value="attended">Attended</MenuItem>
            <MenuItem value="not">Not attended</MenuItem>
          </Select>
        </FormControl>
        <Typography variant="body2" color="text.secondary" sx={{ ml: { sm: 'auto' } }}>{rows.length} shown</Typography>
      </Stack>
      <Divider />
      {rows.length === 0 ? (
        <Box sx={{ p: 6, textAlign: 'center', color: 'text.secondary' }}>No signups match this view.</Box>
      ) : (
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">Present</TableCell>
                <TableCell>Candidate</TableCell>
                <TableCell>Email</TableCell>
                <TableCell>Student ID</TableCell>
                <TableCell>Host</TableCell>
                <TableCell>Slot</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} hover>
                  <TableCell padding="checkbox">
                    <Checkbox checked={!!r.attended} onChange={(e) => onToggle(r.id, e.target.checked)} />
                  </TableCell>
                  <TableCell>{r.fullName}</TableCell>
                  <TableCell sx={{ overflowWrap: 'anywhere', wordBreak: 'break-word', maxWidth: 240 }}>{r.email}</TableCell>
                  <TableCell>{r.studentId || '—'}</TableCell>
                  <TableCell>{r.slot?.member?.fullName || '—'}</TableCell>
                  <TableCell>
                    <Button size="small" onClick={() => onView(r.slot)} sx={{ textTransform: 'none' }}>
                      {formatDateTime(r.slot?.startTime)}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}

// ---- Slot detail dialog --------------------------------------------------

function SlotDetailDialog({ slot, currentUserId, onClose, onToggleAttendance, onDeleteSignup, onEdit }) {
  if (!slot) return null;
  const signups = slot.signups || [];
  const comms = slot.communications || [];
  const attended = signups.filter((s) => s.attended).length;
  const isYou = slot.member?.id === currentUserId;

  return (
    <Dialog open={!!slot} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ pr: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
          <span>Slot details</span>
          <Button size="small" variant="outlined" startIcon={<EditIcon />} onClick={() => onEdit(slot)}>Edit</Button>
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        {/* Host + slot info — two padded, bordered panels that never overlap */}
        <Grid container spacing={2} sx={{ mb: 1 }}>
          <Grid item xs={12} md={6}>
            <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
              <Typography variant="overline" color="text.secondary" display="block" gutterBottom>Host (UC member)</Typography>
              <Stack direction="row" spacing={1.5} alignItems="flex-start">
                <Avatar src={slot.member?.profileImage || undefined}>{slot.member?.fullName?.[0] || '?'}</Avatar>
                <Box sx={{ minWidth: 0 }}>
                  <Typography fontWeight={600} sx={{ wordBreak: 'break-word' }}>
                    {slot.member?.fullName || 'Unknown'}{isYou ? ' (You)' : ''}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                    {slot.member?.email || '—'}
                  </Typography>
                  <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                    {slot.member?.role && <Chip size="small" label={slot.member.role} variant="outlined" />}
                    {slot.member?.graduationClass && <Chip size="small" label={`Class of ${slot.member.graduationClass}`} variant="outlined" />}
                  </Stack>
                </Box>
              </Stack>
            </Paper>
          </Grid>
          <Grid item xs={12} md={6}>
            <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
              <Typography variant="overline" color="text.secondary" display="block" gutterBottom>When & where</Typography>
              <Stack spacing={1}>
                <Stack direction="row" spacing={1} alignItems="flex-start">
                  <ScheduleIcon fontSize="small" color="action" sx={{ mt: '2px' }} />
                  <Typography variant="body2">{formatDateTime(slot.startTime)}{slot.endTime ? ` – ${formatDateTime(slot.endTime)}` : ''}</Typography>
                </Stack>
                <Stack direction="row" spacing={1} alignItems="flex-start">
                  <LocationIcon fontSize="small" color="action" sx={{ mt: '2px' }} />
                  <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{slot.location}</Typography>
                </Stack>
                <Stack direction="row" spacing={1} alignItems="flex-start">
                  <PeopleIcon fontSize="small" color="action" sx={{ mt: '2px' }} />
                  <Typography variant="body2">{signups.length}/{slot.capacity} signed up · {attended} attended</Typography>
                </Stack>
              </Stack>
            </Paper>
          </Grid>
        </Grid>

        {/* Signups */}
        <Typography variant="subtitle1" fontWeight={600} sx={{ mt: 3 }} gutterBottom>Signups ({signups.length})</Typography>
        {signups.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>No one has signed up yet.</Typography>
        ) : (
          <TableContainer component={Paper} variant="outlined" sx={{ mb: 2, overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">Present</TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>Email</TableCell>
                  <TableCell>Student ID</TableCell>
                  <TableCell>Signed up</TableCell>
                  <TableCell align="right">Remove</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {signups.map((s) => (
                  <TableRow key={s.id} hover>
                    <TableCell padding="checkbox">
                      <Checkbox checked={!!s.attended} onChange={(e) => onToggleAttendance(s.id, e.target.checked)} />
                    </TableCell>
                    <TableCell>{s.fullName}</TableCell>
                    <TableCell sx={{ overflowWrap: 'anywhere', wordBreak: 'break-word', maxWidth: 220 }}>{s.email}</TableCell>
                    <TableCell>{s.studentId || '—'}</TableCell>
                    <TableCell>{formatDateTime(s.createdAt)}</TableCell>
                    <TableCell align="right">
                      <IconButton size="small" color="error" onClick={() => onDeleteSignup(s)}><DeleteIcon fontSize="small" /></IconButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {/* Communications log */}
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 3, mb: 1 }}>
          <EmailIcon fontSize="small" color="action" />
          <Typography variant="subtitle1" fontWeight={600}>Communications sent ({comms.length})</Typography>
        </Stack>
        {comms.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No communications logged for this slot yet. Emails are recorded here going forward as they're sent.
          </Typography>
        ) : (
          <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Type</TableCell>
                  <TableCell>Recipient</TableCell>
                  <TableCell>Subject</TableCell>
                  <TableCell align="center">Status</TableCell>
                  <TableCell>Sent</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {comms.map((c) => {
                  const meta = COMM_TYPE_META[c.type] || { label: c.type, color: 'default' };
                  return (
                    <TableRow key={c.id} hover>
                      <TableCell><Chip size="small" label={meta.label} color={meta.color} variant="outlined" /></TableCell>
                      <TableCell sx={{ overflowWrap: 'anywhere', wordBreak: 'break-word', maxWidth: 200 }}>{c.recipient}</TableCell>
                      <TableCell sx={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{c.subject}</TableCell>
                      <TableCell align="center">
                        <Chip
                          size="small"
                          icon={c.status === 'SENT' ? <CheckCircleIcon /> : undefined}
                          label={c.status}
                          color={c.status === 'SENT' ? 'success' : 'error'}
                          variant={c.status === 'SENT' ? 'outlined' : 'filled'}
                        />
                      </TableCell>
                      <TableCell>{formatDateTime(c.sentAt)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
