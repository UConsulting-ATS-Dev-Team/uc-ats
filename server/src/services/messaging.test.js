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
      findUnique: vi.fn()
    },
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

  describe('userCanAccessConversation', () => {
    const admin = { id: 'admin-1', role: 'ADMIN' };
    const member = { id: 'member-1', role: 'MEMBER' };

    it('allows ADMIN access to any conversation', async () => {
      const conv = { id: 'conv-1', contextType: 'INTERVIEW', contextId: 'int-1' };
      const result = await userCanAccessConversation(conv, admin);
      expect(result).toBe(true);
      expect(prisma.interviewAssignment.findUnique).not.toHaveBeenCalled();
    });

    it('allows MEMBER access when assigned to the interview', async () => {
      const conv = { id: 'conv-1', contextType: 'INTERVIEW', contextId: 'int-1' };
      prisma.interviewAssignment.findUnique.mockResolvedValue({ id: 'a-1' });

      const result = await userCanAccessConversation(conv, member);

      expect(result).toBe(true);
      expect(prisma.interviewAssignment.findUnique).toHaveBeenCalledWith({
        where: { interviewId_userId: { interviewId: 'int-1', userId: 'member-1' } }
      });
    });

    it('denies MEMBER access when no longer assigned to the interview', async () => {
      const conv = { id: 'conv-1', contextType: 'INTERVIEW', contextId: 'int-1' };
      prisma.interviewAssignment.findUnique.mockResolvedValue(null);

      const result = await userCanAccessConversation(conv, member);

      expect(result).toBe(false);
    });

    it('falls back to participant rows for non-interview conversations', async () => {
      const conv = { id: 'conv-1', contextType: 'DIRECT_MESSAGE', contextId: null };
      prisma.conversationParticipant.findUnique.mockResolvedValue({ id: 'p-1' });

      const result = await userCanAccessConversation(conv, member);

      expect(result).toBe(true);
      expect(prisma.conversationParticipant.findUnique).toHaveBeenCalledWith({
        where: { conversationId_userId: { conversationId: 'conv-1', userId: 'member-1' } }
      });
    });
  });

  describe('syncInterviewParticipants', () => {
    it('adds missing and removes stale participants', async () => {
      prisma.conversation.findUnique.mockResolvedValue({ id: 'conv-1' });
      prisma.interviewAssignment.findMany.mockResolvedValue([{ userId: 'u-1' }, { userId: 'u-3' }]);
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

    it('excludes interview conversations after the member is unassigned', async () => {
      prisma.interviewAssignment.findMany.mockResolvedValue([]);
      prisma.conversation.findMany.mockResolvedValue([]);
      prisma.message.count.mockResolvedValue(0);

      const result = await listConversationsForUser(member);

      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              {
                contextType: { in: ['APPLICATION', 'CYCLE', 'DIRECT_MESSAGE'] },
                participants: { some: { userId: 'member-1' } }
              },
              {
                contextType: 'INTERVIEW',
                contextId: { in: [] }
              }
            ]
          })
        })
      );
      expect(result).toEqual([]);
    });

    it('includes assigned interview conversations for a member', async () => {
      prisma.interviewAssignment.findMany.mockResolvedValue([{ interviewId: 'int-1' }]);
      prisma.conversation.findMany.mockResolvedValue([
        {
          id: 'conv-1',
          contextType: 'INTERVIEW',
          contextId: 'int-1',
          title: 'Interview',
          updatedAt: new Date(),
          participants: [],
          messages: []
        }
      ]);
      prisma.conversationParticipant.findUnique.mockResolvedValue(null);
      prisma.conversationParticipant.create.mockResolvedValue({});
      prisma.message.count.mockResolvedValue(0);

      const result = await listConversationsForUser(member);

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
