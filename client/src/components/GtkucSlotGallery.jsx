import React from 'react';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  IconButton,
  Stack,
  Typography,
} from '@mui/material';
import {
  EventBusy as EventBusyIcon,
  EditCalendar as EditCalendarIcon,
  LockClock as LockClockIcon,
  LinkedIn as LinkedInIcon,
  LocationOn as LocationIcon,
  Person as PersonIcon,
  Schedule as ScheduleIcon,
} from '@mui/icons-material';

export const formatSlotDateTime = (dateTime) =>
  new Date(dateTime).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Los_Angeles',
  });

// Column count follows the width the grid actually gets, not the viewport, so
// the same grid works on the full-width public page and next to the candidate
// sidebar. At 280px per tile that is one column on phones, two on tablets,
// three on a laptop and four once the page is wide enough. min(100%, ...) keeps
// a single column from overflowing on screens narrower than 280px.
export const GtkucSlotGrid = ({ children }) => (
  <Box
    sx={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))',
      gap: { xs: 1.5, md: 2 },
    }}
  >
    {children}
  </Box>
);

const overlineSx = {
  display: 'block',
  color: 'text.secondary',
  fontWeight: 700,
  letterSpacing: '0.08em',
  lineHeight: 1.6,
};

const SpotsChip = ({ remaining, sx }) => (
  <Chip
    label={remaining === 0 ? 'Full' : `${remaining} ${remaining === 1 ? 'spot' : 'spots'} left`}
    color={remaining === 0 ? 'default' : 'primary'}
    variant={remaining === 0 ? 'outlined' : 'filled'}
    size="small"
    sx={{ flexShrink: 0, fontWeight: 600, ...sx }}
  />
);

// One meeting slot, led by the member hosting it. On phones it keeps the
// avatar-left row layout; from the sm breakpoint up it stacks into a tile with
// the action pinned to the bottom, so tiles in a row line up. `children` renders
// under the action, inside the card (the public page's inline signup form).
export const GtkucSlotCard = ({ slot, selected = false, onSelect, actions, children }) => {
  const clickable = Boolean(onSelect) && slot.remaining > 0;
  const profile = slot.memberProfile;

  return (
    <Card
      variant="outlined"
      onClick={clickable ? () => onSelect(slot.id) : undefined}
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        cursor: clickable ? 'pointer' : 'default',
        opacity: slot.remaining === 0 ? 0.6 : 1,
        border: selected ? 2 : 1,
        borderColor: selected ? 'primary.main' : 'divider',
        transition: 'all 0.2s ease-in-out',
        '&:hover': clickable
          ? { borderColor: 'primary.main', boxShadow: 2, transform: 'translateY(-1px)' }
          : {},
        '&:active': clickable ? { transform: 'translateY(0px)' } : {},
      }}
    >
      <CardContent sx={{ p: { xs: 2, md: 3 }, flexGrow: 1 }}>
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'row', sm: 'column' },
            alignItems: { xs: 'flex-start', sm: 'center' },
            gap: { xs: 2, sm: 1.5 },
          }}
        >
          <Avatar
            src={profile?.photo || undefined}
            alt={slot.memberName}
            sx={{
              width: { xs: 72, md: 92 },
              height: { xs: 72, md: 92 },
              border: '3px solid',
              borderColor: 'primary.light',
              flexShrink: 0,
            }}
          >
            <PersonIcon sx={{ fontSize: { xs: 36, md: 46 } }} />
          </Avatar>

          <Box sx={{ flex: 1, minWidth: 0, width: { sm: '100%' } }}>
            <Box
              sx={{
                display: 'flex',
                justifyContent: { xs: 'space-between', sm: 'center' },
                alignItems: 'flex-start',
                gap: 1,
                mb: 0.5,
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: { sm: 'center' },
                  gap: 0.5,
                  flexWrap: 'wrap',
                }}
              >
                <Typography
                  variant="h6"
                  sx={{
                    fontWeight: 700,
                    fontSize: { xs: '1.15rem', md: '1.35rem' },
                    lineHeight: 1.2,
                    textAlign: { sm: 'center' },
                  }}
                >
                  {slot.memberName}
                </Typography>
                {profile?.linkedinUrl && (
                  <IconButton
                    component="a"
                    href={profile.linkedinUrl}
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
              {/* Phones: chip sits beside the name, as before. */}
              <SpotsChip remaining={slot.remaining} sx={{ display: { xs: 'inline-flex', sm: 'none' } }} />
            </Box>

            {profile?.graduationClass && (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mb: { xs: 1.5, sm: 1 }, textAlign: { sm: 'center' } }}
              >
                Class of {profile.graduationClass}
              </Typography>
            )}

            {/* Tiles: chip centered under the class year. */}
            <Box sx={{ display: { xs: 'none', sm: 'flex' }, justifyContent: 'center', mb: 2 }}>
              <SpotsChip remaining={slot.remaining} />
            </Box>

            <Stack spacing={0.75} sx={{ mb: profile ? 2 : 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <ScheduleIcon sx={{ fontSize: 20, color: 'primary.main' }} />
                <Typography variant="body1" sx={{ fontWeight: 600, fontSize: { xs: '0.95rem', md: '1rem' } }}>
                  {formatSlotDateTime(slot.startTime)}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <LocationIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ fontSize: { xs: '0.9rem', md: '0.925rem' } }}
                >
                  {slot.location}
                </Typography>
              </Box>
            </Stack>

            {profile?.industries?.length > 0 && (
              <Box sx={{ mb: 1.5 }}>
                <Typography variant="overline" sx={overlineSx}>
                  Industry experience
                </Typography>
                <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, mt: 0.5 }}>
                  {profile.industries.map((industry) => (
                    <Chip key={industry} label={industry} size="small" color="primary" variant="outlined" />
                  ))}
                </Stack>
              </Box>
            )}

            {profile?.interests?.length > 0 && (
              <Box>
                <Typography variant="overline" sx={overlineSx}>
                  Interests
                </Typography>
                <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, mt: 0.5 }}>
                  {profile.interests.map((interest) => (
                    <Chip key={interest} label={interest} size="small" variant="outlined" />
                  ))}
                </Stack>
              </Box>
            )}
          </Box>
        </Box>
      </CardContent>
      {actions && (
        <CardActions sx={{ justifyContent: 'center', pb: 2, px: { xs: 2, md: 3 } }}>{actions}</CardActions>
      )}
      {children}
    </Card>
  );
};

