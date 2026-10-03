import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
import DelibControlBar from '../components/reviewDelib/DelibControlBar';
import OverviewStep from '../components/reviewDelib/OverviewStep';
import CandidateCard from '../components/reviewDelib/CandidateCard';
import AllCandidatesTable from '../components/reviewDelib/AllCandidatesTable';
import SummaryStep from '../components/reviewDelib/SummaryStep';
import { stepFromParam, stepToParam, walkthroughNeighbour, walkthroughPosition } from '../utils/reviewDelib';

// A review team deliberation, for everyone in it. The rules live in
// server/src/services/reviewDelibs/. Each viewer moves around on their own: the
// step and the open candidate are this page's, kept in the URL
// (?step=outliers&c=<applicationId>) so a refresh keeps your place. What is
// shared is the data, and an admin's changes to it reach everyone.

export default function ReviewDelib() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { refresh: refreshActive } = useReviewDelibs();
  const [snackbar, setSnackbar] = useState(null);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const [params, setParams] = useSearchParams();
  const requestedStep = stepFromParam(params.get('step'));
  const openId = params.get('c') || null;
  // Replace, not push: stepping through twenty candidates should not take twenty Backs to leave.
  const go = useCallback((nextStep, applicationId = null) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set('step', stepToParam(nextStep));
      if (applicationId) next.set('c', applicationId);
      else next.delete('c');
      return next;
    }, { replace: true });
  }, [setParams]);

  // The card loads only on the steps that show one.
  const onError = useCallback((message) => setSnackbar(message), []);
  const showsCard = requestedStep === 'OUTLIERS' || requestedStep === 'ALL';
  const delib = useReviewDelibSession(sessionId, { onError, step: requestedStep, applicationId: showsCard ? openId : null });
  const { state, team } = delib;

  // The join prompt elsewhere in the app reads whether you are in the session.
  useEffect(() => () => refreshActive?.(), [refreshActive]);

  const isHost = Boolean(state?.viewer?.isHost);
  const ended = state?.session?.status === 'ENDED';
  // When it ends, everyone lands on the summary.
  const step = ended ? 'SUMMARY' : requestedStep;
  const leave = () => navigate(user?.role === 'ADMIN' ? '/review-teams' : '/');

  // A sealed or moved candidate has no card; the walk steps past them. Until the
  // team view arrives, assume each one can be shown.
  const canShow = useMemo(() => {
    if (!team?.candidates) return () => true;
    const open = new Set(team.candidates.filter((row) => !row.locked).map((row) => row.applicationId));
    return (applicationId) => open.has(applicationId);
  }, [team]);

  // On the Outliers step, keep the viewer on a candidate the walkthrough lists:
  // the first when they arrive, and the next one along when an admin's
  // threshold change drops theirs. Elsewhere, leave them where they are.
  const order = state?.session?.outlierApplicationIds;
  const orderKey = order ? order.join(',') : null;
  const previousOrder = useRef(null);
  useEffect(() => {
    if (!order) return;
    const before = previousOrder.current ?? order;
    previousOrder.current = order;
    if (step !== 'OUTLIERS') return;
    const target = walkthroughPosition(before, order, openId, canShow);
    if (target !== openId) go('OUTLIERS', target);
  }, [orderKey, step, openId, canShow]); // eslint-disable-line react-hooks/exhaustive-deps

  // Arrow keys walk the outliers, for anyone at the keyboard.
  useEffect(() => {
    if (step !== 'OUTLIERS' || !order) return undefined;
    const onKey = (event) => {
      if (event.target.closest?.('input, textarea, select, [contenteditable="true"], [role="combobox"]')) return;
      const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      const target = direction && walkthroughNeighbour(order, openId, direction, canShow);
      if (target) go('OUTLIERS', target);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, order, openId, canShow, go]);

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
    const walkthrough = state.session.outlierApplicationIds;

    body = (
      <>
        <DelibHeader state={state} step={step} connected={delib.connected} onLeave={leave} onStep={(next) => go(next)} />

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
          <OverviewStep team={team} onOpenCandidate={(applicationId) => go('ALL', applicationId)} />
        )}

        {step === 'OUTLIERS' && (
          walkthrough.length === 0 || !openId ? (
            <Alert severity="success">
              {walkthrough.length === 0 ? 'No outliers or splits at this threshold.' : 'Every candidate in the walkthrough is sealed or has left the team.'}
              {isHost ? ' Move on to all candidates, or change the threshold.' : ' Move on to all candidates.'}
            </Alert>
          ) : (
            <CandidateCard
              {...cardProps}
              header={(
                <Typography variant="overline" color="text.secondary">
                  Outlier {walkthrough.indexOf(openId) + 1} of {walkthrough.length}
                </Typography>
              )}
            />
          )
        )}

        {team && step === 'ALL' && (
          <Stack spacing={3}>
            <AllCandidatesTable
              candidates={team.candidates}
              rankedCount={team.rankedCount}
              currentApplicationId={openId}
              canOpen
              onOpen={(applicationId) => go('ALL', applicationId)}
            />
            {openId ? (
              <CandidateCard {...cardProps} />
            ) : (
              <Typography color="text.secondary" sx={{ textAlign: 'center', py: 2 }}>
                Click a candidate to open it.
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

        {!ended && (
          <DelibControlBar
            state={state}
            step={step}
            applicationId={openId}
            canShow={canShow}
            isHost={isHost}
            busy={delib.busy}
            onStep={(next) => go(next)}
            onOutlier={(applicationId) => go('OUTLIERS', applicationId)}
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
