import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import conversationsRoutes from './conversations.js';

const mockGetOrCreateInterviewConversation = vi.fn();
const mockGetConversationForUser = vi.fn();
const mockListConversationsForUser = vi.fn();
const mockListMessages = vi.fn();
const mockSendMessage = vi.fn();
const mockMarkRead = vi.fn();
const mockUserCanAccessConversation = vi.fn();
const mockSyncInterviewParticipants = vi.fn();
const mockToggleReaction = vi.fn();
const mockOpenThread = vi.fn();
const mockListChatPeople = vi.fn();
const mockListThreadsForUser = vi.fn();
const mockNudgeInterviewThreads = vi.fn();

vi.mock('../prismaClient.js', () => ({
  default: {
    interview: { findUnique: vi.fn() },
    // Who staffs the interview (interviewRoster.js): it has sessions, and the member
    // is on one of them or not.
    interviewSlot: { findFirst: vi.fn().mockResolvedValue({ id: 'slot-1' }) },
    interviewSlotAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    interviewAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    conversation: { findUnique: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn((ops) => Promise.all(ops))
  }
}));

vi.mock('../services/messaging.js', () => ({
  getOrCreateInterviewConversation: (...args) => mockGetOrCreateInterviewConversation(...args),
  getConversationForUser: (...args) => mockGetConversationForUser(...args),
  listConversationsForUser: (...args) => mockListConversationsForUser(...args),
  listMessages: (...args) => mockListMessages(...args),
  sendMessage: (...args) => mockSendMessage(...args),
  markRead: (...args) => mockMarkRead(...args),
  userCanAccessConversation: (...args) => mockUserCanAccessConversation(...args),
  syncInterviewParticipants: (...args) => mockSyncInterviewParticipants(...args),
  toggleReaction: (...args) => mockToggleReaction(...args)
}));

vi.mock('../services/interviewThreads.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openThread: (...args) => mockOpenThread(...args),
    listChatPeople: (...args) => mockListChatPeople(...args),
    listThreadsForUser: (...args) => mockListThreadsForUser(...args),
    nudgeInterviewThreads: (...args) => mockNudgeInterviewThreads(...args)
  };
});

import prisma from '../prismaClient.js';

const adminUser = {
  id: 'admin-1',
  role: 'ADMIN',
  isActive: true,
  email: 'admin@test.local',
  fullName: 'Test Admin'
};

const memberUser = {
  id: 'member-1',
  role: 'MEMBER',
  isActive: true,
  email: 'member@test.local',
  fullName: 'Test Member'
};

function tokenFor(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
}

