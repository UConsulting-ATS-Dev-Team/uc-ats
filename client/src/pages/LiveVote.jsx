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
  Grid,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Typography
} from '@mui/material';
import { useAuth } from '../context/AuthContext';
import { useLiveVote } from '../context/LiveVoteContext';
import useLiveVoteSession from '../hooks/useLiveVoteSession';
import useLiveVoteShortcuts from '../hooks/useLiveVoteShortcuts';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import LiveVoteHeader from '../components/liveVote/LiveVoteHeader';
import LiveVoteLobby from '../components/liveVote/LiveVoteLobby';
import CandidateSpotlight from '../components/liveVote/CandidateSpotlight';
import BallotPanel from '../components/liveVote/BallotPanel';
import HostControlBar from '../components/liveVote/HostControlBar';
import RosterStrip from '../components/liveVote/RosterStrip';
import RubricPanel from '../components/liveVote/RubricPanel';
import SessionSummary from '../components/liveVote/SessionSummary';
import { DECISION_OPTIONS } from '../utils/liveVoteSelection';

// A live vote session, for everyone in it. See server/src/services/liveVotes.js
// for the rules; this page only renders the state it is given and forwards
// clicks and keys.

const SHORTCUTS = [
  ['Y / N', 'Vote yes / no'],
  ['C', 'Close voting (admins)'],
  ['O', 'Re-open voting (admins)'],
  ['← / →', 'Previous / next candidate (admins)'],
  ['1 – 4', 'Yes, Maybe Yes, Maybe No, No (admins)'],
  ['R', 'Show or hide the rubric'],
  ['F', 'Focus mode'],
  ['?', 'This list']
];

