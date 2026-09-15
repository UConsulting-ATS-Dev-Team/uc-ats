import { Box, Button, Chip, CircularProgress, Grow, Paper, Stack, Typography } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';

export default function LiveVoteLobby({ state, pendingAction, onBegin, onCancel }) {
  const { participants, session, me } = state;

  return (
    <Paper variant="outlined" sx={{ p: { xs: 3, md: 6 }, textAlign: 'center', borderRadius: 3 }}>
      <Typography variant="overline" color="text.secondary">Waiting to begin</Typography>
      <Typography variant="h3" fontWeight={700} sx={{ my: 1 }}>{participants.presentCount} joined</Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        {session.candidateCount} candidate{session.candidateCount === 1 ? '' : 's'} to vote on.{' '}
        {me.isHost ? 'Begin when the room is ready.' : 'The vote starts when an admin begins it.'}
      </Typography>

      <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1} justifyContent="center" sx={{ mb: 4, minHeight: 40 }}>
        {participants.people.map((person) => (
          <Grow in key={person.id}>
            <Chip label={person.fullName} variant={person.id === me.userId ? 'filled' : 'outlined'} />
          </Grow>
        ))}
      </Stack>

      {me.isHost && (
        <Box>
          <Button
            size="large"
            variant="contained"
            startIcon={pendingAction === 'begin' ? <CircularProgress size={18} color="inherit" /> : <PlayArrowIcon />}
            disabled={Boolean(pendingAction)}
            onClick={onBegin}
            sx={{ px: 5, py: 1.5, fontSize: '1.05rem' }}
          >
            Begin voting
          </Button>
          <Box sx={{ mt: 2 }}>
            <Button color="inherit" size="small" onClick={onCancel} disabled={Boolean(pendingAction)}>
              Cancel session
            </Button>
          </Box>
        </Box>
      )}
    </Paper>
  );
}
