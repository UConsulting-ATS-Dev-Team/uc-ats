import React, { useEffect, useState } from 'react';
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
  Card,
  CardContent,
  CardActions,
  Grid,
  Alert,
  CircularProgress,
  Stack,
  Chip,
  Divider,
  Container,
  Avatar,
  IconButton,
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
  LocationOn as LocationIcon,
  People as PeopleIcon,
  Person as PersonIcon,
  Email as EmailIcon,
  School as SchoolIcon,
  CheckCircle as CheckCircleIcon,
  LinkedIn as LinkedInIcon,
  Lock as LockIcon
} from '@mui/icons-material';

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
    setSubmitting(true);
    setError('');
    setSuccess('');
    try {
      const payload = account?.studentId ? {} : { studentId: form.studentId.trim() };
      const response = await api.post(`/meeting-slots/${slotId}/signup`, payload);
      setSuccess(response.message || 'Successfully signed up! You will receive a confirmation email shortly.');
      setForm({ studentId: '' });
      setSelectedSlot(null);
      await load();
    } catch (e) {
      setError(e.message || 'Failed to sign up for this meeting slot');
    } finally {
      setSubmitting(false);
    }
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
      if (slotId) await bookSlot(slotId, account);
    } catch (err) {
      setAuthError(err.message || 'Authentication failed. Please try again.');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const formatDateTime = (dateTime) => {
    const date = new Date(dateTime);
    return date.toLocaleString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/Los_Angeles'
    });
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
              objectPosition: 'center top',
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
                <strong>Important:</strong> You can only sign up for one meeting slot. If you've already signed up for a different time slot, you'll need to cancel that signup first by reaching out to uconsultingla@gmail.com.
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

      <Container maxWidth="lg" sx={{ py: { xs: 3, md: 4 }, px: { xs: 1.5, md: 3 } }}>

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
        {/* Available Slots */}
        <Grid item xs={12}>
          <Paper sx={{ p: { xs: 2, md: 3 } }}>
            <Typography variant="h5" component="h2" sx={{ fontWeight: 600, mb: 3, color: 'primary.dark', fontSize: { xs: '1.5rem', md: '1.75rem' } }}>
              Available Meeting Slots
            </Typography>

            {loading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
                <CircularProgress />
              </Box>
            ) : availableSlots.length === 0 ? (
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
              <Stack spacing={{ xs: 1.5, md: 2 }}>
                {availableSlots.map((slot) => (
                    <Card 
                    key={slot.id} 
                    variant="outlined"
                    sx={{ 
                      cursor: slot.remaining > 0 ? 'pointer' : 'default',
                      opacity: slot.remaining === 0 ? 0.6 : 1,
                      border: selectedSlot === slot.id ? 2 : 1,
                      borderColor: selectedSlot === slot.id ? 'primary.main' : 'divider',
                      transition: 'all 0.2s ease-in-out',
                      '&:hover': slot.remaining > 0 ? {
                        borderColor: 'primary.main',
                        boxShadow: 2,
                        transform: 'translateY(-1px)'
                      } : {},
                      '&:active': slot.remaining > 0 ? {
                        transform: 'translateY(0px)'
                      } : {}
                    }}
                    onClick={() => slot.remaining > 0 && setSelectedSlot(slot.id)}
                  >
                    <CardContent sx={{ p: { xs: 2, md: 3 } }}>
                      {/* Member-led layout: who you would be meeting comes first. */}
                      <Box sx={{ display: 'flex', gap: { xs: 2, sm: 2.5 }, alignItems: 'flex-start' }}>
                        <Avatar
                          src={slot.memberProfile?.photo || undefined}
                          alt={slot.memberName}
                          sx={{
                            width: { xs: 72, md: 92 },
                            height: { xs: 72, md: 92 },
                            border: '3px solid',
                            borderColor: 'primary.light',
                            flexShrink: 0
                          }}
                        >
                          <PersonIcon sx={{ fontSize: { xs: 36, md: 46 } }} />
                        </Avatar>

                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Box sx={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'flex-start',
                            gap: 1,
                            mb: 0.5
                          }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
                              <Typography
                                variant="h6"
                                sx={{ fontWeight: 700, fontSize: { xs: '1.15rem', md: '1.35rem' }, lineHeight: 1.2 }}
                              >
                                {slot.memberName}
                              </Typography>
                              {slot.memberProfile?.linkedinUrl && (
                                <IconButton
                                  component="a"
                                  href={slot.memberProfile.linkedinUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  aria-label={`${slot.memberName} on LinkedIn`}
                                  onClick={(e) => e.stopPropagation()}
                                  sx={{ color: '#0A66C2', p: 0.5 }}
                                >
                                  <LinkedInIcon sx={{ fontSize: { xs: 26, md: 30 } }} />
                                </IconButton>
                              )}
                            </Box>
                            <Chip
                              label={slot.remaining === 0 ? 'Full' : `${slot.remaining} ${slot.remaining === 1 ? 'spot' : 'spots'} left`}
                              color={slot.remaining === 0 ? 'default' : 'primary'}
                              variant={slot.remaining === 0 ? 'outlined' : 'filled'}
                              size="small"
                              sx={{ flexShrink: 0, fontWeight: 600 }}
                            />
                          </Box>

                          {slot.memberProfile?.graduationClass && (
                            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                              Class of {slot.memberProfile.graduationClass}
                            </Typography>
                          )}

                          <Stack spacing={0.75} sx={{ mb: slot.memberProfile ? 2 : 0 }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                              <ScheduleIcon sx={{ fontSize: 20, color: 'primary.main' }} />
                              <Typography variant="body1" sx={{ fontWeight: 600, fontSize: { xs: '0.95rem', md: '1rem' } }}>
                                {formatDateTime(slot.startTime)}
                              </Typography>
                            </Box>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                              <LocationIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                              <Typography variant="body2" color="text.secondary" sx={{ fontSize: { xs: '0.9rem', md: '0.925rem' } }}>
                                {slot.location}
                              </Typography>
                            </Box>
                          </Stack>

                          {slot.memberProfile?.industries?.length > 0 && (
                            <Box sx={{ mb: 1.5 }}>
                              <Typography
                                variant="overline"
                                sx={{ display: 'block', color: 'text.secondary', fontWeight: 700, letterSpacing: '0.08em', lineHeight: 1.6 }}
                              >
                                Industry experience
                              </Typography>
                              <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, mt: 0.5 }}>
                                {slot.memberProfile.industries.map((industry) => (
                                  <Chip key={industry} label={industry} size="small" color="primary" variant="outlined" />
                                ))}
                              </Stack>
                            </Box>
                          )}

                          {slot.memberProfile?.interests?.length > 0 && (
                            <Box>
                              <Typography
                                variant="overline"
                                sx={{ display: 'block', color: 'text.secondary', fontWeight: 700, letterSpacing: '0.08em', lineHeight: 1.6 }}
                              >
                                Interests
                              </Typography>
                              <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, mt: 0.5 }}>
                                {slot.memberProfile.interests.map((interest) => (
                                  <Chip key={interest} label={interest} size="small" variant="outlined" />
                                ))}
                              </Stack>
                            </Box>
                          )}
                        </Box>
                      </Box>
                    </CardContent>
                    {slot.remaining > 0 && (
                      <CardActions sx={{ 
                        justifyContent: 'center', 
                        pb: 2,
                        px: { xs: 2, md: 3 }
                      }}>
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
                      </CardActions>
                    )}

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
                          Sign Up for This Meeting
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
                              {submitting ? 'Signing Up...' : user ? 'Confirm Signup' : 'Log in & Confirm Signup'}
                            </Button>
                          </Stack>
                        </Box>

                        <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block', textAlign: 'center' }}>
                          You will receive a confirmation email with meeting details.
                        </Typography>
                      </Box>
                    )}
                  </Card>
                ))}
              </Stack>
            )}
          </Paper>
        </Grid>

        {/* Instructions when no slot is selected */}
        {!selectedSlot && (
          <Grid item xs={12}>
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
                Choose an available time slot from the list above to sign up for a meeting. The signup form will appear right below your selected slot.
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


