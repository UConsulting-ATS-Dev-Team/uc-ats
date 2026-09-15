import { Box, Button, LinearProgress, Paper, Stack, Typography } from '@mui/material';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import { decisionLabel } from '../../utils/liveVoteSelection';

// The voting surface. While a ballot is open it knows how many have voted and
// nothing else - the server does not send the split - and once closed it shows
// the result to everyone.

// The app theme paints every outlined button in the primary colour, so the
// yes/no colours are pinned here: green and red have to read before anyone votes.
const voteButtonSx = (selected, value, palette) => ({
  flex: 1,
  ...(selected === value
    ? {}
    : {
      color: `${palette}.main`,
      borderColor: `${palette}.main`,
      '&:hover': { borderWidth: 3, borderColor: `${palette}.dark`, bgcolor: `${palette}.light` }
    }),
  minHeight: { xs: 96, md: 128 },
  fontSize: { xs: '1.5rem', md: '2rem' },
  fontWeight: 800,
  letterSpacing: 2,
  borderWidth: 3,
  borderRadius: 3,
  transition: 'transform 120ms ease, opacity 150ms ease',
  opacity: selected === null || selected === value ? 1 : 0.55,
  '&:active': { transform: 'scale(0.98)' }
});

function ResultBar({ label, count, pct, color }) {
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 0.5 }}>
        <Typography variant="h6" fontWeight={700} color={`${color}.main`}>{label}</Typography>
        <Typography variant="h5" fontWeight={800}>
          {count} <Typography component="span" variant="body1" color="text.secondary">({pct}%)</Typography>
        </Typography>
      </Stack>
      <Box sx={{ height: 18, borderRadius: 9, bgcolor: 'action.hover', overflow: 'hidden' }}>
        <Box
          data-testid={`result-bar-${label.toLowerCase()}`}
          sx={{
            width: `${pct}%`,
            height: '100%',
            bgcolor: `${color}.main`,
            borderRadius: 9,
            transition: 'width 600ms cubic-bezier(0.2, 0.8, 0.2, 1)',
            '@media (prefers-reduced-motion: reduce)': { transition: 'none' }
          }}
        />
      </Box>
    </Box>
  );
}

export default function BallotPanel({ ballot, history = [], myVote, voting, isAdmin, onVote }) {
  if (!ballot) {
    return (
      <Paper variant="outlined" sx={{ p: 4, borderRadius: 3, textAlign: 'center', height: '100%' }}>
        <Typography color="text.secondary">Waiting for an admin to open voting…</Typography>
      </Paper>
    );
  }

  if (ballot.status === 'OPEN') {
    const progress = ballot.eligibleCount ? Math.round((ballot.votedCount * 100) / ballot.eligibleCount) : 0;
    return (
      <Paper variant="outlined" sx={{ p: { xs: 3, md: 4 }, borderRadius: 3, height: '100%' }}>
        <Stack spacing={3} sx={{ height: '100%' }} justifyContent="center">
          <Typography variant="overline" color="text.secondary">
            Voting open{ballot.roundNumber > 1 ? ` · Round ${ballot.roundNumber}` : ''}
          </Typography>

          {ballot.canVote ? (
            <>
              <Stack direction="row" spacing={2}>
                <Button
                  variant={myVote === 'YES' ? 'contained' : 'outlined'}
                  color="success"
                  startIcon={<ThumbUpIcon sx={{ fontSize: '2rem !important' }} />}
                  onClick={() => onVote('YES')}
                  aria-pressed={myVote === 'YES'}
                  sx={voteButtonSx(myVote, 'YES', 'success')}
                >
                  YES
                </Button>
                <Button
                  variant={myVote === 'NO' ? 'contained' : 'outlined'}
                  color="error"
                  startIcon={<ThumbDownIcon sx={{ fontSize: '2rem !important' }} />}
                  onClick={() => onVote('NO')}
                  aria-pressed={myVote === 'NO'}
                  sx={voteButtonSx(myVote, 'NO', 'error')}
                >
                  NO
                </Button>
              </Stack>
              <Typography variant="body2" color="text.secondary" aria-live="polite">
                {myVote
                  ? `Your vote: ${myVote}${voting ? ' (sending…)' : ''} — you can change it until voting closes.`
                  : 'Tap Yes or No. Votes are anonymous.'}
              </Typography>
            </>
          ) : (
            <Paper variant="outlined" sx={{ p: 3, bgcolor: 'action.hover', borderRadius: 2 }}>
              <Typography>
                {ballot.cannotVoteReason === 'OWN_RECORD'
                  ? "This is your own application, so you can't vote on it."
                  : 'Rejoin the session to vote.'}
              </Typography>
            </Paper>
          )}

          <Box>
            <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.75 }}>
              <Typography variant="body2" fontWeight={600} aria-live="polite">
                {ballot.votedCount} of {ballot.eligibleCount} have voted
              </Typography>
              <Typography variant="body2" color="text.secondary">{progress}%</Typography>
            </Stack>
            <LinearProgress variant="determinate" value={progress} sx={{ height: 10, borderRadius: 5 }} />
          </Box>
        </Stack>
      </Paper>
    );
  }

  return (
    <Paper variant="outlined" sx={{ p: { xs: 3, md: 4 }, borderRadius: 3, height: '100%' }}>
      <Stack spacing={2.5}>
        <Stack direction="row" justifyContent="space-between" alignItems="baseline">
          <Typography variant="overline" color="text.secondary">
            Results{ballot.roundNumber > 1 ? ` · Round ${ballot.roundNumber}` : ''}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {ballot.yesCount + ballot.noCount} of {ballot.eligibleCount} voted
          </Typography>
        </Stack>
        <ResultBar label="Yes" count={ballot.yesCount} pct={ballot.yesPct} color="success" />
        <ResultBar label="No" count={ballot.noCount} pct={ballot.noPct} color="error" />
        {isAdmin && ballot.decisionApplied && (
          <Typography variant="body2" color="text.secondary">
            Decision applied: <strong>{decisionLabel(ballot.decisionApplied)}</strong>
          </Typography>
        )}
        {history.length > 0 && (
          <Box sx={{ pt: 1, borderTop: 1, borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary">Earlier rounds</Typography>
            {[...history].reverse().map((round) => (
              <Typography key={round.id} variant="body2" color="text.secondary">
                Round {round.roundNumber}: {round.yesCount} yes / {round.noCount} no
              </Typography>
            ))}
          </Box>
        )}
      </Stack>
    </Paper>
  );
}
