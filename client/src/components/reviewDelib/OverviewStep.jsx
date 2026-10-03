import {
  Alert,
  Box,
  Chip,
  Grid,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography
} from '@mui/material';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import InsightsIcon from '@mui/icons-material/Insights';
import { DOC_LABELS, DOC_TYPES, percent, plural, score, signed } from '../../utils/reviewDelib';

// Step 1: the team's numbers on one screen. Everything here is computed on the
// server (services/reviewDelibs/teamStats.js); this only lays it out.

const FLAG_ICONS = {
  error: <ErrorOutlineIcon fontSize="small" color="error" />,
  warning: <WarningAmberIcon fontSize="small" color="warning" />,
  info: <InfoOutlinedIcon fontSize="small" color="info" />
};

function Tile({ label, value, detail, tone }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography
        variant="h4"
        sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: tone ? `${tone}.main` : 'text.primary' }}
      >
        {value}
      </Typography>
      {detail && <Typography variant="caption" color="text.secondary">{detail}</Typography>}
    </Paper>
  );
}

/**
 * One document type: every team's mean as a dot on 0–100% of the max, this
 * team's highlighted and labelled, the rest of the cycle as a tick. Position is
 * the only encoding, so it reads the same without colour.
 */
function ComparisonStrip({ type, entry, teamName }) {
  const dots = entry.otherTeams.filter((team) => team.pct !== null);
  const at = (pct) => `${Math.min(100, Math.max(0, pct * 100))}%`;
  const teamPoints = entry.team.mean;
  const lean = entry.delta === null
    ? 'No other teams to compare with yet'
    : `${signed(entry.delta)} pts vs rest of cycle${entry.of >= 2 && entry.rank ? ` · ${ordinal(entry.rank)} harshest of ${entry.of}` : ''}`;

  return (
    <Box sx={{ py: 1.25 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="baseline" spacing={2} sx={{ mb: 0.75 }}>
        <Typography variant="subtitle2">{DOC_LABELS[type]}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'right' }}>
          {teamPoints === null ? 'Not graded yet' : `${score(teamPoints)} / ${score(entry.max)} avg · ${lean}`}
        </Typography>
      </Stack>
      <Box
        role="img"
        aria-label={teamPoints === null
          ? `${DOC_LABELS[type]}: not graded yet`
          : `${DOC_LABELS[type]}: ${teamName} averages ${percent(entry.team.pct)} of the max; the rest of the cycle ${percent(entry.rest.pct)}.`}
        sx={{ position: 'relative', height: 28 }}
      >
        <Box sx={{ position: 'absolute', left: 0, right: 0, top: 13, height: 2, bgcolor: 'divider', borderRadius: 1 }} />
        {entry.rest.pct !== null && (
          <Tooltip title={`Rest of the cycle: ${score(entry.rest.mean)} (${percent(entry.rest.pct)} of max)`}>
            <Box sx={{ position: 'absolute', left: at(entry.rest.pct), top: 4, width: 2, height: 20, ml: '-1px', bgcolor: 'text.secondary', borderRadius: 1 }} />
          </Tooltip>
        )}
        {dots.map((team) => (
          <Tooltip key={team.groupId} title={`${team.name}: ${score(team.mean)} (${percent(team.pct)} of max)`}>
            <Box
              sx={{
                position: 'absolute', left: at(team.pct), top: 8, width: 12, height: 12, ml: '-6px',
                borderRadius: '50%', bgcolor: 'grey.400', border: 2, borderColor: 'background.paper'
              }}
            />
          </Tooltip>
        ))}
        {entry.team.pct !== null && (
          <Tooltip title={`${teamName}: ${score(teamPoints)} (${percent(entry.team.pct)} of max)`}>
            <Box
              sx={{
                position: 'absolute', left: at(entry.team.pct), top: 5, width: 18, height: 18, ml: '-9px',
                borderRadius: '50%', bgcolor: 'primary.main', border: 2, borderColor: 'background.paper', zIndex: 1
              }}
            />
          </Tooltip>
        )}
      </Box>
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="caption" color="text.disabled">0</Typography>
        <Typography variant="caption" color="text.disabled">{score(entry.max)}</Typography>
      </Stack>
    </Box>
  );
}

const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;

function BiasCell({ bias }) {
  if (!bias) return <TableCell align="right" sx={{ color: 'text.disabled' }}>–</TableCell>;
  const notable = Math.abs(bias.pct) >= 0.1;
  return (
    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: notable ? 700 : 400, color: notable ? 'text.primary' : 'text.secondary' }}>
      <Tooltip title={`${signed(bias.points)} pts against teammates on the same ${bias.docs === 1 ? 'document' : `${bias.docs} documents`}`}>
        <span>{signed(bias.points)}</span>
      </Tooltip>
    </TableCell>
  );
}

