import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Snackbar,
  Stack,
  Typography
} from '@mui/material';
import { useAuth } from '../context/AuthContext';
import { useReviewDelibs } from '../context/ReviewDelibContext';
import useReviewDelibSession from '../hooks/useReviewDelibSession';
import DelibHeader from '../components/reviewDelib/DelibHeader';
import HostControlBar from '../components/reviewDelib/HostControlBar';
import OverviewStep from '../components/reviewDelib/OverviewStep';
import CandidateCard from '../components/reviewDelib/CandidateCard';
import AllCandidatesTable from '../components/reviewDelib/AllCandidatesTable';
import SummaryStep from '../components/reviewDelib/SummaryStep';

// A review team deliberation, for everyone in it. The rules live in
// server/src/services/reviewDelibs/; this page renders the step the room is on
// and forwards an admin's clicks.

export default function ReviewDelib() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { refresh: refreshActive } = useReviewDelibs();
  const [snackbar, setSnackbar] = useState(null);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const onError = useCallback((message) => setSnackbar(message), []);
  const delib = useReviewDelibSession(sessionId, { onError });
  const { state, team } = delib;

  // The join prompt elsewhere in the app reads whether you are in the session.
  useEffect(() => () => refreshActive?.(), [refreshActive]);

  const isHost = Boolean(state?.viewer?.isHost);
  const ended = state?.session?.status === 'ENDED';
  const step = ended ? 'SUMMARY' : state?.session?.step;
  const leave = () => navigate(user?.role === 'ADMIN' ? '/review-teams' : '/');

  // Arrow keys walk the outliers, for an admin driving from the keyboard.
  useEffect(() => {
    if (!isHost || step !== 'OUTLIERS') return undefined;
    const onKey = (event) => {
      if (event.target.closest?.('input, textarea, select, [contenteditable="true"], [role="combobox"]')) return;
      const order = state.session.outlierApplicationIds;
      const position = order.indexOf(state.session.currentApplicationId);
      if (event.key === 'ArrowRight' && position + 1 < order.length) delib.navigate('OUTLIERS', order[position + 1]);
      if (event.key === 'ArrowLeft' && position > 0) delib.navigate('OUTLIERS', order[position - 1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isHost, step, state, delib]);

  let body;
  if (delib.error) {
    const { code, body: errorBody } = delib.error;
    const message = code === 'NOT_FOUND'
      ? 'This deliberation does not exist.'
      : code === 'NOT_ON_TEAM'
        ? `This deliberation is for ${errorBody?.groupName || 'another review team'}. Only that team and admins can join.`
        : delib.error.serverMessage || delib.error.message;
    body = <Alert severity="error" action={<Button color="inherit" onClick={leave}>Go back</Button>}>{message}</Alert>;
  } else if (!state) {
    body = (
      <Stack alignItems="center" sx={{ py: 10 }} spacing={2}>
        <CircularProgress />
        <Typography color="text.secondary">Joining the deliberation…</Typography>
      </Stack>
    );
  } else {
    const cardProps = {
      card: delib.card,
      error: delib.cardError,
      canEdit: isHost,
      pending: delib.pending,
      onOverride: delib.override,
      onDecide: delib.decide
    };
    const order = state.session.outlierApplicationIds;

    body = (
      <>
        <DelibHeader state={state} connected={delib.connected} onLeave={leave} />

        {delib.teamError && (
          // On every step, the summary included: after a session ends nothing
          // refreshes on its own, and numbers kept from an earlier load must
          // not pass for current ones.
          <Alert
            severity={team ? 'warning' : 'error'}
            sx={{ mb: 2 }}
            action={<Button color="inherit" onClick={delib.reloadTeam}>Try again</Button>}
          >
            {team
              ? 'Could not refresh the team’s numbers. What you see may be out of date.'
              : `Could not load the team’s numbers: ${delib.teamError.serverMessage || delib.teamError.message}`}
          </Alert>
        )}
        {!team && step !== 'SUMMARY' && !delib.teamError && (
          <Stack alignItems="center" sx={{ py: 8 }}><CircularProgress /></Stack>
        )}

        {team && step === 'OVERVIEW' && (
          <OverviewStep team={team} isHost={isHost} onOpenCandidate={(applicationId) => delib.navigate('ALL', applicationId)} />
        )}

        {step === 'OUTLIERS' && (
          order.length === 0 ? (
            <Alert severity="success">
              No outliers or splits at this threshold.{isHost ? ' Move on to all candidates, or lower the threshold.' : ''}
            </Alert>
          ) : (
            <CandidateCard
              {...cardProps}
              header={(
                <Typography variant="overline" color="text.secondary">
                  Outlier {order.indexOf(state.session.currentApplicationId) + 1} of {order.length}
                </Typography>
              )}
            />
          )
        )}

        {team && step === 'ALL' && (
          <Stack spacing={3}>
            <AllCandidatesTable
              candidates={team.candidates}
              currentApplicationId={state.session.currentApplicationId}
              canOpen={isHost}
              onOpen={(applicationId) => delib.navigate('ALL', applicationId)}
            />
            {state.session.currentApplicationId ? (
              <CandidateCard {...cardProps} />
            ) : (
              <Typography color="text.secondary" sx={{ textAlign: 'center', py: 2 }}>
                {isHost ? 'Click a candidate to open it for everyone.' : 'An admin will open a candidate here.'}
              </Typography>
            )}
          </Stack>
        )}

        {step === 'SUMMARY' && (
          <SummaryStep
            changes={delib.changes}
            error={delib.changesError}
            onRetry={delib.reloadChanges}
            team={team}
            isAdmin={user?.role === 'ADMIN'}
            ended={ended}
          />
        )}

        {isHost && !ended && (
          <HostControlBar
            state={state}
            busy={delib.busy}
            onStep={(next) => delib.navigate(next)}
            onOutlier={(applicationId) => delib.navigate('OUTLIERS', applicationId)}
            onThreshold={delib.setThreshold}
            onEnd={() => setConfirmEnd(true)}
          />
        )}
      </>
    );
  }

  return (
    <Box sx={{ p: { xs: 0, md: 1 } }}>
      <Box sx={{ maxWidth: 1400, mx: 'auto' }}>{body}</Box>

      <Dialog open={confirmEnd} onClose={() => setConfirmEnd(false)} maxWidth="xs" fullWidth>
        <DialogTitle>End this deliberation?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Everyone moves to the summary. Score and decision changes are already saved and stay on Staging.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmEnd(false)}>Keep going</Button>
          <Button
            color="error"
            variant="contained"
            onClick={async () => {
              setConfirmEnd(false);
              await delib.end();
            }}
          >
            End deliberation
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(snackbar)}
        autoHideDuration={6000}
        onClose={() => setSnackbar(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="error" onClose={() => setSnackbar(null)} variant="filled">{snackbar}</Alert>
      </Snackbar>
    </Box>
  );
}
