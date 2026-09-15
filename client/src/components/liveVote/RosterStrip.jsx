import { Badge, Box, ButtonBase, Stack, Tooltip, Typography } from '@mui/material';
import Headshot from './Headshot';
import { decisionLabel } from '../../utils/liveVoteSelection';

// Every candidate in the session, for the admins running it: where the room is,
// what has been voted on, and a click to jump.

const statusOf = (entry) => {
  if (entry.hasOpenBallot) return { color: 'warning', label: 'Voting open' };
  if (entry.decisionApplied) return { color: 'success', label: `Decided: ${decisionLabel(entry.decisionApplied)}` };
  if (entry.latest) return { color: 'info', label: `Voted: ${entry.latest.yesCount} yes / ${entry.latest.noCount} no` };
  return { color: 'default', label: 'Not voted yet' };
};

export default function RosterStrip({ roster, currentIndex, disabled, onJump }) {
  return (
    <Box sx={{ mt: 3 }}>
      <Typography variant="caption" color="text.secondary">Candidates in this session</Typography>
      <Stack direction="row" spacing={1.5} sx={{ overflowX: 'auto', py: 1, px: 0.5 }}>
        {roster.map((entry) => {
          const status = statusOf(entry);
          const isCurrent = entry.position === currentIndex;
          return (
            <Tooltip key={entry.sessionCandidateId} title={`${entry.name} · ${status.label}`}>
              <ButtonBase
                onClick={() => !isCurrent && onJump(entry.position)}
                disabled={disabled}
                aria-current={isCurrent ? 'true' : undefined}
                aria-label={`${entry.position + 1}. ${entry.name}, ${status.label}`}
                sx={{
                  borderRadius: '50%',
                  outline: isCurrent ? '3px solid' : 'none',
                  outlineColor: 'primary.main',
                  outlineOffset: 2,
                  flexShrink: 0
                }}
              >
                <Badge
                  variant="dot"
                  color={status.color === 'default' ? 'secondary' : status.color}
                  invisible={status.color === 'default'}
                  overlap="circular"
                  anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                >
                  <Headshot src={entry.headshotUrl} name={entry.name} size={44} />
                </Badge>
              </ButtonBase>
            </Tooltip>
          );
        })}
      </Stack>
    </Box>
  );
}
