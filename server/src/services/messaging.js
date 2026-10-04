import prisma from '../prismaClient.js';
import { broadcastToConversation, channelNameFor } from './realtime.js';
import { interviewStaffIds, interviewsStaffedBy } from './interviewRoster.js';
import { interviewIdOfThread, userCanAccessThread } from './interviewThreads.js';

// An interview conversation's members are whoever staffs the interview now
// (interviewRoster.js): session assignments where it has sessions. Reading only the
// old InterviewAssignment table, which nothing writes any more, shut every member
// staffed through a session out of the chat with a 403.

const MESSAGE_PAGE_SIZE = 50;

const senderSelect = {
  id: true,
  fullName: true,
  email: true,
  profileImage: true,
  role: true
};

/// The reactions on offer. A fixed palette rather than any emoji: what arrives in
/// a request body is checked against it, and it keeps the picker one row.
export const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '👎', '🎉', '👀'];

const reactionInclude = {
  reactions: {
    orderBy: { createdAt: 'asc' },
    select: { emoji: true, user: { select: { id: true, fullName: true } } }
  }
};

/** Reaction rows folded to one entry per emoji, in the order each was first used. */
export function summarizeReactions(rows = []) {
  const byEmoji = new Map();
  for (const row of rows) {
    const entry = byEmoji.get(row.emoji) ?? { emoji: row.emoji, count: 0, users: [] };
    entry.count += 1;
    entry.users.push({ id: row.user.id, fullName: row.user.fullName });
    byEmoji.set(row.emoji, entry);
  }
  return [...byEmoji.values()];
}

// message_reactions arrives in its own migration. Until it is applied, chats
// load and send as before and simply show no reactions.
const isMissingTable = (err) => err?.code === 'P2021' || err?.code === 'P2022';

/**
 * Tell a conversation's open clients that something changed. Content-free: the
 * channel is joined with the anon key, so anyone who once learned the id could
 * keep listening after losing access. Clients fetch the change through the API,
 * which checks access on every request.
 */
function nudgeConversation(conversationId, event, { messageId }) {
  broadcastToConversation(conversationId, event, { conversationId, messageId }).catch(() => {});
}

function serializeMessage(msg) {
  return {
    id: msg.id,
    conversationId: msg.conversationId,
    body: msg.body,
    createdAt: msg.createdAt,
    editedAt: msg.editedAt,
    deletedAt: msg.deletedAt,
    sender: msg.sender,
    reactions: summarizeReactions(msg.reactions)
  };
}

export async function getOrCreateInterviewConversation(interviewId) {
  const interview = await prisma.interview.findUnique({
    where: { id: interviewId },
    select: { id: true, title: true }
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

  const userIds = await interviewStaffIds(interviewId);
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

  const desired = new Set(await interviewStaffIds(interviewId));

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

  const toRemove = [...currentSet].filter((id) => !desired.has(id));
  if (toRemove.length > 0) {
    await prisma.conversationParticipant.deleteMany({
      where: { conversationId: conversation.id, userId: { in: toRemove } }
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
  // A coffee chat thread is private to the people in it, admins included
  // (interviewThreads.js), so it is checked before the admin shortcut.
  if (interviewIdOfThread(conversation)) return userCanAccessThread(conversation, user);
  if (user.role === 'ADMIN') return true;

  // Interview conversations are authorized by who staffs the interview now, not stale
  // participant rows, so an interviewer taken off it loses access immediately.
  if (conversation.contextType === 'INTERVIEW') {
    return (await interviewStaffIds(conversation.contextId)).includes(user.id);
  }

  const row = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: conversation.id, userId: user.id } }
  });
  return !!row;
}

export async function listMessages(conversationId, { before, limit = MESSAGE_PAGE_SIZE } = {}) {
  const where = { conversationId };
  if (before) where.createdAt = { lt: new Date(before) };
  const query = {
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(parseInt(limit, 10) || MESSAGE_PAGE_SIZE, 1), 200)
  };
  let rows;
  try {
    rows = await prisma.message.findMany({ ...query, include: { sender: { select: senderSelect }, ...reactionInclude } });
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    rows = await prisma.message.findMany({ ...query, include: { sender: { select: senderSelect } } });
  }
  return rows.reverse().map(serializeMessage);
}

/** One message's reactions, for a client told they changed. */
export async function getMessageReactions(conversationId, messageId) {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { conversationId: true, deletedAt: true }
  });
  // The conversation was authorized; the message id came from the URL.
  if (!message || message.conversationId !== conversationId || message.deletedAt) {
    const err = new Error('Message not found');
    err.status = 404;
    throw err;
  }
  try {
    const rows = await prisma.messageReaction.findMany({
      where: { messageId },
      orderBy: { createdAt: 'asc' },
      select: reactionInclude.reactions.select
    });
    return { messageId, reactions: summarizeReactions(rows) };
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    return { messageId, reactions: [] };
  }
}

