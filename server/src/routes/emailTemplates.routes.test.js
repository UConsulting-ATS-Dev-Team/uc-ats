import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

// The transport is stubbed so that a request reaching it would be visible.
// Previewing must never send, and these routes are the only public way in.
const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});

vi.mock('nodemailer', () => ({ default: { createTransport } }));
vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {},
  SendEmailCommand: class {},
}));

import prisma from '../prismaClient.js';
import emailTemplateRoutes from './emailTemplates.js';

const adminUser = {
  id: 'admin-1',
  role: 'ADMIN',
  isActive: true,
  email: 'admin@example.com',
  fullName: 'Admin User',
  createdAt: new Date().toISOString(),
};

const memberUser = {
  id: 'member-1',
  role: 'MEMBER',
  isActive: true,
  email: 'member@example.com',
  fullName: 'Member User',
  createdAt: new Date().toISOString(),
};

function tokenFor(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
}

describe('/api/admin/email-templates', () => {
  let server;

  beforeAll(() => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin/email-templates', requireAuth, requireAdmin, emailTemplateRoutes);
    server = app.listen(0);
    return new Promise((resolve) => server.on('listening', resolve));
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockImplementation(({ where: { id } }) => {
      if (id === adminUser.id) return adminUser;
      if (id === memberUser.id) return memberUser;
      return null;
    });
  });

  function get(path, token) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://localhost:${server.address().port}/api/admin/email-templates${path}`, {
      headers,
    });
  }

  describe('listing', () => {
    it('returns the catalog to an admin', async () => {
      const res = await get('', tokenFor(adminUser));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.length).toBeGreaterThan(0);
      expect(body[0]).toHaveProperty('key');
      expect(body[0]).toHaveProperty('label');
      expect(body[0]).toHaveProperty('trigger');
      expect(body[0]).not.toHaveProperty('html');
    });

    it('refuses a member', async () => {
      expect((await get('', tokenFor(memberUser))).status).toBe(403);
    });

    it('refuses an anonymous caller', async () => {
      expect((await get('', undefined)).status).toBe(401);
    });
  });

  describe('preview', () => {
    it('renders a template for an admin', async () => {
      const res = await get('/password-reset/preview', tokenFor(adminUser));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.key).toBe('password-reset');
      expect(body.subject).toBe('Reset Your Password - UConsulting ATS');
      expect(body.html).toContain('Password Reset Request');
    });

    it('renders every template in the catalog without error', async () => {
      const list = await (await get('', tokenFor(adminUser))).json();

      for (const { key } of list) {
        const res = await get(`/${key}/preview`, tokenFor(adminUser));
        expect(res.status, `${key} should render`).toBe(200);
        const body = await res.json();
        expect(body.subject, `${key} should have a subject`).toBeTruthy();
        expect(body.html, `${key} should have a body`).toBeTruthy();
      }
    });

    it('sends nothing while previewing', async () => {
      const list = await (await get('', tokenFor(adminUser))).json();
      for (const { key } of list) {
        await get(`/${key}/preview`, tokenFor(adminUser));
      }

      expect(sendMail).not.toHaveBeenCalled();
      expect(createTransport).not.toHaveBeenCalled();
    });

    it('404s an unknown template rather than 500ing', async () => {
      const res = await get('/not-a-template/preview', tokenFor(adminUser));

      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('Unknown email template');
    });

    it('404s a prototype key', async () => {
      expect((await get('/constructor/preview', tokenFor(adminUser))).status).toBe(404);
    });

    it('refuses a member', async () => {
      expect((await get('/password-reset/preview', tokenFor(memberUser))).status).toBe(403);
    });

    it('refuses an anonymous caller', async () => {
      expect((await get('/password-reset/preview', undefined)).status).toBe(401);
    });
  });
});
