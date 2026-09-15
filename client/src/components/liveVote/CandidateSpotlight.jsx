import { Box, Button, Chip, Fade, Paper, Stack, Typography } from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import LockIcon from '@mui/icons-material/Lock';
import Headshot from './Headshot';
import { DECISION_COLORS, decisionLabel } from '../../utils/liveVoteSelection';

export default function CandidateSpotlight({ current, isAdmin, onOpenResume }) {
  const { candidate } = current;
  const details = [candidate.major, candidate.graduationYear ? `Class of ${candidate.graduationYear}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <Fade in key={current.sessionCandidateId} timeout={350}>
      <Paper variant="outlined" sx={{ p: { xs: 3, md: 4 }, borderRadius: 3, height: '100%' }}>
        <Stack alignItems="center" spacing={2} textAlign="center">
          <Headshot src={candidate.headshotUrl} name={candidate.name} size={180} sx={{ boxShadow: 3 }} />
          <Box>
            <Typography variant="h4" fontWeight={700}>{candidate.name}</Typography>
            {details && (
              <Typography variant="h6" color="text.secondary" fontWeight={400} sx={{ mt: 0.5 }}>
                {details}
              </Typography>
            )}
          </Box>

          {candidate.locked ? (
            <Chip icon={<LockIcon />} label="Sealed record" variant="outlined" />
          ) : (
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap justifyContent="center">
              {candidate.resumeUrl && (
                <Button variant="outlined" startIcon={<DescriptionIcon />} onClick={onOpenResume}>
                  Open resume
                </Button>
              )}
              {isAdmin && (
                <Chip
                  label={`Current decision: ${decisionLabel(current.decision)}`}
                  color={DECISION_COLORS[current.decision] || 'default'}
                  variant={current.decision ? 'filled' : 'outlined'}
                />
              )}
            </Stack>
          )}
        </Stack>
      </Paper>
    </Fade>
  );
}
