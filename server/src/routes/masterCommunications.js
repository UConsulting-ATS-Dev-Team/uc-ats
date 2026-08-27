import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  listTemplates,
  createTemplate,
  listLogs,
  previewMasterCommunication,
  buildImessagePacket,
  sendMasterCommunication,
  sendTestCommunication,
  scheduleMessage,
  listScheduledMessages,
  cancelScheduledMessage,
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

router.get('/schedule', requireAuth, requireAdmin, async (req, res) => {
  try {
    const messages = await listScheduledMessages({
      cycleId: req.query.cycleId,
      status: req.query.status,
      limit: req.query.limit,
    });
    res.json(messages);
  } catch (err) {
    console.error('[GET /api/master-communications/schedule]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to list scheduled messages' });
  }
});

router.post('/schedule', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { channel, audience, filters, subject, body, cycleId, templateId, scheduledAt } = req.body || {};

    if (!channel || !audience || !body || !scheduledAt) {
      return res.status(400).json({ error: 'channel, audience, body, and scheduledAt are required' });
    }

    if (channel === 'email' && !subject) {
      return res.status(400).json({ error: 'subject is required for email' });
    }

    const result = await scheduleMessage({
      channel,
      audience,
      filters,
      subject,
      body,
      cycleId,
      templateId,
      sentBy: req.user.id,
      scheduledAt,
    });
    res.status(201).json(result);
  } catch (err) {
    console.error('[POST /api/master-communications/schedule]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to schedule message' });
  }
});

router.delete('/schedule/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await cancelScheduledMessage({
      id: req.params.id,
      sentBy: req.user.id,
    });
    res.json(result);
  } catch (err) {
    console.error('[DELETE /api/master-communications/schedule/:id]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to cancel scheduled message' });
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

router.post('/test', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { audience, filters, subject, body } = req.body || {};

    if (!audience || !subject || !body) {
      return res.status(400).json({ error: 'audience, subject, and body are required' });
    }

    const result = await sendTestCommunication({
      audience,
      filters,
      subject,
      body,
      user: req.user,
    });
    res.json(result);
  } catch (err) {
    console.error('[POST /api/master-communications/test]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to send test email' });
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
