import express from 'express';
import prisma from '../prismaClient.js';

const router = express.Router();

const MAX_CONTENT_LENGTH = 5000;

// Public: validate a feedback token before rendering the form.
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const job = await prisma.applicationFeedbackJob.findUnique({
      where: { feedbackToken: token },
      include: {
        cycle: { select: { name: true } },
        response: { select: { id: true } },
      },
    });

    if (!job) {
      return res.status(404).json({ error: 'Feedback link is invalid or expired.' });
    }

    if (job.status !== 'SENT' || job.respondedAt || job.response) {
      return res.status(409).json({ error: 'Feedback has already been submitted for this link.' });
    }

    return res.json({
      valid: true,
      cycleName: job.cycle?.name || '',
    });
  } catch (error) {
    console.error('[GET /api/feedback/:token]', error);
    return res.status(500).json({ error: 'Failed to validate feedback link', details: error.message });
  }
});

// Public: submit anonymous feedback using the token from the email.
router.post('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { content } = req.body;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ error: 'Feedback content is required.' });
    }

    if (content.length > MAX_CONTENT_LENGTH) {
      return res.status(400).json({ error: `Feedback content must be under ${MAX_CONTENT_LENGTH} characters.` });
    }

    const job = await prisma.applicationFeedbackJob.findUnique({
      where: { feedbackToken: token },
      include: { response: { select: { id: true } } },
    });

    if (!job) {
      return res.status(404).json({ error: 'Feedback link is invalid or expired.' });
    }

    if (job.respondedAt || job.response) {
      return res.status(409).json({ error: 'Feedback has already been submitted for this link.' });
    }

    if (job.status !== 'SENT') {
      return res.status(400).json({ error: 'Feedback link is not yet active.' });
    }

    await prisma.$transaction([
      prisma.feedbackResponse.create({
        data: {
          cycleId: job.cycleId,
          feedbackJobId: job.id,
          content: content.trim(),
        },
      }),
      prisma.applicationFeedbackJob.update({
        where: { id: job.id },
        data: { respondedAt: new Date() },
      }),
    ]);

    return res.status(201).json({ message: 'Thank you for your feedback.' });
  } catch (error) {
    console.error('[POST /api/feedback/:token]', error);
    return res.status(500).json({ error: 'Failed to submit feedback', details: error.message });
  }
});

export default router;
