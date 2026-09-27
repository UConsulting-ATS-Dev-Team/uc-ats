import express from 'express';
import { emailHealthReport } from '../services/emailHealth.js';
import { sendEmail } from '../services/emailNotifications.js';

// Administration -> Email Deliverability. Mounted behind requireAuth and
// requireAdmin in index.js.

const router = express.Router();

const WINDOWS = [1, 7, 30];
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// GET /api/admin/email-health?days=7
router.get('/', async (req, res) => {
  const days = WINDOWS.includes(Number(req.query.days)) ? Number(req.query.days) : 7;
  try {
    res.json(await emailHealthReport({ days }));
  } catch (error) {
    console.error('[GET /api/admin/email-health]', error);
    res.status(500).json({ error: 'Failed to run the email health check' });
  }
});

// POST /api/admin/email-health/test { to? }
//
// Sends through the same sendEmail every real message uses, so the row it logs
// moves to Delivered only if SES and the event webhook are both working - an
// end-to-end check the static checks cannot give. `to` defaults to the admin;
// pointing it at a mail-tester style address gets a spam score as well.
router.post('/test', async (req, res) => {
  const to = String(req.body?.to || req.user.email || '').trim().toLowerCase();
  if (!EMAIL.test(to)) return res.status(400).json({ error: 'Enter a valid email address' });

  const sentBy = req.user.fullName || req.user.email;
  const html = `
    <p>This is a deliverability test from the UConsulting ATS, sent by ${escapeHtml(sentBy)}.</p>
    <p>If it reached your inbox rather than spam, mail from the ATS is getting through.
    Its status on the Email Deliverability page should change from Sent to Delivered within a minute or two.</p>
  `;

  const result = await sendEmail(to, 'UConsulting ATS deliverability test', html, [], {
    category: 'TEST',
    trigger: 'MANUAL',
    triggeredById: req.user.id,
    recipientName: to === req.user.email ? req.user.fullName : null,
  });

  if (!result.success) return res.status(502).json({ error: `SES refused the message: ${result.error}` });
  res.json({ sent: true, to, messageId: result.messageId });
});

export default router;
