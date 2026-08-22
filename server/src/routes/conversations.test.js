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

vi.mock('../prismaClient.js', () => ({
  default: {
    interview: { findUnique: vi.fn() },
    conversation: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
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
  syncInterviewParticipants: (...args) => mockSyncInterviewParticipants(...args)
}));

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

    it('rejects a member who is not assigned to the interview', async () => {
      prisma.interview.findUnique.mockResolvedValue({ id: 'interview-1', assignments: [] });

      const res = await get(tokenFor(memberUser), '/api/conversations/interviews/interview-1');

      expect(res.status).toBe(403);
      expect(mockGetOrCreateInterviewConversation).not.toHaveBeenCalled();
    });

    it('allows an assigned member to access the interview conversation', async () => {
      prisma.interview.findUnique.mockResolvedValue({ id: 'interview-1', assignments: [{ id: 'a-1' }] });
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
});
