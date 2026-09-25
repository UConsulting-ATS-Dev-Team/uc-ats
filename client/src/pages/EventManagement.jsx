import React, { useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  TextField,
  Typography,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  MenuItem,
  IconButton,
  Chip,
  CircularProgress,
  Alert,
  Tooltip,
  Switch,
  FormControlLabel,
  Checkbox,
} from '@mui/material';
import { TrashIcon, PencilIcon } from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import LumaGuestsPanel, { relativeAge, staleSync } from '../components/LumaGuestsPanel';
import LumaSyncSetupDialog from '../components/LumaSyncSetupDialog';
import { useAuth } from '../context/AuthContext';
import { formatInLA, localInputToUTC } from '../../../server/src/utils/timezoneUtils';

export default function EventManagement() {
  const [events, setEvents] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [eventStats, setEventStats] = useState({}); // Store RSVP/attendance counts
  const [loading, setLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState({});
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [editLoading, setEditLoading] = useState(false);
  const [form, setForm] = useState({
    eventName: '',
    eventStartDate: '',
    eventEndDate: '',
    eventLocation: '',
    rsvpForm: '',
    attendanceForm: '',
    showToCandidates: false,
    memberRsvpUrl: '',
    memberAttendanceForm: '',
    lumaUrl: '',
    cycleId: ''
  });
  const [editForm, setEditForm] = useState({
    eventName: '',
    eventStartDate: '',
    eventEndDate: '',
    eventLocation: '',
    rsvpForm: '',
    attendanceForm: '',
    showToCandidates: false,
    memberRsvpUrl: '',
    memberRsvpEnabled: true,
    memberAttendanceForm: '',
    lumaUrl: '',
    cycleId: ''
  });

  // Cycle-portable event copy state
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyPreviewLoading, setCopyPreviewLoading] = useState(false);
  const [copyCommitLoading, setCopyCommitLoading] = useState(false);
  const [copySourceCycleId, setCopySourceCycleId] = useState('');
  const [copyTargetCycleId, setCopyTargetCycleId] = useState('');
  const [copyPreview, setCopyPreview] = useState(null);
  const [copyEvents, setCopyEvents] = useState([]);
  const [copyForce, setCopyForce] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [copySuccess, setCopySuccess] = useState('');

  // Which event's Luma guest panel is open. Null when none is.
  const [lumaPanelEvent, setLumaPanelEvent] = useState(null);

  // The token-and-prompt dialog that sets the hourly sync up.
  const [syncSetupOpen, setSyncSetupOpen] = useState(false);

  // Whether the Google Form sync sends its own RSVP/attendance confirmations.
  // Null until it has been read, so the switch does not flicker through "off".
  const [signupEmails, setSignupEmails] = useState(null);
  const [signupEmailsSaving, setSignupEmailsSaving] = useState(false);

  const { user } = useAuth();

  // The signed-in admin's own RSVP per event (eventId -> source), read from the
  // same endpoint members use, so an admin RSVPs exactly as a member does.
  const [myRsvps, setMyRsvps] = useState({});
  const [myRsvpSaving, setMyRsvpSaving] = useState(null);
  // Latest count refresh per event. Toggling twice quickly starts two refreshes,
  // and only the newer one may write, or a stale count can land last.
  const statsRequestSeq = useRef({});

  const fetchMyRsvps = async () => {
    try {
      const mine = await apiClient.get('/member/events');
      setMyRsvps(Object.fromEntries(
        mine.filter((e) => e.hasMemberRsvpd).map((e) => [e.id, e.memberRsvpSource])
      ));
    } catch (e) {
      console.warn('Failed to load your RSVPs:', e);
    }
  };

  // Only an RSVP made here can be cancelled here; one from Luma or a form has
  // to change where it was made (the server answers 409 RSVP_EXTERNAL).
  const toggleMyRsvp = async (event) => {
    const going = myRsvps[event.id] === 'IN_APP';
    setMyRsvpSaving(event.id);
    setError('');
    try {
      const path = `/member/events/${event.id}/rsvp`;
      const status = going ? await apiClient.delete(path) : await apiClient.put(path, {});
      setMyRsvps((prev) => {
        const next = { ...prev };
        if (status.hasMemberRsvpd) next[event.id] = status.memberRsvpSource;
        else delete next[event.id];
        return next;
      });
      // The RSVP is saved by now. A failed count refresh must not read as a
      // failed save, or a retry would undo what just worked.
      const seq = (statsRequestSeq.current[event.id] || 0) + 1;
      statsRequestSeq.current[event.id] = seq;
      apiClient.get(`/admin/events/${event.id}/stats`)
        .then((stats) => {
          if (statsRequestSeq.current[event.id] !== seq) return;
          setEventStats((prev) => ({ ...prev, [event.id]: stats.stats }));
        })
        .catch((statsError) => console.warn('Failed to refresh RSVP count:', statsError));
    } catch (e) {
      setError(e.code === 'EVENT_STARTED'
        ? 'That event has already started, so RSVPs are closed.'
        : (e.serverMessage || 'Failed to save your RSVP'));
    } finally {
      setMyRsvpSaving(null);
    }
  };

  const myRsvpLabel = (event) => {
    if (myRsvpSaving === event.id) return 'Saving…';
    switch (myRsvps[event.id]) {
      case 'IN_APP': return 'Going ✓ · Cancel';
      case 'LUMA': return "RSVP'd via Luma";
      case 'GOOGLE_FORM': return "RSVP'd via form";
      default: return 'RSVP';
    }
  };

  function formatForDateTimeLocal(date, timeZone) {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return '';

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const parts = Object.fromEntries(
      formatter.formatToParts(d).map((p) => [p.type, p.value])
    );

    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  }


  const fetchSignupEmailSetting = async () => {
    try {
      const setting = await apiClient.get('/admin/event-email-settings');
      setSignupEmails(setting.sendSignupConfirmations);
    } catch (e) {
      // A setting that cannot be read is not worth blocking the page for; the
      // switch stays hidden rather than showing a state it does not know.
      console.error('Failed to load event email settings', e);
    }
  };

  const toggleSignupEmails = async (enabled) => {
    try {
      setSignupEmailsSaving(true);
      setError('');
      const saved = await apiClient.patch('/admin/event-email-settings', {
        sendSignupConfirmations: enabled,
      });
      setSignupEmails(saved.sendSignupConfirmations);
      setSuccessMessage(
        saved.sendSignupConfirmations
          ? 'Form sign-ups will now get an ATS confirmation email again.'
          : 'ATS confirmation emails for form sign-ups are off. Luma sends its own.'
      );
    } catch (e) {
      setError(e.message || 'Failed to save the email setting');
    } finally {
      setSignupEmailsSaving(false);
    }
  };

  const fetchEvents = async () => {
    try {
      setLoading(true);
      const data = await apiClient.get('/admin/events');
      setEvents(data);
      fetchMyRsvps();

      // Fetch stats for each event
      const stats = {};
      for (const event of data) {
        try {
          const eventStats = await apiClient.get(`/admin/events/${event.id}/stats`);
          stats[event.id] = eventStats.stats;
        } catch (e) {
          console.warn(`Failed to fetch stats for event ${event.id}:`, e);
          stats[event.id] = { rsvpCount: 0, attendanceCount: 0, memberRsvpCount: 0, memberAttendanceCount: 0, hasRsvpForm: false, hasAttendanceForm: false, hasMemberRsvpForm: false, hasMemberAttendanceForm: false };
        }
      }
      setEventStats(stats);
    } catch (e) {
      setError(e.message || 'Failed to load events');
    } finally {
      setLoading(false);
    }
  };

  const fetchCycles = async () => {
    try {
      const data = await apiClient.get('/admin/cycles');
      setCycles(data);
    } catch (e) {
      console.error('Failed to fetch cycles:', e);
    }
  };

  const openCopyDialog = () => {
    setCopyOpen(true);
    setCopySourceCycleId('');
    setCopyTargetCycleId('');
    setCopyPreview(null);
    setCopyEvents([]);
    setCopyForce(false);
    setCopyError('');
    setCopySuccess('');
  };

  const closeCopyDialog = () => {
    setCopyOpen(false);
    setCopySourceCycleId('');
    setCopyTargetCycleId('');
    setCopyPreview(null);
    setCopyEvents([]);
    setCopyForce(false);
    setCopyError('');
    setCopySuccess('');
  };

  const loadCopyPreview = async () => {
    try {
      setCopyPreviewLoading(true);
      setCopyError('');
      setCopySuccess('');

      if (!copySourceCycleId || !copyTargetCycleId) {
        setCopyError('Please select both a source and target cycle');
        return;
      }

      const data = await apiClient.post('/admin/events/copy-preview', {
        sourceCycleId: copySourceCycleId,
        targetCycleId: copyTargetCycleId,
      });

      // Convert preview dates to datetime-local values for inline editing
      const events = data.events.map((evt) => ({
        ...evt,
        selected: true,
        eventStartDate: evt.eventStartDate ? formatForDateTimeLocal(evt.eventStartDate, 'America/Los_Angeles') : '',
        eventEndDate: evt.eventEndDate ? formatForDateTimeLocal(evt.eventEndDate, 'America/Los_Angeles') : '',
      }));

      setCopyPreview(data);
      setCopyEvents(events);
    } catch (e) {
      setCopyError(e.message || 'Failed to load copy preview');
    } finally {
      setCopyPreviewLoading(false);
    }
  };

  const updateCopyEvent = (index, field, value) => {
    setCopyEvents((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const toggleAllCopyEvents = (checked) => {
    setCopyEvents((prev) => prev.map((evt) => ({ ...evt, selected: checked })));
  };

  const toggleCopyEvent = (index, checked) => {
    setCopyEvents((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], selected: checked };
      return updated;
    });
  };

  const validateCopyEvents = () => {
    const errors = [];
    const selected = copyEvents.filter((evt) => evt.selected);
    if (selected.length === 0) {
      errors.push('Select at least one event to copy');
    }
    for (let i = 0; i < copyEvents.length; i++) {
      const evt = copyEvents[i];
      if (!evt.selected) continue;
      if (!evt.sourceEventId) {
        errors.push(`Row ${i + 1}: Source event reference is missing`);
      }
      if (!evt.eventName || !evt.eventName.trim()) {
        errors.push(`Row ${i + 1}: Event name is required`);
      }
      if (!evt.eventStartDate) {
        errors.push(`Row ${i + 1}: Start date is required`);
      }
      if (!evt.eventEndDate) {
        errors.push(`Row ${i + 1}: End date is required`);
      }
      const startUTC = evt.eventStartDate ? localInputToUTC(evt.eventStartDate) : null;
      const endUTC = evt.eventEndDate ? localInputToUTC(evt.eventEndDate) : null;
      if (startUTC && endUTC && startUTC >= endUTC) {
        errors.push(`Row ${i + 1}: End date must be after start date`);
      }
      const urlFields = ['rsvpForm', 'attendanceForm', 'memberRsvpUrl', 'memberAttendanceForm'];
      for (const field of urlFields) {
        if (evt[field] && !isValidCopyUrl(evt[field])) {
          errors.push(`Row ${i + 1}: ${field} must be a valid URL`);
        }
      }
    }
    return errors;
  };

  const isValidCopyUrl = (value) => {
    if (!value) return true;
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  };

  const commitCopy = async () => {
    try {
      setCopyCommitLoading(true);
      setCopyError('');
      setCopySuccess('');

      const validationErrors = validateCopyEvents();
      if (validationErrors.length > 0) {
        setCopyError(validationErrors.join('. '));
        return;
      }

      const eventsToCommit = copyEvents
        .filter((evt) => evt.selected)
        .map((evt) => ({
          ...evt,
          eventStartDate: localInputToUTC(evt.eventStartDate).toISOString(),
          eventEndDate: localInputToUTC(evt.eventEndDate).toISOString(),
        }));

      const result = await apiClient.post('/admin/events/copy-commit', {
        sourceCycleId: copySourceCycleId,
        targetCycleId: copyTargetCycleId,
        events: eventsToCommit,
        force: copyForce,
      });

      let message = `Copied ${result.copiedCount} event(s) to ${result.targetCycle.name}`;
      if (result.skippedCount > 0) {
        message += ` (${result.skippedCount} skipped as duplicates)`;
      }
      setCopySuccess(message);

      // Refresh the event list if the target cycle is currently active
      await fetchEvents();
    } catch (e) {
      setCopyError(e.message || 'Failed to copy events');
    } finally {
      setCopyCommitLoading(false);
    }
  };

  const createEvent = async () => {
    try {
      setError('');
      
      // Validate required fields
      if (!form.eventName || !form.eventStartDate || !form.eventEndDate || !form.cycleId) {
        setError('Please fill in all required fields');
        return;
      }

      await apiClient.post('/admin/events', {
        ...form,
        eventStartDate: new Date(form.eventStartDate).toISOString(),
        eventEndDate: new Date(form.eventEndDate).toISOString(),
      });
      
      setCreateOpen(false);
      setForm({
        eventName: '',
        eventStartDate: '',
        eventEndDate: '',
        eventLocation: '',
        rsvpForm: '',
        attendanceForm: '',
        showToCandidates: false,
        memberRsvpUrl: '',
        memberAttendanceForm: '',
        lumaUrl: '',
        cycleId: ''
      });
      
      await fetchEvents();
    } catch (e) {
      setError(e.message || 'Failed to create event');
    }
  };

  const deleteEvent = async (id) => {
    if (window.confirm('Are you sure you want to delete this event?')) {
      try {
        await apiClient.delete(`/admin/events/${id}`);
        await fetchEvents();
      } catch (e) {
        setError(e.message || 'Failed to delete event');
      }
    }
  };

  const openEditDialog = (event) => {
    console.log("HELLO")
    console.dir(event)
    console.log(new Date(event.eventStartDate).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }).slice(0, 16))
    setSelectedEvent(event);
    setEditForm({
      eventName: event.eventName,
      eventStartDate: formatForDateTimeLocal(event.eventStartDate, "America/Los_Angeles"), // Format for datetime-local input
      eventEndDate: formatForDateTimeLocal(event.eventEndDate, "America/Los_Angeles"), // Format for datetime-local input
      eventLocation: event.eventLocation || '',
      rsvpForm: event.rsvpForm || '',
      attendanceForm: event.attendanceForm || '',
      showToCandidates: event.showToCandidates,
      memberRsvpUrl: event.memberRsvpUrl || '',
      memberRsvpEnabled: event.memberRsvpEnabled !== false,
      memberAttendanceForm: event.memberAttendanceForm || '',
      lumaUrl: event.lumaUrl || '',
      cycleId: event.cycleId
    });
    setEditOpen(true);
  };

  const updateEvent = async () => {
    try {
      setEditLoading(true);
      setError('');
      
      // Validate required fields
      if (!editForm.eventName || !editForm.eventStartDate || !editForm.eventEndDate || !editForm.cycleId) {
        setError('Please fill in all required fields');
        return;
      }

      await apiClient.patch(`/admin/events/${selectedEvent.id}`, {
        ...editForm,
        eventStartDate: new Date(editForm.eventStartDate).toISOString(),
        eventEndDate: new Date(editForm.eventEndDate).toISOString(),
      });
      
      setEditOpen(false);
      setSelectedEvent(null);
      await fetchEvents();
      setSuccessMessage('Event updated successfully!');
    } catch (e) {
      setError(e.message || 'Failed to update event');
    } finally {
      setEditLoading(false);
    }
  };


  const syncEventRSVP = async (eventId) => {
    try {
      setSyncLoading(prev => ({ ...prev, [`${eventId}-rsvp`]: true }));
      setError('');
      setSuccessMessage('');
      
      const result = await apiClient.post(`/admin/events/${eventId}/sync-rsvp`);
      setSuccessMessage(`RSVP sync completed: ${result.result.processed} responses processed, ${result.result.errors} errors`);
      
      // Refresh event stats
      await fetchEvents();
    } catch (e) {
      setError(e.message || 'Failed to sync RSVP responses');
    } finally {
      setSyncLoading(prev => ({ ...prev, [`${eventId}-rsvp`]: false }));
    }
  };

  const syncEventAttendance = async (eventId) => {
    try {
      setSyncLoading(prev => ({ ...prev, [`${eventId}-attendance`]: true }));
      setError('');
      setSuccessMessage('');
      
      const result = await apiClient.post(`/admin/events/${eventId}/sync-attendance`);
      setSuccessMessage(`Attendance sync completed: ${result.result.processed} responses processed, ${result.result.errors} errors`);
      
      // Refresh event stats
      await fetchEvents();
    } catch (e) {
      setError(e.message || 'Failed to sync attendance responses');
    } finally {
      setSyncLoading(prev => ({ ...prev, [`${eventId}-attendance`]: false }));
    }
  };

  const syncMemberRSVP = async (eventId) => {
    try {
      setSyncLoading(prev => ({ ...prev, [`${eventId}-member-rsvp`]: true }));
      setError('');
      setSuccessMessage('');
      
      const result = await apiClient.post(`/admin/events/${eventId}/sync-member-rsvp`);
      setSuccessMessage(`Member RSVP sync completed: ${result.result.processed} responses processed, ${result.result.errors} errors`);
      
      // Refresh event stats
      await fetchEvents();
    } catch (e) {
      setError(e.message || 'Failed to sync member RSVP responses');
    } finally {
      setSyncLoading(prev => ({ ...prev, [`${eventId}-member-rsvp`]: false }));
    }
  };

  const syncMemberAttendance = async (eventId) => {
    try {
      setSyncLoading(prev => ({ ...prev, [`${eventId}-member-attendance`]: true }));
      setError('');
      setSuccessMessage('');
      
      const result = await apiClient.post(`/admin/events/${eventId}/sync-member-attendance`);
      setSuccessMessage(`Member attendance sync completed: ${result.result.processed} responses processed, ${result.result.errors} errors`);
      
      // Refresh event stats
      await fetchEvents();
    } catch (e) {
      setError(e.message || 'Failed to sync member attendance responses');
    } finally {
      setSyncLoading(prev => ({ ...prev, [`${eventId}-member-attendance`]: false }));
    }
  };

  const syncAllEvents = async () => {
    try {
      setSyncLoading(prev => ({ ...prev, 'all': true }));
      setError('');
      setSuccessMessage('');
      
      const result = await apiClient.post('/admin/events/sync-all');
      let totalProcessed = 0;
      let totalErrors = 0;
      
      result.results.forEach(eventResult => {
        if (eventResult.rsvp) {
          totalProcessed += eventResult.rsvp.processed;
          totalErrors += eventResult.rsvp.errors;
        }
        if (eventResult.attendance) {
          totalProcessed += eventResult.attendance.processed;
          totalErrors += eventResult.attendance.errors;
        }
        if (eventResult.memberRsvp) {
          totalProcessed += eventResult.memberRsvp.processed;
          totalErrors += eventResult.memberRsvp.errors;
        }
        if (eventResult.memberAttendance) {
          totalProcessed += eventResult.memberAttendance.processed;
          totalErrors += eventResult.memberAttendance.errors;
        }
      });
      
      setSuccessMessage(`All events synced: ${totalProcessed} responses processed, ${totalErrors} errors`);
      
      // Refresh event stats
      await fetchEvents();
    } catch (e) {
      setError(e.message || 'Failed to sync all event forms');
    } finally {
      setSyncLoading(prev => ({ ...prev, 'all': false }));
    }
  };

  useEffect(() => {
    fetchEvents();
    fetchCycles();
    fetchSignupEmailSetting();
    
    // Listen for cycle activation events and refresh when a new cycle is activated
    const handleCycleActivated = () => {
      setError('');
      setSuccessMessage('Cycle activated. Showing events for the new active cycle.');
      
      // Refetch cycles to get updated active cycle info
      fetchCycles();
      
      // Refetch events to show events from the new active cycle (if any exist)
      fetchEvents();
    };
    
    window.addEventListener('cycleActivated', handleCycleActivated);
    
    return () => {
      window.removeEventListener('cycleActivated', handleCycleActivated);
    };
  }, []);

  const formatDateTime = (dateTimeString) => {
    return new Date(dateTimeString).toLocaleString();
  };

  const getCycleName = (cycleId) => {
    const cycle = cycles.find(c => c.id === cycleId);
    return cycle ? cycle.name : 'Unknown Cycle';
  };

  // Get the active cycle
  const activeCycle = cycles.find(c => c.isActive);
  
  // Filter events to only show those from the active cycle
  const filteredEvents = activeCycle 
    ? events.filter(event => event.cycleId === activeCycle.id)
    : [];

  const handleAddToCalendar = (event) => {
    try {
      // Format dates for Google Calendar
      const startDate = new Date(event.eventStartDate);
      const endDate = event.eventEndDate ? new Date(event.eventEndDate) : new Date(startDate.getTime() + 2 * 60 * 60 * 1000); // Default 2 hours if no end date

      // Format dates to YYYYMMDDTHHMMSSZ format (UTC)
      const formatDateForGoogle = (date) => {
        return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      };

      const startTime = formatDateForGoogle(startDate);
      const endTime = formatDateForGoogle(endDate);

      // Create event details with time information
      const eventTitle = event.eventName;
      const timeString = startDate.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/Los_Angeles'
      });
      const dateString = startDate.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'America/Los_Angeles'
      });

      const eventDescription = `UConsulting Event: ${event.eventName}\n\nEvent Details:\nDate: ${dateString}\nTime: ${timeString} PT\nLocation: ${event.eventLocation || 'Location TBD'}\nCycle: ${getCycleName(event.cycleId)}\n\nThis is a UConsulting recruitment event.`;
      const eventLocation = event.eventLocation || 'Location TBD';

      // Create Google Calendar URL
      const googleCalendarUrl = new URL('https://calendar.google.com/calendar/render');
      googleCalendarUrl.searchParams.set('action', 'TEMPLATE');
      googleCalendarUrl.searchParams.set('text', eventTitle);
      googleCalendarUrl.searchParams.set('dates', `${startTime}/${endTime}`);
      googleCalendarUrl.searchParams.set('details', eventDescription);
      googleCalendarUrl.searchParams.set('location', eventLocation);
      googleCalendarUrl.searchParams.set('sf', 'true'); // Show form
      googleCalendarUrl.searchParams.set('output', 'xml'); // Open in new tab
      googleCalendarUrl.searchParams.set('ctz', 'America/Los_Angeles'); // Ensure Calendar UI opens with the intended timezone

      // Open Google Calendar in a new tab
      window.open(googleCalendarUrl.toString(), '_blank');
    } catch (error) {
      console.error('Error adding to calendar:', error);
      alert('Failed to open calendar. Please try again.');
    }
  };

  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <Box sx={{ 
      width: '100%', 
      overflow: 'visible',
      maxWidth: 'none',
      margin: 0,
      padding: 0
    }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}>
        <Stack>
          <Typography variant="h4">Event Management</Typography>
          {activeCycle && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Showing events for: <strong>{activeCycle.name}</strong> cycle
            </Typography>
          )}
          {!activeCycle && (
            <Typography variant="body2" color="error" sx={{ mt: 0.5 }}>
              No active cycle. Please activate a cycle to view events.
            </Typography>
          )}
        </Stack>
        <Stack direction="row" spacing={2}>
          {user?.role === 'ADMIN' && (
            <Button variant="outlined" onClick={openCopyDialog}>
              Copy from Cycle
            </Button>
          )}
          {/* The one setup step that used to need the Render dashboard. */}
          {user?.role === 'ADMIN' && (
            <Button variant="outlined" onClick={() => setSyncSetupOpen(true)}>
              Luma Sync Setup
            </Button>
          )}
          <Button 
            variant="outlined" 
            onClick={syncAllEvents}
            disabled={syncLoading['all']}
          >
            {syncLoading['all'] ? <CircularProgress size={20} /> : 'Sync All Forms'}
          </Button>
          <Button variant="contained" onClick={() => setCreateOpen(true)} disabled={!activeCycle}>
            New Event
          </Button>
        </Stack>
      </Stack>

      {/* Sign-ups run through Luma, which sends its own confirmation and
          calendar invite, so the ATS one is off. It is a switch rather than
          deleted code because the Google Forms path is still here and a move
          back should not need a release. Admins only: it changes what lands in
          candidates' inboxes. */}
      {user?.role === 'ADMIN' && signupEmails !== null && (
        <Alert severity={signupEmails ? 'warning' : 'info'} sx={{ mb: 2 }}>
          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
            <FormControlLabel
              control={
                <Switch
                  checked={signupEmails}
                  disabled={signupEmailsSaving}
                  onChange={(e) => toggleSignupEmails(e.target.checked)}
                />
              }
              label="Send an ATS confirmation email for Google Form sign-ups"
            />
            <Typography variant="body2" color="text.secondary">
              {signupEmails
                ? 'On. Anyone who RSVPs on a Luma event AND a Google Form will get two emails — leave this off while Luma is in use.'
                : 'Off, because Luma emails its own confirmation and calendar invite. Turn this on if events move back to Google Forms.'}
            </Typography>
          </Stack>
        </Alert>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>
      )}
      
      {successMessage && (
        <Alert severity="success" sx={{ mb: 2 }}>{successMessage}</Alert>
      )}

      <Box sx={{ 
        width: '100%',
        overflowX: 'auto',
        overflowY: 'visible',
        '&::-webkit-scrollbar': {
          height: '8px',
        },
        '&::-webkit-scrollbar-track': {
          backgroundColor: '#f1f1f1',
          borderRadius: '4px',
        },
        '&::-webkit-scrollbar-thumb': {
          backgroundColor: '#c1c1c1',
          borderRadius: '4px',
          '&:hover': {
            backgroundColor: '#a8a8a8',
          },
        },
      }}>
        <TableContainer
          component={Paper}
          className="responsive-table"
          sx={{
            minWidth: 'max-content',
            width: 'max-content',
            overflow: 'visible'
          }}
        >
          <Table sx={{ minWidth: 1400, width: 'max-content' }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ minWidth: { xs: 'auto', md: 200 } }}>Event Name</TableCell>
              <TableCell sx={{ minWidth: { xs: 'auto', md: 150 } }}>Start Date</TableCell>
              <TableCell sx={{ minWidth: { xs: 'auto', md: 150 } }}>End Date</TableCell>
              <TableCell sx={{ minWidth: { xs: 'auto', md: 120 } }}>Location</TableCell>
              <TableCell sx={{ minWidth: { xs: 'auto', md: 100 } }}>Cycle</TableCell>
              <TableCell sx={{ minWidth: { xs: 'auto', md: 140 } }}>Show to Candidates</TableCell>
              <TableCell sx={{ minWidth: { xs: 'auto', md: 200 } }}>RSVP</TableCell>
              <TableCell sx={{ minWidth: { xs: 'auto', md: 200 } }}>Attendance</TableCell>
              <TableCell sx={{ minWidth: { xs: 'auto', md: 200 } }}>Member RSVP</TableCell>
              <TableCell sx={{ minWidth: { xs: 'auto', md: 200 } }}>Member Attendance</TableCell>
              <TableCell sx={{ minWidth: { xs: 'auto', md: 200 } }}>Luma</TableCell>
              <TableCell align="right" sx={{ minWidth: { xs: 'auto', md: 120 } }}>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {filteredEvents.length === 0 && !loading ? (
              <TableRow>
                <TableCell colSpan={12} align="center" sx={{ py: 4 }}>
                  <Typography variant="body1" color="text.secondary">
                    {activeCycle 
                      ? `No events found for ${activeCycle.name} cycle. Create a new event to get started.`
                      : 'No active cycle found. Please activate a cycle first.'}
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              filteredEvents.map((event) => {
                const stats = eventStats[event.id] || { rsvpCount: 0, attendanceCount: 0, memberRsvpCount: 0, memberAttendanceCount: 0, hasRsvpForm: false, hasAttendanceForm: false, hasMemberRsvpForm: false, hasMemberAttendanceForm: false, lumaGuestCount: 0, lumaHeldCount: 0 };
              
                return (
                  <TableRow key={event.id}>
                  <TableCell data-label="Event Name">
                    <Stack spacing={0.5} alignItems="flex-start">
                      <span>{event.eventName}</span>
                      {/* Durable shim state from the server, not inferred from the
                          URL fields: an event needs both forms to be connected. */}
                      {event.formStatus === 'PENDING_FORM' && (
                        <Tooltip title="Generated from the cycle timeline. Paste both the RSVP and attendance Google Form URLs to finish setup.">
                          <Chip label="Needs form link" size="small" color="warning" variant="outlined" />
                        </Tooltip>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell data-label="Start Date">{formatDateTime(event.eventStartDate)}</TableCell>
                  <TableCell data-label="End Date">{formatDateTime(event.eventEndDate)}</TableCell>
                  <TableCell data-label="Location">{event.eventLocation || '-'}</TableCell>
                  <TableCell data-label="Cycle">{getCycleName(event.cycleId)}</TableCell>
                  <TableCell data-label="Show to Candidates">
                    <Chip
                      label={event.showToCandidates ? 'Yes' : 'No'}
                      size="small"
                      color={event.showToCandidates ? 'success' : 'default'}
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell data-label="RSVP">
                    {/* Where a candidate actually signs up. That is the Luma
                        page wherever there is one, so it is the link this cell
                        offers; the Google Form stays reachable underneath it,
                        because an event that has both still has old responses
                        worth opening. */}
                    <Stack spacing={1} alignItems="flex-start">
                      {event.lumaUrl || event.rsvpForm ? (
                        <>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Chip
                              label={`${stats.rsvpCount} RSVPs`}
                              size="small"
                              color="primary"
                              variant="outlined"
                            />
                            <Button
                              size="small"
                              variant="text"
                              onClick={() => window.open(event.lumaUrl || event.rsvpForm, '_blank', 'noopener,noreferrer')}
                            >
                              {event.lumaUrl ? 'View Luma' : 'View Form'}
                            </Button>
                            {event.lumaUrl && event.rsvpForm && (
                              <Tooltip title="The Google Form this event used before Luma. Its responses still sync.">
                                <Button
                                  size="small"
                                  variant="text"
                                  color="inherit"
                                  onClick={() => window.open(event.rsvpForm, '_blank', 'noopener,noreferrer')}
                                >
                                  Form
                                </Button>
                              </Tooltip>
                            )}
                          </Stack>
                          {event.rsvpForm && (
                            <Button
                              size="small"
                              variant="outlined"
                              disabled={syncLoading[`${event.id}-rsvp`]}
                              onClick={() => syncEventRSVP(event.id)}
                            >
                              {syncLoading[`${event.id}-rsvp`] ? <CircularProgress size={16} /> : 'Sync'}
                            </Button>
                          )}
                        </>
                      ) : (
                        <Typography variant="body2" color="text.secondary">No sign-up link</Typography>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell data-label="Attendance">
                    <Stack spacing={1} alignItems="flex-start">
                      {event.attendanceForm ? (
                        <>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Chip 
                              label={`${stats.attendanceCount} Attended`} 
                              size="small" 
                              color="secondary" 
                              variant="outlined"
                            />
                            <Button
                              size="small"
                              variant="text"
                              onClick={() => window.open(event.attendanceForm, '_blank')}
                            >
                              View Form
                            </Button>
                          </Stack>
                          <Button
                            size="small"
                            variant="outlined"
                            disabled={syncLoading[`${event.id}-attendance`]}
                            onClick={() => syncEventAttendance(event.id)}
                          >
                            {syncLoading[`${event.id}-attendance`] ? <CircularProgress size={16} /> : 'Sync'}
                          </Button>
                        </>
                      ) : (
                        <Typography variant="body2" color="text.secondary">No Form</Typography>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell data-label="Member RSVP">
                    {event.memberRsvpEnabled === false ? (
                      <Typography variant="body2" color="text.secondary">Off</Typography>
                    ) : (
                    <Stack spacing={1} alignItems="flex-start">
                      {/* Members RSVP in the app, so the count stands with or without a form. */}
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Chip
                          label={`${stats.memberRsvpCount} RSVPs`}
                          size="small"
                          color="secondary"
                          variant="outlined"
                        />
                        {event.memberRsvpUrl && (
                          <Button
                            size="small"
                            variant="text"
                            onClick={() => window.open(event.memberRsvpUrl, '_blank')}
                          >
                            View Form
                          </Button>
                        )}
                      </Stack>
                      {(() => {
                        const started = new Date(event.eventStartDate) <= new Date();
                        const external = myRsvps[event.id] && myRsvps[event.id] !== 'IN_APP';
                        return (
                          <Tooltip
                            title={external
                              ? 'Change this RSVP where you made it'
                              : started ? 'This event has started' : 'Your own RSVP'}
                          >
                            <span>
                              <Button
                                size="small"
                                variant={myRsvps[event.id] ? 'contained' : 'outlined'}
                                color={myRsvps[event.id] ? 'success' : 'primary'}
                                disabled={myRsvpSaving === event.id || external || started}
                                onClick={() => toggleMyRsvp(event)}
                              >
                                {myRsvpLabel(event)}
                              </Button>
                            </span>
                          </Tooltip>
                        );
                      })()}
                      {event.memberRsvpUrl && (
                        <Button
                          size="small"
                          variant="outlined"
                          disabled={syncLoading[`${event.id}-member-rsvp`]}
                          onClick={() => syncMemberRSVP(event.id)}
                        >
                          {syncLoading[`${event.id}-member-rsvp`] ? <CircularProgress size={16} /> : 'Sync'}
                        </Button>
                      )}
                    </Stack>
                    )}
                  </TableCell>
                  <TableCell data-label="Member Attendance">
                    <Stack spacing={1} alignItems="flex-start">
                      {event.memberAttendanceForm ? (
                        <>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Chip
                              label={`${stats.memberAttendanceCount} Attended`}
                              size="small"
                              color="success"
                              variant="outlined"
                            />
                            <Button
                              size="small"
                              variant="text"
                              onClick={() => window.open(event.memberAttendanceForm, '_blank')}
                            >
                              View Form
                            </Button>
                          </Stack>
                          <Button
                            size="small"
                            variant="outlined"
                            disabled={syncLoading[`${event.id}-member-attendance`]}
                            onClick={() => syncMemberAttendance(event.id)}
                          >
                            {syncLoading[`${event.id}-member-attendance`] ? <CircularProgress size={16} /> : 'Sync'}
                          </Button>
                        </>
                      ) : (
                        <Typography variant="body2" color="text.secondary">No Form</Typography>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell data-label="Luma">
                    {/* Whether this event is on Luma, whether the routine has
                        resolved the link yet, and whether it is still running.
                        A link that never resolves and a sync that stopped look
                        identical from the guest list alone, so they are told
                        apart here rather than in the panel. */}
                    <Stack spacing={1} alignItems="flex-start">
                      {!event.lumaUrl ? (
                        <Typography variant="body2" color="text.secondary">Not on Luma</Typography>
                      ) : (
                        <>
                          <Stack direction="row" spacing={1} alignItems="center">
                            {!event.lumaEventId ? (
                              <Tooltip title="The link is saved. The sync routine resolves it to a Luma event id on its next hourly run.">
                                <Chip label="Awaiting first sync" size="small" color="warning" variant="outlined" />
                              </Tooltip>
                            ) : (
                              <Tooltip title={staleSync(event.lumaLastSyncedAt)
                                ? 'The routine runs hourly and has not finished a pass in over three hours. Check that it is still running.'
                                : `Last finished sync: ${formatDateTime(event.lumaLastSyncedAt)}`}>
                                <Chip
                                  label={relativeAge(event.lumaLastSyncedAt) || 'Never synced'}
                                  size="small"
                                  color={staleSync(event.lumaLastSyncedAt) ? 'warning' : 'success'}
                                  variant="outlined"
                                />
                              </Tooltip>
                            )}
                          </Stack>
                          <Button
                            size="small"
                            variant="outlined"
                            color={stats.lumaHeldCount > 0 ? 'warning' : 'primary'}
                            onClick={() => setLumaPanelEvent(event)}
                          >
                            {stats.lumaHeldCount > 0
                              ? `${stats.lumaHeldCount} to review`
                              : `Guests (${stats.lumaGuestCount || 0})`}
                          </Button>
                        </>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell data-label="Actions" align="right">
                    <Stack direction="row" spacing={1}>
                      <Tooltip title="Add to Google Calendar">
                        <IconButton
                          size="small"
                          color="info"
                          onClick={() => handleAddToCalendar(event)}
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="#4285F4">
                            <path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM7 10h5v5H7z"/>
                          </svg>
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Edit Event">
                        <IconButton
                          size="small"
                          color="primary"
                          onClick={() => openEditDialog(event)}
                        >
                          <PencilIcon style={{ width: '1rem', height: '1rem' }} />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete Event">
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() => deleteEvent(event.id)}
                        >
                          <TrashIcon style={{ width: '1rem', height: '1rem' }} />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </TableCell>
                </TableRow>
              );
              })
            )}
          </TableBody>
        </Table>
      </TableContainer>
      </Box>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>Create New Event</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField
              label="Event Name *"
              value={form.eventName}
              onChange={(e) => setForm({ ...form, eventName: e.target.value })}
              fullWidth
              required
            />
            
            <Stack direction="row" spacing={2}>
              <TextField
                label="Start Date & Time *"
                type="datetime-local"
                value={form.eventStartDate}
                onChange={(e) => setForm({ ...form, eventStartDate: e.target.value })}
                fullWidth
                required
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                label="End Date & Time *"
                type="datetime-local"
                value={form.eventEndDate}
                onChange={(e) => setForm({ ...form, eventEndDate: e.target.value })}
                fullWidth
                required
                InputLabelProps={{ shrink: true }}
              />
            </Stack>

            <TextField
              label="Location"
              value={form.eventLocation}
              onChange={(e) => setForm({ ...form, eventLocation: e.target.value })}
              fullWidth
              placeholder="e.g., Business Building Room 101"
            />

            <TextField
              label="Recruiting Cycle *"
              select
              value={form.cycleId}
              onChange={(e) => setForm({ ...form, cycleId: e.target.value })}
              fullWidth
              required
            >
              <MenuItem value="">Select a cycle</MenuItem>
              {cycles.map((cycle) => (
                <MenuItem key={cycle.id} value={cycle.id}>
                  {cycle.name} {cycle.isActive && '(Active)'}
                </MenuItem>
              ))}
            </TextField>

            <TextField
              label="RSVP Google Form URL"
              value={form.rsvpForm}
              onChange={(e) => setForm({ ...form, rsvpForm: e.target.value })}
              fullWidth
              placeholder="https://forms.gle/..."
              helperText="Paste the Google Form URL for event RSVPs"
            />

            <TextField
              label="Attendance Check-in Google Form URL"
              value={form.attendanceForm}
              onChange={(e) => setForm({ ...form, attendanceForm: e.target.value })}
              fullWidth
              placeholder="https://forms.gle/..."
              helperText="Paste the Google Form URL for event attendance tracking"
            />

            <TextField
              label="Member RSVP Google Form URL"
              value={form.memberRsvpUrl}
              onChange={(e) => setForm({ ...form, memberRsvpUrl: e.target.value })}
              fullWidth
              placeholder="https://forms.gle/..."
              helperText="Paste the Google Form URL for UC member RSVPs"
            />

            <TextField
              label="Member Attendance Google Form URL"
              value={form.memberAttendanceForm}
              onChange={(e) => setForm({ ...form, memberAttendanceForm: e.target.value })}
              fullWidth
              placeholder="https://forms.gle/..."
              helperText="Paste the Google Form URL for UC member attendance tracking"
            />

            <TextField
              label="Luma Event Link"
              value={form.lumaUrl}
              onChange={(e) => setForm({ ...form, lumaUrl: e.target.value })}
              fullWidth
              placeholder="https://lu.ma/your-event"
              helperText="Paste the event's Luma page (lu.ma/...). Luma then takes RSVPs and the door check-in for this event, and the hourly sync brings both back. Changing it makes the sync re-resolve the event from scratch."
            />

            <TextField
              label="Show to Candidates"
              select
              value={form.showToCandidates ? 'true' : 'false'}
              onChange={(e) => setForm({ ...form, showToCandidates: e.target.value === 'true' })}
              fullWidth
              helperText="Choose whether this event should be visible to candidates"
            >
              <MenuItem value="false">No - Internal Event Only</MenuItem>
              <MenuItem value="true">Yes - Show to Candidates</MenuItem>
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button onClick={createEvent} variant="contained">Create Event</Button>
        </DialogActions>
      </Dialog>

      {/* Edit Event Dialog */}
      <Dialog open={editOpen} onClose={() => setEditOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>Edit Event</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField
              label="Event Name *"
              value={editForm.eventName}
              onChange={(e) => setEditForm({ ...editForm, eventName: e.target.value })}
              fullWidth
              required
            />
            
            <Stack direction="row" spacing={2}>
              <TextField
                label="Start Date & Time *"
                type="datetime-local"
                value={editForm.eventStartDate}
                onChange={(e) => setEditForm({ ...editForm, eventStartDate: e.target.value })}
                fullWidth
                required
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                label="End Date & Time *"
                type="datetime-local"
                value={editForm.eventEndDate}
                onChange={(e) => {console.log(editForm.eventEndDate); setEditForm({ ...editForm, eventEndDate: e.target.value })}}
                fullWidth
                required
                InputLabelProps={{ shrink: true }}
              />
            </Stack>

            <TextField
              label="Location"
              value={editForm.eventLocation}
              onChange={(e) => setEditForm({ ...editForm, eventLocation: e.target.value })}
              fullWidth
              placeholder="e.g., Business Building Room 101"
            />

            <TextField
              label="Recruiting Cycle *"
              select
              value={editForm.cycleId}
              onChange={(e) => setEditForm({ ...editForm, cycleId: e.target.value })}
              fullWidth
              required
            >
              <MenuItem value="">Select a cycle</MenuItem>
              {cycles.map((cycle) => (
                <MenuItem key={cycle.id} value={cycle.id}>
                  {cycle.name} {cycle.isActive && '(Active)'}
                </MenuItem>
              ))}
            </TextField>

            <TextField
              label="RSVP Google Form URL"
              value={editForm.rsvpForm}
              onChange={(e) => setEditForm({ ...editForm, rsvpForm: e.target.value })}
              fullWidth
              placeholder="https://forms.gle/..."
              helperText="Paste the Google Form URL for event RSVPs"
            />

            <TextField
              label="Attendance Check-in Google Form URL"
              value={editForm.attendanceForm}
              onChange={(e) => setEditForm({ ...editForm, attendanceForm: e.target.value })}
              fullWidth
              placeholder="https://forms.gle/..."
              helperText="Paste the Google Form URL for event attendance tracking"
            />

            <FormControlLabel
              control={
                <Switch
                  checked={editForm.memberRsvpEnabled}
                  onChange={(e) => setEditForm({ ...editForm, memberRsvpEnabled: e.target.checked })}
                />
              }
              label={editForm.memberRsvpEnabled
                ? 'Member RSVP on'
                : 'Member RSVP off. Members are not asked to RSVP to this event'}
            />

            <TextField
              label="Member RSVP Google Form URL"
              value={editForm.memberRsvpUrl}
              onChange={(e) => setEditForm({ ...editForm, memberRsvpUrl: e.target.value })}
              fullWidth
              placeholder="https://forms.gle/..."
              helperText="Paste the Google Form URL for UC member RSVPs"
            />

            <TextField
              label="Member Attendance Google Form URL"
              value={editForm.memberAttendanceForm}
              onChange={(e) => setEditForm({ ...editForm, memberAttendanceForm: e.target.value })}
              fullWidth
              placeholder="https://forms.gle/..."
              helperText="Paste the Google Form URL for UC member attendance tracking"
            />

            <TextField
              label="Luma Event Link"
              value={editForm.lumaUrl}
              onChange={(e) => setEditForm({ ...editForm, lumaUrl: e.target.value })}
              fullWidth
              placeholder="https://lu.ma/your-event"
              helperText="Paste the event's Luma page (lu.ma/...). Luma then takes RSVPs and the door check-in for this event, and the hourly sync brings both back. Changing it makes the sync re-resolve the event from scratch."
            />

            <TextField
              label="Show to Candidates"
              select
              value={editForm.showToCandidates ? 'true' : 'false'}
              onChange={(e) => setEditForm({ ...editForm, showToCandidates: e.target.value === 'true' })}
              fullWidth
              helperText="Choose whether this event should be visible to candidates"
            >
              <MenuItem value="false">No - Internal Event Only</MenuItem>
              <MenuItem value="true">Yes - Show to Candidates</MenuItem>
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditOpen(false)}>Cancel</Button>
          <Button 
            onClick={updateEvent} 
            variant="contained"
            disabled={editLoading}
          >
            {editLoading ? <CircularProgress size={20} /> : 'Update Event'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Cycle-portable event copy dialog */}
      <Dialog open={copyOpen} onClose={closeCopyDialog} fullWidth maxWidth="lg">
        <DialogTitle>Copy Events from Another Cycle</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <Typography variant="body2" color="text.secondary">
              Copy event records only. Registrations, candidate data, calendar events, attachments, and source records are not copied.
            </Typography>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="Source Cycle"
                select
                fullWidth
                SelectProps={{ native: true }}
                value={copySourceCycleId}
                onChange={(e) => setCopySourceCycleId(e.target.value)}
              >
                <option value="">Select a source cycle</option>
                {cycles.map((cycle) => (
                  <option key={cycle.id} value={cycle.id}>
                    {cycle.name}
                  </option>
                ))}
              </TextField>
              <TextField
                label="Target Cycle"
                select
                fullWidth
                SelectProps={{ native: true }}
                value={copyTargetCycleId}
                onChange={(e) => setCopyTargetCycleId(e.target.value)}
              >
                <option value="">Select a target cycle</option>
                {cycles.map((cycle) => (
                  <option key={cycle.id} value={cycle.id}>
                    {cycle.name}{cycle.isActive ? ' (Active)' : ''}
                  </option>
                ))}
              </TextField>
            </Stack>

            <Button
              variant="outlined"
              onClick={loadCopyPreview}
              disabled={copyPreviewLoading || !copySourceCycleId || !copyTargetCycleId}
            >
              {copyPreviewLoading ? <CircularProgress size={20} /> : 'Preview Events'}
            </Button>

            {copyError && <Alert severity="error">{copyError}</Alert>}
            {copySuccess && <Alert severity="success">{copySuccess}</Alert>}

            {copyPreview && (
              <>
                <Typography variant="subtitle2">
                  Preview: {copyPreview.events.length} event(s) from {copyPreview.sourceCycle.name} to {copyPreview.targetCycle.name} ({copyEvents.filter((e) => e.selected).length} selected)
                </Typography>

                <Box sx={{ width: '100%', overflowX: 'auto' }}>
                  <TableContainer component={Paper} sx={{ minWidth: 1100 }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell padding="checkbox">
                            <Checkbox
                              size="small"
                              checked={copyEvents.length > 0 && copyEvents.every((e) => e.selected)}
                              indeterminate={
                                copyEvents.some((e) => e.selected) && !copyEvents.every((e) => e.selected)
                              }
                              onChange={(e) => toggleAllCopyEvents(e.target.checked)}
                              inputProps={{ 'aria-label': 'Select all events to copy' }}
                            />
                          </TableCell>
                          <TableCell sx={{ minWidth: 220 }}>Name</TableCell>
                          <TableCell>Start</TableCell>
                          <TableCell>End</TableCell>
                          <TableCell>Location</TableCell>
                          <TableCell>Show to Candidates</TableCell>
                          <TableCell>RSVP Form</TableCell>
                          <TableCell>Attendance Form</TableCell>
                          <TableCell>Member RSVP</TableCell>
                          <TableCell>Member Attendance Form</TableCell>
                          <TableCell>Status</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {copyEvents.map((evt, index) => (
                          <TableRow key={evt.sourceEventId || index}>
                            <TableCell padding="checkbox">
                              <Checkbox
                                size="small"
                                checked={Boolean(evt.selected)}
                                onChange={(e) => toggleCopyEvent(index, e.target.checked)}
                                inputProps={{ 'aria-label': `Copy ${evt.eventName}` }}
                              />
                            </TableCell>
                            <TableCell sx={{ minWidth: 220 }}>
                              <TextField
                                size="small"
                                value={evt.eventName}
                                onChange={(e) => updateCopyEvent(index, 'eventName', e.target.value)}
                                aria-label={`Event name for ${evt.eventName}`}
                                placeholder="Event name"
                                fullWidth
                              />
                            </TableCell>
                            <TableCell>
                              <TextField
                                type="datetime-local"
                                size="small"
                                value={evt.eventStartDate}
                                onChange={(e) => updateCopyEvent(index, 'eventStartDate', e.target.value)}
                                InputLabelProps={{ shrink: true }}
                                aria-label={`Start date for ${evt.eventName}`}
                                fullWidth
                              />
                            </TableCell>
                            <TableCell>
                              <TextField
                                type="datetime-local"
                                size="small"
                                value={evt.eventEndDate}
                                onChange={(e) => updateCopyEvent(index, 'eventEndDate', e.target.value)}
                                InputLabelProps={{ shrink: true }}
                                aria-label={`End date for ${evt.eventName}`}
                                fullWidth
                              />
                            </TableCell>
                            <TableCell>
                              <TextField
                                size="small"
                                value={evt.eventLocation}
                                onChange={(e) => updateCopyEvent(index, 'eventLocation', e.target.value)}
                                aria-label={`Location for ${evt.eventName}`}
                                fullWidth
                              />
                            </TableCell>
                            <TableCell>
                              <FormControlLabel
                                control={
                                  <Switch
                                    size="small"
                                    checked={evt.showToCandidates}
                                    onChange={(e) => updateCopyEvent(index, 'showToCandidates', e.target.checked)}
                                    inputProps={{ 'aria-label': `Show to candidates for ${evt.eventName}` }}
                                  />
                                }
                                label=""
                              />
                            </TableCell>
                            <TableCell>
                              <TextField
                                size="small"
                                value={evt.rsvpForm}
                                onChange={(e) => updateCopyEvent(index, 'rsvpForm', e.target.value)}
                                placeholder="https://forms.gle/..."
                                aria-label={`RSVP form URL for ${evt.eventName}`}
                                fullWidth
                              />
                            </TableCell>
                            <TableCell>
                              <TextField
                                size="small"
                                value={evt.attendanceForm}
                                onChange={(e) => updateCopyEvent(index, 'attendanceForm', e.target.value)}
                                placeholder="https://forms.gle/..."
                                aria-label={`Attendance form URL for ${evt.eventName}`}
                                fullWidth
                              />
                            </TableCell>
                            <TableCell>
                              <TextField
                                size="small"
                                value={evt.memberRsvpUrl}
                                onChange={(e) => updateCopyEvent(index, 'memberRsvpUrl', e.target.value)}
                                placeholder="https://forms.gle/..."
                                aria-label={`Member RSVP URL for ${evt.eventName}`}
                                fullWidth
                              />
                            </TableCell>
                            <TableCell>
                              <TextField
                                size="small"
                                value={evt.memberAttendanceForm}
                                onChange={(e) => updateCopyEvent(index, 'memberAttendanceForm', e.target.value)}
                                placeholder="https://forms.gle/..."
                                aria-label={`Member attendance URL for ${evt.eventName}`}
                                fullWidth
                              />
                            </TableCell>
                            <TableCell>
                              {evt.alreadyExists ? (
                                <Chip label="Exists" size="small" color="warning" variant="outlined" />
                              ) : (
                                <Chip label="New" size="small" color="success" variant="outlined" />
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </Box>

                <FormControlLabel
                  control={
                    <Switch
                      checked={copyForce}
                      onChange={(e) => setCopyForce(e.target.checked)}
                    />
                  }
                  label="Re-run (skip duplicates)"
                />
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeCopyDialog}>Cancel</Button>
          <Button
            variant="contained"
            onClick={commitCopy}
            disabled={copyCommitLoading || !copyEvents.some((evt) => evt.selected)}
          >
            {copyCommitLoading ? <CircularProgress size={20} /> : 'Copy Events'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Linking a guest changes real RSVP and attendance rows, so the row's
          counts are refetched when the panel reports a change. */}
      <LumaGuestsPanel
        open={Boolean(lumaPanelEvent)}
        eventId={lumaPanelEvent?.id}
        eventName={lumaPanelEvent?.eventName}
        onClose={() => setLumaPanelEvent(null)}
        onChanged={fetchEvents}
      />

      <LumaSyncSetupDialog open={syncSetupOpen} onClose={() => setSyncSetupOpen(false)} />

    </Box>
    </AccessControl>
  );
}