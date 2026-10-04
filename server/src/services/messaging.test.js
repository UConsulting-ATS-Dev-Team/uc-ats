import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  userCanAccessConversation,
  listConversationsForUser,
  syncInterviewParticipants,
  listMessages,
  sendMessage,
  toggleReaction,
  summarizeReactions
} from './messaging.js';

const mockBroadcastToConversation = vi.fn();
const mockChannelNameFor = vi.fn();

vi.mock('../services/realtime.js', () => ({
  broadcastToConversation: (...args) => mockBroadcastToConversation(...args),
  channelNameFor: (...args) => mockChannelNameFor(...args),
  isSupabaseAvailable: () => false
}));

vi.mock('../prismaClient.js', () => ({
  default: {
    interview: {
      findUnique: vi.fn(),
      findMany: vi.fn()
    },
    interviewSlot: { findFirst: vi.fn(), findMany: vi.fn() },
    interviewSlotAssignment: { findMany: vi.fn() },
    interviewAssignment: {
      findMany: vi.fn(),
      findUnique: vi.fn()
    },
    conversation: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn()
    },
    conversationParticipant: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    message: {
      create: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn()
    },
    messageReaction: {
      deleteMany: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn()
    },
    $executeRaw: vi.fn(),
    // The toggle runs in a transaction; the mock hands the same client back as tx.
    $transaction: vi.fn()
  }
}));

import prisma from '../prismaClient.js';

beforeEach(() => {
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
});

