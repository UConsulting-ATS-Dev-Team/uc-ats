import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  userCanAccessConversation,
  listConversationsForUser,
  syncInterviewParticipants
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
      count: vi.fn()
    }
  }
}));

import prisma from '../prismaClient.js';

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

    it('returns all conversations for ADMIN', async () => {
      prisma.conversation.findMany.mockResolvedValue([]);
      prisma.message.count.mockResolvedValue(0);

      await listConversationsForUser(admin);

      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} })
      );
    });
  });
});
