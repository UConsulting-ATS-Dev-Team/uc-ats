import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  listTemplates,
  createTemplate,
  listLogs,
  previewMasterCommunication,
  buildImessagePacket,
  sendMasterCommunication,
} from '../services/masterCommunications.js';

const router = express.Router();

router.get('/templates', requireAuth, requireAdmin, async (req, res) => {
  try {
    const templates = await listTemplates({ cycleId: req.query.cycleId });
    res.json(templates);
  } catch (err) {
    console.error('[GET /api/master-communications/templates]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to list templates' });
  }
});

router.post('/templates', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, subject, body, channel, cycleId } = req.body || {};
    const template = await createTemplate({
      name,
      subject,
      body,
      channel,
      cycleId,
      createdBy: req.user.id,
    });
    res.status(201).json(template);
  } catch (err) {
    console.error('[POST /api/master-communications/templates]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to create template' });
  }
});

router.get('/logs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const logs = await listLogs({
      cycleId: req.query.cycleId,
      limit: req.query.limit,
    });
    res.json(logs);
  } catch (err) {
    console.error('[GET /api/master-communications/logs]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to list logs' });
  }
});

router.post('/preview', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { audience, filters } = req.body || {};
    if (!audience) {
      return res.status(400).json({ error: 'audience is required' });
    }
    const result = await previewMasterCommunication({ audience, filters });
    res.json(result);
  } catch (err) {
    console.error('[POST /api/master-communications/preview]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to preview recipients' });
  }
});

router.post('/send', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { audience, channel, filters, subject, body, cycleId, templateId } = req.body || {};

    if (!audience || !channel || !body) {
      return res.status(400).json({ error: 'audience, channel, and body are required' });
    }

    if (channel === 'email' && !subject) {
      return res.status(400).json({ error: 'subject is required for email' });
    }

    const result = await sendMasterCommunication({
      audience,
      channel,
      filters,
      subject,
      body,
      sentBy: req.user.id,
      cycleId,
      templateId,
    });
    res.json(result);
  } catch (err) {
    console.error('[POST /api/master-communications/send]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to send communication' });
  }
});

router.post('/packet', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { filters } = req.body || {};
    const packet = await buildImessagePacket({ filters });
    res.json(packet);
  } catch (err) {
    console.error('[POST /api/master-communications/packet]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to build iMessage packet' });
  }
});

export default router;
