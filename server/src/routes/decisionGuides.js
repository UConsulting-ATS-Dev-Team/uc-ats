import express from 'express';
import { requireAuth, requireAdmin, requireAdminOrMember } from '../middleware/auth.js';
import { getGuide, getGuides, resetGuide, saveGuide } from '../services/decisionGuides.js';

// The deliberation decision guide. Rules live in services/decisionGuides.js;
// this file only maps HTTP onto them.
//
// Members read it - they are the ones being told what the decisions mean - and
// only admins write it.

const router = express.Router();

router.use(requireAuth, requireAdminOrMember);

const guideRoute = (label, handler) => async (req, res) => {
  try {
    res.json(await handler(req));
  } catch (error) {
    if (!error.status) {
      console.error(`[${label}]`, error);
      return res.status(500).json({ error: 'Decision guide request failed' });
    }
    res.status(error.status).json({ error: error.message, code: error.code });
  }
};

router.get('/', guideRoute('GET /api/decision-guides',
  () => getGuides()));

router.get('/:phase', guideRoute('GET /api/decision-guides/:phase',
  (req) => getGuide({ phase: req.params.phase })));

router.put('/:phase', requireAdmin, guideRoute('PUT /api/decision-guides/:phase',
  (req) => saveGuide({
    phase: req.params.phase,
    intro: req.body?.intro,
    criteria: req.body?.criteria,
    user: req.user
  })));

router.delete('/:phase', requireAdmin, guideRoute('DELETE /api/decision-guides/:phase',
  (req) => resetGuide({ phase: req.params.phase })));

export default router;
