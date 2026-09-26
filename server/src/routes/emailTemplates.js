import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  listEmailTemplates,
  renderEmailTemplatePreview,
  UnknownEmailTemplateError,
} from '../services/emailTemplatePreview.js';
import { getEmailCopy, resetEmailCopy, saveEmailCopy } from '../services/emailTemplateCopy.js';

// The automatic emails: what each one says, and what an admin may change about
// it. Rules live in services/emailTemplateCopy.js; this file only maps HTTP
// onto them.
//
// Admin-only throughout. These are the words every candidate reads, and a
// member who can grade an application has no business rewriting the rejection.

const router = express.Router();

router.use(requireAuth, requireAdmin);

const templateRoute = (label, fallback, handler) => async (req, res) => {
  try {
    res.json(await handler(req));
  } catch (error) {
    if (error instanceof UnknownEmailTemplateError) {
      return res.status(404).json({ error: 'Unknown email template' });
    }
    if (error.status) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    // A builder threw, which means the catalog's sample arguments no longer
    // match its signature. That is a bug in the catalog, not bad input.
    console.error(`[${label}]`, error);
    res.status(500).json({ error: fallback });
  }
};

// GET /api/admin/email-templates
router.get('/', templateRoute('GET /api/admin/email-templates', 'Failed to load email templates',
  () => listEmailTemplates()));

// GET /api/admin/email-templates/:key/preview
router.get('/:key/preview', templateRoute('GET /api/admin/email-templates/:key/preview', 'Failed to render email template',
  (req) => renderEmailTemplatePreview(req.params.key)));

// GET /api/admin/email-templates/:key/copy - the editable fields, what is
// stored, and the wording each falls back to.
router.get('/:key/copy', templateRoute('GET /api/admin/email-templates/:key/copy', 'Failed to load this email template',
  (req) => getEmailCopy(req.params.key)));

// PUT /api/admin/email-templates/:key/copy
router.put('/:key/copy', templateRoute('PUT /api/admin/email-templates/:key/copy', 'Failed to save this email template',
  (req) => saveEmailCopy({ key: req.params.key, copy: req.body?.copy, user: req.user })));

// DELETE /api/admin/email-templates/:key/copy - back to the shipped wording.
router.delete('/:key/copy', templateRoute('DELETE /api/admin/email-templates/:key/copy', 'Failed to reset this email template',
  (req) => resetEmailCopy({ key: req.params.key })));

export default router;
