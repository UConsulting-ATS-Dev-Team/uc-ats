import React, { useCallback, useEffect, useState } from 'react';
import api from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { fetchActiveCycle, slotsInCycleDates } from '../utils/activeCycle';
import UConsultingLogo from '../components/UConsultingLogo';
import {
  Box,
  Typography,
  Paper,
  TextField,
  Button,
  Grid,
  Alert,
  CircularProgress,
  Stack,
  Container,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Tabs,
  Tab,
  Link
} from '@mui/material';
import {
  Schedule as ScheduleIcon,
  People as PeopleIcon,
  Person as PersonIcon,
  Email as EmailIcon,
  School as SchoolIcon,
  CheckCircle as CheckCircleIcon,
  Lock as LockIcon
} from '@mui/icons-material';
import { GtkucBookedMeetingCard, GtkucSlotCard, GtkucSlotGrid, formatSlotDateTime } from '../components/GtkucSlotGallery';
import {
  MODIFY_CUTOFF_HOURS,
  canModify,
  currentCycleBooking,
  errorText,
} from '../utils/schedulingWindows';

export default function CoffeeChatsPublic() {
  const { user, login, register } = useAuth();
  const [slots, setSlots] = useState([]);
  const [allSlots, setAllSlots] = useState([]); // Store all slots for filtering
  const [activeCycle, setActiveCycle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedSlot, setSelectedSlot] = useState(null);
  // Name and email come from the signed-in account, server-side. The only thing
  // the form can add is a student ID, for an account that lacks one.
  const [form, setForm] = useState({ studentId: '' });
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState('');

  // Booking requires an account (POST /meeting-slots/:id/signup is requireAuth).
  // A guest who picks a slot is asked to log in or register, and the booking
  // completes on success.
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState('login'); // 'login' | 'register'
  const [authForm, setAuthForm] = useState({ email: '', password: '', fullName: '', graduationClass: '', studentId: '' });
  const [authError, setAuthError] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [pendingSlotId, setPendingSlotId] = useState(null);

  // One booking per cycle. A signed-in user who holds one sees it instead of
  // the gallery, and gets the gallery back only to pick a new time for it.
  const [mySignups, setMySignups] = useState([]);
  const [changingTime, setChangingTime] = useState(false);
  const [bookingBusy, setBookingBusy] = useState(false);

  const loadMine = useCallback(async () => {
    if (!user) {
      setMySignups([]);
      return;
    }
    // Right after a login the context has not handed the API client its token yet.
    const token = localStorage.getItem('token');
    if (token) api.setToken(token);
    try {
      const data = await api.get('/meeting-signups/mine');
      setMySignups(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('Failed to load your meeting signups:', e);
      setMySignups([]);
    }
  }, [user]);

  useEffect(() => {
    loadMine();
  }, [loadMine]);

  const myBooking = user ? currentCycleBooking(mySignups, activeCycle, (s) => s.slot?.startTime) : null;

  const loadActiveCycle = async () => {
    try {
      // Use public endpoint so it works for all users (members, admins, and unauthenticated)
      const active = await fetchActiveCycle(api);
      setActiveCycle(active);
      return active;
    } catch (e) {
      console.error('Failed to load active cycle:', e);
      return null;
    }
  };

  const load = async () => {
    try {
      setLoading(true);
      setError('');
      const data = await api.get('/meeting-slots');
      setAllSlots(data);
      
      // Load active cycle and filter slots
      const cycle = await loadActiveCycle();
      const filtered = slotsInCycleDates(data, cycle);
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
      setSelectedSlot(null);
      setForm({ fullName: '', email: '', studentId: '' });
      setError('');
      setSuccess('');
      
      // Reload from server to get updated slots and filter by new active cycle
      await load();
    };
    
    window.addEventListener('cycleActivated', handleCycleActivated);
    
    return () => {
      window.removeEventListener('cycleActivated', handleCycleActivated);
    };
  }, []);

  // Book a slot as the signed-in account. `account` is passed right after a
  // login or register, before the context's user has updated.
  const bookSlot = async (slotId, account = user) => {
    setError('');
    setSuccess('');
    // The server only checks the ID is present; hold it to the rule registration uses.
    if (!account?.studentId && !/^\d{9}$/.test(form.studentId.trim())) {
      setError('Student ID must be exactly 9 digits.');
      return;
    }
    setSubmitting(true);
    try {
      const payload = account?.studentId ? {} : { studentId: form.studentId.trim() };
      const response = await api.post(`/meeting-slots/${slotId}/signup`, payload);
      setSuccess(response.message || 'Successfully signed up! You will receive a confirmation email shortly.');
      setForm({ studentId: '' });
      setSelectedSlot(null);
      await Promise.all([load(), loadMine()]);
    } catch (e) {
      if (e.status === 409 && e.code === 'ALREADY_BOOKED') {
        // They already hold this cycle's meeting. Show it instead of the gallery.
        setSelectedSlot(null);
        setChangingTime(false);
        await loadMine();
        setError(errorText(e, 'You already have a meeting booked this cycle.'));
      } else {
        setError(errorText(e, 'Failed to sign up for this meeting slot'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Move the booking to the selected slot. The server keeps the old seat if the
  // new one is gone, so a failure leaves the current meeting as it was.
  const moveBooking = async (slotId) => {
    if (!myBooking) return;
    setError('');
    setSuccess('');
    setSubmitting(true);
    try {
      const response = await api.put(`/meeting-signups/${myBooking.id}`, { slotId });
      setSelectedSlot(null);
      setChangingTime(false);
      setSuccess(response?.message || 'Your meeting time has been changed.');
      await Promise.all([load(), loadMine()]);
    } catch (e) {
      // A full slot: refresh the counts first, since load() clears the error.
      if (e.status === 409) await load();
      setError(errorText(e, 'Failed to change your meeting time'));
    } finally {
      setSubmitting(false);
    }
  };

  const cancelBooking = async () => {
    if (!myBooking) return;
    if (!window.confirm('Cancel your Get to Know UC meeting? Your spot will go to someone else.')) return;
    setError('');
    setSuccess('');
    setBookingBusy(true);
    try {
      await api.delete(`/meeting-signups/${myBooking.id}`);
      setChangingTime(false);
      setSelectedSlot(null);
      setSuccess('Your meeting has been cancelled. You can book a new time below.');
      await Promise.all([load(), loadMine()]);
    } catch (e) {
      setError(errorText(e, 'Failed to cancel your meeting'));
    } finally {
      setBookingBusy(false);
    }
  };

  const startChangingTime = () => {
    setError('');
    setSuccess('');
    setSelectedSlot(null);
    setChangingTime(true);
  };

  const keepCurrentTime = () => {
    setSelectedSlot(null);
    setChangingTime(false);
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!selectedSlot) return;

    if (!user) {
      setPendingSlotId(selectedSlot);
      setAuthMode('login');
      setAuthError('');
      setAuthForm({ email: '', password: '', fullName: '', graduationClass: '', studentId: '' });
      setAuthOpen(true);
      return;
    }

    if (myBooking && changingTime) {
      await moveBooking(selectedSlot);
      return;
    }

    await bookSlot(selectedSlot);
  };

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError('');

    if (authMode === 'register' && !/^\d{9}$/.test(authForm.studentId.trim())) {
      setAuthError('Student ID must be exactly 9 digits.');
      return;
    }

    setAuthSubmitting(true);
    try {
      const result = authMode === 'login'
        ? await login(authForm.email.trim(), authForm.password)
        : await register({
            email: authForm.email.trim(),
            password: authForm.password,
            fullName: authForm.fullName.trim(),
            graduationClass: authForm.graduationClass.trim(),
            studentId: authForm.studentId.trim()
          });

      if (!result?.success) {
        setAuthError(result?.error || 'Authentication failed. Please try again.');
        return;
      }

      // The context hands the new token to the API client in an effect, which
      // has not run yet. Book with it now rather than waiting a render.
      const token = localStorage.getItem('token');
      if (token) api.setToken(token);

      setAuthOpen(false);
      const slotId = pendingSlotId;
      setPendingSlotId(null);
      // register() does not return the user; its student ID is the one just typed.
      const account = result.user || { studentId: authForm.studentId.trim() };
      if (!slotId) return;
      if (!account.studentId) {
        // An older account with no student ID on file. Booking now would be
        // refused; leave the slot open so its signed-in form asks for the ID.
        setSelectedSlot(slotId);
        setError('Add your UCLA student ID to finish booking.');
        return;
      }
      await bookSlot(slotId, account);
    } catch (err) {
      setAuthError(err.message || 'Authentication failed. Please try again.');
    } finally {
      setAuthSubmitting(false);
    }
  };


  const getSelectedSlotData = () => {
    return slots.find(s => s.id === selectedSlot);
  };

  // Filter out past meeting slots and full capacity slots
  const getAvailableSlots = () => {
    const now = new Date();
    return slots.filter(slot => {
      // Compare times in UTC (no conversion needed)
      const startTime = new Date(slot.startTime);
      // Only show slots that haven't ended yet AND have available capacity
      return startTime >= now && slot.remaining > 0;
    });
  };

  const availableSlots = getAvailableSlots();
  const showBooked = Boolean(myBooking) && !changingTime;
  const picking = Boolean(myBooking) && changingTime;
  const gallerySlots = picking ? availableSlots.filter((s) => s.id !== myBooking.slotId) : availableSlots;
  const bookingLocked = myBooking ? !canModify(myBooking.slot.startTime) : false;
  
  // Calculate total available spots and total spots
  // Note: slots is already filtered by active cycle, so totalSpots only counts spots from current cycle
  const totalAvailableSpots = availableSlots.reduce((sum, slot) => sum + slot.remaining, 0);
  const totalSpots = slots.reduce((sum, slot) => sum + slot.capacity, 0);

  return (
    <Box>
      {/* Hero Section with Club Photo - Full Width */}
      <Box sx={{ mb: 6 }}>
        {/* Club Photo - Full Width */}
        <Box sx={{ 
          position: 'relative', 
          mb: 4,
          width: '100vw',
          marginLeft: 'calc(-50vw + 50%)',
          height: '500px',
          overflow: 'hidden'
        }}>
          <img 
            src="/api/uploads/clubPhoto.jpg" 
            alt="UConsulting Members"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'center 33%',
              display: 'block'
            }}
          />
          {/* Dark overlay for better text readability */}
          <Box sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.4)'
          }} />
          
          {/* Logo in top left */}
          <Box sx={{
            position: 'absolute',
            top: { xs: 16, md: 24 },
            left: { xs: 16, md: 24 },
            zIndex: 1
          }}>
            <Box sx={{ filter: 'brightness(0) invert(1)' }}>
              <UConsultingLogo size="large" />
            </Box>
          </Box>

          {/* Overlay with Title */}
          <Box sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            textAlign: 'center',
            p: { xs: 3, md: 4 },
            zIndex: 1
          }}>
            <Typography variant="h2" component="h1" sx={{ 
              fontWeight: 700, 
              color: '#ffffff !important', 
              mb: 2,
              textShadow: '0 2px 4px rgba(0,0,0,0.5)',
              fontSize: { xs: '2rem', sm: '2.5rem', md: '3rem' }
            }}>
              Get to Know UC
            </Typography>
            <Typography variant="h6" sx={{ 
              color: '#ffffff !important', 
              maxWidth: 600,
              textShadow: '0 1px 2px rgba(0,0,0,0.5)',
              fontSize: { xs: '1rem', sm: '1.1rem', md: '1.25rem' },
              px: { xs: 2, md: 0 }
            }}>
              Connect with our members for 1:2 meetings to learn more about UConsulting and get your questions answered.
            </Typography>
          </Box>
        </Box>

        {/* Instructions */}
        <Container maxWidth="lg" sx={{ px: { xs: 2, md: 3 } }}>
          <Box sx={{ textAlign: 'center' }}>
            <Alert severity="info" sx={{ maxWidth: 600, mx: 'auto' }}>
              <Typography variant="body2">
                <strong>Important:</strong> You can book one meeting per recruiting cycle. Once you have one, you can change its time or cancel it on this page, up to {MODIFY_CUTOFF_HOURS} hours before it starts.
              </Typography>
            </Alert>
          </Box>
        </Container>

        {/* Stats Section */}
        {!loading && (
          <Container maxWidth="lg" sx={{ px: { xs: 2, md: 3 }, mt: 4 }}>
            <Box sx={{ 
              display: 'flex', 
              justifyContent: 'center', 
              gap: { xs: 2, md: 4 },
              flexWrap: 'wrap'
            }}>
              <Box sx={{ 
                textAlign: 'center',
                px: { xs: 2, md: 3 },
                py: { xs: 1.5, md: 2 },
                borderRadius: 2,
                backgroundColor: 'primary.50',
                border: 1,
                borderColor: 'primary.200',
                minWidth: { xs: 120, md: 140 }
              }}>
                <Typography variant="h4" component="div" sx={{ 
                  fontWeight: 700, 
                  color: 'primary.main',
                  fontSize: { xs: '1.75rem', md: '2.125rem' }
                }}>
                  {totalAvailableSpots}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ 
                  fontSize: { xs: '0.8rem', md: '0.875rem' },
                  fontWeight: 500
                }}>
                  Available Spots
                </Typography>
              </Box>
              
              <Box sx={{ 
                textAlign: 'center',
                px: { xs: 2, md: 3 },
                py: { xs: 1.5, md: 2 },
                borderRadius: 2,
                backgroundColor: 'grey.50',
                border: 1,
                borderColor: 'grey.300',
                minWidth: { xs: 120, md: 140 }
              }}>
                <Typography variant="h4" component="div" sx={{ 
                  fontWeight: 700, 
                  color: 'text.primary',
                  fontSize: { xs: '1.75rem', md: '2.125rem' }
                }}>
                  {totalSpots}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ 
                  fontSize: { xs: '0.8rem', md: '0.875rem' },
                  fontWeight: 500
                }}>
                  Total Spots
                </Typography>
              </Box>
            </Box>
          </Container>
        )}
      </Box>

      {/* Widens to xl on very wide screens so the slot grid can fit a fourth column. */}
      <Container maxWidth="lg" sx={{ py: { xs: 3, md: 4 }, px: { xs: 1.5, md: 3 }, maxWidth: { xl: 1536 } }}>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {success && (
        <Alert severity="success" sx={{ mb: 3 }} onClose={() => setSuccess('')}>
          {success}
        </Alert>
      )}

      <Grid container spacing={{ xs: 2, md: 4 }}>
        {showBooked && (
          <Grid size={12}>
            <Box sx={{ maxWidth: 720, mx: 'auto' }}>
              <GtkucBookedMeetingCard
                memberName={myBooking.slot.member?.fullName || 'UC Consulting Member'}
                profile={allSlots.find((s) => s.id === myBooking.slotId)?.memberProfile}
                startTime={myBooking.slot.startTime}
                location={myBooking.slot.location}
                locked={bookingLocked}
                cutoffHours={MODIFY_CUTOFF_HOURS}
                busy={bookingBusy}
                onChangeTime={startChangingTime}
                onCancel={cancelBooking}
              />
            </Box>
          </Grid>
        )}

        {/* Available Slots */}
        {!showBooked && (
        <Grid size={12}>
          <Paper sx={{ p: { xs: 2, md: 3 } }}>
            <Box
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', sm: 'row' },
                alignItems: { xs: 'stretch', sm: 'center' },
                justifyContent: 'space-between',
                gap: 1.5,
                mb: 3,
              }}
            >
              <Typography variant="h5" component="h2" sx={{ fontWeight: 600, color: 'primary.dark', fontSize: { xs: '1.5rem', md: '1.75rem' } }}>
                {picking ? 'Pick a new time' : 'Available Meeting Slots'}
              </Typography>
              {picking && (
                <Button variant="outlined" onClick={keepCurrentTime} disabled={submitting} sx={{ minHeight: { xs: 44, md: 36 } }}>
                  Keep my current time
                </Button>
              )}
            </Box>

            {picking && (
              <Alert severity="info" sx={{ mb: 3 }}>
                Your current meeting is {formatSlotDateTime(myBooking.slot.startTime)} with{' '}
                {myBooking.slot.member?.fullName || 'a UC Consulting member'}. It stays booked until you confirm a new time.
              </Alert>
            )}

            {loading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
                <CircularProgress />
              </Box>
            ) : gallerySlots.length === 0 ? (
              <Box sx={{ textAlign: 'center', p: 4 }}>
                <ScheduleIcon sx={{ fontSize: 60, color: 'grey.400', mb: 2 }} />
                <Typography variant="h6" color="text.secondary" sx={{ mb: 1 }}>
                  {slots.length === 0 ? 'No Meeting Slots Available' : 'No Available Meeting Slots'}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {slots.length === 0 
                    ? 'Check back later for new meeting opportunities.'
                    : 'All meeting slots are either full or have passed. Check back later for new meeting opportunities.'
                  }
                </Typography>
              </Box>
            ) : (
              <GtkucSlotGrid>
                {gallerySlots.map((slot) => (
                  <GtkucSlotCard
                    key={slot.id}
                    slot={slot}
                    selected={selectedSlot === slot.id}
                    onSelect={setSelectedSlot}
                    actions={
                      slot.remaining > 0 && (
                        <Button
                          variant={selectedSlot === slot.id ? 'contained' : 'outlined'}
                          size="medium"
                          startIcon={<CheckCircleIcon />}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedSlot(slot.id);
                          }}
                          sx={{
                            minHeight: { xs: 44, md: 36 }, // Larger touch target on mobile
                            fontSize: { xs: '0.9rem', md: '0.875rem' },
                            px: { xs: 3, md: 2 }
                          }}
                        >
                          {selectedSlot === slot.id ? 'Selected' : 'Select This Slot'}
                        </Button>
                      )
                    }
                  >
                    {/* Inline Signup Form - appears below selected slot */}
                    {selectedSlot === slot.id && (
                      <Box sx={{ 
                        borderTop: 1, 
                        borderColor: 'divider',
                        bgcolor: 'grey.50',
                        p: { xs: 2, md: 3 }
                      }}>
                        <Typography variant="h6" sx={{ 
                          fontWeight: 600, 
                          mb: 2, 
                          color: 'primary.dark',
                          fontSize: { xs: '1.1rem', md: '1.25rem' }
                        }}>
                          {picking ? 'Move My Meeting Here' : 'Sign Up for This Meeting'}
                        </Typography>

                        <Box component="form" onSubmit={onSubmit}>
                          <Stack spacing={{ xs: 2.5, md: 3 }}>
                            {user ? (
                              <>
                                <Box sx={{ p: 2, borderRadius: 2, bgcolor: 'background.paper', border: 1, borderColor: 'divider' }}>
                                  <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>Signing up as</Typography>
                                  <Stack direction="row" spacing={1} alignItems="center">
                                    <PersonIcon sx={{ color: 'text.secondary', fontSize: 20 }} />
                                    <Typography sx={{ fontWeight: 600 }}>{user.fullName}</Typography>
                                  </Stack>
                                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
                                    <EmailIcon sx={{ color: 'text.secondary', fontSize: 20 }} />
                                    <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>{user.email}</Typography>
                                  </Stack>
                                </Box>

                                {!user.studentId && (
                                  <TextField
                                    fullWidth
                                    label="UCLA Student ID"
                                    placeholder="e.g., 123456789"
                                    value={form.studentId}
                                    onChange={(e) => setForm({ ...form, studentId: e.target.value })}
                                    required
                                    helperText="Your account doesn't have a student ID on file."
                                    InputProps={{
                                      startAdornment: <SchoolIcon sx={{ color: 'text.secondary', mr: 1, fontSize: { xs: 20, md: 18 } }} />
                                    }}
                                  />
                                )}
                              </>
                            ) : (
                              <Alert severity="info" icon={<LockIcon />}>
                                You'll be asked to log in or create an account to confirm your signup.
                              </Alert>
                            )}

                            <Button
                              type="submit"
                              variant="contained"
                              fullWidth
                              size="large"
                              disabled={submitting}
                              sx={{ 
                                mt: 2,
                                minHeight: { xs: 52, md: 44 },
                                fontSize: { xs: '1.1rem', md: '1rem' },
                                py: { xs: 2, md: 1.25 },
                                fontWeight: 600,
                                borderRadius: 2,
                                textTransform: 'none',
                                boxShadow: 2,
                                '&:hover': {
                                  boxShadow: 4,
                                  transform: 'translateY(-1px)'
                                },
                                '&:active': {
                                  transform: 'translateY(0px)'
                                }
                              }}
                            >
                              {picking
                                ? (submitting ? 'Changing...' : 'Confirm New Time')
                                : submitting ? 'Signing Up...' : user ? 'Confirm Signup' : 'Log in & Confirm Signup'}
                            </Button>
                          </Stack>
                        </Box>

                        <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block', textAlign: 'center' }}>
                          {picking
                            ? 'Your old time is released only once the new one is confirmed.'
                            : 'You will receive a confirmation email with meeting details.'}
                        </Typography>
                      </Box>
                    )}
                  </GtkucSlotCard>
                ))}
              </GtkucSlotGrid>
            )}
          </Paper>
        </Grid>
        )}

        {/* Instructions when no slot is selected */}
        {!selectedSlot && !showBooked && (
          <Grid size={12}>
            <Paper sx={{ p: { xs: 2, md: 3 }, textAlign: 'center' }}>
              <PeopleIcon sx={{ fontSize: { xs: 48, md: 60 }, color: 'grey.400', mb: 2 }} />
              <Typography variant="h6" color="text.secondary" sx={{ 
                mb: 1,
                fontSize: { xs: '1.1rem', md: '1.25rem' }
              }}>
                Select a Meeting Slot
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{
                fontSize: { xs: '0.9rem', md: '0.875rem' }
              }}>
                {picking
                  ? 'Choose a new time from the list above. The confirm button will appear right below the slot you pick.'
                  : 'Choose an available time slot from the list above to sign up for a meeting. The signup form will appear right below your selected slot.'}
              </Typography>
            </Paper>
          </Grid>
        )}
      </Grid>
      </Container>

      {/* Log in or create an account, then finish the booking that was waiting */}
      <Dialog open={authOpen} onClose={() => { if (!authSubmitting) setAuthOpen(false); }} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ pb: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <LockIcon color="primary" />
            <span>{authMode === 'login' ? 'Log in to confirm' : 'Create an account'}</span>
          </Stack>
        </DialogTitle>
        <Tabs
          value={authMode}
          onChange={(_, v) => { setAuthMode(v); setAuthError(''); }}
          variant="fullWidth"
          sx={{ px: 2, mt: 1 }}
        >
          <Tab value="login" label="Log in" />
          <Tab value="register" label="Create account" />
        </Tabs>
        <Box component="form" onSubmit={handleAuthSubmit}>
          <DialogContent>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              An account is required to book a Get to Know UC meeting slot.
            </Typography>
            {authError && <Alert severity="error" sx={{ mb: 2 }}>{authError}</Alert>}
            <Stack spacing={2}>
              {authMode === 'register' && (
                <>
                  <TextField
                    label="Full Name"
                    fullWidth
                    required
                    value={authForm.fullName}
                    onChange={(e) => setAuthForm({ ...authForm, fullName: e.target.value })}
                  />
                  <TextField
                    label="Graduation Class"
                    placeholder="e.g., 2027"
                    fullWidth
                    required
                    value={authForm.graduationClass}
                    onChange={(e) => setAuthForm({ ...authForm, graduationClass: e.target.value })}
                  />
                  <TextField
                    label="UCLA Student ID"
                    placeholder="9 digits"
                    fullWidth
                    required
                    value={authForm.studentId}
                    onChange={(e) => setAuthForm({ ...authForm, studentId: e.target.value })}
                  />
                </>
              )}
              <TextField
                label="Email Address"
                type="email"
                fullWidth
                required
                value={authForm.email}
                onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })}
              />
              <TextField
                label="Password"
                type="password"
                fullWidth
                required
                value={authForm.password}
                onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })}
              />
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
              {authMode === 'login' ? (
                <>Don't have an account?{' '}
                  <Link component="button" type="button" onClick={() => { setAuthMode('register'); setAuthError(''); }}>Create one</Link>
                </>
              ) : (
                <>Already have an account?{' '}
                  <Link component="button" type="button" onClick={() => { setAuthMode('login'); setAuthError(''); }}>Log in</Link>
                </>
              )}
            </Typography>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => setAuthOpen(false)} disabled={authSubmitting}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={authSubmitting}>
              {authSubmitting ? 'Please wait…' : authMode === 'login' ? 'Log in & book' : 'Create account & book'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
    </Box>
  );
}


