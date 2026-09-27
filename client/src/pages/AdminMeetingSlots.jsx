import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
import { fetchActiveCycle, slotsCreatedForCycle } from '../utils/activeCycle';
import {
  ATTENDANCE_SORT_KEYS,
  SLOT_SORT_KEYS,
  nextSort,
  slotStatus as getSlotStatus,
  sortRows
} from '../utils/gtkucSort';
import {
  attendanceReminders,
  attendanceState,
  canFinishAttendance,
  isOutstanding,
  timeAgo
} from '../utils/gtkucAttendance';
import AccessControl from '../components/AccessControl';
import MemberAvatar from '../components/MemberAvatar';
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
  TableSortLabel,
  Checkbox,
  Chip,
  Stack,
  Alert,
  CircularProgress,
  Grid,
  Card,
  CardActionArea,
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
  InputAdornment,
  Switch,
  Link
} from '@mui/material';
import GtkucProfileModal from '../components/GtkucProfileModal';
import SlotContactDialog from '../components/meetings/SlotContactDialog';
import {
  Add as AddIcon,
  Badge as BadgeIcon,
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
  OpenInNew as OpenInNewIcon,
  LinkedIn as LinkedInIcon,
  Sms as SmsIcon,
  NotificationsActive as RemindIcon,
  AssignmentLate as OverdueIcon
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

const STATUS_META = {
  upcoming: { label: 'Upcoming', color: 'primary' },
  active: { label: 'Now', color: 'success' },
  past: { label: 'Past', color: 'default' }
};

const COMM_TYPE_META = {
  CONFIRMATION: { label: 'Signup confirmation', color: 'info' },
  HOST_NOTIFICATION: { label: 'Host notified', color: 'default' },
  CANCELLATION: { label: 'Cancellation', color: 'warning' },
  RESCHEDULED: { label: 'Rescheduled', color: 'info' },
  REMINDER: { label: 'Host reminder', color: 'secondary' },
  ATTENDANCE_REMINDER: { label: 'Attendance reminder', color: 'secondary' }
};

// A table header cell that sorts its column when clicked.
const SortableHeader = ({ field, sort, onSort, children, ...cellProps }) => (
  <TableCell {...cellProps} sortDirection={sort.field === field ? sort.dir : false}>
    <TableSortLabel
      active={sort.field === field}
      direction={sort.field === field ? sort.dir : 'asc'}
      onClick={() => onSort(field)}
    >
      {children}
    </TableSortLabel>
  </TableCell>
);

// Matches MAX_MANUAL_REMINDERS in server/src/routes/admin.js.
const REMINDER_BATCH = 200;

const emptyForm = { memberId: '', location: '', startTime: '', endTime: '', capacity: 2 };

export default function AdminMeetingSlots() {
  const { token, user } = useAuth();

  const [slots, setSlots] = useState([]);
  const [members, setMembers] = useState([]);
  const [gtkucProfiles, setGtkucProfiles] = useState([]);
  const [profileState, setProfileState] = useState(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  // Set when the profile gate interrupted a "New Slot" click, so the create
  // form opens by itself once the profile is confirmed.
  const [createAfterProfile, setCreateAfterProfile] = useState(false);
  const [activeCycle, setActiveCycle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [tab, setTab] = useState(0);
  const [cycleScope, setCycleScope] = useState('cycle'); // 'cycle' | 'all'

  // Time Slots tab filters
  const [hostFilter, setHostFilter] = useState('all'); // 'all' | 'mine' | memberId
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'upcoming' | 'active' | 'past' | 'overdue'
  const [slotSearch, setSlotSearch] = useState('');
  const [slotSort, setSlotSort] = useState({ field: 'start', dir: 'asc' });

  // Attendance tab filters
  const [attSearch, setAttSearch] = useState('');
  const [attFilter, setAttFilter] = useState('all'); // 'all' | 'attended' | 'not' | 'unmarked'
  const [attSort, setAttSort] = useState({ field: 'slot', dir: 'asc' });

  // One clock for every status on the page. The sort, the status filter and the
  // badges all read it, so a slot that starts while the page is open moves to
  // its new place in the order at the same moment its badge changes.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // Overdue slots ticked for a bulk reminder.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [reminding, setReminding] = useState(false);

  const [detailSlot, setDetailSlot] = useState(null);
  const [contactSlot, setContactSlot] = useState(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [formInitial, setFormInitial] = useState(null);
  const [editingSignupCount, setEditingSignupCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { api.setToken(token); }, [token]);

  // The signed-in admin's own candidate-facing profile. Admins host slots like
  // members do, so the same per-cycle confirmation applies before they open one.
  const loadProfileState = async () => {
    try {
      const state = await api.get('/member/gtkuc-profile');
      setProfileState(state);
      return state;
    } catch (e) {
      console.error('Failed to load GTKUC profile state:', e);
      return null;
    }
  };

  const load = async () => {
    try {
      setLoading(true);
      setError('');
      const [data, cycle, users, profiles] = await Promise.all([
        api.get('/admin/meeting-slots'),
        fetchActiveCycle(api).catch(() => null),
        api.get('/admin/users').catch(() => []),
        api.get('/admin/gtkuc-profiles').catch(() => []),
        loadProfileState()
      ]);
      setSlots(data?.slots || []);
      setActiveCycle(cycle);
      setMembers((users || []).filter((u) => u.role === 'MEMBER' || u.role === 'ADMIN'));
      setGtkucProfiles(profiles || []);
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

  // Profile completeness of whoever is hosting the slot being created/edited.
  const selectedHostProfile = useMemo(() => {
    const hostId = form.memberId || user?.id;
    return gtkucProfiles.find((p) => p.id === hostId) || null;
  }, [gtkucProfiles, form.memberId, user]);

  const hostLabel = (m) => `${m.fullName || 'Member'}${m.id === user?.id ? ' (You)' : ''}${m.email ? ` · ${m.email}` : ''}`;

  // Cycle-scoped set — drives the summary cards and both tabs.
  const cycleSlots = useMemo(() => {
    if (cycleScope === 'all') return slots;
    return slotsCreatedForCycle(slots, activeCycle);
  }, [slots, cycleScope, activeCycle]);

  const stats = useMemo(() => {
    const totalSlots = cycleSlots.length;
    const totalSignups = cycleSlots.reduce((sum, s) => sum + (s.signups || []).length, 0);
    const totalCapacity = cycleSlots.reduce((sum, s) => sum + (s.capacity || 0), 0);
    const upcoming = cycleSlots.filter((s) => getSlotStatus(s, now) === 'upcoming').length;
    // The rate is over slots whose attendance is finished: an upcoming signup
    // has not had the chance to attend, and an unmarked one is not a no-show yet.
    const doneSignups = cycleSlots
      .filter((s) => attendanceState(s, now) === 'done')
      .flatMap((s) => s.signups || []);
    const attended = doneSignups.filter((s) => s.attended).length;
    const overdue = cycleSlots.filter((s) => isOutstanding(s, now));
    return {
      totalSlots, totalSignups, totalCapacity, upcoming, attended,
      finishedSignups: doneSignups.length,
      attendanceRate: doneSignups.length > 0 ? Math.round((attended / doneSignups.length) * 100) : null,
      overdueSlots: overdue.length,
      overdueSignups: overdue.reduce((sum, s) => sum + s.signups.filter((su) => !su.attended).length, 0)
    };
  }, [cycleSlots, now]);

  // Time Slots tab — apply host / status / search filters, then the column sort.
  const visibleSlots = useMemo(() => {
    const q = slotSearch.trim().toLowerCase();
    const filtered = cycleSlots.filter((slot) => {
      if (hostFilter === 'mine' && slot.memberId !== user?.id) return false;
      if (hostFilter !== 'all' && hostFilter !== 'mine' && slot.memberId !== hostFilter) return false;
      if (statusFilter === 'overdue') {
        if (!isOutstanding(slot, now)) return false;
      } else if (statusFilter !== 'all' && getSlotStatus(slot, now) !== statusFilter) return false;
      if (!q) return true;
      return (
        slot.location?.toLowerCase().includes(q) ||
        slot.member?.fullName?.toLowerCase().includes(q)
      );
    });
    return sortRows(filtered, SLOT_SORT_KEYS, slotSort, { tiebreak: 'start', now });
  }, [cycleSlots, hostFilter, statusFilter, slotSearch, slotSort, user, now]);

  // Attendance tab — flattened signup rows, filtered then column-sorted.
  const attendanceRows = useMemo(() => {
    const rows = cycleSlots.flatMap((slot) => (slot.signups || []).map((su) => ({ ...su, slot })));
    const q = attSearch.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (attFilter === 'attended' && !r.attended) return false;
      if (attFilter === 'not' && r.attended) return false;
      if (attFilter === 'unmarked' && (r.attended || !isOutstanding(r.slot, now))) return false;
      if (!q) return true;
      return (
        r.fullName?.toLowerCase().includes(q) ||
        r.email?.toLowerCase().includes(q) ||
        r.studentId?.toLowerCase().includes(q) ||
        r.slot?.member?.fullName?.toLowerCase().includes(q)
      );
    });
    return sortRows(filtered, ATTENDANCE_SORT_KEYS, attSort, { tiebreak: 'slot' });
  }, [cycleSlots, attSearch, attFilter, attSort, now]);

  // A ticked slot that leaves the overdue list (marked done, reminded and
  // then finished, or filtered out) drops out of the selection with it.
  const visibleOverdueIds = useMemo(
    () => (statusFilter === 'overdue' ? visibleSlots.map((s) => s.id) : []),
    [statusFilter, visibleSlots]
  );
  const selectedOverdue = visibleOverdueIds.filter((id) => selectedIds.has(id));

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

  // Email each slot's host to take attendance. One email per slot, so a host
  // with two overdue slots gets two, each with a button to that slot.
  const sendReminders = async (slotIds) => {
    if (slotIds.length === 0) return;
    if (slotIds.length > 1 && !window.confirm(`Email the hosts of ${slotIds.length} slots to take attendance?`)) return;
    try {
      setReminding(true);
      // The endpoint takes REMINDER_BATCH slots per request, and the first
      // run after the migration can easily select more.
      let sent = 0;
      let failed = 0;
      let skipped = 0;
      for (let i = 0; i < slotIds.length; i += REMINDER_BATCH) {
        const res = await api.post('/admin/meeting-slots/attendance-reminders', {
          slotIds: slotIds.slice(i, i + REMINDER_BATCH)
        });
        sent += res?.sent || 0;
        failed += res?.failed || 0;
        skipped += res?.skipped || 0;
      }
      const parts = [`${sent} reminder${sent === 1 ? '' : 's'} sent.`];
      if (skipped > 0) parts.push(`${skipped} skipped: already finished, host deactivated, or being sent right now.`);
      if (failed > 0) {
        setError(`${parts.join(' ')} ${failed} could not be emailed; see the slot's communications log.`);
      } else {
        flash(parts.join(' '));
      }
      setSelectedIds(new Set());
      await load();
    } catch (e) {
      setError(e.message || 'Failed to send reminders');
    } finally {
      setReminding(false);
    }
  };

  const setAttendanceDone = async (slot, complete) => {
    try {
      await api.put(`/admin/meeting-slots/${slot.id}/attendance-complete`, { complete });
      flash(complete ? 'Attendance finished. Anyone unchecked counts as a no-show.' : 'Attendance reopened.');
      await load();
    } catch (e) {
      setError(e.message || 'Failed to update attendance');
    }
  };

  const toggleSelected = (id, on) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
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

  // Hide a member from candidate-facing GTKUC (their slots stop being offered).
  const setGtkucHidden = async (memberId, hiddenFromGtkuc) => {
    try {
      await api.patch(`/admin/gtkuc-profiles/${memberId}/visibility`, { hiddenFromGtkuc });
      flash(hiddenFromGtkuc ? 'Member hidden from Get to Know UC.' : 'Member visible in Get to Know UC.');
      await load();
    } catch (e) {
      setError(e.message || 'Failed to update GTKUC visibility');
    }
  };

  const openCreate = async () => {
    // Admins host slots too: confirm the candidate-facing profile once per cycle
    // before the first one, same as the member portal.
    const currentProfileState = profileState || (await loadProfileState());
    if (currentProfileState?.confirmationRequired) {
      setCreateAfterProfile(true);
      setProfileModalOpen(true);
      return;
    }

    setEditingId(null);
    setForm({ ...emptyForm, memberId: user?.id || '' });
    setFormInitial(null);
    setEditingSignupCount(0);
    setFormError('');
    setFormOpen(true);
  };

  const openEdit = (slot) => {
    const initial = {
      memberId: slot.member?.id || slot.memberId || '',
      location: slot.location || '',
      startTime: toLocalInput(slot.startTime),
      endTime: slot.endTime ? toLocalInput(slot.endTime) : '',
      capacity: slot.capacity ?? 2
    };

    setEditingId(slot.id);
    setForm(initial);
    // Kept so submit can tell a reschedule (which emails everyone who booked,
    // plus the host) from a capacity or host change (which emails nobody).
    setFormInitial(initial);
    setEditingSignupCount(slot.signups?.length || 0);
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
    // Backstop for a form opened before the profile lapsed; the create button
    // gates first. Slots opened on behalf of another member are not gated.
    const hostingSelf = !form.memberId || form.memberId === user?.id;
    if (!editingId && hostingSelf) {
      const currentProfileState = profileState || (await loadProfileState());
      if (currentProfileState?.confirmationRequired) {
        setProfileModalOpen(true);
        return;
      }
    }

    // Moving a slot that people have booked emails them; changing capacity or
    // reassigning the host does not. Only the first is worth a confirmation.
    const moved = editingId && formInitial && (
      form.startTime !== formInitial.startTime ||
      form.endTime !== formInitial.endTime ||
      form.location !== formInitial.location
    );

    if (moved && editingSignupCount > 0) {
      const confirmed = window.confirm(
        `This will email ${editingSignupCount} signed-up candidate(s) and the host member ` +
        'the new time and location. Continue?'
      );
      if (!confirmed) return;
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
        const updated = await api.put(`/admin/meeting-slots/${editingId}`, payload);
        // The server reports deliveries alongside what it expected to send.
        // Anyone it could not reach still has the old time and needs telling
        // by hand, so a shortfall is a warning rather than a success message.
        const n = updated?.notified || {};
        const missed = [];
        if ((n.candidatesExpected || 0) > (n.candidates || 0)) {
          missed.push(`${(n.candidatesExpected || 0) - (n.candidates || 0)} of ${n.candidatesExpected} candidate(s)`);
        }
        if (n.hostExpected && !n.host) {
          missed.push('the host member');
        }

        if (missed.length > 0) {
          setError(`Slot moved, but ${missed.join(' and ')} could not be emailed. Contact them directly.`);
        } else {
          flash(
            n.candidates > 0
              ? `Meeting slot updated. ${n.candidates} signed-up candidate(s) emailed the new details.`
              : 'Meeting slot updated.'
          );
        }
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

  const StatCard = ({ icon, label, value, sub, onClick, warn }) => {
    const body = (
      <CardContent>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Avatar sx={{ bgcolor: warn ? 'warning.light' : 'action.hover', color: warn ? 'warning.dark' : 'primary.main' }}>{icon}</Avatar>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h5" fontWeight={700}>{value}</Typography>
            <Typography variant="body2" color="text.secondary" noWrap>{label}</Typography>
            {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
          </Box>
        </Stack>
      </CardContent>
    );
    return (
      <Card variant="outlined" sx={{ height: '100%', ...(warn && { borderColor: 'warning.main' }) }}>
        {onClick ? <CardActionArea onClick={onClick} sx={{ height: '100%' }}>{body}</CardActionArea> : body}
      </Card>
    );
  };

  // The card counts every overdue slot in scope, so the list it opens must not
  // be narrowed by a host or search filter left over from earlier.
  const showOverdue = () => {
    setTab(0);
    setHostFilter('all');
    setSlotSearch('');
    setStatusFilter('overdue');
  };

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
            >
              View Public Page
            </Button>
            <Button
              variant="outlined"
              startIcon={<BadgeIcon />}
              onClick={() => setProfileModalOpen(true)}
            >
              My Candidate Profile
            </Button>
            <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>New Slot</Button>
          </Stack>
        </Stack>

        {profileState?.confirmationRequired && (
          <Alert
            severity="warning"
            sx={{ mb: 2 }}
            action={
              <Button color="inherit" size="small" onClick={() => setProfileModalOpen(true)}>
                Confirm profile
              </Button>
            }
          >
            {profileState.missingFields?.length > 0
              ? `Candidates see your profile when they pick one of your timeslots. Add your ${profileState.missingFields.join(', ')} before opening timeslots.`
              : `Confirm your Get to Know UC profile for ${
                  profileState.activeCycle?.name || 'this cycle'
                } before opening your own timeslots.`}
          </Alert>
        )}

        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
        {success && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>{success}</Alert>}

        <GtkucProfileModal
          open={profileModalOpen}
          state={profileState}
          required={Boolean(profileState?.confirmationRequired)}
          onClose={() => {
            setProfileModalOpen(false);
            setCreateAfterProfile(false);
          }}
          onSaved={(updated) => {
            setProfileState(updated);
            setProfileModalOpen(false);
            load();
            if (createAfterProfile && !updated?.confirmationRequired) {
              setCreateAfterProfile(false);
              setEditingId(null);
              setForm({ ...emptyForm, memberId: user?.id || '' });
              setFormError('');
              setFormOpen(true);
            }
          }}
        />

        {/* Summary cards */}
        <Grid container spacing={2} mb={3}>
          <Grid item xs={6} md={3}>
            <StatCard icon={<ScheduleIcon />} label="Time slots" value={stats.totalSlots} sub={`${stats.upcoming} upcoming`} />
          </Grid>
          <Grid item xs={6} md={3}>
            <StatCard icon={<PeopleIcon />} label="Signups" value={stats.totalSignups} sub={`of ${stats.totalCapacity} capacity`} />
          </Grid>
          <Grid item xs={6} md={3}>
            <StatCard
              icon={<PercentIcon />}
              label="Attendance rate"
              value={stats.attendanceRate === null ? '—' : `${stats.attendanceRate}%`}
              sub={`${stats.attended} of ${stats.finishedSignups} in finished slots`}
            />
          </Grid>
          <Grid item xs={6} md={3}>
            {stats.overdueSlots > 0 ? (
              <StatCard
                warn
                icon={<OverdueIcon />}
                label="Attendance overdue"
                value={stats.overdueSlots}
                sub={`slot${stats.overdueSlots === 1 ? '' : 's'} · ${stats.overdueSignups} ${stats.overdueSignups === 1 ? 'person' : 'people'} unmarked`}
                onClick={showOverdue}
              />
            ) : (
              <StatCard icon={<EventAvailableIcon />} label="Attendance overdue" value={0} sub="Every past slot is marked" />
            )}
          </Grid>
        </Grid>

        <Paper variant="outlined">
          <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ borderBottom: 1, borderColor: 'divider', px: 2 }}>
            <Tab label={`Time Slots (${stats.totalSlots})`} />
            <Tab label={`Attendance (${stats.totalSignups})`} />
            <Tab label={`Member Profiles (${gtkucProfiles.length})`} />
          </Tabs>

          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}><CircularProgress /></Box>
          ) : tab === 0 ? (
            <TimeSlotsTab
              slots={visibleSlots}
              now={now}
              totalInScope={cycleSlots.length}
              hostOptions={hostOptions}
              hostLabel={hostLabel}
              hostFilter={hostFilter}
              setHostFilter={setHostFilter}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              search={slotSearch}
              setSearch={setSlotSearch}
              sort={slotSort}
              onSort={(field) => setSlotSort((prev) => nextSort(prev, field))}
              onView={setDetailSlot}
              onEdit={openEdit}
              onDelete={deleteSlot}
              selectedIds={selectedIds}
              selectedCount={selectedOverdue.length}
              onToggleSelected={toggleSelected}
              onSelectAll={(on) => setSelectedIds(new Set(on ? visibleOverdueIds : []))}
              onRemind={sendReminders}
              onRemindSelected={() => sendReminders(selectedOverdue)}
              reminding={reminding}
            />
          ) : tab === 1 ? (
            <AttendanceTab
              rows={attendanceRows}
              search={attSearch}
              setSearch={setAttSearch}
              filter={attFilter}
              setFilter={setAttFilter}
              sort={attSort}
              onSort={(field) => setAttSort((prev) => nextSort(prev, field))}
              onToggle={setAttendance}
              onView={setDetailSlot}
            />
          ) : (
            <MemberProfilesTab profiles={gtkucProfiles} onToggleHidden={setGtkucHidden} />
          )}
        </Paper>
      </Box>

      {/* Detail dialog */}
      <SlotDetailDialog
        slot={detailSlot}
        now={now}
        currentUserId={user?.id}
        reminding={reminding}
        onRemind={(s) => sendReminders([s.id])}
        onAttendanceDone={setAttendanceDone}
        onClose={() => setDetailSlot(null)}
        onToggleAttendance={setAttendance}
        onDeleteSignup={deleteSignup}
        onEdit={(s) => { setDetailSlot(null); openEdit(s); }}
        onContact={setContactSlot}
      />

      <SlotContactDialog
        open={!!contactSlot}
        onClose={() => setContactSlot(null)}
        slot={contactSlot}
        hostName={contactSlot?.member?.fullName}
      />

      {/* Create/Edit dialog */}
      <Dialog open={formOpen} onClose={() => setFormOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingId ? 'Edit meeting slot' : 'New meeting slot'}</DialogTitle>
        <form onSubmit={submitForm}>
          <DialogContent dividers>
            {formError && <Alert severity="error" sx={{ mb: 2 }}>{formError}</Alert>}
            {editingId && editingSignupCount > 0 && (
              <Alert severity="info" sx={{ mb: 2 }}>
                {editingSignupCount} candidate(s) have signed up for this slot. Rescheduling it
                keeps their spot. They and the host member get an email with the new details.
              </Alert>
            )}
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
              {selectedHostProfile && !selectedHostProfile.complete && (
                <Alert severity="info">
                  {`${selectedHostProfile.fullName || 'This host'} hasn't finished their Get to Know UC profile (missing ${selectedHostProfile.missingFields.join(', ')}), so candidates won't see a profile on this slot.`}
                </Alert>
              )}
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
  slots, now, totalInScope, hostOptions, hostLabel,
  hostFilter, setHostFilter, statusFilter, setStatusFilter,
  search, setSearch, sort, onSort, onView, onEdit, onDelete,
  selectedIds, selectedCount, onToggleSelected, onSelectAll, onRemind, onRemindSelected, reminding
}) {
  const header = (field, label, props = {}) => (
    <SortableHeader field={field} sort={sort} onSort={onSort} {...props}>{label}</SortableHeader>
  );
  // The overdue view is where reminders are sent from, so it gains a
  // selection column and when each host was last reminded.
  const overdueView = statusFilter === 'overdue';
  const allSelected = overdueView && slots.length > 0 && selectedCount === slots.length;
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
        <FormControl size="small" sx={{ minWidth: 190 }}>
          <InputLabel>Status</InputLabel>
          <Select value={statusFilter} label="Status" onChange={(e) => setStatusFilter(e.target.value)}>
            <MenuItem value="all">All statuses</MenuItem>
            <MenuItem value="upcoming">Upcoming</MenuItem>
            <MenuItem value="active">Happening now</MenuItem>
            <MenuItem value="past">Past</MenuItem>
            <Divider />
            <MenuItem value="overdue">Attendance overdue</MenuItem>
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
        {overdueView && (
          <Button
            variant="contained"
            startIcon={<RemindIcon />}
            disabled={selectedCount === 0 || reminding}
            onClick={onRemindSelected}
          >
            {reminding ? 'Sending…' : `Remind hosts (${selectedCount})`}
          </Button>
        )}
      </Stack>
      <Divider />
      {slots.length === 0 ? (
        <Box sx={{ p: 6, textAlign: 'center', color: 'text.secondary' }}>
          {overdueView ? 'Every past slot in this view has its attendance marked.' : 'No meeting slots match these filters.'}
        </Box>
      ) : (
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table>
            <TableHead>
              <TableRow>
                {overdueView && (
                  <TableCell padding="checkbox">
                    <Checkbox
                      checked={allSelected}
                      indeterminate={selectedCount > 0 && !allSelected}
                      onChange={(e) => onSelectAll(e.target.checked)}
                      inputProps={{ 'aria-label': 'Select all overdue slots' }}
                    />
                  </TableCell>
                )}
                {header('host', 'Host')}
                {header('location', 'Location')}
                {header('start', 'Start')}
                {header('status', 'Status', { align: 'center' })}
                {header('signups', 'Signups', { align: 'center' })}
                {header('attendance', 'Attendance', { align: 'center' })}
                {overdueView && <TableCell>Last reminded</TableCell>}
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {slots.map((slot) => {
                const signups = slot.signups || [];
                const status = getSlotStatus(slot, now);
                const outstanding = isOutstanding(slot, now);
                return (
                  <TableRow key={slot.id} hover sx={{ cursor: 'pointer' }} onClick={() => onView(slot)}>
                    {overdueView && (
                      <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedIds.has(slot.id)}
                          onChange={(e) => onToggleSelected(slot.id, e.target.checked)}
                          inputProps={{ 'aria-label': `Select ${slot.member?.fullName || 'host'}'s slot` }}
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <MemberAvatar member={slot.member} size={28} />
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
                    <TableCell align="center">
                      <AttendanceCell slot={slot} now={now} />
                    </TableCell>
                    {overdueView && (
                      <TableCell>
                        <LastReminded slot={slot} now={now} />
                      </TableCell>
                    )}
                    <TableCell align="right" onClick={(e) => e.stopPropagation()} sx={{ whiteSpace: 'nowrap' }}>
                      {outstanding && (
                        <Tooltip title="Email the host to take attendance">
                          <span>
                            <IconButton size="small" aria-label="Remind host" disabled={reminding} onClick={() => onRemind([slot.id])}>
                              <RemindIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      )}
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

// "2/3 attended" once finished, "Not marked" while outstanding, a dash before.
function AttendanceCell({ slot, now }) {
  const state = attendanceState(slot, now);
  const signups = slot.signups || [];
  if (state === 'none') return <Typography variant="body2" color="text.disabled">—</Typography>;
  if (state === 'outstanding') {
    const unmarked = signups.filter((s) => !s.attended).length;
    return (
      <Tooltip title={`${unmarked} of ${signups.length} not checked, and the host has not pressed Attendance done`}>
        <Chip size="small" color="warning" label="Not marked" />
      </Tooltip>
    );
  }
  const attended = signups.filter((s) => s.attended).length;
  return <Typography variant="body2">{attended}/{signups.length} attended</Typography>;
}

function LastReminded({ slot, now }) {
  const sent = attendanceReminders(slot);
  if (sent.length === 0) return <Typography variant="body2" color="text.secondary">Never</Typography>;
  return (
    <Tooltip title={formatDateTime(sent[0].sentAt)}>
      <Typography variant="body2">
        {timeAgo(sent[0].sentAt, now)}{sent.length > 1 ? ` · ${sent.length}×` : ''}
      </Typography>
    </Tooltip>
  );
}

// ---- Member profiles tab -------------------------------------------------

// Candidate-facing GTKUC profiles: completeness at a glance plus the per-member
// hide switch. Hidden members' slots are not offered to candidates at all.
function MemberProfilesTab({ profiles, onToggleHidden }) {
  if (profiles.length === 0) {
    return <Box sx={{ p: 6, textAlign: 'center', color: 'text.secondary' }}>No member profiles yet.</Box>;
  }

  return (
    <TableContainer sx={{ overflowX: 'auto' }}>
      <Table>
        <TableHead>
          <TableRow>
            <TableCell>Member</TableCell>
            <TableCell>Industries</TableCell>
            <TableCell>Interests</TableCell>
            <TableCell>LinkedIn</TableCell>
            <TableCell align="center">Profile</TableCell>
            <TableCell align="center">Hidden from GTKUC</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {profiles.map((profile) => (
            <TableRow key={profile.id} hover>
              <TableCell>
                <Stack direction="row" spacing={1} alignItems="center">
                  <MemberAvatar member={profile} size={28} />
                  <Box>
                    <Typography variant="body2">{profile.fullName}</Typography>
                    <Typography variant="caption" color="text.secondary">{profile.email}</Typography>
                  </Box>
                </Stack>
              </TableCell>
              <TableCell>
                <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                  {profile.industries.map((industry) => (
                    <Chip key={industry} size="small" label={industry} variant="outlined" />
                  ))}
                </Stack>
              </TableCell>
              <TableCell>
                <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                  {profile.interests.map((interest) => (
                    <Chip key={interest} size="small" label={interest} variant="outlined" />
                  ))}
                </Stack>
              </TableCell>
              <TableCell>
                {profile.linkedinUrl ? (
                  <Link href={profile.linkedinUrl} target="_blank" rel="noopener noreferrer" underline="hover">
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <LinkedInIcon fontSize="small" />
                      <Typography variant="body2">Profile</Typography>
                    </Stack>
                  </Link>
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    Not linked
                  </Typography>
                )}
              </TableCell>
              <TableCell align="center">
                {profile.complete ? (
                  <Chip size="small" color="success" label="Complete" />
                ) : (
                  <Tooltip title={`Missing: ${profile.missingFields.join(', ')}`}>
                    <Chip size="small" color="warning" label="Incomplete" />
                  </Tooltip>
                )}
              </TableCell>
              <TableCell align="center">
                <Switch
                  checked={profile.hiddenFromGtkuc}
                  onChange={(e) => onToggleHidden(profile.id, e.target.checked)}
                  inputProps={{ 'aria-label': `Hide ${profile.fullName} from Get to Know UC` }}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

// ---- Attendance tab ------------------------------------------------------

function AttendanceTab({ rows, search, setSearch, filter, setFilter, sort, onSort, onToggle, onView }) {
  const header = (field, label, props = {}) => (
    <SortableHeader field={field} sort={sort} onSort={onSort} {...props}>{label}</SortableHeader>
  );
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
            <MenuItem value="unmarked">Not marked yet</MenuItem>
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
                {header('present', 'Present', { padding: 'checkbox' })}
                {header('candidate', 'Candidate')}
                {header('email', 'Email')}
                {header('studentId', 'Student ID')}
                {header('host', 'Host')}
                {header('slot', 'Slot')}
                {header('signedUp', 'Signed up')}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} hover>
                  <TableCell padding="checkbox">
                    <Checkbox
                      checked={!!r.attended}
                      onChange={(e) => onToggle(r.id, e.target.checked)}
                      inputProps={{ 'aria-label': `${r.fullName} attended` }}
                    />
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
                  <TableCell>{formatDateTime(r.createdAt)}</TableCell>
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

function SlotDetailDialog({
  slot, now, currentUserId, reminding, onRemind, onAttendanceDone,
  onClose, onToggleAttendance, onDeleteSignup, onEdit, onContact
}) {
  if (!slot) return null;
  const signups = slot.signups || [];
  const comms = slot.communications || [];
  const attended = signups.filter((s) => s.attended).length;
  const isYou = slot.member?.id === currentUserId;
  const outstanding = isOutstanding(slot, now);
  const reminders = attendanceReminders(slot);

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
                <MemberAvatar member={slot.member} size={40} />
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
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 3, mb: 1 }}>
          <Typography variant="subtitle1" fontWeight={600}>Signups ({signups.length})</Typography>
          {signups.length > 0 && (
            <Button size="small" variant="outlined" startIcon={<SmsIcon />} onClick={() => onContact(slot)}>
              iMessage / email signups
            </Button>
          )}
        </Stack>
        {canFinishAttendance(slot, now) && (
          <Alert
            severity={outstanding ? 'warning' : slot.attendanceMarkedAt ? 'success' : 'info'}
            sx={{ mb: 1.5 }}
            action={
              <Stack direction="row" spacing={1}>
                {outstanding && (
                  <Button color="inherit" size="small" startIcon={<RemindIcon />} disabled={reminding} onClick={() => onRemind(slot)}>
                    Remind host
                  </Button>
                )}
                {slot.attendanceMarkedAt ? (
                  <Button color="inherit" size="small" onClick={() => onAttendanceDone(slot, false)}>Reopen</Button>
                ) : (
                  <Button color="inherit" size="small" onClick={() => onAttendanceDone(slot, true)}>Attendance done</Button>
                )}
              </Stack>
            }
          >
            {slot.attendanceMarkedAt
              ? `Attendance finished ${formatDateTime(slot.attendanceMarkedAt)}. Anyone unchecked is a no-show.`
              : outstanding
                ? `Attendance not marked. ${reminders.length > 0 ? `Host last reminded ${timeAgo(reminders[0].sentAt, now)}.` : 'Host not reminded yet.'}`
                : attended === signups.length
                  ? 'Everyone is checked, so attendance is done.'
                  : 'Check who came, then press Attendance done.'}
          </Alert>
        )}
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
                      <Checkbox
                        checked={!!s.attended}
                        onChange={(e) => onToggleAttendance(s.id, e.target.checked)}
                        inputProps={{ 'aria-label': `${s.fullName} attended` }}
                      />
                    </TableCell>
                    <TableCell>{s.fullName}</TableCell>
                    <TableCell sx={{ overflowWrap: 'anywhere', wordBreak: 'break-word', maxWidth: 220 }}>{s.email}</TableCell>
                    <TableCell>{s.studentId || '—'}</TableCell>
                    <TableCell>{formatDateTime(s.createdAt)}</TableCell>
                    <TableCell align="right">
                      <Tooltip title="Remove signup">
                        <IconButton size="small" color="error" aria-label={`Remove ${s.fullName}`} onClick={() => onDeleteSignup(s)}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
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