describe('Conversations routes', () => {
  let app;
  let server;
  let port;

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
    app = express();
    app.use(express.json());
    app.use('/api/conversations', conversationsRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockImplementation(({ where: { id } }) => {
      if (id === adminUser.id) return adminUser;
      if (id === memberUser.id) return memberUser;
      return null;
    });
    prisma.conversation.findUnique.mockResolvedValue({ id: 'conv-1' });
  });

  async function get(token, path) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://localhost:${port}${path}`, { headers });
  }

  async function post(token, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://localhost:${port}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  }

  describe('GET /api/conversations/interviews/:interviewId', () => {
    it('allows an admin to access any interview conversation', async () => {
      prisma.interview.findUnique.mockResolvedValue({ id: 'interview-1', assignments: [] });
      mockGetOrCreateInterviewConversation.mockResolvedValue({ id: 'conv-1' });
      mockGetConversationForUser.mockResolvedValue({ id: 'conv-1', title: 'Test' });

      const res = await get(tokenFor(adminUser), '/api/conversations/interviews/interview-1');

      expect(res.status).toBe(200);
      expect(mockSyncInterviewParticipants).toHaveBeenCalledWith('interview-1');
    });

    it('rejects a member who is not on the interview', async () => {
      prisma.interview.findUnique.mockResolvedValue({ id: 'interview-1', description: null });
      prisma.interviewSlotAssignment.findMany.mockResolvedValue([{ userId: 'someone-else' }]);

      const res = await get(tokenFor(memberUser), '/api/conversations/interviews/interview-1');

      expect(res.status).toBe(403);
      expect(mockGetOrCreateInterviewConversation).not.toHaveBeenCalled();
    });

    it('allows a member on one of its sessions into the interview conversation', async () => {
      // Staffed the way members are now: a session, nothing in the old table.
      prisma.interview.findUnique.mockResolvedValue({ id: 'interview-1', description: null });
      prisma.interviewSlotAssignment.findMany.mockResolvedValue([{ userId: memberUser.id }]);
      mockGetOrCreateInterviewConversation.mockResolvedValue({ id: 'conv-1' });
      mockGetConversationForUser.mockResolvedValue({ id: 'conv-1', title: 'Test' });

      const res = await get(tokenFor(memberUser), '/api/conversations/interviews/interview-1');

      expect(res.status).toBe(200);
    });

    it('returns 404 when the interview does not exist', async () => {
      prisma.interview.findUnique.mockResolvedValue(null);

      const res = await get(tokenFor(adminUser), '/api/conversations/interviews/missing');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/conversations/:id/messages', () => {
    it('lists messages for an accessible conversation', async () => {
      mockUserCanAccessConversation.mockResolvedValue(true);
      mockListMessages.mockResolvedValue([{ id: 'msg-1' }]);

      const res = await get(tokenFor(adminUser), '/api/conversations/conv-1/messages');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
    });

    it('returns 403 for an inaccessible conversation', async () => {
      mockUserCanAccessConversation.mockResolvedValue(false);

      const res = await get(tokenFor(memberUser), '/api/conversations/conv-1/messages');

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/conversations/:id/messages', () => {
    it('sends a message in an accessible conversation', async () => {
      mockUserCanAccessConversation.mockResolvedValue(true);
      mockSendMessage.mockResolvedValue({ id: 'msg-1', body: 'hello' });

      const res = await post(tokenFor(adminUser), '/api/conversations/conv-1/messages', { body: 'hello' });

      expect(res.status).toBe(201);
      expect(mockSendMessage).toHaveBeenCalledWith({ conversationId: 'conv-1', sender: adminUser, body: 'hello' });
    });

    it('rejects sending to an inaccessible conversation', async () => {
      mockUserCanAccessConversation.mockResolvedValue(false);

      const res = await post(tokenFor(memberUser), '/api/conversations/conv-1/messages', { body: 'hello' });

      expect(res.status).toBe(403);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('coffee chat threads', () => {
    const coffeeChat = { id: 'cc-1', description: null, interviewType: 'COFFEE_CHAT' };

    it('refuses the one room for everyone on a coffee chat', async () => {
      prisma.interview.findUnique.mockResolvedValue(coffeeChat);

      const res = await get(tokenFor(adminUser), '/api/conversations/interviews/cc-1');

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('THREADS_ONLY');
      expect(mockGetOrCreateInterviewConversation).not.toHaveBeenCalled();
    });

    it('lists the people and threads for a member staffing the coffee chat', async () => {
      prisma.interview.findUnique.mockResolvedValue(coffeeChat);
      prisma.interviewSlotAssignment.findMany.mockResolvedValue([{ userId: memberUser.id }]);
      mockListChatPeople.mockResolvedValue([{ id: 'm2' }]);
      mockListThreadsForUser.mockResolvedValue([{ id: 'conv-t' }]);

      const res = await get(tokenFor(memberUser), '/api/conversations/interviews/cc-1/threads');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ people: [{ id: 'm2' }], threads: [{ id: 'conv-t' }] });
    });

    it('keeps a member not on the coffee chat out of its threads', async () => {
      prisma.interview.findUnique.mockResolvedValue(coffeeChat);
      prisma.interviewSlotAssignment.findMany.mockResolvedValue([{ userId: 'someone-else' }]);

      const res = await post(tokenFor(memberUser), '/api/conversations/interviews/cc-1/threads', { userIds: ['m2'] });

      expect(res.status).toBe(403);
      expect(mockOpenThread).not.toHaveBeenCalled();
    });

    it('opens a thread with the people picked', async () => {
      prisma.interview.findUnique.mockResolvedValue(coffeeChat);
      prisma.interviewSlotAssignment.findMany.mockResolvedValue([{ userId: memberUser.id }]);
      mockOpenThread.mockResolvedValue('conv-t');
      mockGetConversationForUser.mockResolvedValue({ id: 'conv-t' });

      const res = await post(tokenFor(memberUser), '/api/conversations/interviews/cc-1/threads', { userIds: ['m2', 'm3'] });

      expect(res.status).toBe(201);
      expect(mockOpenThread).toHaveBeenCalledWith('cc-1', memberUser, ['m2', 'm3']);
    });

    it('has no threads on any other round', async () => {
      prisma.interview.findUnique.mockResolvedValue({ id: 'r1', description: null, interviewType: 'ROUND_ONE' });

      const res = await get(tokenFor(adminUser), '/api/conversations/interviews/r1/threads');

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('ROOM_ONLY');
    });

    it("nudges thread lists when a thread's message is sent", async () => {
      prisma.conversation.findUnique.mockResolvedValue({ id: 'conv-t', contextType: 'DIRECT_MESSAGE', contextId: 'interview:cc-1:abc' });
      mockUserCanAccessConversation.mockResolvedValue(true);
      mockSendMessage.mockResolvedValue({ id: 'msg-1' });

      await post(tokenFor(memberUser), '/api/conversations/conv-t/messages', { body: 'hi' });

      expect(mockNudgeInterviewThreads).toHaveBeenCalledWith('cc-1');
    });
  });

  describe('POST /api/conversations/:id/messages/:messageId/reactions', () => {
    it('toggles a reaction in an accessible conversation', async () => {
      mockUserCanAccessConversation.mockResolvedValue(true);
      mockToggleReaction.mockResolvedValue({ messageId: 'msg-1', reactions: [{ emoji: '👍', count: 1 }] });

      const res = await post(tokenFor(memberUser), '/api/conversations/conv-1/messages/msg-1/reactions', { emoji: '👍' });

      expect(res.status).toBe(200);
      expect(mockToggleReaction).toHaveBeenCalledWith({ conversationId: 'conv-1', messageId: 'msg-1', user: memberUser, emoji: '👍' });
    });

    it('refuses a conversation the user cannot read', async () => {
      mockUserCanAccessConversation.mockResolvedValue(false);

      const res = await post(tokenFor(memberUser), '/api/conversations/conv-1/messages/msg-1/reactions', { emoji: '👍' });

      expect(res.status).toBe(403);
      expect(mockToggleReaction).not.toHaveBeenCalled();
    });
  });
});
