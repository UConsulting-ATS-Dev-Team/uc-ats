import prisma from '../prismaClient.js';
import { broadcastToConversation, channelNameFor } from './realtime.js';

const MESSAGE_PAGE_SIZE = 50;

const senderSelect = {
  id: true,
  fullName: true,
  email: true,
  profileImage: true,
  role: true
};

function serializeMessage(msg) {
  return {
    id: msg.id,
    conversationId: msg.conversationId,
    body: msg.body,
    createdAt: msg.createdAt,
    editedAt: msg.editedAt,
    deletedAt: msg.deletedAt,
    sender: msg.sender
  };
}

export async function getOrCreateInterviewConversation(interviewId) {
  const interview = await prisma.interview.findUnique({
    where: { id: interviewId },
    select: { id: true, title: true, assignments: { select: { userId: true } } }
  });
  if (!interview) {
    const err = new Error('Interview not found');
    err.status = 404;
    throw err;
  }

  const existing = await prisma.conversation.findUnique({
    where: { contextType_contextId: { contextType: 'INTERVIEW', contextId: interviewId } }
  });
  if (existing) return existing;

  const conversation = await prisma.conversation.create({
    data: {
      contextType: 'INTERVIEW',
      contextId: interviewId,
      title: interview.title || null
    }
  });

  const userIds = [...new Set(interview.assignments.map((a) => a.userId))];
  if (userIds.length > 0) {
    await prisma.conversationParticipant.createMany({
      data: userIds.map((userId) => ({ conversationId: conversation.id, userId })),
      skipDuplicates: true
    });
  }

  return conversation;
}

export async function syncInterviewParticipants(interviewId) {
  const conversation = await prisma.conversation.findUnique({
    where: { contextType_contextId: { contextType: 'INTERVIEW', contextId: interviewId } },
    select: { id: true }
  });
  if (!conversation) return;

  const assignments = await prisma.interviewAssignment.findMany({
    where: { interviewId },
    select: { userId: true }
  });
  const desired = new Set(assignments.map((a) => a.userId));

  const current = await prisma.conversationParticipant.findMany({
    where: { conversationId: conversation.id },
    select: { userId: true }
  });
  const currentSet = new Set(current.map((p) => p.userId));

  const toAdd = [...desired].filter((id) => !currentSet.has(id));
  if (toAdd.length > 0) {
    await prisma.conversationParticipant.createMany({
      data: toAdd.map((userId) => ({ conversationId: conversation.id, userId })),
      skipDuplicates: true
    });
  }
}

async function ensureParticipantRow(conversationId, userId) {
  const existing = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { id: true }
  });
  if (existing) return;
  try {
    await prisma.conversationParticipant.create({
      data: { conversationId, userId }
    });
  } catch (_) {
    // ignore unique-constraint races
  }
}

export async function userCanAccessConversation(conversation, user) {
  if (!conversation || !user) return false;
  if (user.role === 'ADMIN') return true;
  const row = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: conversation.id, userId: user.id } }
  });
  return !!row;
}

export async function listMessages(conversationId, { before, limit = MESSAGE_PAGE_SIZE } = {}) {
  const where = { conversationId };
  if (before) where.createdAt = { lt: new Date(before) };
  const rows = await prisma.message.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(parseInt(limit, 10) || MESSAGE_PAGE_SIZE, 1), 200),
    include: { sender: { select: senderSelect } }
  });
  return rows.reverse().map(serializeMessage);
}

export async function sendMessage({ conversationId, sender, body }) {
  const trimmed = (body || '').trim();
  if (!trimmed) {
    const err = new Error('Message body cannot be empty');
    err.status = 400;
    throw err;
  }
  if (trimmed.length > 5000) {
    const err = new Error('Message body too long');
    err.status = 400;
    throw err;
  }

  const created = await prisma.message.create({
    data: { conversationId, senderId: sender.id, body: trimmed },
    include: { sender: { select: senderSelect } }
  });

  const payload = serializeMessage(created);
  broadcastToConversation(conversationId, 'message:created', payload).catch(() => {});

  // Tail writes — not on the response-path. Best-effort, fire-and-forget.
  ensureParticipantRow(conversationId, sender.id).catch(() => {});
  prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: created.createdAt }
  }).catch(() => {});

  return payload;
}

export async function markRead(conversationId, userId, at = new Date()) {
  await ensureParticipantRow(conversationId, userId);
  await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { lastReadAt: at }
  });
}

export async function getConversationForUser(conversationId, user) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      participants: {
        include: { user: { select: senderSelect } }
      }
    }
  });
  if (!conversation) return null;
  if (!(await userCanAccessConversation(conversation, user))) return null;
  return {
    id: conversation.id,
    contextType: conversation.contextType,
    contextId: conversation.contextId,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    channelName: channelNameFor(conversation.id),
    participants: conversation.participants.map((p) => ({
      userId: p.userId,
      joinedAt: p.joinedAt,
      lastReadAt: p.lastReadAt,
      user: p.user
    }))
  };
}

export async function listConversationsForUser(user) {
  const where = user.role === 'ADMIN'
    ? {}
    : { participants: { some: { userId: user.id } } };

  const conversations = await prisma.conversation.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    include: {
      participants: {
        where: { userId: user.id },
        select: { lastReadAt: true }
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { sender: { select: senderSelect } }
      }
    }
  });

  const result = [];
  for (const c of conversations) {
    const lastReadAt = c.participants[0]?.lastReadAt || null;
    const unreadCount = await prisma.message.count({
      where: {
        conversationId: c.id,
        senderId: { not: user.id },
        ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {})
      }
    });
    result.push({
      id: c.id,
      contextType: c.contextType,
      contextId: c.contextId,
      title: c.title,
      updatedAt: c.updatedAt,
      lastMessage: c.messages[0] ? serializeMessage(c.messages[0]) : null,
      unreadCount
    });
  }
  return result;
}

export { channelNameFor };
