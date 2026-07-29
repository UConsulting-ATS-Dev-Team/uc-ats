import React, { useEffect, useState } from 'react';
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
  Tooltip
} from '@mui/material';
import {
  Add as AddIcon,
  Schedule as ScheduleIcon,
  LocationOn as LocationIcon,
  People as PeopleIcon,
  CheckCircle as CheckCircleIcon,
  Cancel as CancelIcon,
  Edit as EditIcon,
  OpenInNew as OpenInNewIcon,
  Visibility as VisibilityIcon,
  Event as EventIcon,
  Delete as DeleteIcon,
  Refresh as RefreshIcon
} from '@mui/icons-material';

export default function MemberMeetingSlots() {
  const { token } = useAuth();
  const [slots, setSlots] = useState([]);
  const [allSlots, setAllSlots] = useState([]); // Store all slots for filtering
  const [activeCycle, setActiveCycle] = useState(null);
  const [form, setForm] = useState({ location: '', startTime: '', endTime: '', capacity: 2 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [syncWarning, setSyncWarning] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [dateError, setDateError] = useState('');
  const [editingSlot, setEditingSlot] = useState(null);
  const [editForm, setEditForm] = useState({ location: '', startTime: '', endTime: '', capacity: 2 });
  const [editDateError, setEditDateError] = useState('');

  useEffect(() => {
    api.setToken(token);
  }, [token]);

  const loadActiveCycle = async () => {
    try {
      // Use public endpoint so it works for all users (members and admins)
      const active = await api.get('/active-cycle');
      setActiveCycle(active || null);
      return active || null;
    } catch (e) {
      console.error('Failed to load active cycle:', e);
      return null;
    }
  };

  const filterSlotsByCycle = (slotsToFilter, cycle) => {
    // If no active cycle, return empty array to only show slots from current cycle
    if (!cycle) return [];

    // Filter slots by creation date - include slots created up to 1 month before cycle starts
    if (cycle.startDate) {
      const cycleStartDate = new Date(cycle.startDate);
      cycleStartDate.setHours(0, 0, 0, 0);
      // Allow slots created up to 1 month before the cycle starts
      cycleStartDate.setMonth(cycleStartDate.getMonth() - 1);

      return slotsToFilter.filter(slot => {
        const slotCreatedAt = new Date(slot.createdAt);
        return slotCreatedAt >= cycleStartDate;
      });
    }

    // If no start date on cycle, return all slots (fallback)
    return slotsToFilter;
  };

  const load = async () => {
    try {
      setLoading(true);
      setError('');
      const data = await api.get('/member/meeting-slots');
      setAllSlots(data);
      
      // Load active cycle and filter slots
      const cycle = await loadActiveCycle();
      const filtered = filterSlotsByCycle(data, cycle);
      setSlots(filtered);
    } catch (e) {
      setError(e.message || 'Failed to load meeting slots');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    
    // Listen for cycle activation events and reset when a new cycle is activated
    const handleCycleActivated = async () => {
      // Clear slots since they're tied to the previous cycle
      setSlots([]);
      setForm({ location: '', startTime: '', endTime: '', capacity: 2 });
      setEditingSlot(null);
      setEditForm({ location: '', startTime: '', endTime: '', capacity: 2 });
      setError('');
      setDateError('');
      setEditDateError('');
      
      // Reload active cycle and filter existing slots
      const cycle = await loadActiveCycle();
      const filtered = filterSlotsByCycle(allSlots, cycle);
      setSlots(filtered);
      
      // Also reload from server to get any new slots
      await load();
    };
    
    window.addEventListener('cycleActivated', handleCycleActivated);
    
    return () => {
      window.removeEventListener('cycleActivated', handleCycleActivated);
    };
  }, []);

  const validateDate = (dateString) => {
    if (!dateString) return null;
    
    const date = new Date(dateString);
    const year = date.getFullYear();
    
    // Check if year is within reasonable bounds (1900-2100)
    if (year < 1900 || year > 2100) {
      return 'Year must be between 1900 and 2100';
    }
    
    // Check if the date is valid
    if (isNaN(date.getTime())) {
      return 'Invalid date format';
    }
    
    // Check if date is not too far in the past
    const now = new Date();
    const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    if (date < oneYearAgo) {
      return 'Date cannot be more than 1 year in the past';
    }
    
    return null;
  };

  const handleDateChange = (field, value) => {
    const error = validateDate(value);
    setDateError(error || '');
    
    if (field === 'startTime' && value) {
      // When start time changes, automatically set end time to 30 minutes later
      const startDate = new Date(value);
      const endDate = new Date(startDate.getTime() + 30 * 60 * 1000); // Add 30 minutes
      
      // Format the end date for datetime-local input
      const formatForInput = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${year}-${month}-${day}T${hours}:${minutes}`;
      };
      
      const endTimeFormatted = formatForInput(endDate);
      setForm({ ...form, [field]: value, endTime: endTimeFormatted });
    } else {
      setForm({ ...form, [field]: value });
    }
  };

  const onCreate = async (e) => {
    e.preventDefault();
    
    // Validate dates before submitting
    const startTimeError = validateDate(form.startTime);
    const endTimeError = validateDate(form.endTime);
    
    if (startTimeError || endTimeError) {
      setDateError(startTimeError || endTimeError);
      return;
    }
    
    // Check if end time is after start time
    if (form.endTime && form.startTime && new Date(form.endTime) <= new Date(form.startTime)) {
      setDateError('End time must be after start time');
      return;
    }
    
    try {
      setSubmitting(true);
      setError('');
      setSyncWarning('');
      setDateError('');


      const response = await api.post('/member/meeting-slots', form);

      if (response?.calendarSync?.warning) {
        setSyncWarning(response.calendarSync.warning);
      }

      setForm({ location: '', startTime: '', endTime: '', capacity: 2 });
      await load();
    } catch (e) {
      setError(e.message || 'Failed to create meeting slot');
    } finally {
      setSubmitting(false);
    }
  };

  const setAttendance = async (signupId, attended) => {
    try {
      await api.patch(`/member/meeting-signups/${signupId}/attendance`, { attended });
      await load();
    } catch (e) {
      setError(e.message || 'Failed to update attendance');
    }
  };

  const deleteSignup = async (signupId, candidateName) => {
    if (!window.confirm(`Are you sure you want to remove ${candidateName} from this timeslot? This will send them a cancellation email.`)) {
      return;
    }

    try {
      setSubmitting(true);
      setError('');
      await api.delete(`/member/meeting-signups/${signupId}`);
      await load();
    } catch (e) {
      setError(e.message || 'Failed to remove candidate from timeslot');
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (slot) => {
    setEditingSlot(slot);
    // Convert UTC time back to datetime-local format for editing
    const startDate = new Date(slot.startTime);
    const endDate = slot.endTime ? new Date(slot.endTime) : null;
    
    
    // Format for datetime-local input - convert from UTC to LA time
    const formatForInput = (date) => {
      // Convert UTC to LA time string, then parse components
      const laTimeStr = date.toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });

      // Parse the formatted string: "MM/DD/YYYY, HH:MM"
      const [datePart, timePart] = laTimeStr.split(', ');
      const [month, day, year] = datePart.split('/');
      const [hours, minutes] = timePart.split(':');

      const formatted = `${year}-${month}-${day}T${hours}:${minutes}`;
      return formatted;
    };
    
    const startTimeFormatted = formatForInput(startDate);
    const endTimeFormatted = endDate ? formatForInput(endDate) : '';
    
    setEditForm({
      location: slot.location,
      startTime: startTimeFormatted,
      endTime: endTimeFormatted,
      capacity: slot.capacity
    });
    setEditDateError('');
  };

  const cancelEdit = () => {
    setEditingSlot(null);
    setEditForm({ location: '', startTime: '', endTime: '', capacity: 2 });
    setEditDateError('');
  };

  const onUpdate = async (e) => {
    e.preventDefault();
    
    // Validate dates before submitting
    const startTimeError = validateDate(editForm.startTime);
    const endTimeError = validateDate(editForm.endTime);
    
    if (startTimeError || endTimeError) {
      setEditDateError(startTimeError || endTimeError);
      return;
    }
    
    // Check if end time is after start time
    if (editForm.endTime && editForm.startTime && new Date(editForm.endTime) <= new Date(editForm.startTime)) {
      setEditDateError('End time must be after start time');
      return;
    }
    
    try {
      setSubmitting(true);
      setError('');
      setSyncWarning('');
      setEditDateError('');


      const response = await api.put(`/member/meeting-slots/${editingSlot.id}`, editForm);
      if (response?.calendarSync?.warning) {
        setSyncWarning(response.calendarSync.warning);
      }
      setEditingSlot(null);
      setEditForm({ location: '', startTime: '', endTime: '', capacity: 2 });
      await load();
    } catch (e) {
      setError(e.message || 'Failed to update meeting slot');
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async (slotId) => {
    // Find the slot to check if it has signups
    const slot = slots.find(s => s.id === slotId);
    const hasSignups = slot && slot.signups.length > 0;

    const confirmMessage = hasSignups
      ? `Are you sure you want to delete this meeting slot? This will cancel the meeting for ${slot.signups.length} signup(s) and send them cancellation emails. This action cannot be undone.`
      : 'Are you sure you want to delete this meeting slot? This action cannot be undone.';

    if (!window.confirm(confirmMessage)) {
      return;
    }

    try {
      setSubmitting(true);
      setError('');
      setSyncWarning('');
      await api.delete(`/member/meeting-slots/${slotId}`);
      await load();
    } catch (e) {
      setError(e.message || 'Failed to delete meeting slot');
      await load();
    } finally {
      setSubmitting(false);
    }
  };

  const onRetryCalendar = async (slotId) => {
    try {
      setSubmitting(true);
      setError('');
      setSyncWarning('');
      const response = await api.post(`/member/meeting-slots/${slotId}/retry-calendar`);
      if (response?.calendarSync?.warning) {
        setSyncWarning(response.calendarSync.warning);
      }
      await load();
    } catch (e) {
      setError(e.message || 'Failed to retry calendar sync');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddToCalendar = (slot) => {
    try {
      // Use stored UTC timestamps directly and let Google Calendar handle conversion
      const utcStartDate = new Date(slot.startTime);
      const utcEndDate = slot.endTime ? new Date(slot.endTime) : new Date(utcStartDate.getTime() + 30 * 60 * 1000);

      // Format for Google Calendar (UTC, no manual offsets)
      const formatDateForGoogle = (date) => date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

      const startTime = formatDateForGoogle(utcStartDate);
      const endTime = formatDateForGoogle(utcEndDate);

      const eventTitle = 'Get to Know UC - Meeting Slot';

      // For human-readable text, format in Los Angeles tz (handles PST/PDT automatically)
      const timeString = utcStartDate.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/Los_Angeles'
      });
      const dateString = utcStartDate.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'America/Los_Angeles'
      });

      const eventDescription = `Get to Know UC Meeting Slot\n\nMeeting Details:\nDate: ${dateString}\nTime: ${timeString} PT\nLocation: ${slot.location}\n\nThis is your scheduled meeting slot for "Get to Know UC" where you'll meet with potential candidates.`;
      const eventLocation = slot.location;

      const googleCalendarUrl = new URL('https://calendar.google.com/calendar/render');
      googleCalendarUrl.searchParams.set('action', 'TEMPLATE');
      googleCalendarUrl.searchParams.set('text', eventTitle);
      googleCalendarUrl.searchParams.set('dates', `${startTime}/${endTime}`);
      googleCalendarUrl.searchParams.set('details', eventDescription);
      googleCalendarUrl.searchParams.set('location', eventLocation);
      googleCalendarUrl.searchParams.set('sf', 'true');
      googleCalendarUrl.searchParams.set('output', 'xml');
      // Ensure Calendar UI opens with the intended timezone
      googleCalendarUrl.searchParams.set('ctz', 'America/Los_Angeles');

      window.open(googleCalendarUrl.toString(), '_blank');
    } catch (error) {
      console.error('Error adding to calendar:', error);
      alert('Failed to open calendar. Please try again.');
    }
  };

  const formatDateTime = (dateTime) => {
    const date = new Date(dateTime);
    return date.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/Los_Angeles'
    });
  };

  const getSlotStatus = (slot) => {
    const now = new Date();
    // Compare times in UTC (no conversion needed)
    const startTime = new Date(slot.startTime);
    const endTime = slot.endTime ? new Date(slot.endTime) : new Date(startTime.getTime() + 60 * 60 * 1000); // Default 1 hour

    if (now < startTime) return 'upcoming';
    if (now >= startTime && now <= endTime) return 'active';
    return 'completed';
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'upcoming': return 'primary';
      case 'active': return 'success';
      case 'completed': return 'default';
      default: return 'default';
    }
  };


  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <Box sx={{ maxWidth: 1200, mx: 'auto', p: 0 }}>
      {/* Header */}
      <Box sx={{ mb: 4 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
          <Box>
            <Typography variant="h3" component="h1" sx={{ fontWeight: 700, color: 'primary.dark' }}>
              Get to Know UC
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
              Manage your meeting slots and track attendance for 1:2 meetings with potential candidates.
            </Typography>
          </Box>
          <Button
            variant="outlined"
            startIcon={<VisibilityIcon />}
            endIcon={<OpenInNewIcon />}
            onClick={() => window.open('/meet', '_blank')}
            sx={{ 
              minWidth: 200,
              borderColor: 'primary.main',
              color: 'primary.main',
              '&:hover': {
                borderColor: 'primary.dark',
                backgroundColor: 'primary.50'
              }
            }}
          >
            View Public Page
          </Button>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {syncWarning && (
        <Alert severity="warning" sx={{ mb: 3 }} onClose={() => setSyncWarning('')}>
          {syncWarning}
        </Alert>
      )}

      {/* Create New Slot Form */}
      <Paper sx={{ p: 3, mb: 4 }}>
        <Typography variant="h5" component="h2" sx={{ fontWeight: 600, mb: 3, color: 'primary.dark' }}>
          Create New Meeting Slot
        </Typography>
        
        <Box component="form" onSubmit={onCreate}>
          <Grid container spacing={3}>
            <Grid item xs={12} md={3}>
              <TextField
                fullWidth
                label="Location"
                placeholder="e.g., Kerckhoff 152"
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                required
                InputProps={{
                  startAdornment: <LocationIcon sx={{ color: 'text.secondary', mr: 1 }} />
                }}
              />
            </Grid>
            <Grid item xs={12} md={3}>
              <TextField
                fullWidth
                label="Start Time"
                type="datetime-local"
                value={form.startTime}
                onChange={(e) => handleDateChange('startTime', e.target.value)}
                required
                error={!!dateError}
                helperText={dateError}
                inputProps={{
                  min: new Date().toISOString().slice(0, 16), // Prevent past dates
                  max: new Date(new Date().getFullYear() + 1, 11, 31).toISOString().slice(0, 16) // Max 1 year in future
                }}
                InputProps={{
                  startAdornment: <ScheduleIcon sx={{ color: 'text.secondary', mr: 1 }} />
                }}
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
            <Grid item xs={12} md={3}>
              <TextField
                fullWidth
                label="End Time (Optional)"
                type="datetime-local"
                value={form.endTime}
                onChange={(e) => handleDateChange('endTime', e.target.value)}
                inputProps={{
                  min: form.startTime || new Date().toISOString().slice(0, 16),
                  max: new Date(new Date().getFullYear() + 1, 11, 31).toISOString().slice(0, 16)
                }}
                InputProps={{
                  startAdornment: <ScheduleIcon sx={{ color: 'text.secondary', mr: 1 }} />
                }}
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
            <Grid item xs={12} md={2}>
              <TextField
                fullWidth
                label="Capacity"
                type="number"
                min={1}
                max={10}
                value={form.capacity}
                onChange={(e) => {
                  const value = e.target.value;
                  // Allow empty string during editing, but default to 2 when form is reset
                  if (value === '') {
                    setForm({ ...form, capacity: '' });
                  } else {
                    const numValue = parseInt(value, 10);
                    if (!isNaN(numValue) && numValue >= 1 && numValue <= 10) {
                      setForm({ ...form, capacity: numValue });
                    }
                  }
                }}
                onBlur={(e) => {
                  // Ensure we have a valid number when field loses focus
                  const value = e.target.value;
                  if (value === '' || isNaN(parseInt(value, 10))) {
                    setForm({ ...form, capacity: 2 });
                  }
                }}
                InputProps={{
                  startAdornment: <PeopleIcon sx={{ color: 'text.secondary', mr: 1 }} />
                }}
              />
            </Grid>
            <Grid item xs={12} md={1}>
              <Button
                type="submit"
                variant="contained"
                fullWidth
                disabled={submitting || !!dateError || !form.location || !form.startTime || !form.capacity || form.capacity < 1 || form.capacity > 10}
                startIcon={<AddIcon />}
                sx={{ height: '56px' }}
              >
                {submitting ? 'Creating...' : 'Create'}
              </Button>
            </Grid>
          </Grid>
        </Box>
      </Paper>

      {/* Edit Meeting Slot Form */}
      {editingSlot && (
        <Paper sx={{ p: 3, mb: 4, border: '2px solid', borderColor: 'primary.main' }}>
          <Typography variant="h5" component="h2" sx={{ fontWeight: 600, mb: 3, color: 'primary.dark' }}>
            Edit Meeting Slot
          </Typography>
          
          <Box component="form" onSubmit={onUpdate}>
            <Grid container spacing={3}>
              <Grid item xs={12} md={3}>
                <TextField
                  fullWidth
                  label="Location"
                  placeholder="e.g., Kerckhoff 152"
                  value={editForm.location}
                  onChange={(e) => setEditForm({ ...editForm, location: e.target.value })}
                  required
                  InputProps={{
                    startAdornment: <LocationIcon sx={{ color: 'text.secondary', mr: 1 }} />
                  }}
                />
              </Grid>
              <Grid item xs={12} md={3}>
                <TextField
                  fullWidth
                  label="Start Time"
                  type="datetime-local"
                  value={editForm.startTime}
                  onChange={(e) => {
                    const error = validateDate(e.target.value);
                    setEditDateError(error || '');
                    
                    if (e.target.value) {
                      // When start time changes, automatically set end time to 30 minutes later
                      const startDate = new Date(e.target.value);
                      const endDate = new Date(startDate.getTime() + 30 * 60 * 1000); // Add 30 minutes
                      
                      // Format the end date for datetime-local input
                      const formatForInput = (date) => {
                        const year = date.getFullYear();
                        const month = String(date.getMonth() + 1).padStart(2, '0');
                        const day = String(date.getDate()).padStart(2, '0');
                        const hours = String(date.getHours()).padStart(2, '0');
                        const minutes = String(date.getMinutes()).padStart(2, '0');
                        return `${year}-${month}-${day}T${hours}:${minutes}`;
                      };
                      
                      const endTimeFormatted = formatForInput(endDate);
                      setEditForm({ ...editForm, startTime: e.target.value, endTime: endTimeFormatted });
                    } else {
                      setEditForm({ ...editForm, startTime: e.target.value });
                    }
                  }}
                  required
                  error={!!editDateError}
                  helperText={editDateError}
                  inputProps={{
                    min: new Date().toISOString().slice(0, 16),
                    max: new Date(new Date().getFullYear() + 1, 11, 31).toISOString().slice(0, 16)
                  }}
                  InputProps={{
                    startAdornment: <ScheduleIcon sx={{ color: 'text.secondary', mr: 1 }} />
                  }}
                  InputLabelProps={{ shrink: true }}
                />
              </Grid>
              <Grid item xs={12} md={3}>
                <TextField
                  fullWidth
                  label="End Time (Optional)"
                  type="datetime-local"
                  value={editForm.endTime}
                  onChange={(e) => {
                    const error = validateDate(e.target.value);
                    setEditDateError(error || '');
                    setEditForm({ ...editForm, endTime: e.target.value });
                  }}
                  inputProps={{
                    min: editForm.startTime || new Date().toISOString().slice(0, 16),
                    max: new Date(new Date().getFullYear() + 1, 11, 31).toISOString().slice(0, 16)
                  }}
                  InputProps={{
                    startAdornment: <ScheduleIcon sx={{ color: 'text.secondary', mr: 1 }} />
                  }}
                  InputLabelProps={{ shrink: true }}
                />
              </Grid>
              <Grid item xs={12} md={2}>
                <TextField
                  fullWidth
                  label="Capacity"
                  type="number"
                  min={1}
                  max={10}
                  value={editForm.capacity}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value === '') {
                      setEditForm({ ...editForm, capacity: '' });
                    } else {
                      const numValue = parseInt(value, 10);
                      if (!isNaN(numValue) && numValue >= 1 && numValue <= 10) {
                        setEditForm({ ...editForm, capacity: numValue });
                      }
                    }
                  }}
                  onBlur={(e) => {
                    const value = e.target.value;
                    if (value === '' || isNaN(parseInt(value, 10))) {
                      setEditForm({ ...editForm, capacity: 2 });
                    }
                  }}
                  InputProps={{
                    startAdornment: <PeopleIcon sx={{ color: 'text.secondary', mr: 1 }} />
                  }}
                />
              </Grid>
              <Grid item xs={12} md={1}>
                <Stack spacing={1}>
                  <Button
                    type="submit"
                    variant="contained"
                    fullWidth
                    disabled={submitting || !!editDateError || !editForm.location || !editForm.startTime || !editForm.capacity || editForm.capacity < 1 || editForm.capacity > 10}
                    startIcon={<EditIcon />}
                    sx={{ height: '28px' }}
                  >
                    {submitting ? 'Updating...' : 'Update'}
                  </Button>
                  <Button
                    type="button"
                    variant="outlined"
                    fullWidth
                    onClick={cancelEdit}
                    disabled={submitting}
                    sx={{ height: '28px' }}
                  >
                    Cancel
                  </Button>
                </Stack>
              </Grid>
            </Grid>
          </Box>
        </Paper>
      )}

      {/* Meeting Slots List */}
      <Paper sx={{ p: 3 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
          <Typography variant="h5" component="h2" sx={{ fontWeight: 600, color: 'primary.dark' }}>
            Your Meeting Slots
          </Typography>
          <Chip
            label={`${slots.length} Total`}
            color="primary"
            variant="outlined"
          />
        </Box>

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
            <CircularProgress />
          </Box>
        ) : slots.length === 0 ? (
          <Box sx={{ textAlign: 'center', p: 4 }}>
            <ScheduleIcon sx={{ fontSize: 60, color: 'grey.400', mb: 2 }} />
            <Typography variant="h6" color="text.secondary" sx={{ mb: 1 }}>
              No Meeting Slots Yet
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Create your first meeting slot to start connecting with potential candidates.
            </Typography>
          </Box>
        ) : (
          <Stack spacing={3}>
            {slots.map((slot) => {
              const status = getSlotStatus(slot);
              const attendedCount = slot.signups.filter(s => s.attended).length;
              
              return (
                <Card key={slot.id} variant="outlined">
                  <CardContent>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
                      <Box>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
                          <Typography variant="h6" sx={{ fontWeight: 600 }}>
                            {formatDateTime(slot.startTime)}
                          </Typography>
                          <Chip
                            label={status.charAt(0).toUpperCase() + status.slice(1)}
                            color={getStatusColor(status)}
                            size="small"
                          />
                          {slot.calendarSyncStatus && slot.calendarSyncStatus !== 'SYNCED' && slot.calendarSyncStatus !== 'NOT_CONFIGURED' && (
                            <Chip
                              label={slot.calendarSyncStatus === 'CANCEL_PENDING' ? 'Cancel Pending' : 'Calendar Sync Failed'}
                              color="warning"
                              size="small"
                            />
                          )}
                        </Box>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                          <LocationIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                          <Typography variant="body2" color="text.secondary">
                            {slot.location}
                          </Typography>
                        </Box>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <PeopleIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                          <Typography variant="body2" color="text.secondary">
                            {slot.signups.length} / {slot.capacity} signed up
                            {attendedCount > 0 && ` • ${attendedCount} attended`}
                          </Typography>
                        </Box>
                      </Box>
                      <Box sx={{ display: 'flex', gap: 1 }}>
                        {slot.calendarSyncStatus && slot.calendarSyncStatus !== 'SYNCED' && (
                          <Tooltip title="Retry calendar sync">
                            <IconButton
                              size="small"
                              onClick={() => onRetryCalendar(slot.id)}
                              disabled={submitting}
                            >
                              <RefreshIcon />
                            </IconButton>
                          </Tooltip>
                        )}
                        <Tooltip title="Add to Google Calendar">
                          <IconButton
                            size="small"
                            onClick={() => handleAddToCalendar(slot)}
                            sx={{ color: 'primary.main' }}
                          >
                            <EventIcon />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Edit slot">
                          <IconButton 
                            size="small"
                            onClick={() => startEdit(slot)}
                            disabled={editingSlot !== null}
                          >
                            <EditIcon />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title={slot.signups.length > 0 ? "Delete slot (will send cancellation emails)" : "Delete slot"}>
                          <IconButton 
                            size="small"
                            onClick={() => onDelete(slot.id)}
                            disabled={editingSlot !== null}
                            sx={{ color: 'error.main' }}
                          >
                            <CancelIcon />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    </Box>

                    {slot.signups.length > 0 && (
                      <>
                        <Divider sx={{ my: 2 }} />
                        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 2 }}>
                          Signups ({slot.signups.length})
                        </Typography>
                        <TableContainer className="responsive-table">
                          <Table size="small">
                            <TableHead>
                              <TableRow>
                                <TableCell>Name</TableCell>
                                <TableCell>Email</TableCell>
                                <TableCell>Student ID</TableCell>
                                <TableCell align="center">Attended</TableCell>
                                <TableCell align="center">Actions</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {slot.signups.map((signup) => (
                                <TableRow key={signup.id}>
                                  <TableCell data-label="Name">
                                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                                      {signup.fullName}
                                    </Typography>
                                  </TableCell>
                                  <TableCell data-label="Email">
                                    <Typography variant="body2" color="text.secondary">
                                      {signup.email}
                                    </Typography>
                                  </TableCell>
                                  <TableCell data-label="Student ID">
                                    <Typography variant="body2" color="text.secondary">
                                      {signup.studentId || '-'}
                                    </Typography>
                                  </TableCell>
                                  <TableCell data-label="Attended" align="center">
                                    <Checkbox
                                      checked={signup.attended}
                                      onChange={(e) => setAttendance(signup.id, e.target.checked)}
                                      color="success"
                                    />
                                  </TableCell>
                                  <TableCell data-label="Actions" align="center">
                                    <Tooltip title="Remove candidate from this timeslot">
                                      <IconButton
                                        size="small"
                                        onClick={() => deleteSignup(signup.id, signup.fullName)}
                                        disabled={submitting}
                                        sx={{ color: 'error.main' }}
                                      >
                                        <DeleteIcon fontSize="small" />
                                      </IconButton>
                                    </Tooltip>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </TableContainer>
                      </>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </Stack>
        )}
      </Paper>
    </Box>
    </AccessControl>
  );
}


