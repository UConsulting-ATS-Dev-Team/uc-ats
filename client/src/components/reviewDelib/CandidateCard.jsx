import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography
} from '@mui/material';
import Headshot from '../liveVote/Headshot';
import DocumentPanel from './DocumentPanel';
import ScoreCell from './ScoreCell';
import { DECISION_COLORS, DECISION_OPTIONS, decisionLabel } from '../../utils/liveVoteSelection';
import { DOC_LABELS, DOC_TYPES, score } from '../../utils/reviewDelib';

// One candidate on one screen: who they are, their documents, and every
// grader's score on each, with the Resume Review decision. The room sees the
// same card; only an admin running the session can change anything on it.

export function DecisionControl({ value, canEdit, saving, onChange }) {
  if (!canEdit) {
    return (
      <Chip
        label={`Resume Review: ${decisionLabel(value)}`}
        color={value ? DECISION_COLORS[value] : 'default'}
        variant={value ? 'filled' : 'outlined'}
      />
    );
  }
  return (
    <FormControl size="small" sx={{ minWidth: 200 }}>
      <InputLabel id="delib-decision-label">Resume Review decision</InputLabel>
      <Select
        labelId="delib-decision-label"
        label="Resume Review decision"
        value={value || ''}
        disabled={saving}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <MenuItem value=""><em>Pending</em></MenuItem>
        {DECISION_OPTIONS.map((option) => (
          <MenuItem key={option} value={option}>{decisionLabel(option)}</MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

export default function CandidateCard({ card, error, canEdit, pendingAction, onOverride, onDecide, header }) {
  if (error) {
    const message = error.code === 'RECORD_LOCKED'
      ? 'This candidate’s record is sealed.'
      : error.serverMessage || error.message || 'Could not load this candidate.';
    return <Alert severity="warning">{message}</Alert>;
  }
  if (!card) {
    return (
      <Stack alignItems="center" sx={{ py: 8 }}>
        <CircularProgress />
      </Stack>
    );
  }

  const facts = [
    [card.major, card.major2].filter(Boolean).join(' & '),
    card.year ? `Class of ${card.year}` : null,
    card.gpa ? `GPA ${card.gpa}` : null
  ].filter(Boolean);

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
      {header}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2.5} alignItems={{ sm: 'center' }} justifyContent="space-between" sx={{ mb: 3 }}>
        <Stack direction="row" spacing={2} alignItems="center" sx={{ minWidth: 0 }}>
          <Headshot src={card.headshotUrl} name={card.name} size={72} />
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h5" component="h2" sx={{ fontWeight: 700 }} data-no-track>{card.name}</Typography>
            <Typography color="text.secondary">{facts.join(' · ')}</Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 0.75 }} flexWrap="wrap" useFlexGap>
              <Chip size="small" variant="outlined" label={`Documents total ${score(card.total)}`} />
              {card.outlierCount > 0 && <Chip size="small" color="error" label={`${card.outlierCount} outlier${card.outlierCount === 1 ? '' : 's'}`} />}
              {card.splitDocs > 0 && <Chip size="small" color="warning" label={`${card.splitDocs} split`} />}
            </Stack>
          </Box>
        </Stack>
        <DecisionControl
          value={card.resumeDecision}
          canEdit={canEdit}
          saving={pendingAction === `decide:${card.applicationId}`}
          onChange={(decision) => onDecide(card.applicationId, decision)}
        />
      </Stack>

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 5 }}>
          <Stack spacing={2.5}>
            {DOC_TYPES.filter((type) => card.docs[type].has || card.docs[type].rows.length).map((type) => {
              const doc = card.docs[type];
              return (
                <Box key={type} component="section" aria-label={`${DOC_LABELS[type]} scores`}>
                  <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 1 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{DOC_LABELS[type]}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      avg {score(doc.avg)} / {score(doc.max)}
                    </Typography>
                  </Stack>
                  {doc.rows.length ? (
                    <Stack spacing={1}>
                      {doc.rows.map((row) => (
                        <ScoreCell
                          key={row.scoreId}
                          row={row}
                          max={doc.max}
                          canEdit={canEdit}
                          saving={pendingAction === `override:${row.scoreId}`}
                          onSave={(value) => onOverride(type, row.scoreId, value)}
                        />
                      ))}
                    </Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary">Not graded yet.</Typography>
                  )}
                </Box>
              );
            })}
          </Stack>
        </Grid>
        <Grid size={{ xs: 12, md: 7 }}>
          <DocumentPanel card={card} />
        </Grid>
      </Grid>
    </Paper>
  );
}
