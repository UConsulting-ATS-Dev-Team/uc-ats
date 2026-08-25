import React, { useEffect, useMemo, useState } from 'react';
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
  Tooltip,
  IconButton
} from '@mui/material';
import { ArrowPathIcon, TrophyIcon, ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import { useAuth } from '../context/AuthContext';

const formatDate = (value) => {
  if (!value) return '—';
  return new Date(value).toLocaleString();
};

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
  const [expandedInterviews, setExpandedInterviews] = useState({});
  const [search, setSearch] = useState('');

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

  const fetchData = async () => {
    if (!selectedCycleId) return;
    setLoading(true);
    setError('');
    try {
      const result = await apiClient.get(`/admin/accountability?cycleId=${selectedCycleId}`);
      setData(result);
    } catch (e) {
      setError(e.message || 'Failed to load accountability data');
      setData(null);
    } finally {
      setLoading(false);
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

  const toggleInterviewExpand = (interviewId) => {
    setExpandedInterviews((prev) => ({ ...prev, [interviewId]: !prev[interviewId] }));
  };

  const openEventDialog = async (event) => {
    setEventDialog(event);
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

  const toggleInterviewAttendance = async (assignmentId, attended) => {
    try {
      await apiClient.post(`/admin/accountability/interview-assignments/${assignmentId}/attendance`, {
        attended
      });
      setMessage('Interview attendance updated');
      fetchData();
    } catch (e) {
      setError(e.message || 'Failed to update interview attendance');
    }
  };

  const leaderboard = useMemo(() => data?.leaderboard || [], [data]);
  const filteredLeaderboard = useMemo(() => {
    const term = search.toLowerCase();
    if (!term) return leaderboard;
    return leaderboard.filter(
      (m) =>
        m.fullName?.toLowerCase().includes(term) ||
        m.email?.toLowerCase().includes(term) ||
        m.studentId?.toLowerCase().includes(term)
    );
  }, [leaderboard, search]);

  const topThree = leaderboard.slice(0, 3);
  const bottomThree = leaderboard.slice(-3).reverse();

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
            <Stack direction="row" spacing={2} alignItems="center" mb={2}>
              <TrophyIcon style={{ width: '1.5rem', height: '1.5rem' }} />
              <Typography variant="h6">Leaderboard</Typography>
            </Stack>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} mb={2}>
              <TextField
                label="Search members"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                fullWidth
                placeholder="Name, email, or student ID"
              />
            </Stack>

            <Stack direction="row" spacing={1} mb={2} flexWrap="wrap">
              {topThree.map((m, i) => (
                <Chip key={m.id} color="success" variant="outlined" label={`#${i + 1} ${m.fullName} (${m.total})`} />
              ))}
              {bottomThree.map((m, i) => (
                <Chip key={`bottom-${m.id}`} color="error" variant="outlined" label={`Bottom ${i + 1} ${m.fullName} (${m.total})`} />
              ))}
            </Stack>

            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Rank</TableCell>
                    <TableCell>Member</TableCell>
                    <TableCell align="right">Events</TableCell>
                    <TableCell align="right">GTKUC</TableCell>
                    <TableCell align="right">Interviews</TableCell>
                    <TableCell align="right">Total</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filteredLeaderboard.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} align="center">
                        No members match your search.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredLeaderboard.map((member, index) => {
                      const rank = index + 1;
                      const isTop = rank <= 3 && filteredLeaderboard === leaderboard;
                      const isBottom = rank > leaderboard.length - 3 && filteredLeaderboard === leaderboard;
                      return (
                        <TableRow
                          key={member.id}
                          sx={{
                            backgroundColor: isTop
                              ? 'rgba(46, 125, 50, 0.08)'
                              : isBottom
                              ? 'rgba(211, 47, 47, 0.08)'
                              : 'inherit'
                          }}
                        >
                          <TableCell>{rank}</TableCell>
                          <TableCell>
                            <Typography fontWeight={500}>{member.fullName}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {member.email}
                            </Typography>
                          </TableCell>
                          <TableCell align="right">{member.eventCount}</TableCell>
                          <TableCell align="right">{member.gtkucCount}</TableCell>
                          <TableCell align="right">{member.interviewCount}</TableCell>
                          <TableCell align="right">
                            <Chip label={member.total} color={isTop ? 'success' : isBottom ? 'error' : 'default'} size="small" />
                          </TableCell>
                        </TableRow>
                      );
                    })
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
                      <TableCell align="right">Attendance</TableCell>
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
                          <TableCell align="right">{event.memberAttendanceCount}</TableCell>
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
                            <TableCell colSpan={6} sx={{ p: 0, borderBottom: 0 }}>
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

          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" gutterBottom>
              Interviews
            </Typography>
            {data.interviews.length === 0 ? (
              <Typography color="text.secondary">No interviews found for this cycle.</Typography>
            ) : (
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell />
                      <TableCell>Interview</TableCell>
                      <TableCell>Type</TableCell>
                      <TableCell>Date</TableCell>
                      <TableCell align="right">Attended</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.interviews.map((interview) => {
                      const attendedCount = interview.assignments.filter((a) => a.attended).length;
                      const totalCount = interview.assignments.length;
                      return (
                        <React.Fragment key={interview.id}>
                          <TableRow>
                            <TableCell>
                              <IconButton size="small" onClick={() => toggleInterviewExpand(interview.id)}>
                                {expandedInterviews[interview.id] ? (
                                  <ChevronUpIcon style={{ width: '1rem', height: '1rem' }} />
                                ) : (
                                  <ChevronDownIcon style={{ width: '1rem', height: '1rem' }} />
                                )}
                              </IconButton>
                            </TableCell>
                            <TableCell>{interview.title}</TableCell>
                            <TableCell>{interview.interviewType}</TableCell>
                            <TableCell>{formatDate(interview.startDate)}</TableCell>
                            <TableCell align="right">
                              <Chip
                                label={`${attendedCount}/${totalCount}`}
                                color={attendedCount === totalCount && totalCount > 0 ? 'success' : 'default'}
                                size="small"
                                variant="outlined"
                              />
                            </TableCell>
                          </TableRow>
                          {expandedInterviews[interview.id] && (
                            <TableRow>
                              <TableCell colSpan={5} sx={{ p: 0, borderBottom: 0 }}>
                                <Box p={2} bgcolor="action.hover">
                                  <Stack spacing={1}>
                                    {interview.assignments.map((assignment) => (
                                      <Stack
                                        key={assignment.id}
                                        direction="row"
                                        spacing={2}
                                        alignItems="center"
                                        justifyContent="space-between"
                                      >
                                        <Typography variant="body2">
                                          {assignment.user.fullName} ({assignment.role})
                                        </Typography>
                                        <Tooltip title="Toggle attendance">
                                          <Switch
                                            checked={assignment.attended}
                                            onChange={(e) => toggleInterviewAttendance(assignment.id, e.target.checked)}
                                            inputProps={{ 'aria-label': `${assignment.user.fullName} attended` }}
                                          />
                                        </Tooltip>
                                      </Stack>
                                    ))}
                                  </Stack>
                                </Box>
                              </TableCell>
                            </TableRow>
                          )}
                        </React.Fragment>
                      );
                    })}
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
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Member</TableCell>
                    <TableCell>Student ID</TableCell>
                    <TableCell align="right">Attended</TableCell>
                    <TableCell>Source</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {eventMembers.map((member) => (
                    <TableRow key={member.id}>
                      <TableCell>
                        <Typography fontWeight={500}>{member.fullName}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {member.email}
                        </Typography>
                      </TableCell>
                      <TableCell>{member.studentId || '—'}</TableCell>
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
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeEventDialog}>Close</Button>
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
