import express from 'express';
import { interviewStaffIds } from '../services/interviewRoster.js';
import { requireAuth, requireAdminOrMember } from '../middleware/auth.js';
import prisma from '../prismaClient.js';
import {
  getOrCreateInterviewConversation,
  getConversationForUser,
  listConversationsForUser,
  listMessages,
  sendMessage,
  toggleReaction,
  getMessageReactions,
  markRead,
  userCanAccessConversation,
  syncInterviewParticipants
} from '../services/messaging.js';
import {
  THREAD_INTERVIEW_TYPES,
  canUseThreads,
  interviewIdOfThread,
  interviewUsesThreads,
  listChatPeople,
  listThreadsForUser,
  nudgeInterviewThreads,
  openThread
} from '../services/interviewThreads.js';
import { isApplicationLocked, sendRecordLocked } from '../utils/lockedRecords.js';

const router = express.Router();

// A conversation about an application is part of that person's record, so it is
// sealed along with it.
const isSealedConversation = async (req, conversation) =>
  conversation?.contextType === 'APPLICATION' && (await isApplicationLocked(req, conversation.contextId));

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
      select: { id: true, interviewType: true }
    });

    if (!interview) {
      return res.status(404).json({ error: 'Interview not found' });
    }

    // A coffee chat has no room for everyone: its staff pick who to message.
    if (THREAD_INTERVIEW_TYPES.has(interview.interviewType)) {
      return res.status(409).json({ error: 'This interview uses chats with the people you pick', code: 'THREADS_ONLY' });
    }

    // Whoever staffs the interview now (interviewRoster.js), sessions included.
    if (req.user.role === 'MEMBER' && !(await interviewStaffIds(interviewId)).includes(req.user.id)) {
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

// Coffee chat threads (interviewThreads.js): the people a user can pick, and the
// threads they are in.
const threadsGate = async (req, res) => {
  const { interviewId } = req.params;
  if (!(await interviewUsesThreads(interviewId))) {
    res.status(409).json({ error: 'This interview has one chat for everyone on it', code: 'ROOM_ONLY' });
    return false;
  }
  if (!(await canUseThreads(interviewId, req.user))) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
};

router.get('/interviews/:interviewId/threads', requireAuth, requireAdminOrMember, async (req, res) => {
  try {
    if (!(await threadsGate(req, res))) return;
    const { interviewId } = req.params;
    const [people, threads] = await Promise.all([
      listChatPeople(interviewId, req.user),
      listThreadsForUser(interviewId, req.user)
    ]);
    res.json({ people, threads });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[GET /api/conversations/interviews/:id/threads]', err);
    res.status(500).json({ error: 'Failed to load chats' });
  }
});

router.post('/interviews/:interviewId/threads', requireAuth, requireAdminOrMember, async (req, res) => {
  try {
    if (!(await threadsGate(req, res))) return;
    const conversationId = await openThread(req.params.interviewId, req.user, req.body?.userIds);
    const dto = await getConversationForUser(conversationId, req.user);
    if (!dto) return res.status(403).json({ error: 'Forbidden' });
    res.status(201).json(dto);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[POST /api/conversations/interviews/:id/threads]', err);
    res.status(500).json({ error: 'Failed to open chat' });
  }
});

router.get('/:id', requireAuth, requireAdminOrMember, async (req, res) => {
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: req.params.id },
      select: { contextType: true, contextId: true }
    });
    if (await isSealedConversation(req, conversation)) return sendRecordLocked(res);

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
    if (await isSealedConversation(req, conversation)) return sendRecordLocked(res);
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
    if (await isSealedConversation(req, conversation)) return sendRecordLocked(res);
    const message = await sendMessage({
      conversationId: req.params.id,
      sender: req.user,
      body: req.body?.body
    });
    // Other people's thread lists show unread counts and the latest message.
    nudgeInterviewThreads(interviewIdOfThread(conversation));
    res.status(201).json(message);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[POST /api/conversations/:id/messages]', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

router.get('/:id/messages/:messageId/reactions', requireAuth, requireAdminOrMember, async (req, res) => {
  try {
    const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!(await userCanAccessConversation(conversation, req.user))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (await isSealedConversation(req, conversation)) return sendRecordLocked(res);
    res.json(await getMessageReactions(req.params.id, req.params.messageId));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[GET /api/conversations/:id/messages/:messageId/reactions]', err);
    res.status(500).json({ error: 'Failed to load reactions' });
  }
});

router.post('/:id/messages/:messageId/reactions', requireAuth, requireAdminOrMember, async (req, res) => {
  try {
    const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!(await userCanAccessConversation(conversation, req.user))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (await isSealedConversation(req, conversation)) return sendRecordLocked(res);
    const result = await toggleReaction({
      conversationId: req.params.id,
      messageId: req.params.messageId,
      user: req.user,
      emoji: req.body?.emoji
    });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[POST /api/conversations/:id/messages/:messageId/reactions]', err);
    res.status(500).json({ error: 'Failed to react' });
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
