import { useEffect, useState } from 'react';
import { AvatarGroup, Box, Button, Chip, Paper, Stack, Tooltip, Typography } from '@mui/material';
import TimerOutlinedIcon from '@mui/icons-material/TimerOutlined';
import Headshot from '../liveVote/Headshot';
import { MEETING_MS, STEPS, elapsed } from '../../utils/reviewDelib';

// Which team, which step you are on, how long it has been going, and who is
// here. Team members who have not joined show faded, so the admin can see who
// is missing. The steps are yours to move between; nobody else moves with you.

function useClock(serverNow) {
  // Measured against the server's clock, so a laptop running fast does not
  // show the meeting overrunning.
  const [skew] = useState(() => (serverNow ? serverNow - Date.now() : 0));
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + skew), 1000);
    return () => clearInterval(timer);
  }, [skew]);
  return now;
}

export default function DelibHeader({ state, step, connected, onLeave, onStep }) {
  const { session, participants } = state;
  const now = useClock(state.now);
  const ended = session.status === 'ENDED';
  const running = (ended ? new Date(session.endedAt).getTime() : now) - new Date(session.startedAt).getTime();
  const over = !ended && running > MEETING_MS;
  const stepIndex = STEPS.findIndex((entry) => entry.id === step);
  const here = participants.filter((person) => person.present);
  const missing = participants.filter((person) => person.isTeamMember && !person.present);

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, md: 2.5 }, mb: 3 }}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }} justifyContent="space-between">
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1.4 }}>
            Review team deliberation{session.createdByName ? ` · started by ${session.createdByName}` : ''}
          </Typography>
          <Typography variant="h5" component="h1" sx={{ fontWeight: 700 }} noWrap>
            {session.groupName}
          </Typography>
        </Box>

        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <Tooltip title={ended ? 'How long it ran' : 'Ten minutes is the target'}>
            <Chip
              icon={<TimerOutlinedIcon />}
              label={elapsed(running)}
              color={over ? 'warning' : 'default'}
              variant={over ? 'filled' : 'outlined'}
              sx={{ fontVariantNumeric: 'tabular-nums' }}
            />
          </Tooltip>
          <Tooltip
            title={[
              here.length ? `Here: ${here.map((person) => person.name).join(', ')}` : 'Nobody else here yet',
              missing.length ? `Not here: ${missing.map((person) => person.name).join(', ')}` : null,
              connected ? null : 'Live updates are off; refreshing every couple of seconds'
            ].filter(Boolean).join(' · ')}
          >
            <AvatarGroup max={8} sx={{ '& .MuiAvatar-root': { width: 32, height: 32, fontSize: 12 } }}>
              {[...here, ...missing].map((person) => (
                <Headshot
                  key={person.userId}
                  src={person.profileImage}
                  name={person.name}
                  size={32}
                  sx={{ opacity: person.present ? 1 : 0.35 }}
                />
              ))}
            </AvatarGroup>
          </Tooltip>
          <Button size="small" onClick={onLeave}>Leave</Button>
        </Stack>
      </Stack>

      <Stack direction="row" spacing={0.75} sx={{ mt: 2, overflowX: 'auto' }} role="list" aria-label="Steps">
        {STEPS.map((entry, index) => (
          <Chip
            key={entry.id}
            role="listitem"
            aria-current={index === stepIndex ? 'step' : undefined}
            label={`${index + 1}. ${entry.label}`}
            size="small"
            color={index === stepIndex ? 'primary' : 'default'}
            variant={index === stepIndex ? 'filled' : 'outlined'}
            // Once it has ended there is only the summary to see.
            onClick={!ended && index !== stepIndex ? () => onStep(entry.id) : undefined}
            sx={{ opacity: index < stepIndex ? 0.7 : 1 }}
          />
        ))}
      </Stack>
    </Paper>
  );
}