describe('messaging service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Who staffs interview int-1: through sessions (how members are staffed now), or,
  // for an interview without sessions, the older table and the description's groups.
  const staff = ({ sessions = true, onSession = [], removed = [], legacy = [], groups = [] } = {}) => {
    const description = groups.length ? JSON.stringify({ memberGroups: [{ id: 'mg', memberIds: groups }] }) : null;
    prisma.interview.findUnique.mockResolvedValue({ id: 'int-1', title: 'Interview', description });
    prisma.interview.findMany.mockResolvedValue([{ id: 'int-1', description }]);
    prisma.interviewSlot.findFirst.mockResolvedValue(sessions ? { id: 'slot-1' } : null);
    prisma.interviewSlot.findMany.mockResolvedValue(sessions ? [{ interviewId: 'int-1' }] : []);
    prisma.interviewSlotAssignment.findMany.mockImplementation(({ where }) => {
      const rows = [...onSession.map((userId) => ({ userId })), ...(where.removedAt === null ? [] : removed.map((userId) => ({ userId })))];
      return Promise.resolve(
        where.userId
          ? rows.filter((r) => r.userId === where.userId).map(() => ({ interviewId: 'int-1' }))
          : rows
      );
    });
    prisma.interviewAssignment.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.userId
          ? legacy.filter((id) => id === where.userId).map(() => ({ interviewId: 'int-1' }))
          : legacy.map((userId) => ({ userId }))
      )
    );
  };

  describe('userCanAccessConversation', () => {
    const admin = { id: 'admin-1', role: 'ADMIN' };
    const member = { id: 'member-1', role: 'MEMBER' };
    const conv = { id: 'conv-1', contextType: 'INTERVIEW', contextId: 'int-1' };

    it('allows ADMIN access to any conversation', async () => {
      const result = await userCanAccessConversation(conv, admin);
      expect(result).toBe(true);
      expect(prisma.interviewSlotAssignment.findMany).not.toHaveBeenCalled();
    });

    it("allows a MEMBER on one of the interview's sessions", async () => {
      // How members are staffed now; the old table is empty for them.
      staff({ onSession: ['member-1'] });
      expect(await userCanAccessConversation(conv, member)).toBe(true);
    });

    it('denies a MEMBER taken off their session', async () => {
      staff({ removed: ['member-1'] });
      expect(await userCanAccessConversation(conv, member)).toBe(false);
    });

    it('ignores the old table once the interview has sessions', async () => {
      staff({ legacy: ['member-1'] });
      expect(await userCanAccessConversation(conv, member)).toBe(false);
    });

    it('still allows the old table or member groups for an interview without sessions', async () => {
      staff({ sessions: false, legacy: ['member-1'] });
      expect(await userCanAccessConversation(conv, member)).toBe(true);
      staff({ sessions: false, groups: ['member-1'] });
      expect(await userCanAccessConversation(conv, member)).toBe(true);
    });

    it('falls back to participant rows for non-interview conversations', async () => {
      const dm = { id: 'conv-1', contextType: 'DIRECT_MESSAGE', contextId: null };
      prisma.conversationParticipant.findUnique.mockResolvedValue({ id: 'p-1' });

      const result = await userCanAccessConversation(dm, member);

      expect(result).toBe(true);
      expect(prisma.conversationParticipant.findUnique).toHaveBeenCalledWith({
        where: { conversationId_userId: { conversationId: 'conv-1', userId: 'member-1' } }
      });
    });
  });

  describe('syncInterviewParticipants', () => {
    it("makes the participants the interview's current session staff", async () => {
      prisma.conversation.findUnique.mockResolvedValue({ id: 'conv-1' });
      staff({ onSession: ['u-1', 'u-3'], removed: ['u-2'] });
      prisma.conversationParticipant.findMany.mockResolvedValue([
        { userId: 'u-1' },
        { userId: 'u-2' }
      ]);

      await syncInterviewParticipants('int-1');

      expect(prisma.conversationParticipant.createMany).toHaveBeenCalledWith({
        data: [{ conversationId: 'conv-1', userId: 'u-3' }],
        skipDuplicates: true
      });
      expect(prisma.conversationParticipant.deleteMany).toHaveBeenCalledWith({
        where: { conversationId: 'conv-1', userId: { in: ['u-2'] } }
      });
    });
  });

  describe('listConversationsForUser', () => {
    const member = { id: 'member-1', role: 'MEMBER' };
    const admin = { id: 'admin-1', role: 'ADMIN' };
    const chat = {
      id: 'conv-1',
      contextType: 'INTERVIEW',
      contextId: 'int-1',
      title: 'Interview',
      updatedAt: new Date(),
      participants: [],
      messages: []
    };
    const conversations = (rows) => prisma.conversation.findMany.mockResolvedValue(rows);
    const interviewIdsListed = () =>
      prisma.conversation.findMany.mock.calls.at(-1)[0].where.OR[1].contextId.in;

    it('excludes interview conversations after the member is taken off', async () => {
      staff({ removed: ['member-1'] });
      conversations([]);
      prisma.message.count.mockResolvedValue(0);

      const result = await listConversationsForUser(member);

      expect(interviewIdsListed()).toEqual([]);
      expect(result).toEqual([]);
    });

    it("looks only at the member's own interviews, not every interview with a chat", async () => {
      staff({ onSession: ['member-1'] });
      conversations([]);
      prisma.message.count.mockResolvedValue(0);

      await listConversationsForUser(member);

      expect(prisma.interviewSlotAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'member-1', removedAt: null } })
      );
      // The only interview lookups are scoped: by the member's id in a legacy
      // description, then the candidates found.
      for (const [args] of prisma.interview.findMany.mock.calls) {
        expect(args.where).toSatisfy((w) => Boolean(w.description?.contains === 'member-1' || w.id?.in));
      }
    });

    it("includes the chat of an interview the member is on through a session", async () => {
      staff({ onSession: ['member-1'] });
      conversations([chat]);
      prisma.conversationParticipant.findUnique.mockResolvedValue(null);
      prisma.conversationParticipant.create.mockResolvedValue({});
      prisma.message.count.mockResolvedValue(0);

      const result = await listConversationsForUser(member);

      expect(interviewIdsListed()).toEqual(['int-1']);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('conv-1');
      expect(prisma.conversationParticipant.create).toHaveBeenCalledWith({
        data: { conversationId: 'conv-1', userId: 'member-1' }
      });
    });

    it('returns every conversation for ADMIN except coffee chat threads they are not in', async () => {
      prisma.conversation.findMany.mockResolvedValue([]);
      prisma.message.count.mockResolvedValue(0);

      await listConversationsForUser(admin);

      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { contextType: { not: 'DIRECT_MESSAGE' } },
              { participants: { some: { userId: admin.id } } }
            ]
          }
        })
      );
    });
  });

  describe('coffee chat threads', () => {
    const admin = { id: 'admin-1', role: 'ADMIN' };
    const member = { id: 'member-1', role: 'MEMBER' };
    const thread = { id: 'conv-t', contextType: 'DIRECT_MESSAGE', contextId: 'interview:int-1:abc' };

    it('keeps an admin out of a thread they are not in', async () => {
      staff({ onSession: ['member-1'] });
      prisma.conversationParticipant.findUnique.mockResolvedValue(null);
      expect(await userCanAccessConversation(thread, admin)).toBe(false);
    });

    it('lets an admin in a thread read it', async () => {
      staff({ onSession: ['member-1'] });
      prisma.conversationParticipant.findUnique.mockResolvedValue({ id: 'p' });
      expect(await userCanAccessConversation(thread, admin)).toBe(true);
    });

    it('lets a member in the thread read it while they staff the coffee chat', async () => {
      staff({ onSession: ['member-1'] });
      prisma.conversationParticipant.findUnique.mockResolvedValue({ id: 'p' });
      expect(await userCanAccessConversation(thread, member)).toBe(true);
    });

    it('drops a member taken off the coffee chat, even though they are in the thread', async () => {
      staff({ onSession: [], removed: ['member-1'] });
      prisma.conversationParticipant.findUnique.mockResolvedValue({ id: 'p' });
      expect(await userCanAccessConversation(thread, member)).toBe(false);
    });
  });

  describe('reactions', () => {
    const user = { id: 'member-1', role: 'MEMBER' };
    const row = (emoji, id, fullName) => ({ emoji, user: { id, fullName } });

    it('folds rows to one entry per emoji with who reacted', () => {
      expect(summarizeReactions([row('👍', 'a', 'A'), row('❤️', 'b', 'B'), row('👍', 'c', 'C')])).toEqual([
        { emoji: '👍', count: 2, users: [{ id: 'a', fullName: 'A' }, { id: 'c', fullName: 'C' }] },
        { emoji: '❤️', count: 1, users: [{ id: 'b', fullName: 'B' }] }
      ]);
    });

    it('adds a reaction the user has not put on yet', async () => {
      prisma.message.findUnique.mockResolvedValue({ id: 'msg-1', conversationId: 'conv-1', deletedAt: null });
      prisma.messageReaction.deleteMany.mockResolvedValue({ count: 0 });
      prisma.messageReaction.findMany.mockResolvedValue([row('👍', 'member-1', 'Me')]);
      mockBroadcastToConversation.mockResolvedValue();

      const result = await toggleReaction({ conversationId: 'conv-1', messageId: 'msg-1', user, emoji: '👍' });

      expect(prisma.$executeRaw).toHaveBeenCalled();
      expect(prisma.messageReaction.create).toHaveBeenCalledWith({ data: { messageId: 'msg-1', userId: 'member-1', emoji: '👍' } });
      expect(result.reactions).toEqual([{ emoji: '👍', count: 1, users: [{ id: 'member-1', fullName: 'Me' }] }]);
      // Content-free: who reacted is fetched through the API, not broadcast.
      expect(mockBroadcastToConversation).toHaveBeenCalledWith('conv-1', 'message:reactions', {
        conversationId: 'conv-1',
        messageId: 'msg-1'
      });
    });

    it('takes a reaction off when the user taps it again', async () => {
      prisma.message.findUnique.mockResolvedValue({ id: 'msg-1', conversationId: 'conv-1', deletedAt: null });
      prisma.messageReaction.deleteMany.mockResolvedValue({ count: 1 });
      prisma.messageReaction.findMany.mockResolvedValue([]);
      mockBroadcastToConversation.mockResolvedValue();

      const result = await toggleReaction({ conversationId: 'conv-1', messageId: 'msg-1', user, emoji: '👍' });

      expect(prisma.messageReaction.create).not.toHaveBeenCalled();
      expect(result.reactions).toEqual([]);
    });

    it('refuses an emoji outside the palette, or a message from another conversation', async () => {
      await expect(toggleReaction({ conversationId: 'conv-1', messageId: 'msg-1', user, emoji: '<b>' })).rejects.toMatchObject({ status: 400 });
      prisma.message.findUnique.mockResolvedValue({ id: 'msg-1', conversationId: 'conv-2', deletedAt: null });
      await expect(toggleReaction({ conversationId: 'conv-1', messageId: 'msg-1', user, emoji: '👍' })).rejects.toMatchObject({ status: 404 });
    });

    it('answers 503 before the reactions table exists', async () => {
      prisma.message.findUnique.mockResolvedValue({ id: 'msg-1', conversationId: 'conv-1', deletedAt: null });
      prisma.messageReaction.deleteMany.mockRejectedValue(Object.assign(new Error('missing'), { code: 'P2021' }));

      await expect(toggleReaction({ conversationId: 'conv-1', messageId: 'msg-1', user, emoji: '👍' })).rejects.toMatchObject({
        status: 503,
        code: 'REACTIONS_UNAVAILABLE'
      });
    });

    it('still lists messages, without reactions, before the table exists', async () => {
      const msg = { id: 'msg-1', conversationId: 'conv-1', body: 'hi', createdAt: new Date(), sender: { id: 'x' } };
      prisma.message.findMany
        .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'P2021' }))
        .mockResolvedValueOnce([msg]);

      const messages = await listMessages('conv-1');

      expect(messages).toHaveLength(1);
      expect(messages[0].reactions).toEqual([]);
    });
  });

  describe('message broadcasts', () => {
    it('announces a new message without its body', async () => {
      prisma.message.create.mockResolvedValue({
        id: 'msg-9', conversationId: 'conv-1', body: 'secret', createdAt: new Date(), sender: { id: 'u' }
      });
      prisma.conversationParticipant.findUnique.mockResolvedValue({ id: 'p' });
      prisma.conversation.update.mockResolvedValue({});
      mockBroadcastToConversation.mockResolvedValue();

      await sendMessage({ conversationId: 'conv-1', sender: { id: 'u' }, body: 'secret' });

      expect(mockBroadcastToConversation).toHaveBeenCalledWith('conv-1', 'message:created', {
        conversationId: 'conv-1',
        messageId: 'msg-9'
      });
    });
  });

  describe('thread listing', () => {
    it("drops a coffee chat thread from a member's list once they are off the coffee chat", async () => {
      staff({ onSession: [], removed: ['member-1'] });
      prisma.conversation.findMany.mockResolvedValue([
        { id: 'conv-t', contextType: 'DIRECT_MESSAGE', contextId: 'interview:int-1:abc', participants: [{ lastReadAt: null }], messages: [] }
      ]);
      prisma.message.count.mockResolvedValue(0);

      expect(await listConversationsForUser({ id: 'member-1', role: 'MEMBER' })).toEqual([]);
    });

    it('keeps it while they staff it', async () => {
      staff({ onSession: ['member-1'] });
      prisma.conversation.findMany.mockResolvedValue([
        { id: 'conv-t', contextType: 'DIRECT_MESSAGE', contextId: 'interview:int-1:abc', participants: [{ lastReadAt: null }], messages: [] }
      ]);
      prisma.message.count.mockResolvedValue(0);

      const list = await listConversationsForUser({ id: 'member-1', role: 'MEMBER' });
      expect(list.map((c) => c.id)).toEqual(['conv-t']);
    });
  });
});
