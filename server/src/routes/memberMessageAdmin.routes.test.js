// "Message an Admin" must not tell the sender it worked when the email to the
// exec inbox failed: Slack is optional and silent when unconfigured, so the
// email is the only copy that is sure to reach anyone.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import memberRoutes from './member.js';
import { sendSlackMessage } from '../services/slackService.js';

vi.mock('../prismaClient.js', () => ({
  default: { user: { findUnique: vi.fn() } },
}));

vi.mock('../services/slackService.js', () => ({ sendSlackMessage: vi.fn() }));

const sendAdminMessageEmail = vi.fn();
vi.mock('../services/emailNotifications.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sendAdminMessageEmail: (...args) => sendAdminMessageEmail(...args),
}));

const memberUser = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'pam@g.ucla.edu', fullName: 'Pam Beesly' };

let server;
let port;

const post = (body) =>
  fetch(`http://localhost:${port}/api/member/message-admin`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt.sign({ userId: memberUser.id }, process.env.JWT_SECRET)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const app = express();
  app.use(express.json());
  app.use('/api/member', memberRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  prisma.user.findUnique.mockResolvedValue(memberUser);
  sendSlackMessage.mockResolvedValue(undefined);
});

describe('POST /api/member/message-admin', () => {
  it('emails the admins as the signed-in user', async () => {
    sendAdminMessageEmail.mockResolvedValue({ success: true });

    const res = await post({ message: '  Can I swap my interview slot?  ' });

    expect(res.status).toBe(200);
    expect(sendAdminMessageEmail).toHaveBeenCalledWith({
      fromName: 'Pam Beesly',
      fromEmail: 'pam@g.ucla.edu',
      role: 'MEMBER',
      message: 'Can I swap my interview slot?',
      triggeredById: 'member-1',
    });
  });

  it('says so when the email fails, and posts nothing to Slack', async () => {
    sendAdminMessageEmail.mockResolvedValue({ success: false, error: 'SES down' });

    const res = await post({ message: 'Hello' });

    // The sender will retry; a Slack copy here would be posted again each time.
    expect(res.status).toBe(502);
    expect(sendSlackMessage).not.toHaveBeenCalled();
  });

  it('posts to Slack once the email has gone', async () => {
    sendAdminMessageEmail.mockResolvedValue({ success: true });

    await post({ message: 'Hello' });

    expect(sendSlackMessage).toHaveBeenCalledTimes(1);
  });

  it('answers without waiting on a stalled Slack webhook', async () => {
    sendAdminMessageEmail.mockResolvedValue({ success: true });
    sendSlackMessage.mockReturnValue(new Promise(() => {}));

    const res = await post({ message: 'Hello' });

    expect(res.status).toBe(200);
  });

  it('still answers success when Slack rejects', async () => {
    sendAdminMessageEmail.mockResolvedValue({ success: true });
    sendSlackMessage.mockRejectedValue(new Error('Slack down'));

    const res = await post({ message: 'Hello' });

    expect(res.status).toBe(200);
  });

  it('refuses an empty message without sending', async () => {
    const res = await post({ message: '   ' });

    expect(res.status).toBe(400);
    expect(sendAdminMessageEmail).not.toHaveBeenCalled();
  });
});
