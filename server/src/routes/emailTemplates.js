import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  listEmailTemplates,
  renderEmailTemplatePreview,
  UnknownEmailTemplateError,
} from '../services/emailTemplatePreview.js';

const router = express.Router();

// GET /api/admin/email-templates
router.get('/', requireAuth, requireAdmin, (req, res) => {
  try {
    res.json(listEmailTemplates());
  } catch (error) {
    console.error('[GET /api/admin/email-templates]', error);
    res.status(500).json({ error: 'Failed to load email templates' });
  }
});

// GET /api/admin/email-templates/:key/preview
router.get('/:key/preview', requireAuth, requireAdmin, (req, res) => {
  try {
    res.json(renderEmailTemplatePreview(req.params.key));
  } catch (error) {
    if (error instanceof UnknownEmailTemplateError) {
      return res.status(404).json({ error: 'Unknown email template' });
    }

    // A builder threw, which means the catalog's sample arguments no longer
    // match its signature. That is a bug in the catalog, not bad input.
    console.error('[GET /api/admin/email-templates/:key/preview]', error);
    res.status(500).json({ error: 'Failed to render email template' });
  }
});

export default router;