// The meeting a candidate already holds. A candidate gets one per cycle, so
// this replaces the slot gallery; moving the meeting goes through "Change
// time", never a second booking. `locked` is true inside the change cutoff.
export const GtkucBookedMeetingCard = ({
  memberName,
  profile,
  startTime,
  location,
  locked = false,
  cutoffHours = 12,
  busy = false,
  onChangeTime,
  onCancel,
}) => (
  <Card variant="outlined" sx={{ border: 2, borderColor: 'primary.main' }}>
    <CardContent sx={{ p: { xs: 2, md: 3 } }}>
      <Chip label="Your meeting" color="primary" size="small" sx={{ mb: 2, fontWeight: 600 }} />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
        <Avatar
          src={profile?.photo || undefined}
          alt={memberName}
          sx={{ width: { xs: 56, md: 72 }, height: { xs: 56, md: 72 }, border: '3px solid', borderColor: 'primary.light' }}
        >
          <PersonIcon sx={{ fontSize: { xs: 28, md: 36 } }} />
        </Avatar>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            Hosted by
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
            <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
              {memberName}
            </Typography>
            {profile?.linkedinUrl && (
              <IconButton
                component="a"
                href={profile.linkedinUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${memberName} on LinkedIn`}
                sx={{ color: '#0A66C2', p: 0.5 }}
              >
                <LinkedInIcon />
              </IconButton>
            )}
          </Box>
          {profile?.graduationClass && (
            <Typography variant="body2" color="text.secondary">
              Class of {profile.graduationClass}
            </Typography>
          )}
        </Box>
      </Box>
      <Stack spacing={0.75}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <ScheduleIcon sx={{ fontSize: 20, color: 'primary.main' }} />
          <Typography variant="body1" sx={{ fontWeight: 600 }}>
            {formatSlotDateTime(startTime)}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <LocationIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
          <Typography variant="body2" color="text.secondary">
            {location}
          </Typography>
        </Box>
      </Stack>
      {locked && (
        <Alert severity="info" icon={<LockClockIcon fontSize="inherit" />} sx={{ mt: 2 }}>
          Changes close {cutoffHours} hours before your meeting, so it can no longer be moved or
          cancelled here. Email uconsultingla@gmail.com if something has come up.
        </Alert>
      )}
    </CardContent>
    <CardActions
      sx={{
        px: { xs: 2, md: 3 },
        pb: 2,
        gap: 1,
        flexDirection: { xs: 'column', sm: 'row' },
        alignItems: 'stretch',
        '& > :not(style) ~ :not(style)': { ml: { xs: 0, sm: 1 } },
      }}
    >
      <Button
        variant="contained"
        startIcon={<EditCalendarIcon />}
        onClick={onChangeTime}
        disabled={locked || busy}
        sx={{ minHeight: { xs: 44, md: 36 } }}
      >
        Change time
      </Button>
      <Button
        variant="outlined"
        color="error"
        startIcon={<EventBusyIcon />}
        onClick={onCancel}
        disabled={locked || busy}
        sx={{ minHeight: { xs: 44, md: 36 } }}
      >
        Cancel meeting
      </Button>
    </CardActions>
  </Card>
);
