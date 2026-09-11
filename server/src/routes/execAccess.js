import express from 'express';
import prisma from '../prismaClient.js';
import { requireAuth, requireAdmin, requireAdminOrMember } from '../middleware/auth.js';
import {
  EXEC_ACCESS_ACTIONS,
  clearFailedAttempts,
  isExecPasswordConfigured,
  isExecUnlocked,
  isRateLimited,
  issueUnlockToken,
  lockCandidateRecords,
  logExecAccess,
  readUnlock,
  recordFailedAttempt,
  setExecPassword,
  unlockCandidateRecords,
  verifyExecPassword
} from '../services/execAccess.js';

// Executive access to sealed recruiting records. See services/execAccess.js for
// why the seal exists and utils/lockedRecords.js for where it is enforced.

const router = express.Router();

router.use(requireAuth, requireAdminOrMember);

// Managing the seal - who is sealed, the password, the audit trail - is itself
// executive business, so it needs a live unlock and not just the admin role.
// Otherwise any recruitment-committee admin could unseal their own record.
const requireExecUnlock = (req, res, next) => {
  if (!isExecUnlocked(req)) {
    return res.status(403).json({ error: 'Enter the executive password first.', code: 'EXEC_UNLOCK_REQUIRED' });
  }
  next();
};

router.get('/status', async (req, res) => {
  try {
    const unlock = readUnlock(req);
    res.json({
      configured: await isExecPasswordConfigured(),
      unlocked: Boolean(unlock),
      expiresAt: unlock?.expiresAt ?? null
    });
  } catch (error) {
    console.error('[GET /api/exec-access/status]', error);
    res.status(500).json({ error: 'Failed to load executive access status' });
  }
});

router.post('/unlock', async (req, res) => {
  const userId = req.user.id;

  try {
    if (isRateLimited(userId)) {
      await logExecAccess({ userId, action: EXEC_ACCESS_ACTIONS.UNLOCK_RATE_LIMITED, ipAddress: req.ip });
      return res.status(429).json({ error: 'Too many incorrect attempts. Try again in 15 minutes.' });
    }

    if (!(await isExecPasswordConfigured())) {
      return res.status(409).json({
        error: 'Executive access has not been set up yet.',
        code: 'EXEC_NOT_CONFIGURED'
      });
    }

    if (!(await verifyExecPassword(req.body?.password))) {
      recordFailedAttempt(userId);
      await logExecAccess({ userId, action: EXEC_ACCESS_ACTIONS.UNLOCK_FAILED, ipAddress: req.ip });
      // 403 rather than 401: the session is fine, only the second secret is wrong.
      return res.status(403).json({ error: 'Incorrect executive password.', code: 'EXEC_PASSWORD_INCORRECT' });
    }

    clearFailedAttempts(userId);
    await logExecAccess({ userId, action: EXEC_ACCESS_ACTIONS.UNLOCK_OK, ipAddress: req.ip });
    res.json(issueUnlockToken(userId));
  } catch (error) {
    console.error('[POST /api/exec-access/unlock]', error);
    res.status(500).json({ error: 'Failed to unlock executive access' });
  }
});

// Whether a candidate is sealed. Says nothing about what the record holds, so
// it needs no unlock - the UI uses it to label the seal and offer the toggle.
router.get('/candidates/:id', async (req, res) => {
  try {
    const candidate = await prisma.candidate.findUnique({
      where: { id: req.params.id },
      select: { id: true, recordsLockedAt: true }
    });
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }
    res.json({
      candidateId: candidate.id,
      locked: Boolean(candidate.recordsLockedAt),
      lockedAt: candidate.recordsLockedAt
    });
  } catch (error) {
    console.error('[GET /api/exec-access/candidates/:id]', error);
    res.status(500).json({ error: 'Failed to load record seal' });
  }
});

const candidateExists = async (id) =>
  Boolean(await prisma.candidate.findUnique({ where: { id }, select: { id: true } }));

router.post('/candidates/:id/lock', requireAdmin, requireExecUnlock, async (req, res) => {
  try {
    const { id } = req.params;
    if (!(await candidateExists(id))) {
      return res.status(404).json({ error: 'Candidate not found' });
    }
    await lockCandidateRecords(id, { userId: req.user.id, ipAddress: req.ip });
    res.json({ candidateId: id, locked: true });
  } catch (error) {
    console.error('[POST /api/exec-access/candidates/:id/lock]', error);
    res.status(500).json({ error: 'Failed to seal record' });
  }
});

router.post('/candidates/:id/unlock', requireAdmin, requireExecUnlock, async (req, res) => {
  try {
    const { id } = req.params;
    if (!(await candidateExists(id))) {
      return res.status(404).json({ error: 'Candidate not found' });
    }
    await unlockCandidateRecords(id, { userId: req.user.id, ipAddress: req.ip });
    res.json({ candidateId: id, locked: false });
  } catch (error) {
    console.error('[POST /api/exec-access/candidates/:id/unlock]', error);
    res.status(500).json({ error: 'Failed to unseal record' });
  }
});

// Rotating the password needs the current one (via the unlock). The very first
// password is set with scripts/set-exec-password.js, never here, so no admin
// can claim an unconfigured seal for themselves.
router.put('/password', requireAdmin, requireExecUnlock, async (req, res) => {
  try {
    await setExecPassword(req.body?.newPassword, { updatedById: req.user.id });
    res.json({ ok: true });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[PUT /api/exec-access/password]', error);
    res.status(500).json({ error: 'Failed to change executive password' });
  }
});

router.get('/logs', requireAdmin, requireExecUnlock, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const logs = await prisma.execAccessLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit
    });

    const userIds = [...new Set(logs.map((log) => log.userId).filter(Boolean))];
    const candidateIds = [...new Set(logs.map((log) => log.candidateId).filter(Boolean))];
    const [users, candidates] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, email: true } }),
      prisma.candidate.findMany({ where: { id: { in: candidateIds } }, select: { id: true, firstName: true, lastName: true } })
    ]);
    const usersById = new Map(users.map((user) => [user.id, user]));
    const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));

    res.json(logs.map((log) => ({
      ...log,
      user: usersById.get(log.userId) ?? null,
      candidate: candidatesById.get(log.candidateId) ?? null
    })));
  } catch (error) {
    console.error('[GET /api/exec-access/logs]', error);
    res.status(500).json({ error: 'Failed to load executive access log' });
  }
});

export default router;
