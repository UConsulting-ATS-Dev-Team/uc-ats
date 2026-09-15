import { Avatar, AvatarGroup, Box, Button, Chip, Stack, Tooltip, Typography } from '@mui/material';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import LogoutIcon from '@mui/icons-material/Logout';
import KeyboardIcon from '@mui/icons-material/Keyboard';

const STATUS_CHIP = {
  LOBBY: { label: 'Lobby', color: 'default' },
  ACTIVE: { label: 'Live', color: 'error' },
  ENDED: { label: 'Ended', color: 'default' }
};

const initialsOf = (name) => name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();

export default function LiveVoteHeader({
  state,
  connected,
  rubricOpen,
  focus,
  onToggleRubric,
  onToggleFocus,
  onShowShortcuts,
  onLeave
}) {
  const { session, participants } = state;
  const chip = STATUS_CHIP[session.status] || STATUS_CHIP.LOBBY;

  return (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      spacing={2}
      alignItems={{ xs: 'flex-start', md: 'center' }}
      justifyContent="space-between"
      sx={{ mb: 3 }}
    >
      <Box>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Typography variant="h5" fontWeight={700}>Live Vote · {session.phaseLabel}</Typography>
          <Chip size="small" label={chip.label} color={chip.color} />
          <Tooltip title={connected ? 'Live updates connected' : 'Updating every couple of seconds'}>
            <Box
              role="status"
              aria-label={connected ? 'Live updates connected' : 'Polling for updates'}
              sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: connected ? 'success.main' : 'warning.main' }}
            />
          </Tooltip>
        </Stack>
        {session.status === 'ACTIVE' && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Candidate {session.currentIndex + 1} of {session.candidateCount}
          </Typography>
        )}
      </Box>

      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Tooltip title={participants.people.map((person) => person.fullName).join(', ') || 'Nobody yet'}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mr: 1 }}>
            <AvatarGroup max={5} sx={{ '& .MuiAvatar-root': { width: 28, height: 28, fontSize: 12 } }}>
              {participants.people.map((person) => (
                <Avatar key={person.id}>{initialsOf(person.fullName)}</Avatar>
              ))}
            </AvatarGroup>
            <Typography variant="body2" color="text.secondary">{participants.presentCount} here</Typography>
          </Stack>
        </Tooltip>
        {state.rubric.length > 0 && (
          <Button
            size="small"
            variant={rubricOpen ? 'contained' : 'outlined'}
            startIcon={<MenuBookIcon />}
            onClick={onToggleRubric}
          >
            Rubric
          </Button>
        )}
        <Tooltip title="Keyboard shortcuts (?)">
          <Button size="small" variant="text" onClick={onShowShortcuts} aria-label="Keyboard shortcuts">
            <KeyboardIcon fontSize="small" />
          </Button>
        </Tooltip>
        <Tooltip title={focus ? 'Exit focus mode (F)' : 'Focus mode (F)'}>
          <Button size="small" variant="text" onClick={onToggleFocus} aria-label="Toggle focus mode">
            {focus ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
          </Button>
        </Tooltip>
        <Button size="small" color="inherit" startIcon={<LogoutIcon />} onClick={onLeave}>
          Leave
        </Button>
      </Stack>
    </Stack>
  );
}
