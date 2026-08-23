import React, { useEffect, useState } from 'react';
import api from '../utils/api';
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
  IconButton
} from '@mui/material';
import {
  Schedule as ScheduleIcon,
  LocationOn as LocationIcon,
  People as PeopleIcon,
  Person as PersonIcon,
  Email as EmailIcon,
  School as SchoolIcon,
  CheckCircle as CheckCircleIcon,
  LinkedIn as LinkedInIcon
} from '@mui/icons-material';

export default function CoffeeChatsPublic() {
  const [slots, setSlots] = useState([]);
  const [allSlots, setAllSlots] = useState([]); // Store all slots for filtering
  const [activeCycle, setActiveCycle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [form, setForm] = useState({ fullName: '', email: '', studentId: '' });
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState('');

  const loadActiveCycle = async () => {
    try {
      // Use public endpoint so it works for all users (members, admins, and unauthenticated)
      const active = await api.get('/active-cycle');
      setActiveCycle(active || null);
      return active || null;
    } catch (e) {
      console.error('Failed to load active cycle:', e);
      return null;
    }
  };

  const filterSlotsByCycle = (slotsToFilter, cycle) => {
    // If no active cycle, return empty array to only show spots from current cycle
    if (!cycle) return [];
    
    // If cycle has date range, filter slots by date
    if (cycle.startDate || cycle.endDate) {
      return slotsToFilter.filter(slot => {
        const slotDate = new Date(slot.startTime);
        const startDate = cycle.startDate ? new Date(cycle.startDate) : null;
        const endDate = cycle.endDate ? new Date(cycle.endDate) : null;
        
        // If cycle has start date, slot must be on or after start date
        if (startDate && slotDate < startDate) return false;
        
        // If cycle has end date, slot must be on or before end date
        if (endDate && slotDate > endDate) return false;
        
        return true;
      });
    }
    
    // If no date range, return empty array to hide old cycle slots
    return [];
  };

  const load = async () => {
    try {
      setLoading(true);
      setError('');
      const data = await api.get('/meeting-slots');
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

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!selectedSlot) return;
    try {
      setSubmitting(true);
      setError('');
      setSuccess('');
      const response = await api.post(`/meeting-slots/${selectedSlot}/signup`, form);
      setSuccess(response.message || 'Successfully signed up! You will receive a confirmation email shortly.');
      
      // If user needs an account, ask if they want to create one
      if (response.needsAccount) {
        const wantsAccount = window.confirm(
          'You successfully signed up for the meeting! Would you like to create an account to track your application status and access more features?'
        );
        if (wantsAccount) {
          window.open('/signup', '_blank');
        }
      }
      
      setForm({ fullName: '', email: '', studentId: '' });
      setSelectedSlot(null);
      await load();
    } catch (e) {
      setError(e.message || 'Failed to sign up for this meeting slot');
    } finally {
      setSubmitting(false);
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
                            <TextField
                              fullWidth
                              label="Full Name"
                              placeholder="Enter your full name"
                              value={form.fullName}
                              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                              required
                              InputProps={{
                                startAdornment: <PersonIcon sx={{ color: 'text.secondary', mr: 1, fontSize: { xs: 20, md: 18 } }} />
                              }}
                              sx={{
                                '& .MuiInputBase-input': {
                                  fontSize: { xs: '1rem', md: '1rem' },
                                  padding: { xs: '16px 14px 16px 0', md: '16px 14px 16px 0' },
                                  minHeight: { xs: '24px', md: '24px' }
                                },
                                '& .MuiInputLabel-root': {
                                  fontSize: { xs: '1rem', md: '1rem' }
                                }
                              }}
                            />

                            <TextField
                              fullWidth
                              label="Email Address"
                              type="email"
                              placeholder="your.email@ucla.edu"
                              value={form.email}
                              onChange={(e) => setForm({ ...form, email: e.target.value })}
                              required
                              InputProps={{
                                startAdornment: <EmailIcon sx={{ color: 'text.secondary', mr: 1, fontSize: { xs: 20, md: 18 } }} />
                              }}
                              sx={{
                                '& .MuiInputBase-input': {
                                  fontSize: { xs: '1rem', md: '1rem' },
                                  padding: { xs: '16px 14px 16px 0', md: '16px 14px 16px 0' },
                                  minHeight: { xs: '24px', md: '24px' }
                                },
                                '& .MuiInputLabel-root': {
                                  fontSize: { xs: '1rem', md: '1rem' }
                                }
                              }}
                            />

                            <TextField
                              fullWidth
                              label="UCLA Student ID"
                              placeholder="e.g., 123456789"
                              value={form.studentId}
                              onChange={(e) => setForm({ ...form, studentId: e.target.value })}
                              required
                              InputProps={{
                                startAdornment: <SchoolIcon sx={{ color: 'text.secondary', mr: 1, fontSize: { xs: 20, md: 18 } }} />
                              }}
                              sx={{
                                '& .MuiInputBase-input': {
                                  fontSize: { xs: '1rem', md: '1rem' },
                                  padding: { xs: '16px 14px 16px 0', md: '16px 14px 16px 0' },
                                  minHeight: { xs: '24px', md: '24px' }
                                },
                                '& .MuiInputLabel-root': {
                                  fontSize: { xs: '1rem', md: '1rem' }
                                }
                              }}
                            />

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
                              {submitting ? 'Signing Up...' : 'Confirm Signup'}
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
    </Box>
  );
}