export default function LiveVote() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { refresh: refreshActive } = useLiveVote();
  const [snackbar, setSnackbar] = useState(null);
  const [rubricOpen, setRubricOpen] = useState(false);
  const [focus, setFocus] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const onError = useCallback((message) => setSnackbar({ severity: 'error', message }), []);
  const live = useLiveVoteSession(sessionId, { onError });
  const { state } = live;

  // The join prompt elsewhere in the app reads whether you are in the session.
  useEffect(() => () => refreshActive?.(), [refreshActive]);

  const isHost = Boolean(state?.me?.isHost);
  const status = state?.session?.status;
  const ballotOpen = state?.current?.ballot?.status === 'OPEN';

  const go = useCallback((toIndex) => {
    if (!state) return;
    if (toIndex < 0 || toIndex >= state.session.candidateCount) return;
    if (ballotOpen) {
      setConfirm({
        title: 'Close voting and move on?',
        body: 'Voting on this candidate is still open. Moving on closes it and records the votes cast so far.',
        confirmLabel: 'Close and move on',
        action: () => live.navigate(toIndex)
      });
      return;
    }
    live.navigate(toIndex);
  }, [state, ballotOpen, live]);

  const askEnd = useCallback(() => {
    setConfirm({
      title: status === 'LOBBY' ? 'Cancel this live vote?' : 'End this live vote?',
      body: ballotOpen
        ? 'Voting is still open on the current candidate. Ending closes it and records the votes cast so far.'
        : 'Everyone will see the session summary. Results stay on the Staging page.',
      confirmLabel: status === 'LOBBY' ? 'Cancel session' : 'End session',
      destructive: true,
      action: () => live.end()
    });
  }, [status, ballotOpen, live]);

  const leave = () => navigate(user?.role === 'ADMIN' ? '/staging' : '/');

  const hostKeys = isHost && status === 'ACTIVE'
    ? {
      c: () => ballotOpen && live.close(),
      o: () => !ballotOpen && live.reopen(),
      ArrowLeft: () => go(state.session.currentIndex - 1),
      ArrowRight: () => go(state.session.currentIndex + 1),
      ...Object.fromEntries(DECISION_OPTIONS.map((decision, index) => [
        String(index + 1),
        () => !ballotOpen && live.decide(decision)
      ]))
    }
    : {};

  useLiveVoteShortcuts({
    y: () => live.vote('YES'),
    n: () => live.vote('NO'),
    r: () => state?.rubric?.length && setRubricOpen((open) => !open),
    f: () => setFocus((value) => !value),
    '?': () => setShortcutsOpen(true),
    Enter: () => isHost && status === 'LOBBY' && live.begin(),
    ...hostKeys
  }, { enabled: Boolean(state) && !resumeOpen });

  let body;
  if (live.error) {
    const message = live.error.code === 'NOT_FOUND'
      ? 'This live vote does not exist.'
      : live.error.serverMessage || live.error.message;
    body = (
      <Alert severity="error" action={<Button color="inherit" onClick={leave}>Go back</Button>}>{message}</Alert>
    );
  } else if (!state) {
    body = (
      <Stack alignItems="center" sx={{ py: 10 }} spacing={2}>
        <CircularProgress />
        <Typography color="text.secondary">Joining the live vote…</Typography>
      </Stack>
    );
  } else {
    body = (
      <>
        <LiveVoteHeader
          state={state}
          connected={live.connected}
          rubricOpen={rubricOpen}
          focus={focus}
          onToggleRubric={() => setRubricOpen((open) => !open)}
          onToggleFocus={() => setFocus((value) => !value)}
          onShowShortcuts={() => setShortcutsOpen(true)}
          onLeave={leave}
        />
        <Stack direction="row" spacing={3} alignItems="stretch">
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {status === 'LOBBY' && (
              <LiveVoteLobby state={state} pendingAction={live.pendingAction} onBegin={live.begin} onCancel={askEnd} />
            )}

            {status === 'ACTIVE' && state.current && (
              <>
                <Grid container spacing={3}>
                  <Grid size={{ xs: 12, md: 5 }}>
                    <CandidateSpotlight
                      current={state.current}
                      isAdmin={state.me.isAdmin}
                      onOpenResume={() => setResumeOpen(true)}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, md: 7 }}>
                    <BallotPanel
                      ballot={state.current.ballot}
                      history={state.current.history}
                      myVote={live.myVote}
                      voting={live.voting}
                      isAdmin={state.me.isAdmin}
                      onVote={live.vote}
                    />
                  </Grid>
                </Grid>
                {isHost && (
                  <>
                    <RosterStrip
                      roster={state.roster}
                      currentIndex={state.session.currentIndex}
                      disabled={Boolean(live.pendingAction)}
                      onJump={go}
                    />
                    <HostControlBar
                      state={state}
                      pendingAction={live.pendingAction}
                      onPrev={() => go(state.session.currentIndex - 1)}
                      onNext={() => go(state.session.currentIndex + 1)}
                      onClose={live.close}
                      onReopen={live.reopen}
                      onDecide={live.decide}
                      onEnd={askEnd}
                    />
                  </>
                )}
              </>
            )}

            {status === 'ENDED' && <SessionSummary state={state} onBack={leave} />}
          </Box>
          <RubricPanel open={rubricOpen} rubric={state.rubric} onClose={() => setRubricOpen(false)} />
        </Stack>
      </>
    );
  }

  return (
    <Box
      sx={focus
        ? {
          position: 'fixed',
          inset: 0,
          zIndex: (theme) => theme.zIndex.drawer + 2,
          bgcolor: 'background.default',
          overflowY: 'auto',
          p: { xs: 2, md: 4 },
          pt: { xs: 'calc(16px + env(safe-area-inset-top, 0px))', md: 'calc(32px + env(safe-area-inset-top, 0px))' }
        }
        : { p: { xs: 0, md: 1 } }}
    >
      <Box sx={{ maxWidth: 1400, mx: 'auto' }}>{body}</Box>

      {resumeOpen && state?.current?.candidate?.resumeUrl && (
        <DocumentPreviewModal
          src={state.current.candidate.resumeUrl}
          kind="pdf"
          title={`${state.current.candidate.name} — Resume`}
          onClose={() => setResumeOpen(false)}
        />
      )}

      <Dialog open={Boolean(confirm)} onClose={() => setConfirm(null)} maxWidth="xs" fullWidth>
        {confirm && (
          <>
            <DialogTitle>{confirm.title}</DialogTitle>
            <DialogContent>
              <DialogContentText>{confirm.body}</DialogContentText>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setConfirm(null)}>Keep going</Button>
              <Button
                variant="contained"
                color={confirm.destructive ? 'error' : 'primary'}
                autoFocus
                onClick={() => {
                  confirm.action();
                  setConfirm(null);
                }}
              >
                {confirm.confirmLabel}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      <Dialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogContent>
          <Table size="small">
            <TableBody>
              {SHORTCUTS.map(([keys, label]) => (
                <TableRow key={keys}>
                  <TableCell sx={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{keys}</TableCell>
                  <TableCell>{label}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShortcutsOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(snackbar)}
        autoHideDuration={4000}
        onClose={() => setSnackbar(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        {snackbar ? <Alert severity={snackbar.severity} onClose={() => setSnackbar(null)}>{snackbar.message}</Alert> : undefined}
      </Snackbar>
    </Box>
  );
}
