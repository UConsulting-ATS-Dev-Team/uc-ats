import {
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography
} from '@mui/material';
import Headshot from './Headshot';
import { DECISION_COLORS, decisionLabel } from '../../utils/liveVoteSelection';

export default function SessionSummary({ state, onBack }) {
  const { roster, me, session } = state;

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, md: 4 }, borderRadius: 3 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={2} sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h5" fontWeight={700}>Session ended</Typography>
          <Typography variant="body2" color="text.secondary">
            {session.phaseLabel} · {session.candidateCount} candidate{session.candidateCount === 1 ? '' : 's'}
          </Typography>
        </Box>
        <Button variant="contained" onClick={onBack} sx={{ alignSelf: { sm: 'center' } }}>
          {me.isAdmin ? 'Back to Staging' : 'Back to dashboard'}
        </Button>
      </Stack>

      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Candidate</TableCell>
              <TableCell align="right">Yes</TableCell>
              <TableCell align="right">No</TableCell>
              <TableCell align="right">Rounds</TableCell>
              {me.isAdmin && <TableCell>Decision</TableCell>}
            </TableRow>
          </TableHead>
          <TableBody>
            {roster.map((entry) => (
              <TableRow key={entry.sessionCandidateId}>
                <TableCell>
                  <Stack direction="row" spacing={1.5} alignItems="center">
                    <Headshot src={entry.headshotUrl} name={entry.name} size={32} />
                    <Typography variant="body2" fontWeight={600}>{entry.name}</Typography>
                  </Stack>
                </TableCell>
                <TableCell align="right">{entry.latest ? entry.latest.yesCount : '—'}</TableCell>
                <TableCell align="right">{entry.latest ? entry.latest.noCount : '—'}</TableCell>
                <TableCell align="right">{entry.rounds}</TableCell>
                {me.isAdmin && (
                  <TableCell>
                    <Chip
                      size="small"
                      label={decisionLabel(entry.decision)}
                      color={DECISION_COLORS[entry.decision] || 'default'}
                      variant={entry.decision ? 'filled' : 'outlined'}
                    />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}
