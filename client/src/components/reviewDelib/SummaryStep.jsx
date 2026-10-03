import { Alert, Box, Button, CircularProgress, Paper, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { decisionLabel } from '../../utils/liveVoteSelection';
import { DOC_LABELS, plural, score } from '../../utils/reviewDelib';

// Step 4: what the session changed, netted per score and per decision, and what
// is still open.

function describe(change) {
  if (change.kind === 'DECISION') {
    return `Resume Review decision: ${decisionLabel(change.fromValue)} → ${decisionLabel(change.toValue)}`;
  }
  const doc = DOC_LABELS[change.docType]?.toLowerCase() || 'document';
  const from = change.fromValue === null ? score(change.originalScore) : score(Number(change.fromValue));
  const to = change.toValue === null ? `${score(change.originalScore)} (override cleared)` : score(Number(change.toValue));
  return `${change.graderName}’s ${doc} score: ${from} → ${to}`;
}

export default function SummaryStep({ changes, error, onRetry, team, isAdmin, ended }) {
  if (!changes && error) {
    return (
      <Alert severity="error" action={<Button color="inherit" onClick={onRetry}>Try again</Button>}>
        Could not load what changed: {error.serverMessage || error.message}
      </Alert>
    );
  }
  if (!changes) {
    return (
      <Stack alignItems="center" sx={{ py: 8 }}>
        <CircularProgress />
      </Stack>
    );
  }

  const byCandidate = new Map();
  for (const change of changes.changes) {
    if (!byCandidate.has(change.applicationId)) byCandidate.set(change.applicationId, { name: change.candidateName, items: [] });
    byCandidate.get(change.applicationId).items.push(change);
  }
  const open = team?.counts;

  return (
    <Stack spacing={3}>
      <Paper variant="outlined" sx={{ p: 3 }}>
        <Typography variant="h6" component="h2" gutterBottom>
          {ended ? 'Deliberation finished' : 'Summary so far'}
        </Typography>
        <Typography color="text.secondary">
          {changes.changes.length
            ? `${plural(changes.changes.length, 'change')} on ${plural(byCandidate.size, 'candidate')}. They are already live on Staging.`
            : 'No scores or decisions were changed in this session.'}
        </Typography>
        {open && (open.outlierGrades > 0 || open.splits > 0 || open.missing > 0 || open.undecided > 0) && (
          <Alert severity="info" sx={{ mt: 2 }}>
            Still open: {[
              open.outlierGrades ? plural(open.outlierGrades, 'outlier grade') : null,
              open.splits ? plural(open.splits, 'split') : null,
              open.missing ? plural(open.missing, 'missing grade') : null,
              open.undecided ? `${plural(open.undecided, 'candidate')} without a decision` : null
            ].filter(Boolean).join(', ')}.
          </Alert>
        )}
        {isAdmin && (
          <Button component={RouterLink} to="/staging" variant="outlined" sx={{ mt: 2 }}>
            Open Staging
          </Button>
        )}
      </Paper>

      {[...byCandidate.entries()].map(([applicationId, entry]) => (
        <Paper key={applicationId} variant="outlined" sx={{ p: 2.5 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }} data-no-track>{entry.name}</Typography>
          <Box component="ul" sx={{ m: 0, mt: 1, pl: 2.5 }}>
            {entry.items.map((change) => (
              <Typography component="li" key={change.id} variant="body2" sx={{ mb: 0.5 }}>
                {describe(change)}
                <Typography component="span" variant="caption" color="text.secondary"> · {change.byName}</Typography>
              </Typography>
            ))}
          </Box>
        </Paper>
      ))}
    </Stack>
  );
}
