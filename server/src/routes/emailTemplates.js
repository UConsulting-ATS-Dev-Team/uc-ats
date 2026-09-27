import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  listEmailTemplates,
  renderEmailTemplatePreview,
  sendEmailTemplateTest,
  UnknownEmailTemplateError,
} from '../services/emailTemplatePreview.js';
import {
  createEmailSignature,
  deleteEmailSignature,
  listEmailSignatures,
  updateEmailSignature,
} from '../services/emailSignatures.js';
import { getEmailCopy, resetEmailCopy, saveEmailCopy } from '../services/emailTemplateCopy.js';
import { getEmailTheme, resetEmailTheme, saveEmailTheme } from '../services/emailTheme.js';
import { getEmailStyle, resetEmailStyle, saveEmailStyle } from '../services/emailTemplateStyle.js';

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

// The theme every automatic email is drawn in. Registered before the /:key
// routes only for readability; none of them has a one-segment path.
router.get('/theme', templateRoute('GET /api/admin/email-templates/theme', 'Failed to load the email theme',
  () => getEmailTheme()));

router.put('/theme', templateRoute('PUT /api/admin/email-templates/theme', 'Failed to save the email theme',
  (req) => saveEmailTheme({ theme: req.body?.theme, user: req.user })));

// Back to the look the code ships.
router.delete('/theme', templateRoute('DELETE /api/admin/email-templates/theme', 'Failed to reset the email theme',
  () => resetEmailTheme()));

// Signatures: named sign-offs any email can use in place of its own.
// Registered before the /:key routes so /signatures/<id> is never read as a key.
router.get('/signatures', templateRoute('GET /api/admin/email-templates/signatures', 'Failed to load signatures',
  () => listEmailSignatures()));

router.post('/signatures', templateRoute('POST /api/admin/email-templates/signatures', 'Failed to save the signature',
  (req) => createEmailSignature({ signature: req.body?.signature, user: req.user })));

router.put('/signatures/:id', templateRoute('PUT /api/admin/email-templates/signatures/:id', 'Failed to save the signature',
  (req) => updateEmailSignature({ id: req.params.id, signature: req.body?.signature, user: req.user })));

router.delete('/signatures/:id', templateRoute('DELETE /api/admin/email-templates/signatures/:id', 'Failed to delete the signature',
  (req) => deleteEmailSignature({ id: req.params.id })));

// GET /api/admin/email-templates/:key/preview
router.get('/:key/preview', templateRoute('GET /api/admin/email-templates/:key/preview', 'Failed to render email template',
  (req) => renderEmailTemplatePreview(req.params.key)));

// The unsaved edits an editor can send along: { theme, style, copy, signature }.
const draftFrom = (body) => ({
  theme: body?.theme ?? null,
  style: body?.style ?? null,
  copy: body?.copy ?? null,
  signature: body?.signature ?? null,
});

// POST /api/admin/email-templates/:key/preview - the same render with unsaved
// edits applied, for the editors. Saves nothing and sends nothing.
router.post('/:key/preview', templateRoute('POST /api/admin/email-templates/:key/preview', 'Failed to render email template',
  (req) => renderEmailTemplatePreview(req.params.key, { draft: draftFrom(req.body) })));

// POST /api/admin/email-templates/:key/test - sends this email, with sample
// data, to the admin asking and nobody else.
router.post('/:key/test', templateRoute('POST /api/admin/email-templates/:key/test', 'Failed to send the test email',
  (req) => sendEmailTemplateTest(req.params.key, { user: req.user, draft: draftFrom(req.body) })));

// GET /api/admin/email-templates/:key/style - Designed or Plain, header colour.
router.get('/:key/style', templateRoute('GET /api/admin/email-templates/:key/style', 'Failed to load this email style',
  (req) => getEmailStyle(req.params.key)));

router.put('/:key/style', templateRoute('PUT /api/admin/email-templates/:key/style', 'Failed to save this email style',
  (req) => saveEmailStyle({ key: req.params.key, style: req.body?.style, user: req.user })));

router.delete('/:key/style', templateRoute('DELETE /api/admin/email-templates/:key/style', 'Failed to reset this email style',
  (req) => resetEmailStyle({ key: req.params.key })));

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
