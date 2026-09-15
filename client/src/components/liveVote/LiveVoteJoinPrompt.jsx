import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Fab,
  Grow,
  Typography
} from '@mui/material';
import HowToVoteIcon from '@mui/icons-material/HowToVote';

// The "a live vote has started" popup, and the pill that stays in the corner
// until the session ends so "Not now" is never a way to lose the room.

const pulse = {
  width: 10,
  height: 10,
  borderRadius: '50%',
  bgcolor: 'error.main',
  flexShrink: 0,
  animation: 'liveVotePulse 1.6s ease-in-out infinite',
  '@keyframes liveVotePulse': {
    '0%': { boxShadow: '0 0 0 0 rgba(211, 47, 47, 0.6)' },
    '70%': { boxShadow: '0 0 0 10px rgba(211, 47, 47, 0)' },
    '100%': { boxShadow: '0 0 0 0 rgba(211, 47, 47, 0)' }
  },
  '@media (prefers-reduced-motion: reduce)': { animation: 'none' }
};

export default function LiveVoteJoinPrompt({ session, promptOpen, onJoin, onDismiss }) {
  const summary = [
    session.phaseLabel,
    `${session.candidateCount} candidate${session.candidateCount === 1 ? '' : 's'}`,
    session.createdByName ? `started by ${session.createdByName}` : null
  ].filter(Boolean).join(' · ');

  return (
    <>
      <Dialog
        open={promptOpen}
        onClose={onDismiss}
        TransitionComponent={Grow}
        maxWidth="xs"
        fullWidth
        aria-labelledby="live-vote-prompt-title"
      >
        <DialogTitle id="live-vote-prompt-title" sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box sx={pulse} aria-hidden="true" />
          A live vote has started
        </DialogTitle>
        <DialogContent>
          <Typography variant="body1" gutterBottom>
            Please join the session so your vote counts.
          </Typography>
          <Typography variant="body2" color="text.secondary">{summary}</Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={onDismiss}>Not now</Button>
          <Button variant="contained" startIcon={<HowToVoteIcon />} onClick={onJoin} autoFocus>
            Join live vote
          </Button>
        </DialogActions>
      </Dialog>

      {!promptOpen && (
        <Fab
          variant="extended"
          color="primary"
          onClick={onJoin}
          aria-label={session.joined ? 'Return to live vote' : 'Join live vote'}
          sx={{
            position: 'fixed',
            right: 24,
            bottom: 'calc(24px + env(safe-area-inset-bottom, 0px))',
            zIndex: (theme) => theme.zIndex.snackbar,
            gap: 1.25,
            textTransform: 'none',
            fontWeight: 600
          }}
        >
          <Box sx={pulse} aria-hidden="true" />
          {session.joined ? 'Return to live vote' : 'Join live vote'}
        </Fab>
      )}
    </>
  );
}
