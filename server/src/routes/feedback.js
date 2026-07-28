import express from 'express';
import prisma from '../prismaClient.js';

const router = express.Router();

const MAX_ANSWER_LENGTH = 5000;

function normalizeQuestions(questions) {
  if (!questions || !Array.isArray(questions)) return null;
  return questions.filter((q) => q && typeof q === 'object' && typeof q.label === 'string');
}

function buildContentSummary(answers, questions) {
  const lines = [];
  const entries = Object.entries(answers || {});
  for (const [key, value] of entries) {
    const question = questions?.find((q) => q.id === key);
    const label = question?.label || key;
    lines.push(`${label}: ${value}`);
  }
  return lines.join('\n');
}

// Public: validate a feedback token before rendering the form.
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const job = await prisma.applicationFeedbackJob.findUnique({
      where: { feedbackToken: token },
      include: {
        cycle: { select: { name: true } },
      },
    });

    if (!job) {
      return res.status(404).json({ error: 'Feedback link is invalid or expired.' });
    }

    if (job.status !== 'SENT' || job.responded) {
      return res.status(409).json({ error: 'Feedback has already been submitted for this link.' });
    }

    const questions = normalizeQuestions(job.feedbackQuestions);

    return res.json({
      valid: true,
      cycleName: job.cycle?.name || '',
      prompt: job.feedbackPrompt || null,
      questions: questions && questions.length > 0 ? questions : null,
    });
  } catch (error) {
    console.error('[GET /api/feedback/:token]', error);
    return res.status(500).json({ error: 'Failed to validate feedback link', details: error.message });
  }
});

// Public: submit confidential feedback using the token from the email.
router.post('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { content, answers } = req.body;

    const job = await prisma.applicationFeedbackJob.findUnique({
      where: { feedbackToken: token },
      include: {
        cycle: { select: { name: true } },
      },
    });

    if (!job) {
      return res.status(404).json({ error: 'Feedback link is invalid or expired.' });
    }

    if (job.respondedAt) {
      return res.status(409).json({ error: 'Feedback has already been submitted for this link.' });
    }

    if (job.status !== 'SENT') {
      return res.status(400).json({ error: 'Feedback link is not yet active.' });
    }

    const questions = normalizeQuestions(job.feedbackQuestions);

    let finalAnswers = {};
    let finalContent = '';

    if (questions && questions.length > 0) {
      if (!answers || typeof answers !== 'object') {
        return res.status(400).json({ error: 'Answers are required.' });
      }

      for (const question of questions) {
        const answer = answers[question.id];
        if (question.required && (!answer || typeof answer !== 'string' || answer.trim().length === 0)) {
          return res.status(400).json({ error: `Response required for: ${question.label}` });
        }
        if (typeof answer === 'string') {
          if (answer.length > MAX_ANSWER_LENGTH) {
            return res.status(400).json({ error: `Response for ${question.label} is too long.` });
          }
          finalAnswers[question.id] = answer.trim();
        }
      }

      finalContent = buildContentSummary(finalAnswers, questions) || '';
    } else {
      // Fall back to a single open feedback field when no questions are configured.
      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({ error: 'Feedback content is required.' });
      }
      if (content.length > MAX_ANSWER_LENGTH) {
        return res.status(400).json({ error: `Feedback content must be under ${MAX_ANSWER_LENGTH} characters.` });
      }
      finalContent = content.trim();
    }

    // Atomically claim the one-use token: only the first transaction that
    // flips responded from false to true creates a response. Concurrent submissions
    // get a 409 without creating duplicate rows.
    await prisma.$transaction(async (tx) => {
      const claim = await tx.applicationFeedbackJob.updateMany({
        where: { id: job.id, status: 'SENT', responded: false },
        data: { responded: true },
      });
      if (claim.count === 0) {
        throw new Error('Feedback has already been submitted for this link.');
      }
      await tx.feedbackResponse.create({
        data: {
          cycleId: job.cycleId,
          content: finalContent,
          answers: Object.keys(finalAnswers).length > 0 ? finalAnswers : null,
          promptSnapshot: job.feedbackPrompt,
          questionsSnapshot: job.feedbackQuestions,
        },
      });
    });

    return res.status(201).json({ message: 'Thank you for your feedback.' });
  } catch (error) {
    console.error('[POST /api/feedback/:token]', error);
    if (error.message === 'Feedback has already been submitted for this link.') {
      return res.status(409).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to submit feedback', details: error.message });
  }
});

export default router;
