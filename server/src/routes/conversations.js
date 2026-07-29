import express from 'express';
import { requireAuth, requireAdminOrMember } from '../middleware/auth.js';
import prisma from '../prismaClient.js';
import {
  getOrCreateInterviewConversation,
  getConversationForUser,
  listConversationsForUser,
  listMessages,
  sendMessage,
  markRead,
  userCanAccessConversation,
  syncInterviewParticipants
} from '../services/messaging.js';

const router = express.Router();

router.get('/', requireAuth, requireAdminOrMember, async (req, res) => {
  try {
    const conversations = await listConversationsForUser(req.user);
    res.json(conversations);
  } catch (err) {
    console.error('[GET /api/conversations]', err);
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

router.get('/interviews/:interviewId', requireAuth, requireAdminOrMember, async (req, res) => {
  try {
    const { interviewId } = req.params;

    const interview = await prisma.interview.findUnique({
      where: { id: interviewId },
      select: {
        id: true,
        assignments: { where: { userId: req.user.id }, select: { id: true } }
      }
    });

    if (!interview) {
      return res.status(404).json({ error: 'Interview not found' });
    }

    if (req.user.role === 'MEMBER' && interview.assignments.length === 0) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const conversation = await getOrCreateInterviewConversation(interviewId);
    await syncInterviewParticipants(interviewId);
    const dto = await getConversationForUser(conversation.id, req.user);
    if (!dto) return res.status(403).json({ error: 'Forbidden' });
    res.json(dto);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[GET /api/conversations/interviews/:id]', err);
    res.status(500).json({ error: 'Failed to load interview conversation' });
  }
});

router.get('/:id', requireAuth, requireAdminOrMember, async (req, res) => {
  try {
    const dto = await getConversationForUser(req.params.id, req.user);
    if (!dto) return res.status(404).json({ error: 'Conversation not found' });
    res.json(dto);
  } catch (err) {
    console.error('[GET /api/conversations/:id]', err);
    res.status(500).json({ error: 'Failed to load conversation' });
  }
});

router.get('/:id/messages', requireAuth, requireAdminOrMember, async (req, res) => {
  try {
    const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!(await userCanAccessConversation(conversation, req.user))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const messages = await listMessages(req.params.id, {
      before: req.query.before,
      limit: req.query.limit
    });
    res.json(messages);
  } catch (err) {
    console.error('[GET /api/conversations/:id/messages]', err);
    res.status(500).json({ error: 'Failed to list messages' });
  }
});

router.post('/:id/messages', requireAuth, requireAdminOrMember, async (req, res) => {
  try {
    const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!(await userCanAccessConversation(conversation, req.user))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const message = await sendMessage({
      conversationId: req.params.id,
      sender: req.user,
      body: req.body?.body
    });
    res.status(201).json(message);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[POST /api/conversations/:id/messages]', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

router.post('/:id/read', requireAuth, requireAdminOrMember, async (req, res) => {
  try {
    const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!(await userCanAccessConversation(conversation, req.user))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await markRead(req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/conversations/:id/read]', err);
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

export default router;
