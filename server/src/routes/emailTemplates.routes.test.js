import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    emailTemplateCopy: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
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

    // Nobody has edited anything unless a test says otherwise.
    prisma.emailTemplateCopy.findMany.mockResolvedValue([]);
    prisma.emailTemplateCopy.deleteMany.mockResolvedValue({ count: 0 });
    prisma.emailTemplateCopy.upsert.mockResolvedValue({});
  });

  function request(path, token, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`http://localhost:${server.address().port}/api/admin/email-templates${path}`, {
      ...init,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  const get = (path, token) => request(path, token);
  const put = (path, token, body) => request(path, token, { method: 'PUT', body });
  const del = (path, token) => request(path, token, { method: 'DELETE' });

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

  describe('reading the editable wording', () => {
    it('hands an admin the fields, what is stored and what they fall back to', async () => {
      prisma.emailTemplateCopy.findMany.mockResolvedValue([
        { templateKey: 'rsvp-confirmation', copy: { heading: 'You are on the list' }, updatedAt: new Date() },
      ]);

      const res = await get('/rsvp-confirmation/copy', tokenFor(adminUser));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.key).toBe('rsvp-confirmation');
      expect(body.customized).toBe(true);
      const heading = body.fields.find((field) => field.name === 'heading');
      expect(heading.value).toBe('You are on the list');
      expect(heading.default).toBe('RSVP Confirmation');
      expect(body.mergeFields).toContain('candidateName');
    });

    it('404s a template that does not exist', async () => {
      expect((await get('/not-a-template/copy', tokenFor(adminUser))).status).toBe(404);
    });

    it('404s a prototype key', async () => {
      expect((await get('/constructor/copy', tokenFor(adminUser))).status).toBe(404);
    });

    it('refuses a member', async () => {
      expect((await get('/rsvp-confirmation/copy', tokenFor(memberUser))).status).toBe(403);
    });

    it('refuses an anonymous caller', async () => {
      expect((await get('/rsvp-confirmation/copy', undefined)).status).toBe(401);
    });
  });

  describe('saving wording', () => {
    it('stores what an admin changed', async () => {
      const res = await put('/rsvp-confirmation/copy', tokenFor(adminUser), {
        copy: { heading: 'You are on the list' },
      });

      expect(res.status).toBe(200);
      expect(prisma.emailTemplateCopy.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { templateKey: 'rsvp-confirmation' },
          create: expect.objectContaining({
            templateKey: 'rsvp-confirmation',
            copy: { heading: 'You are on the list' },
            updatedById: adminUser.id,
          }),
        })
      );
    });

    it('refuses a merge field the email cannot fill in, and says which', async () => {
      const res = await put('/rsvp-confirmation/copy', tokenFor(adminUser), {
        copy: { heading: 'Hi {{memberName}}' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('UNKNOWN_MERGE_FIELD');
      expect(body.error).toContain('{{memberName}}');
      expect(prisma.emailTemplateCopy.upsert).not.toHaveBeenCalled();
    });

    it('refuses a body that is not an object', async () => {
      const res = await put('/rsvp-confirmation/copy', tokenFor(adminUser), { copy: 'nope' });

      expect(res.status).toBe(400);
      expect(prisma.emailTemplateCopy.upsert).not.toHaveBeenCalled();
    });

    it('404s a template that does not exist', async () => {
      const res = await put('/not-a-template/copy', tokenFor(adminUser), { copy: {} });
      expect(res.status).toBe(404);
    });

    it('refuses a member', async () => {
      const res = await put('/rsvp-confirmation/copy', tokenFor(memberUser), { copy: {} });
      expect(res.status).toBe(403);
      expect(prisma.emailTemplateCopy.upsert).not.toHaveBeenCalled();
    });

    it('refuses an anonymous caller', async () => {
      const res = await put('/rsvp-confirmation/copy', undefined, { copy: {} });
      expect(res.status).toBe(401);
      expect(prisma.emailTemplateCopy.upsert).not.toHaveBeenCalled();
    });

    it('sends nothing while saving', async () => {
      await put('/rsvp-confirmation/copy', tokenFor(adminUser), { copy: { heading: 'New' } });

      expect(sendMail).not.toHaveBeenCalled();
      expect(createTransport).not.toHaveBeenCalled();
    });
  });

  describe('restoring the shipped wording', () => {
    it('drops the row', async () => {
      const res = await del('/rsvp-confirmation/copy', tokenFor(adminUser));

      expect(res.status).toBe(200);
      expect(prisma.emailTemplateCopy.deleteMany).toHaveBeenCalledWith({
        where: { templateKey: 'rsvp-confirmation' },
      });
    });

    it('404s a template that does not exist', async () => {
      expect((await del('/not-a-template/copy', tokenFor(adminUser))).status).toBe(404);
      expect(prisma.emailTemplateCopy.deleteMany).not.toHaveBeenCalled();
    });

    it('refuses a member', async () => {
      expect((await del('/rsvp-confirmation/copy', tokenFor(memberUser))).status).toBe(403);
      expect(prisma.emailTemplateCopy.deleteMany).not.toHaveBeenCalled();
    });

    it('refuses an anonymous caller', async () => {
      expect((await del('/rsvp-confirmation/copy', undefined)).status).toBe(401);
      expect(prisma.emailTemplateCopy.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('the preview reflects an edit', () => {
    it('renders what an admin saved, not what the repo ships', async () => {
      prisma.emailTemplateCopy.findMany.mockResolvedValue([
        { templateKey: 'rsvp-confirmation', copy: { heading: 'You are on the list' }, updatedAt: new Date() },
      ]);

      const body = await (await get('/rsvp-confirmation/preview', tokenFor(adminUser))).json();

      expect(body.html).toContain('You are on the list');
      expect(body.html).not.toContain('>RSVP Confirmation<');
    });
  });
});