export default function OverviewStep({ team, isHost, onOpenCandidate }) {
  if (!team) return null;
  const { counts, insights, flags, comparison, graders, group } = team;
  const teamName = group?.name || 'This team';

  return (
    <Stack spacing={3}>
      <Grid container spacing={2}>
        <Grid size={{ xs: 6, md: 2.4 }}>
          <Tile label="Candidates" value={counts.candidates} detail={counts.sealed ? `${counts.sealed} sealed` : null} />
        </Grid>
        <Grid size={{ xs: 6, md: 2.4 }}>
          <Tile
            label="Outlier grades"
            value={counts.outlierGrades}
            detail={counts.outlierCandidates ? `on ${plural(counts.outlierCandidates, 'candidate')}` : 'none'}
            tone={counts.outlierGrades ? 'error' : null}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 2.4 }}>
          <Tile label="Splits" value={counts.splits} detail="wide gap, no clear outlier" tone={counts.splits ? 'warning' : null} />
        </Grid>
        <Grid size={{ xs: 6, md: 2.4 }}>
          <Tile label="Missing grades" value={counts.missing} tone={counts.missing ? 'warning' : null} />
        </Grid>
        <Grid size={{ xs: 12, md: 2.4 }}>
          <Tile label="Overrides" value={counts.overrides} detail={`threshold ${percent(team.thresholdPct)} of max`} />
        </Grid>
      </Grid>

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 6 }}>
          <Paper variant="outlined" sx={{ p: 2.5, height: '100%' }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
              <InsightsIcon color="primary" fontSize="small" />
              <Typography variant="h6" component="h2">What stands out</Typography>
            </Stack>
            {insights.length ? (
              <Stack component="ol" spacing={1.25} sx={{ m: 0, pl: 2.5 }}>
                {insights.map((insight) => (
                  <Typography component="li" key={insight.id} variant="body1">{insight.text}</Typography>
                ))}
              </Stack>
            ) : (
              <Typography color="text.secondary">Not enough grades yet to say anything.</Typography>
            )}

            <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>Needs correcting</Typography>
            {flags.length ? (
              <Stack spacing={0.75}>
                {flags.map((flag) => (
                  <Stack
                    key={flag.id}
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    component={isHost ? 'button' : 'div'}
                    type={isHost ? 'button' : undefined}
                    onClick={isHost ? () => onOpenCandidate(flag.applicationIds[0]) : undefined}
                    data-track={isHost ? `delib-flag-${flag.id}` : undefined}
                    sx={{
                      border: 0, bgcolor: 'transparent', p: 0.5, borderRadius: 1, textAlign: 'left', font: 'inherit', color: 'inherit',
                      cursor: isHost ? 'pointer' : 'default',
                      '&:hover': isHost ? { bgcolor: 'action.hover' } : undefined
                    }}
                  >
                    {FLAG_ICONS[flag.level]}
                    <Typography variant="body2">{flag.text}</Typography>
                  </Stack>
                ))}
              </Stack>
            ) : (
              <Alert severity="success" variant="outlined">Nothing to correct: every grade is in and the team agrees.</Alert>
            )}
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <Paper variant="outlined" sx={{ p: 2.5, height: '100%' }}>
            <Typography variant="h6" component="h2">Against the other teams</Typography>
            <Stack direction="row" spacing={2} sx={{ mt: 0.5, mb: 1 }} alignItems="center" flexWrap="wrap" useFlexGap>
              <Legend swatch={{ width: 12, height: 12, borderRadius: '50%', bgcolor: 'primary.main' }} label={teamName} />
              <Legend swatch={{ width: 10, height: 10, borderRadius: '50%', bgcolor: 'grey.400' }} label="Other teams" />
              <Legend swatch={{ width: 2, height: 14, bgcolor: 'text.secondary' }} label="Rest of cycle" />
            </Stack>
            {DOC_TYPES.map((type) => (
              <ComparisonStrip key={type} type={type} entry={comparison[type]} teamName={teamName} />
            ))}
            <Typography variant="caption" color="text.secondary">
              Average of each candidate’s document score, overrides included. Further left is harsher.
            </Typography>
          </Paper>
        </Grid>
      </Grid>

      <Paper variant="outlined">
        <Box sx={{ p: 2.5, pb: 1 }}>
          <Typography variant="h6" component="h2">Graders</Typography>
          <Typography variant="body2" color="text.secondary">
            Lean is how far each grader sits from their teammates on the same documents, in points. Bold means 10% of the max or more.
          </Typography>
        </Box>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Grader</TableCell>
                <TableCell align="right">Graded</TableCell>
                <TableCell align="right">Outliers</TableCell>
                <TableCell align="right">Splits</TableCell>
                {DOC_TYPES.map((type) => <TableCell key={type} align="right">{DOC_LABELS[type]} lean</TableCell>)}
                <TableCell align="right">Overridden</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {graders.map((grader) => (
                <TableRow key={grader.id}>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <span data-no-track>{grader.name}</span>
                      {!grader.onTeam && <Chip size="small" label="not on team" variant="outlined" />}
                    </Stack>
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{grader.gradedTotal}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: grader.outlierCount ? 700 : 400, color: grader.outlierCount ? 'error.main' : 'text.secondary' }}>
                    {grader.outlierCount ? `${grader.outlierCount} (${grader.outliersHigh}↑ ${grader.outlierCount - grader.outliersHigh}↓)` : '0'}
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{grader.splitCount}</TableCell>
                  {DOC_TYPES.map((type) => <BiasCell key={type} bias={grader.bias[type]} />)}
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{grader.overrides}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
    </Stack>
  );
}

function Legend({ swatch, label }) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      <Box sx={swatch} />
      <Typography variant="caption" color="text.secondary">{label}</Typography>
    </Stack>
  );
}
