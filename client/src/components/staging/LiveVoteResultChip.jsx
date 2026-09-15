import { Box, Chip, Tooltip, Typography } from '@mui/material';
import HowToVoteIcon from '@mui/icons-material/HowToVote';
import { ballotTone, formatBallotLine, latestBallot } from '../../utils/liveVoteSelection';

// The live vote record behind a Staging decision: the latest result on the
// chip, every round in the tooltip.
export default function LiveVoteResultChip({ ballots }) {
  const latest = latestBallot(ballots);
  if (!latest) return null;

  return (
    <Tooltip
      arrow
      title={
        <Box sx={{ py: 0.5 }}>
          <Typography variant="caption" fontWeight={700} display="block">Live vote history</Typography>
          {ballots.map((ballot, index) => (
            <Typography key={`${ballot.sessionId}-${ballot.roundNumber}-${index}`} variant="caption" display="block">
              {formatBallotLine(ballot)}
            </Typography>
          ))}
        </Box>
      }
    >
      <Chip
        size="small"
        variant="outlined"
        icon={<HowToVoteIcon />}
        color={ballotTone(latest)}
        label={`Vote ${latest.yesCount}–${latest.noCount}`}
        sx={{ mt: 0.5, fontWeight: 600 }}
      />
    </Tooltip>
  );
}
