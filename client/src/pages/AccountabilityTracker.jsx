import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
  Alert,
  IconButton
} from '@mui/material';
import { ArrowPathIcon, TrophyIcon, ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import { useAuth } from '../context/AuthContext';

const formatDate = (value) => {
  if (!value) return '—';
  return new Date(value).toLocaleString();
};

const formatPoints = (value) => String(Number(value));

export default function AccountabilityTracker() {
  const { user } = useAuth();
  const [cycles, setCycles] = useState([]);
  const [selectedCycleId, setSelectedCycleId] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [syncLoading, setSyncLoading] = useState({});
  const [eventDialog, setEventDialog] = useState(null);
  const [eventMembers, setEventMembers] = useState([]);
  const [eventMembersLoading, setEventMembersLoading] = useState(false);
  const [expandedEvents, setExpandedEvents] = useState({});
  const [search, setSearch] = useState('');
  const [rsvpOnly, setRsvpOnly] = useState(true);
  const [underTargetOnly, setUnderTargetOnly] = useState(false);
  const [pointsDraft, setPointsDraft] = useState(null);
  const [savingPoints, setSavingPoints] = useState(false);
  const [reminder, setReminder] = useState(null);
  const [sendingReminders, setSendingReminders] = useState(false);

  const fetchCycles = async () => {
    try {
      const list = await apiClient.get('/admin/cycles');
      setCycles(list);
      const active = list.find((c) => c.isActive);
      if (active) {
        setSelectedCycleId(active.id);
      } else if (list.length > 0) {
        setSelectedCycleId(list[0].id);
      }
    } catch (e) {
      setError(e.message || 'Failed to load cycles');
    }
  };

  // Only the latest request may write, so a slow response for the cycle an
  // admin just switched away from cannot replace the one they switched to.
  const latestRequest = useRef(0);
  const fetchData = async () => {
    if (!selectedCycleId) return;
    const request = ++latestRequest.current;
    setLoading(true);
    setError('');
    try {
      const result = await apiClient.get(`/admin/accountability?cycleId=${selectedCycleId}`);
      if (request === latestRequest.current) setData(result);
    } catch (e) {
      if (request !== latestRequest.current) return;
      setError(e.message || 'Failed to load accountability data');
      setData(null);
    } finally {
      if (request === latestRequest.current) setLoading(false);
    }
  };

  useEffect(() => {
    fetchCycles();
  }, []);

  useEffect(() => {
    fetchData();
  }, [selectedCycleId]);

  const toggleEventExpand = (eventId) => {
    setExpandedEvents((prev) => ({ ...prev, [eventId]: !prev[eventId] }));
  };

  const openEventDialog = async (event) => {
    setEventDialog(event);
    // Start from the RSVP list when there is one; walk-ins are one switch away.
    setRsvpOnly(event.memberRsvpCount > 0);
    setEventMembersLoading(true);
    try {
      const result = await apiClient.get(`/admin/accountability/events/${event.id}/members`);
      setEventMembers(result.members);
    } catch (e) {
      setError(e.message || 'Failed to load event member attendance');
    } finally {
      setEventMembersLoading(false);
    }
  };

  const closeEventDialog = () => {
    setEventDialog(null);
    setEventMembers([]);
  };

  const toggleMemberAttendance = async (memberId, attended) => {
    if (!eventDialog) return;
    try {
      await apiClient.post(`/admin/accountability/events/${eventDialog.id}/member-attendance`, {
        memberId,
        attended
      });
      setEventMembers((prev) =>
        prev.map((m) => (m.id === memberId ? { ...m, attended, source: attended ? 'MANUAL' : null } : m))
      );
      setMessage('Member attendance updated');
      fetchData();
    } catch (e) {
      setError(e.message || 'Failed to update member attendance');
    }
  };

  const syncEventAttendance = async (eventId) => {
    setSyncLoading((prev) => ({ ...prev, [eventId]: true }));
    setError('');
    setMessage('');
    try {
      const result = await apiClient.post(`/admin/accountability/events/${eventId}/sync-attendance`);
      setMessage(result.message || 'Member attendance synced');
      await fetchData();
    } catch (e) {
      setError(e.message || 'Failed to sync member attendance');
    } finally {
      setSyncLoading((prev) => ({ ...prev, [eventId]: false }));
    }
  };

  const openPointsDialog = () => {
    setPointsDraft({
      targetPoints: String(data.config.targetPoints),
      points: Object.fromEntries(data.config.types.map((t) => [t.key, String(t.points)]))
    });
  };

  const savePoints = async () => {
    setSavingPoints(true);
    setError('');
    try {
      await apiClient.put('/admin/accountability/config', {
        targetPoints: pointsDraft.targetPoints,
        points: pointsDraft.points
      });
      setPointsDraft(null);
      setMessage('Point values saved');
      await fetchData();
    } catch (e) {
      setError(e.message || 'Failed to save point values');
    } finally {
      setSavingPoints(false);
    }
  };

  const setEventPointType = async (eventId, pointType) => {
    try {
      await apiClient.put(`/admin/accountability/events/${eventId}/point-type`, { pointType: pointType || null });
      await fetchData();
    } catch (e) {
      setError(e.message || 'Failed to update event point type');
    }
  };

  // `members` is who the dialog is about: everyone under target, or one person.
  // The cycle is the one they were scored in, not whatever is selected at Send.
  const openReminder = (members) => {
    setReminder({
      cycleId: data.cycle.id,
      members,
      subject: data.reminderDefaults.subject,
      message: data.reminderDefaults.message
    });
  };

  const sendReminders = async () => {
    setSendingReminders(true);
    setError('');
    setMessage('');
    try {
      const result = await apiClient.post(`/admin/accountability/reminders?cycleId=${reminder.cycleId}`, {
        memberIds: reminder.members.map((m) => m.id),
        subject: reminder.subject,
        message: reminder.message
      });
      setReminder(null);
      const parts = [`Sent ${result.sent} reminder${result.sent === 1 ? '' : 's'}`];
      if (result.skipped) parts.push(`${result.skipped} skipped (already at target)`);
      if (result.failed.length) {
        setError(`Failed to send to ${result.failed.map((f) => f.email).join(', ')}`);
      }
      setMessage(parts.join(' · '));
    } catch (e) {
      setError(e.message || 'Failed to send reminders');
    } finally {
      setSendingReminders(false);
    }
  };

  const leaderboard = useMemo(() => data?.leaderboard || [], [data]);
  const underTarget = useMemo(() => leaderboard.filter((m) => !m.met), [leaderboard]);
  const filteredLeaderboard = useMemo(() => {
    const term = search.toLowerCase();
    return leaderboard.filter(
      (m) =>
        (!underTargetOnly || !m.met) &&
        (!term ||
          m.fullName?.toLowerCase().includes(term) ||
          m.email?.toLowerCase().includes(term) ||
          m.studentId?.toLowerCase().includes(term))
    );
  }, [leaderboard, search, underTargetOnly]);
  const pointTypeLabel = useMemo(
    () => Object.fromEntries((data?.config.types || []).map((t) => [t.key, t.label])),
    [data]
  );

  // RSVP'd members first, so the check-in list reads top-down at the door.
  const dialogMembers = useMemo(() => {
    const list = rsvpOnly ? eventMembers.filter((m) => m.rsvpd) : eventMembers;
    return [...list].sort((a, b) => Number(b.rsvpd) - Number(a.rsvpd));
  }, [eventMembers, rsvpOnly]);
  const rsvpdMembers = eventMembers.filter((m) => m.rsvpd);
  const rsvpdAttended = rsvpdMembers.filter((m) => m.attended).length;
  const walkIns = eventMembers.filter((m) => m.attended && !m.rsvpd).length;

  if (!user || user.role !== 'ADMIN') {
    return (
      <Box p={3}>
        <Alert severity="warning">You must be an admin to view this page.</Alert>
      </Box>
    );
  }

  return (
    <Box p={3}>
      <Typography variant="h4" gutterBottom>
        Member Accountability Tracker
      </Typography>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="center" mb={3}>
        <FormControl fullWidth sx={{ maxWidth: 400 }}>
          <InputLabel id="cycle-select-label">Recruiting Cycle</InputLabel>
          <Select
            labelId="cycle-select-label"
            value={selectedCycleId}
            label="Recruiting Cycle"
            onChange={(e) => setSelectedCycleId(e.target.value)}
          >
            {cycles.map((cycle) => (
              <MenuItem key={cycle.id} value={cycle.id}>
                {cycle.name} {cycle.isActive && '(Active)'}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <Button
          variant="outlined"
          onClick={fetchData}
          startIcon={<ArrowPathIcon style={{ width: '1rem', height: '1rem' }} />}
          disabled={loading}
        >
          Refresh
        </Button>
      </Stack>

      {data?.cycle && (
        <Typography variant="subtitle1" color="text.secondary" mb={2}>
          Showing data for <strong>{data.cycle.name}</strong>
        </Typography>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {message && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setMessage('')}>
          {message}
        </Alert>
      )}

      {loading && (
        <Box display="flex" justifyContent="center" my={4}>
          <CircularProgress />
        </Box>
      )}

      {data && !loading && (
        <Stack spacing={4}>
          <Paper sx={{ p: 2 }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} mb={2}>
              <Stack direction="row" spacing={2} alignItems="center" flexGrow={1}>
                <TrophyIcon style={{ width: '1.5rem', height: '1.5rem' }} />
                <Typography variant="h6">Points</Typography>
                <Typography variant="body2" color="text.secondary">
                  {leaderboard.length - underTarget.length} of {leaderboard.length} members have {formatPoints(data.config.targetPoints)} points
                </Typography>
              </Stack>
              <Button variant="outlined" onClick={openPointsDialog}>
                Edit point values
              </Button>
              <Button variant="contained" disabled={underTarget.length === 0} onClick={() => openReminder(underTarget)}>
                Remind {underTarget.length} under target
              </Button>
            </Stack>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} mb={2}>
              <TextField
                label="Search members"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                fullWidth
                placeholder="Name, email, or student ID"
              />
              <Stack direction="row" alignItems="center" spacing={1} sx={{ whiteSpace: 'nowrap' }}>
                <Switch
                  size="small"
                  checked={underTargetOnly}
                  onChange={(e) => setUnderTargetOnly(e.target.checked)}
                  inputProps={{ 'aria-label': 'Show members under target only' }}
                />
                <Typography variant="body2">Under target only</Typography>
              </Stack>
            </Stack>

            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Rank</TableCell>
                    <TableCell>Member</TableCell>
                    <TableCell>Done</TableCell>
                    <TableCell align="right">Points</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filteredLeaderboard.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} align="center">
                        No members match.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredLeaderboard.map((member) => (
                      <TableRow
                        key={member.id}
                        sx={{ backgroundColor: member.met ? 'rgba(46, 125, 50, 0.08)' : 'inherit' }}
                      >
                        <TableCell>{leaderboard.indexOf(member) + 1}</TableCell>
                        <TableCell>
                          <Typography fontWeight={500}>{member.fullName}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {member.email}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                            {member.types.filter((t) => t.done).map((t) => (
                              <Chip key={t.key} label={t.label} size="small" variant="outlined" />
                            ))}
                          </Stack>
                        </TableCell>
                        <TableCell align="right">
                          <Chip
                            label={`${formatPoints(member.points)} / ${formatPoints(member.targetPoints)}`}
                            color={member.met ? 'success' : 'default'}
                            size="small"
                          />
                        </TableCell>
                        <TableCell align="right">
                          {!member.met && (
                            <Button size="small" onClick={() => openReminder([member])}>
                              Remind
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>

          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" gutterBottom>
              Events
            </Typography>
            {data.events.length === 0 ? (
              <Typography color="text.secondary">No events found for this cycle.</Typography>
            ) : (
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell />
                      <TableCell>Event</TableCell>
                      <TableCell>Date</TableCell>
                      <TableCell align="right">RSVPs</TableCell>
                      <TableCell align="right">Attendance</TableCell>
                      {/* Staging.css makes every MUI table `table-layout: fixed`, where only a header width sizes a column. */}
                      <TableCell sx={{ width: 212 }}>Counts as</TableCell>
                      <TableCell>Form</TableCell>
                      <TableCell align="right">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.events.map((event) => (
                      <React.Fragment key={event.id}>
                        <TableRow>
                          <TableCell>
                            <IconButton size="small" onClick={() => toggleEventExpand(event.id)}>
                              {expandedEvents[event.id] ? (
                                <ChevronUpIcon style={{ width: '1rem', height: '1rem' }} />
                              ) : (
                                <ChevronDownIcon style={{ width: '1rem', height: '1rem' }} />
                              )}
                            </IconButton>
                          </TableCell>
                          <TableCell>{event.eventName}</TableCell>
                          <TableCell>{formatDate(event.eventStartDate)}</TableCell>
                          <TableCell align="right">{event.memberRsvpCount ?? 0}</TableCell>
                          <TableCell align="right">{event.memberAttendanceCount}</TableCell>
                          <TableCell>
                            <Select
                              size="small"
                              sx={{ width: 180 }}
                              value={event.pointType || ''}
                              displayEmpty
                              onChange={(e) => setEventPointType(event.id, e.target.value)}
                              inputProps={{ 'aria-label': `Point type for ${event.eventName}` }}
                            >
                              <MenuItem value="">
                                <em>No points</em>
                              </MenuItem>
                              {data.config.eventPointTypes.map((key) => (
                                <MenuItem key={key} value={key}>
                                  {pointTypeLabel[key]}
                                </MenuItem>
                              ))}
                            </Select>
                          </TableCell>
                          <TableCell>
                            {event.memberAttendanceForm ? (
                              <Button size="small" variant="text" onClick={() => window.open(event.memberAttendanceForm, '_blank')}>
                                View Form
                              </Button>
                            ) : (
                              <Chip label="No form" size="small" variant="outlined" />
                            )}
                          </TableCell>
                          <TableCell align="right">
                            <Stack direction="row" spacing={1} justifyContent="flex-end">
                              <Button
                                size="small"
                                variant="outlined"
                                disabled={syncLoading[event.id] || !event.memberAttendanceForm}
                                onClick={() => syncEventAttendance(event.id)}
                              >
                                {syncLoading[event.id] ? <CircularProgress size={16} /> : 'Sync'}
                              </Button>
                              <Button size="small" variant="outlined" onClick={() => openEventDialog(event)}>
                                Manage
                              </Button>
                            </Stack>
                          </TableCell>
                        </TableRow>
                        {expandedEvents[event.id] && (
                          <TableRow>
                            <TableCell colSpan={8} sx={{ p: 0, borderBottom: 0 }}>
                              <Box p={2} bgcolor="action.hover">
                                <Typography variant="subtitle2" gutterBottom>
                                  Quick check-in
                                </Typography>
                                <QuickCheckIn
                                  eventId={event.id}
                                  onUpdate={fetchData}
                                  onError={setError}
                                  onMessage={setMessage}
                                />
                              </Box>
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>

        </Stack>
      )}

      <Dialog open={Boolean(eventDialog)} onClose={closeEventDialog} fullWidth maxWidth="md">
        <DialogTitle>{eventDialog?.eventName} — Member Check-in</DialogTitle>
        <DialogContent>
          {eventMembersLoading ? (
            <Box display="flex" justifyContent="center" py={4}>
              <CircularProgress />
            </Box>
          ) : (
            <>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} justifyContent="space-between" mb={1}>
              <Typography variant="body2" color="text.secondary">
                {rsvpdMembers.length > 0
                  ? `Attended ${rsvpdAttended} of ${rsvpdMembers.length} RSVP'd`
                  : 'No member RSVPs for this event'}
                {walkIns > 0 && ` · ${walkIns} without an RSVP`}
              </Typography>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Switch
                  size="small"
                  checked={rsvpOnly}
                  onChange={(e) => setRsvpOnly(e.target.checked)}
                  inputProps={{ 'aria-label': "Show RSVP'd members only" }}
                />
                <Typography variant="body2">RSVP'd only</Typography>
              </Stack>
            </Stack>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Member</TableCell>
                    <TableCell>Student ID</TableCell>
                    <TableCell>RSVP</TableCell>
                    <TableCell align="right">Attended</TableCell>
                    <TableCell>Source</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {dialogMembers.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} align="center">
                        No RSVP'd members. Turn off "RSVP'd only" to mark a walk-in.
                      </TableCell>
                    </TableRow>
                  )}
                  {dialogMembers.map((member) => (
                    <TableRow key={member.id}>
                      <TableCell>
                        <Typography fontWeight={500}>{member.fullName}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {member.email}
                        </Typography>
                      </TableCell>
                      <TableCell>{member.studentId || '—'}</TableCell>
                      <TableCell>
                        {member.rsvpd ? (
                          <Chip
                            label={{ IN_APP: 'App', LUMA: 'Luma', GOOGLE_FORM: 'Form' }[member.rsvpSource] || 'Yes'}
                            size="small"
                            color="primary"
                            variant="outlined"
                          />
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell align="right">
                        <Switch
                          checked={member.attended}
                          onChange={(e) => toggleMemberAttendance(member.id, e.target.checked)}
                        />
                      </TableCell>
                      <TableCell>
                        {member.attended ? (
                          <Chip label={member.source || 'MANUAL'} size="small" variant="outlined" />
                        ) : (
                          '—'
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeEventDialog}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(pointsDraft)} onClose={() => setPointsDraft(null)} fullWidth maxWidth="xs">
        <DialogTitle>Point values</DialogTitle>
        {pointsDraft && (
          <DialogContent>
            <Typography variant="body2" color="text.secondary" mb={2}>
              Each type counts once per member per cycle. Changes apply to everyone's totals straight away.
            </Typography>
            <Stack spacing={2}>
              <TextField
                label="Points needed"
                type="number"
                size="small"
                value={pointsDraft.targetPoints}
                onChange={(e) => setPointsDraft((d) => ({ ...d, targetPoints: e.target.value }))}
                inputProps={{ min: 0.01, step: 0.5 }}
              />
              {data.config.types.map((type) => (
                <TextField
                  key={type.key}
                  label={type.label}
                  type="number"
                  size="small"
                  value={pointsDraft.points[type.key]}
                  onChange={(e) =>
                    setPointsDraft((d) => ({ ...d, points: { ...d.points, [type.key]: e.target.value } }))
                  }
                  helperText={type.points !== type.defaultPoints ? `Default ${formatPoints(type.defaultPoints)}` : undefined}
                  inputProps={{ min: 0, step: 0.5 }}
                />
              ))}
            </Stack>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setPointsDraft(null)}>Cancel</Button>
          <Button variant="contained" onClick={savePoints} disabled={savingPoints}>
            {savingPoints ? <CircularProgress size={16} /> : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(reminder)} onClose={() => !sendingReminders && setReminder(null)} fullWidth maxWidth="sm">
        <DialogTitle>
          {reminder?.members.length === 1
            ? `Remind ${reminder.members[0].fullName}`
            : `Remind ${reminder?.members.length} members under target`}
        </DialogTitle>
        {reminder && (
          <DialogContent>
            <Typography variant="body2" color="text.secondary" mb={2}>
              Each person gets their own email with this message, their points, and a checklist of what they
              have done and what's still open. Anyone who reaches the target before you send is skipped.
            </Typography>
            <Stack spacing={2}>
              <TextField
                label="Subject"
                size="small"
                value={reminder.subject}
                onChange={(e) => setReminder((r) => ({ ...r, subject: e.target.value }))}
              />
              <TextField
                label="Message"
                multiline
                minRows={4}
                value={reminder.message}
                onChange={(e) => setReminder((r) => ({ ...r, message: e.target.value }))}
                helperText={`Markdown works. Merge fields: ${data.reminderDefaults.mergeFields.map((f) => `{{${f}}}`).join(' ')}`}
              />
            </Stack>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setReminder(null)} disabled={sendingReminders}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={sendReminders}
            disabled={sendingReminders || !reminder?.subject.trim() || !reminder?.message.trim()}
          >
            {sendingReminders ? <CircularProgress size={16} /> : `Send ${reminder?.members.length ?? ''}`}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

function QuickCheckIn({ eventId, onUpdate, onError, onMessage }) {
  const [query, setQuery] = useState('');
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState({});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!query.trim()) {
        setMembers([]);
        return;
      }
      setLoading(true);
      try {
        const result = await apiClient.get(`/admin/accountability/events/${eventId}/members`);
        const term = query.toLowerCase();
        const filtered = result.members.filter(
          (m) =>
            m.fullName?.toLowerCase().includes(term) ||
            m.email?.toLowerCase().includes(term) ||
            m.studentId?.toLowerCase().includes(term)
        );
        if (!cancelled) {
          setMembers(filtered.slice(0, 5));
          setChecked(Object.fromEntries(filtered.slice(0, 5).map((m) => [m.id, m.attended])));
        }
      } catch (e) {
        if (!cancelled) onError(e.message || 'Failed to load members');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    const timeout = setTimeout(load, 250);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [query, eventId]);

  const save = async (memberId, attended) => {
    try {
      await apiClient.post(`/admin/accountability/events/${eventId}/member-attendance`, { memberId, attended });
      onUpdate();
      onMessage('Attendance updated');
    } catch (e) {
      onError(e.message || 'Failed to update attendance');
    }
  };

  return (
    <Stack spacing={1}>
      <TextField
        label="Quick check-in by name, email, or student ID"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        fullWidth
        size="small"
      />
      {loading && <CircularProgress size={20} />}
      {members.map((member) => (
        <Stack key={member.id} direction="row" spacing={2} alignItems="center" justifyContent="space-between">
          <Typography variant="body2">
            {member.fullName} ({member.email})
          </Typography>
          <Switch
            checked={checked[member.id] ?? member.attended}
            onChange={(e) => {
              const value = e.target.checked;
              setChecked((prev) => ({ ...prev, [member.id]: value }));
              save(member.id, value);
            }}
          />
        </Stack>
      ))}
    </Stack>
  );
}
