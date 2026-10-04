import crypto from 'node:crypto';
import prisma from '../prismaClient.js';
import { broadcast } from './realtime.js';
import { interviewStaffIds } from './interviewRoster.js';

// Coffee chat interviewers message the people they pick, not the whole round.
//
// Every other interview has one room for everyone staffing it (messaging.js). A
// coffee chat is staffed by twenty-odd people across a morning, and one room for
// all of them is noise nobody reads, so for a coffee chat the room is refused and
// staff open threads instead: one other person, or a few.
//
// A thread is a DIRECT_MESSAGE conversation, a context type the enum has always
// had and nothing else writes, so this needs no migration. Its contextId is
// `interview:<interviewId>:<key>`, where key is a hash of the sorted participant
// ids: picking the same people again reopens the same thread instead of starting a
// second one, and the unique (contextType, contextId) index settles two people
// opening it at once.
//
// A thread is private to its participants. Admins do not read threads they are
// not in, unlike the rooms, which every admin can open.

export const THREAD_INTERVIEW_TYPES = new Set(['COFFEE_CHAT']);

/** You plus at most five others. A thread that wants more is the room again. */
export const MAX_THREAD_PARTICIPANTS = 6;

const PREFIX = 'interview:';

const personSelect = { id: true, fullName: true, email: true, profileImage: true, role: true };

export const interviewThreadsChannel = (interviewId) => `interview-threads:${interviewId}`;

export function threadContextId(interviewId, userIds) {
  const key = crypto
    .createHash('sha256')
    .update([...new Set(userIds)].sort().join(','))
    .digest('hex')
    .slice(0, 32);
  return `${PREFIX}${interviewId}:${key}`;
}

/** The interview a thread belongs to, or null for any other conversation. */
export function interviewIdOfThread(conversation) {
  if (conversation?.contextType !== 'DIRECT_MESSAGE') return null;
  const contextId = conversation.contextId || '';
  if (!contextId.startsWith(PREFIX)) return null;
  return contextId.slice(PREFIX.length).split(':')[0] || null;
}

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

export async function interviewUsesThreads(interviewId) {
  const interview = await prisma.interview.findUnique({
    where: { id: interviewId },
    select: { interviewType: true }
  });
  if (!interview) throw httpError(404, 'Interview not found');
  return THREAD_INTERVIEW_TYPES.has(interview.interviewType);
}

/**
 * Who may be in a thread for this interview: whoever staffs it now, and every
 * active admin, since admins run the room on the day without being on a session.
 */
async function eligibleIds(interviewId) {
  const [staff, admins] = await Promise.all([
    interviewStaffIds(interviewId),
    prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } })
  ]);
  return new Set([...staff, ...admins.map((admin) => admin.id)]);
}

export async function canUseThreads(interviewId, user) {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  return (await interviewStaffIds(interviewId)).includes(user.id);
}

/**
 * Whether a user may read a thread: they are in it, and still eligible for its
 * interview. A member taken off the coffee chat loses their threads with it;
 * the others in the thread keep it.
 */
export async function userCanAccessThread(conversation, user) {
  const interviewId = interviewIdOfThread(conversation);
  if (!interviewId || !user) return false;
  const row = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: conversation.id, userId: user.id } },
    select: { id: true }
  });
  if (!row) return false;
  return canUseThreads(interviewId, user);
}

/** The people a user can pick, with the sessions each is on to tell them apart. */
export async function listChatPeople(interviewId, user) {
  const ids = await eligibleIds(interviewId);
  ids.delete(user.id);
  if (ids.size === 0) return [];

  const [people, assignments] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: [...ids] }, isActive: true },
      select: personSelect
    }),
    prisma.interviewSlotAssignment.findMany({
      where: { interviewId, removedAt: null },
      select: { userId: true, slot: { select: { label: true, startTime: true } } },
      orderBy: { slot: { startTime: 'asc' } }
    })
  ]);

  const sessionsByUser = new Map();
  for (const { userId, slot } of assignments) {
    const list = sessionsByUser.get(userId) ?? [];
    list.push({ label: slot.label, startTime: slot.startTime });
    sessionsByUser.set(userId, list);
  }

  return people
    .map((person) => ({ ...person, sessions: sessionsByUser.get(person.id) ?? [] }))
    .sort((a, b) => (a.fullName || a.email || '').localeCompare(b.fullName || b.email || ''));
}

