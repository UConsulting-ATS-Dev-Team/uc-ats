import express from 'express';
import { requireAuth, requireAdmin, requireAdminOrMember } from '../middleware/auth.js';
import {
  applyDecision,
  beginSession,
  castVote,
  closeBallot,
  endSession,
  getActiveSession,
  getRubrics,
  getState,
  joinSession,
  launchSession,
  leaveSession,
  navigateSession,
  reopenBallot,
  saveRubric
} from '../services/liveVotes.js';

// Live vote deliberations. The rules live in services/liveVotes.js; this file
// only maps HTTP onto them. Members and admins both reach the router because
// both join and vote; running a session is admin-only, checked here for the
// role and again in the service for "has joined".

const router = express.Router();

router.use(requireAuth, requireAdminOrMember);

// Services throw errors carrying status and code, plus extras such as the
// rejected candidates on a launch or the id of the session already running.
const liveVoteRoute = (label, handler, { successStatus = 200 } = {}) => async (req, res) => {
  try {
    const result = await handler(req);
    if (result === undefined) return res.status(204).end();
    res.status(successStatus).json(result);
  } catch (error) {
    if (!error.status) {
      console.error(`[${label}]`, error);
      return res.status(500).json({ error: 'Live vote request failed' });
    }
    const { status, code, message, rejected, sessionId } = error;
    res.status(status).json({
      error: message,
      code,
      ...(rejected ? { rejected } : {}),
      ...(sessionId !== undefined ? { sessionId } : {})
    });
  }
};

router.get('/active', liveVoteRoute('GET /api/live-votes/active',
  (req) => getActiveSession({ user: req.user })));

router.get('/rubrics', requireAdmin, liveVoteRoute('GET /api/live-votes/rubrics',
  () => getRubrics()));

router.put('/rubrics/:phase', requireAdmin, liveVoteRoute('PUT /api/live-votes/rubrics/:phase',
  (req) => saveRubric({ phase: req.params.phase, criteria: req.body?.criteria, user: req.user })));

router.post('/', requireAdmin, liveVoteRoute('POST /api/live-votes',
  (req) => launchSession({
    user: req.user,
    phase: req.body?.phase,
    applicationIds: req.body?.applicationIds,
    rubricCriteria: req.body?.rubricCriteria,
    saveRubricAsDefault: Boolean(req.body?.saveRubricAsDefault)
  }), { successStatus: 201 }));

router.post('/:id/join', liveVoteRoute('POST /api/live-votes/:id/join',
  (req) => joinSession({ sessionId: req.params.id, user: req.user })));

router.post('/:id/leave', liveVoteRoute('POST /api/live-votes/:id/leave',
  (req) => leaveSession({ sessionId: req.params.id, user: req.user })));

router.get('/:id/state', liveVoteRoute('GET /api/live-votes/:id/state',
  (req) => getState({ sessionId: req.params.id, user: req.user })));

router.post('/:id/votes', liveVoteRoute('POST /api/live-votes/:id/votes',
  (req) => castVote({
    sessionId: req.params.id,
    ballotId: req.body?.ballotId,
    value: req.body?.value,
    user: req.user
  })));

router.post('/:id/begin', requireAdmin, liveVoteRoute('POST /api/live-votes/:id/begin',
  (req) => beginSession({ sessionId: req.params.id, user: req.user })));

router.post('/:id/close', requireAdmin, liveVoteRoute('POST /api/live-votes/:id/close',
  (req) => closeBallot({ sessionId: req.params.id, ballotId: req.body?.ballotId, user: req.user })));

router.post('/:id/reopen', requireAdmin, liveVoteRoute('POST /api/live-votes/:id/reopen',
  (req) => reopenBallot({
    sessionId: req.params.id,
    sessionCandidateId: req.body?.sessionCandidateId,
    user: req.user
  })));

router.post('/:id/navigate', requireAdmin, liveVoteRoute('POST /api/live-votes/:id/navigate',
  (req) => navigateSession({
    sessionId: req.params.id,
    fromIndex: req.body?.fromIndex,
    toIndex: req.body?.toIndex,
    user: req.user
  })));

router.post('/:id/decision', requireAdmin, liveVoteRoute('POST /api/live-votes/:id/decision',
  (req) => applyDecision({
    sessionId: req.params.id,
    sessionCandidateId: req.body?.sessionCandidateId,
    decision: req.body?.decision,
    user: req.user
  })));

router.post('/:id/end', requireAdmin, liveVoteRoute('POST /api/live-votes/:id/end',
  (req) => endSession({ sessionId: req.params.id, user: req.user })));

export default router;
