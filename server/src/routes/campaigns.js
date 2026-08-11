import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  createCampaignTemplate,
  updateCampaignTemplate,
  getCampaignTemplates,
  getCampaignTemplateById,
  deleteCampaignTemplate,
  createCampaignAudience,
  updateCampaignAudience,
  getCampaignAudiences,
  getCampaignAudienceById,
  deleteCampaignAudience,
  previewAudience,
  resolveAudience,
  createCampaignSend,
  updateCampaignSend,
  getCampaignSends,
  getCampaignSendById,
  approveCampaignSend,
  previewCampaignSend,
  sendCampaign,
  retryFailedCampaignSend,
  resolveCampaignLog,
  getSuppressedEmails,
  addSuppressedEmail,
  removeSuppressedEmail,
} from '../services/campaigns.js';

const router = express.Router();

router.use(requireAuth, requireAdmin);

// Templates
router.get('/templates', async (req, res) => {
  try {
    const { cycleId } = req.query;
    const templates = await getCampaignTemplates({ cycleId });
    res.json(templates);
  } catch (error) {
    console.error('[GET /api/admin/campaigns/templates]', error);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

router.post('/templates', async (req, res) => {
  try {
    const { name, cycleId, category, subject, body, mergeFields } = req.body;
    if (!name || !subject || !body) {
      return res.status(400).json({ error: 'name, subject, and body are required' });
    }
    const template = await createCampaignTemplate({
      name,
      cycleId: cycleId || null,
      category: category || null,
      subject,
      body,
      mergeFields: mergeFields || [],
      createdBy: req.user.id,
    });
    res.json(template);
  } catch (error) {
    console.error('[POST /api/admin/campaigns/templates]', error);
    res.status(500).json({ error: error.message || 'Failed to create template' });
  }
});

router.patch('/templates/:id', async (req, res) => {
  try {
    const { name, cycleId, category, subject, body, mergeFields } = req.body;
    const template = await updateCampaignTemplate(req.params.id, {
      name,
      cycleId: cycleId || null,
      category: category || null,
      subject,
      body,
      mergeFields,
    });
    res.json(template);
  } catch (error) {
    console.error('[PATCH /api/admin/campaigns/templates/:id]', error);
    res.status(500).json({ error: error.message || 'Failed to update template' });
  }
});

router.get('/templates/:id', async (req, res) => {
  try {
    const template = await getCampaignTemplateById(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(template);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch template' });
  }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    await deleteCampaignTemplate(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to delete template' });
  }
});

// Audiences
router.get('/audiences', async (req, res) => {
  try {
    const { cycleId } = req.query;
    const audiences = await getCampaignAudiences({ cycleId });
    res.json(audiences);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch audiences' });
  }
});

router.post('/audiences', async (req, res) => {
  try {
    const { name, cycleId, filters } = req.body;
    if (!name || !filters) {
      return res.status(400).json({ error: 'name and filters are required' });
    }
    const audience = await createCampaignAudience({
      name,
      cycleId: cycleId || null,
      filters,
      createdBy: req.user.id,
    });
    res.json(audience);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to create audience' });
  }
});

router.patch('/audiences/:id', async (req, res) => {
  try {
    const { name, cycleId, filters } = req.body;
    const audience = await updateCampaignAudience(req.params.id, { name, cycleId: cycleId || null, filters });
    res.json(audience);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to update audience' });
  }
});

router.get('/audiences/:id', async (req, res) => {
  try {
    const audience = await getCampaignAudienceById(req.params.id);
    if (!audience) return res.status(404).json({ error: 'Audience not found' });
    res.json(audience);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch audience' });
  }
});

router.delete('/audiences/:id', async (req, res) => {
  try {
    await deleteCampaignAudience(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to delete audience' });
  }
});

router.post('/audiences/preview', async (req, res) => {
  try {
    const filters = req.body;
    const preview = await previewAudience(filters);
    res.json(preview);
  } catch (error) {
    console.error('[POST /api/admin/campaigns/audiences/preview]', error);
    res.status(500).json({ error: error.message || 'Failed to preview audience' });
  }
});

router.post('/audiences/resolve', async (req, res) => {
  try {
    const filters = req.body;
    const recipients = await resolveAudience(filters, { includeApplications: false });
    res.json(recipients.map((c) => ({ id: c.id, email: c.email, firstName: c.firstName, lastName: c.lastName })));
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to resolve audience' });
  }
});

// Sends
router.get('/sends', async (req, res) => {
  try {
    const { cycleId } = req.query;
    const sends = await getCampaignSends({ cycleId });
    res.json(sends);
  } catch (error) {
    console.error('[GET /api/admin/campaigns/sends]', error);
    res.status(500).json({ error: 'Failed to fetch sends' });
  }
});

router.post('/sends', async (req, res) => {
  try {
    const { name, cycleId, templateId, audienceId, scheduledAt } = req.body;
    if (!name || !templateId || !audienceId) {
      return res.status(400).json({ error: 'name, templateId, and audienceId are required' });
    }
    const send = await createCampaignSend({
      name,
      cycleId: cycleId || null,
      templateId,
      audienceId,
      scheduledAt: scheduledAt || null,
      sentBy: req.user.id,
    });
    res.json(send);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to create send' });
  }
});

router.post('/sends/:id/approve', async (req, res) => {
  try {
    const { approvalFingerprint } = req.body || {};
    if (!approvalFingerprint) {
      return res.status(400).json({ error: 'approvalFingerprint is required' });
    }
    const send = await approveCampaignSend({ sendId: req.params.id, actorId: req.user.id, approvalFingerprint });
    res.json(send);
  } catch (error) {
    console.error('[POST /api/admin/campaigns/sends/:id/approve]', error);
    res.status(400).json({ error: error.message || 'Failed to approve send' });
  }
});

router.get('/sends/:id/preview', async (req, res) => {
  try {
    const preview = await previewCampaignSend({ sendId: req.params.id });
    res.json(preview);
  } catch (error) {
    console.error('[GET /api/admin/campaigns/sends/:id/preview]', error);
    res.status(400).json({ error: error.message || 'Failed to preview send' });
  }
});

router.get('/sends/:id', async (req, res) => {
  try {
    const send = await getCampaignSendById(req.params.id);
    if (!send) return res.status(404).json({ error: 'Send not found' });
    res.json(send);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch send' });
  }
});

router.patch('/sends/:id', async (req, res) => {
  try {
    const { name, cycleId, templateId, audienceId, scheduledAt } = req.body;
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (cycleId !== undefined) updateData.cycleId = cycleId || null;
    if (templateId !== undefined) updateData.templateId = templateId;
    if (audienceId !== undefined) updateData.audienceId = audienceId;
    if (scheduledAt !== undefined) {
      updateData.scheduledAt = scheduledAt ? new Date(scheduledAt) : null;
      if (updateData.scheduledAt && updateData.scheduledAt > new Date()) {
        updateData.status = 'SCHEDULED';
      }
    }
    const send = await updateCampaignSend(req.params.id, updateData);
    res.json(send);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to update send' });
  }
});

router.post('/sends/:id/send', async (req, res) => {
  try {
    const { force } = req.body || {};
    const result = await sendCampaign(req.params.id, req.user.id, { force });
    res.json(result);
  } catch (error) {
    console.error('[POST /api/admin/campaigns/sends/:id/send]', error);
    res.status(500).json({ error: error.message || 'Failed to send campaign' });
  }
});

router.post('/sends/:id/retry', async (req, res) => {
  try {
    const result = await retryFailedCampaignSend(req.params.id, req.user.id);
    res.json(result);
  } catch (error) {
    console.error('[POST /api/admin/campaigns/sends/:id/retry]', error);
    res.status(500).json({ error: error.message || 'Failed to retry campaign' });
  }
});

router.post('/logs/:id/resolve', async (req, res) => {
  try {
    const { status, reason } = req.body || {};
    if (!status) {
      return res.status(400).json({ error: 'status is required' });
    }
    const log = await resolveCampaignLog({ logId: req.params.id, actorId: req.user.id, status, reason });
    res.json(log);
  } catch (error) {
    console.error('[POST /api/admin/campaigns/logs/:id/resolve]', error);
    res.status(400).json({ error: error.message || 'Failed to resolve log' });
  }
});

// Suppression list
router.get('/suppressions', async (req, res) => {
  try {
    const list = await getSuppressedEmails();
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch suppressions' });
  }
});

router.post('/suppressions', async (req, res) => {
  try {
    const { email, reason, source } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    const entry = await addSuppressedEmail({ email, reason, source });
    res.json(entry);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to add suppression' });
  }
});

router.delete('/suppressions/:email', async (req, res) => {
  try {
    await removeSuppressedEmail(decodeURIComponent(req.params.email));
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to remove suppression' });
  }
});

export default router;