/**
 * The thread between the user and the people they picked, created if it does not
 * exist yet. Returns the conversation id.
 */
export async function openThread(interviewId, user, pickedIds) {
  const others = [...new Set((Array.isArray(pickedIds) ? pickedIds : []).map(String))].filter(
    (id) => id && id !== user.id
  );
  if (others.length === 0) throw httpError(400, 'Pick at least one person to message', 'NO_PARTICIPANTS');
  if (others.length + 1 > MAX_THREAD_PARTICIPANTS) {
    throw httpError(
      400,
      `A chat can have at most ${MAX_THREAD_PARTICIPANTS} people, you included`,
      'TOO_MANY_PARTICIPANTS'
    );
  }

  // The ids arrive in a request body, so each is checked rather than trusted.
  const eligible = await eligibleIds(interviewId);
  const active = await prisma.user.findMany({
    where: { id: { in: others }, isActive: true },
    select: { id: true }
  });
  const activeIds = new Set(active.map((row) => row.id));
  if (others.some((id) => !eligible.has(id) || !activeIds.has(id))) {
    throw httpError(400, 'Everyone in a chat has to be working this coffee chat or be an admin', 'NOT_ELIGIBLE');
  }

  const participants = [user.id, ...others];
  const contextId = threadContextId(interviewId, participants);
  const where = { contextType_contextId: { contextType: 'DIRECT_MESSAGE', contextId } };

  const existing = await prisma.conversation.findUnique({ where, select: { id: true } });
  if (existing) return existing.id;

  try {
    const created = await prisma.conversation.create({
      data: {
        contextType: 'DIRECT_MESSAGE',
        contextId,
        participants: { create: participants.map((userId) => ({ userId })) }
      },
      select: { id: true }
    });
    nudgeInterviewThreads(interviewId);
    return created.id;
  } catch (err) {
    // Somebody else in the same group opened it at the same moment.
    if (err?.code === 'P2002') {
      const raced = await prisma.conversation.findUnique({ where, select: { id: true } });
      if (raced) return raced.id;
    }
    throw err;
  }
}

/** The user's threads for this interview, newest activity first, with unread counts. */
export async function listThreadsForUser(interviewId, user) {
  const conversations = await prisma.conversation.findMany({
    where: {
      contextType: 'DIRECT_MESSAGE',
      contextId: { startsWith: `${PREFIX}${interviewId}:` },
      participants: { some: { userId: user.id } }
    },
    orderBy: { updatedAt: 'desc' },
    include: {
      participants: { include: { user: { select: personSelect } } },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { sender: { select: personSelect } }
      }
    }
  });

  return Promise.all(
    conversations.map(async (conversation) => {
      const mine = conversation.participants.find((p) => p.userId === user.id);
      const lastReadAt = mine?.lastReadAt ?? null;
      const unreadCount = await prisma.message.count({
        where: {
          conversationId: conversation.id,
          senderId: { not: user.id },
          ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {})
        }
      });
      const last = conversation.messages[0];
      return {
        id: conversation.id,
        updatedAt: conversation.updatedAt,
        people: conversation.participants.filter((p) => p.userId !== user.id).map((p) => p.user),
        lastMessage: last
          ? { id: last.id, body: last.body, createdAt: last.createdAt, sender: last.sender }
          : null,
        unreadCount
      };
    })
  );
}

/**
 * Tell everyone on the interview's thread list to refetch it. Content-free: the
 * channel is joined with the anon key, so it carries neither who nor what.
 */
export function nudgeInterviewThreads(interviewId) {
  if (!interviewId) return;
  void broadcast(interviewThreadsChannel(interviewId), 'threads:changed', { at: new Date().toISOString() });
}
