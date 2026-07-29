import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import prisma from '../prismaClient.js';
import { sendPasswordResetConfirmationEmail } from '../services/emailNotifications.js';
import authRoutes from './auth.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    }
  }
}));

vi.mock('../services/emailNotifications.js', () => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue({ success: true }),
  sendPasswordResetConfirmationEmail: vi.fn().mockResolvedValue({ success: true })
}));

describe('auth routes', () => {
  let app;
  let server;
  let port;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function postResetPassword(body) {
    return fetch(`http://localhost:${port}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  describe('POST /api/auth/reset-password', () => {
    it('updates the password and sends a confirmation email to the account email', async () => {
      const user = {
        id: 'user-1',
        email: 'user@example.com',
        fullName: 'Test User',
      };
      prisma.user.findFirst.mockResolvedValue(user);
      prisma.user.update.mockResolvedValue({ ...user, password: 'hashed' });

      const res = await postResetPassword({ token: 'valid-token', newPassword: 'newpass123' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toBe('Password reset successful');

      expect(prisma.user.update).toHaveBeenCalledOnce();
      expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'user-1' },
        data: expect.objectContaining({
          resetToken: null,
          resetTokenExpiry: null,
        })
      }));

      expect(sendPasswordResetConfirmationEmail).toHaveBeenCalledOnce();
      expect(sendPasswordResetConfirmationEmail).toHaveBeenCalledWith('user@example.com', 'Test User');
    });

    it('does not expose tokens or passwords in the confirmation email call', async () => {
      const user = {
        id: 'user-1',
        email: 'user@example.com',
        fullName: 'Test User',
      };
      prisma.user.findFirst.mockResolvedValue(user);
      prisma.user.update.mockResolvedValue(user);

      await postResetPassword({ token: 'valid-token', newPassword: 'newpass123' });

      const [confirmationEmail, confirmationName] = sendPasswordResetConfirmationEmail.mock.calls[0];
      expect(confirmationEmail).toBe('user@example.com');
      expect(confirmationName).toBe('Test User');
      expect(JSON.stringify(sendPasswordResetConfirmationEmail.mock.calls)).not.toContain('valid-token');
      expect(JSON.stringify(sendPasswordResetConfirmationEmail.mock.calls)).not.toContain('newpass123');
    });

    it('returns 400 and does not send confirmation for an invalid or expired token', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      const res = await postResetPassword({ token: 'bad-token', newPassword: 'newpass123' });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid or expired token/i);
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(sendPasswordResetConfirmationEmail).not.toHaveBeenCalled();
    });

    it('returns 400 when the token or new password is missing', async () => {
      const res = await postResetPassword({ token: 'only-token' });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Missing token or new password/i);
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('keeps the successful password change even if confirmation delivery fails', async () => {
      const user = {
        id: 'user-2',
        email: 'user2@example.com',
        fullName: 'User Two',
      };
      prisma.user.findFirst.mockResolvedValue(user);
      prisma.user.update.mockResolvedValue(user);
      sendPasswordResetConfirmationEmail.mockResolvedValue({ success: false, error: 'SES failure' });

      const res = await postResetPassword({ token: 'valid-token', newPassword: 'newpass123' });

      expect(res.status).toBe(200);
      expect(prisma.user.update).toHaveBeenCalledOnce();
      expect(sendPasswordResetConfirmationEmail).toHaveBeenCalledOnce();
    });

    it('skips confirmation when the account has no email address', async () => {
      const user = {
        id: 'user-3',
        email: null,
        fullName: 'User Three',
      };
      prisma.user.findFirst.mockResolvedValue(user);
      prisma.user.update.mockResolvedValue(user);

      const res = await postResetPassword({ token: 'valid-token', newPassword: 'newpass123' });

      expect(res.status).toBe(200);
      expect(sendPasswordResetConfirmationEmail).not.toHaveBeenCalled();
    });
  });
});