/**
 * Put an emoji on a message, or take it off if the user already put that one on.
 * Returns the message's reactions afterwards and tells the conversation.
 */
export async function toggleReaction({ conversationId, messageId, user, emoji }) {
  if (!REACTION_EMOJI.includes(emoji)) {
    const err = new Error('Unknown reaction');
    err.status = 400;
    throw err;
  }
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, conversationId: true, deletedAt: true }
  });
  // The conversation was authorized; the message id came from the URL.
  if (!message || message.conversationId !== conversationId || message.deletedAt) {
    const err = new Error('Message not found');
    err.status = 404;
    throw err;
  }

  try {
    // Delete-or-insert is one decision: under the lock, two taps at once land
    // one after the other and cancel out, instead of both seeing nothing to
    // delete and both inserting.
    const lockKey = `reaction:${messageId}:${user.id}:${emoji}`;
    const reactions = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const removed = await tx.messageReaction.deleteMany({ where: { messageId, userId: user.id, emoji } });
      if (removed.count === 0) {
        await tx.messageReaction.create({ data: { messageId, userId: user.id, emoji } });
      }
      const rows = await tx.messageReaction.findMany({
        where: { messageId },
        orderBy: { createdAt: 'asc' },
        select: reactionInclude.reactions.select
      });
      return summarizeReactions(rows);
    });
    nudgeConversation(conversationId, 'message:reactions', { messageId });
    return { messageId, reactions };
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    const unavailable = new Error('Reactions are not available yet');
    unavailable.status = 503;
    unavailable.code = 'REACTIONS_UNAVAILABLE';
    throw unavailable;
  }
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
  nudgeConversation(conversationId, 'message:created', { messageId: created.id });

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
  let conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      participants: {
        include: { user: { select: senderSelect } }
      }
    }
  });
  if (!conversation) return null;
  if (!(await userCanAccessConversation(conversation, user))) return null;

  if (conversation.contextType === 'INTERVIEW') {
    await syncInterviewParticipants(conversation.contextId);
    conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        participants: {
          include: { user: { select: senderSelect } }
        }
      }
    });
  }

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

// The interviews this member staffs now, found from their own rows rather than by
// scanning every interview: their session assignments, the older table, and
// interviews whose description names them (a legacy member group). Only those few
// candidates then go through the strict check.
async function interviewIdsWithChatsFor(user) {
  const [onSessions, onOldTable, inDescriptions] = await Promise.all([
    prisma.interviewSlotAssignment.findMany({ where: { userId: user.id, removedAt: null }, select: { interviewId: true } }),
    prisma.interviewAssignment.findMany({ where: { userId: user.id }, select: { interviewId: true } }),
    prisma.interview.findMany({ where: { description: { contains: user.id } }, select: { id: true } })
  ]);
  const candidateIds = [
    ...new Set([...onSessions, ...onOldTable].map((row) => row.interviewId).concat(inDescriptions.map((row) => row.id)))
  ];
  if (candidateIds.length === 0) return [];
  const interviews = await prisma.interview.findMany({
    where: { id: { in: candidateIds } },
    select: { id: true, description: true }
  });
  return (await interviewsStaffedBy(user.id, interviews)).map((interview) => interview.id);
}

export async function listConversationsForUser(user) {
  const assignedInterviewIds = user.role === 'ADMIN' ? [] : await interviewIdsWithChatsFor(user);

  // Admins see every conversation except coffee chat threads they are not in.
  const where = user.role === 'ADMIN'
    ? {
        OR: [
          { contextType: { not: 'DIRECT_MESSAGE' } },
          { participants: { some: { userId: user.id } } }
        ]
      }
    : {
        OR: [
          {
            contextType: { in: ['APPLICATION', 'CYCLE', 'DIRECT_MESSAGE'] },
            participants: { some: { userId: user.id } }
          },
          {
            contextType: 'INTERVIEW',
            contextId: { in: assignedInterviewIds }
          }
        ]
      };

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

  // A member keeps their participant row in a coffee chat thread after being
  // taken off the coffee chat; the thread drops out of their list with access.
  const staffed = new Set(assignedInterviewIds);
  const visible = conversations.filter((c) => {
    const threadInterviewId = interviewIdOfThread(c);
    return !threadInterviewId || user.role === 'ADMIN' || staffed.has(threadInterviewId);
  });

  const result = [];
  for (const c of visible) {
    // Interview participants may be missing if a member was assigned after the
    // conversation was created; ensure a row exists so lastReadAt is tracked.
    if (c.contextType === 'INTERVIEW' && !c.participants[0]) {
      await ensureParticipantRow(c.id, user.id);
      c.participants = [{ lastReadAt: null }];
    }

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
