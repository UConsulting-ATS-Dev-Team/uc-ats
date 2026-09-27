// POST /api/analytics/events - where browsers send page views, clicks, errors
// and web vitals (client/src/analytics/tracker.js).
//
// Public on purpose: anonymous visitors' activity counts, and navigator.sendBeacon
// cannot attach a bearer token anyway. When a token is present,
// externalContainment has already resolved it to req.user; that is the only
// identity used. Validation lives in services/analytics/ingest.js.
import express from 'express';

import { INGEST } from '../services/analytics/constants.js';
import { allowBatch, readClientEvents } from '../services/analytics/ingest.js';
import { clientEvents } from '../services/analytics/sinks.js';

const router = express.Router();

// sendBeacon posts text/plain (a JSON content type would need a CORS preflight
// a beacon cannot make). A JSON body express.json already parsed is used as-is.
router.use(express.text({ type: ['text/plain'], limit: INGEST.maxBodyBytes }));

router.post('/', (req, res) => {
  if (!allowBatch(req.ip)) return res.status(429).end();

  const result = readClientEvents(req.body, { user: req.user || null });
  if (result.error) return res.status(400).json({ error: result.error });

  for (const row of result.rows) clientEvents.push(row);
  return res.status(202).json({ accepted: result.rows.length, rejected: result.rejected });
});

export default router;
