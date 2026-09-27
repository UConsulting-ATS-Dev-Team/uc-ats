import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  createAutomaticEmail,
  deleteAutomaticEmail,
  dryRunAutomaticEmail,
  getAutomaticEmail,
  listAutomaticEmails,
  previewAutomaticEmail,
  sendAutomaticEmailTest,
  setAutomaticEmailEnabled,
  updateAutomaticEmail,
} from '../services/automaticEmails/automaticEmails.js';
import {
  CYCLE_DATE_FIELDS,
  RECORD_KINDS,
  SAMPLE_VALUES,
  TRIGGERS,
  mergeFieldsFor,
} from '../services/automaticEmails/automaticEmailRules.js';
import { APPLICATION_STATUSES } from '../services/audiences/audienceFilters.js';
import { listSavedAudiences } from '../services/audiences/savedAudiences.js';

// Admin-written automatic emails. The rules are in services/automaticEmails/;
// this file only maps HTTP onto them. Admin-only: these email candidates on
// their own, with nobody pressing send.

const router = express.Router();
router.use(requireAuth, requireAdmin);

const route = (label, fallback, handler) => async (req, res) => {
  try {
    res.json(await handler(req));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    console.error(`[${label}]`, error);
    res.status(500).json({ error: fallback });
  }
};

// What the editor can offer: triggers, their options, and the merge fields each fills.
router.get('/options', route('GET /api/admin/automatic-emails/options', 'Failed to load options', async () => ({
  triggers: Object.entries(TRIGGERS).map(([id, t]) => ({ id, label: t.label })),
  records: Object.entries(RECORD_KINDS).map(([id, r]) => ({ id, label: r.label })),
  cycleDates: Object.entries(CYCLE_DATE_FIELDS).map(([id, label]) => ({ id, label })),
  statuses: APPLICATION_STATUSES,
  samples: SAMPLE_VALUES,
  savedAudiences: (await listSavedAudiences()).map((a) => ({ id: a.id, name: a.name })),
})));

// The merge fields one trigger configuration can fill, for the editor's chips.
router.post('/merge-fields', route('POST /api/admin/automatic-emails/merge-fields', 'Failed to load merge fields',
  (req) => ({ mergeFields: mergeFieldsFor(req.body?.trigger, req.body?.triggerConfig ?? {}) })));

router.get('/', route('GET /api/admin/automatic-emails', 'Failed to load automatic emails', () => listAutomaticEmails()));

router.post('/', route('POST /api/admin/automatic-emails', 'Failed to save the automatic email',
  (req) => createAutomaticEmail({ input: req.body?.email, user: req.user })));

// Checking one before it goes live. None of these save anything.
router.post('/preview', route('POST /api/admin/automatic-emails/preview', 'Failed to preview',
  (req) => previewAutomaticEmail({ input: req.body?.email })));

router.post('/dry-run', route('POST /api/admin/automatic-emails/dry-run', 'Failed to check who this reaches',
  (req) => dryRunAutomaticEmail({ input: req.body?.email })));

router.post('/test', route('POST /api/admin/automatic-emails/test', 'Failed to send the test email',
  (req) => sendAutomaticEmailTest({ input: req.body?.email, user: req.user })));

router.get('/:id', route('GET /api/admin/automatic-emails/:id', 'Failed to load the automatic email',
  (req) => getAutomaticEmail(req.params.id)));

router.put('/:id', route('PUT /api/admin/automatic-emails/:id', 'Failed to save the automatic email',
  (req) => updateAutomaticEmail({ id: req.params.id, input: req.body?.email, user: req.user })));

router.put('/:id/enabled', route('PUT /api/admin/automatic-emails/:id/enabled', 'Failed to turn the automatic email on or off',
  (req) => setAutomaticEmailEnabled({ id: req.params.id, enabled: req.body?.enabled === true, user: req.user })));

router.delete('/:id', route('DELETE /api/admin/automatic-emails/:id', 'Failed to delete the automatic email',
  (req) => deleteAutomaticEmail({ id: req.params.id })));

export default router;
