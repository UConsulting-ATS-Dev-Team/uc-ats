// The admin Site Analytics page's data. Reads only, apart from POST /rollup,
// which runs the nightly job on demand.
//
// Mounted at /api/admin/analytics behind requireAuth + requireAdmin in index.js.
import express from 'express';

import { clampDays, clampRole, errors, overview, performance } from '../services/analytics/queries.js';
import { runRollup } from '../services/analytics/rollup.js';

const router = express.Router();

const route = (label, handler) => async (req, res) => {
  try {
    res.json(await handler(req));
  } catch (error) {
    console.error(`[${label}]`, error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not load analytics' });
  }
};

router.get('/overview', route('GET /api/admin/analytics/overview', (req) => overview(clampDays(req.query.days))));

router.get(
  '/performance',
  route('GET /api/admin/analytics/performance', (req) => performance(clampDays(req.query.days), clampRole(req.query.role)))
);

router.get('/errors', route('GET /api/admin/analytics/errors', (req) => errors(clampDays(req.query.days))));

router.post('/rollup', async (req, res) => {
  try {
    const result = await runRollup();
    if (!result) return res.status(409).json({ error: 'A rollup is already running' });
    return res.json(result);
  } catch (error) {
    console.error('[POST /api/admin/analytics/rollup]', error);
    return res.status(500).json({ error: 'Rollup failed' });
  }
});

export default router;
