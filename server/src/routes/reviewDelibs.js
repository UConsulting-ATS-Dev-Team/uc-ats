import express from 'express';
import { requireAuth, requireAdmin, requireAdminOrMember } from '../middleware/auth.js';
import {
  endSession,
  getActiveSessions,
  getCandidateCard,
  getChanges,
  getGroupStatuses,
  getState,
  getTeamView,
  joinSession,
  launchSession,
  leaveSession,
  navigate,
  overrideScore,
  setDecision,
  setThreshold
} from '../services/reviewDelibs/reviewDelibs.js';

// Review team deliberations. The rules live in services/reviewDelibs/; this
// file only maps HTTP onto them. Members reach the router to watch their own
// team's session - the service checks the team on every request - and running
// one is admin-only, checked here for the role and in the service for "has joined".

const router = express.Router();

router.use(requireAuth, requireAdminOrMember);

const delibRoute = (label, handler, { successStatus = 200 } = {}) => async (req, res) => {
  try {
    const result = await handler(req);
    if (result === undefined) return res.status(204).end();
    res.status(successStatus).json(result);
  } catch (error) {
    if (!error.status) {
      console.error(`[${label}]`, error);
      return res.status(500).json({ error: 'Deliberation request failed' });
    }
    const { status, code, message, sessionId, groupName } = error;
    res.status(status).json({
      error: message,
      code,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(groupName !== undefined ? { groupName } : {})
    });
  }
};

router.get('/active', delibRoute('GET /api/review-delibs/active',
  (req) => getActiveSessions({ user: req.user })));

router.get('/groups', requireAdmin, delibRoute('GET /api/review-delibs/groups',
  () => getGroupStatuses({})));

router.post('/', requireAdmin, delibRoute('POST /api/review-delibs',
  (req) => launchSession({ user: req.user, groupId: req.body?.groupId, thresholdPct: req.body?.thresholdPct }),
  { successStatus: 201 }));

router.post('/:id/join', delibRoute('POST /api/review-delibs/:id/join',
  (req) => joinSession({ sessionId: req.params.id, user: req.user })));

router.post('/:id/leave', delibRoute('POST /api/review-delibs/:id/leave',
  (req) => leaveSession({ sessionId: req.params.id, user: req.user })));

router.get('/:id/state', delibRoute('GET /api/review-delibs/:id/state',
  (req) => getState({ sessionId: req.params.id, user: req.user })));

router.get('/:id/team', delibRoute('GET /api/review-delibs/:id/team',
  (req) => getTeamView({ sessionId: req.params.id, user: req.user })));

router.get('/:id/candidates/:applicationId', delibRoute('GET /api/review-delibs/:id/candidates/:applicationId',
  (req) => getCandidateCard({ sessionId: req.params.id, applicationId: req.params.applicationId, user: req.user })));

router.get('/:id/changes', delibRoute('GET /api/review-delibs/:id/changes',
  (req) => getChanges({ sessionId: req.params.id, user: req.user })));

router.post('/:id/navigate', requireAdmin, delibRoute('POST /api/review-delibs/:id/navigate',
  (req) => navigate({
    sessionId: req.params.id,
    user: req.user,
    step: req.body?.step,
    applicationId: req.body?.applicationId ?? null,
    from: req.body?.from
  })));

router.post('/:id/threshold', requireAdmin, delibRoute('POST /api/review-delibs/:id/threshold',
  (req) => setThreshold({ sessionId: req.params.id, user: req.user, thresholdPct: req.body?.thresholdPct })));

router.post('/:id/scores/:type/:scoreId', requireAdmin, delibRoute('POST /api/review-delibs/:id/scores/:type/:scoreId',
  (req) => overrideScore({
    sessionId: req.params.id,
    user: req.user,
    type: req.params.type,
    scoreId: req.params.scoreId,
    adminScore: req.body?.adminScore
  })));

router.post('/:id/decision', requireAdmin, delibRoute('POST /api/review-delibs/:id/decision',
  (req) => setDecision({
    sessionId: req.params.id,
    user: req.user,
    applicationId: req.body?.applicationId,
    decision: req.body?.decision
  })));

router.post('/:id/end', requireAdmin, delibRoute('POST /api/review-delibs/:id/end',
  (req) => endSession({ sessionId: req.params.id, user: req.user })));

export default router;
