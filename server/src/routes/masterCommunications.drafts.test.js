// Saved drafts of master communications.
//
// The assertions worth having are about what a draft is for: it holds an
// unfinished message, it holds the whole composition rather than just the text,
// and it is shared - one admin writes it, another finishes it.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import routes from './masterCommunications.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    messageDraft: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

const admin = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Admin One' };
const otherAdmin = { id: 'admin-2', role: 'ADMIN', isActive: true, email: 'b@uc.org', fullName: 'Admin Two' };
const member = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org' };
const ALL = [admin, otherAdmin, member];

let server;
let port;

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

const call = (path, { user, method = 'GET', body } = {}) =>
  fetch(`http://localhost:${port}${path}`, {
    method,
    headers: {
      ...(user ? { Authorization: `Bearer ${tokenFor(user)}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const draftRow = (overrides = {}) => ({
  id: 'draft-1',
  name: 'TPN launch',
  channel: 'email',
  audience: 'members',
  filters: { roles: ['MEMBER'] },
  subject: 'Get on the Talent Partner Network',
  body: 'Hi {{firstName}}!',
  cycleId: null,
  createdAt: new Date('2026-08-27'),
  updatedAt: new Date('2026-08-27'),
  creator: { id: admin.id, fullName: admin.fullName, email: admin.email },
  editor: null,
  ...overrides,
});

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/master-communications', routes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockImplementation(({ where: { id } }) => ALL.find((u) => u.id === id) || null);
  prisma.messageDraft.findMany.mockResolvedValue([draftRow()]);
  prisma.messageDraft.findUnique.mockResolvedValue({ id: 'draft-1' });
  prisma.messageDraft.create.mockImplementation(({ data }) => Promise.resolve(draftRow(data)));
  prisma.messageDraft.update.mockImplementation(({ data }) => Promise.resolve(draftRow(data)));
  prisma.messageDraft.delete.mockResolvedValue({ id: 'draft-1' });
});

describe('access', () => {
  it('is admin-only', async () => {
    expect((await call('/api/master-communications/drafts', { user: member })).status).toBe(403);
  });

  it('refuses an unauthenticated request', async () => {
    expect((await call('/api/master-communications/drafts')).status).toBe(401);
  });
});

describe('saving a draft', () => {
  it('keeps the whole composition, not just the text', async () => {
    const res = await call('/api/master-communications/drafts', {
      user: admin,
      method: 'POST',
      body: {
        name: 'TPN launch',
        channel: 'email',
        audience: 'members',
        filters: { roles: ['MEMBER'] },
        subject: 'Subject',
        body: 'Body',
      },
    });

    expect(res.status).toBe(201);
    // Audience and filters are the difference between a draft and a template -
    // without them reopening one would not restore who it was going to.
    expect(prisma.messageDraft.create.mock.calls[0][0].data).toMatchObject({
      audience: 'members',
      filters: { roles: ['MEMBER'] },
      channel: 'email',
      createdById: admin.id,
    });
  });

  it('accepts an empty body, because unfinished is the point', async () => {
    const res = await call('/api/master-communications/drafts', {
      user: admin,
      method: 'POST',
      body: { name: 'Half-written', channel: 'email', audience: 'members' },
    });
    expect(res.status).toBe(201);
  });

  it('still requires enough to identify it later', async () => {
    const res = await call('/api/master-communications/drafts', {
      user: admin,
      method: 'POST',
      body: { channel: 'email', audience: 'members' },
    });
    expect(res.status).toBe(400);
  });
});

describe('editing a draft', () => {
  it('lets a different admin finish someone else\'s draft', async () => {
    const res = await call('/api/master-communications/drafts/draft-1', {
      user: otherAdmin,
      method: 'PATCH',
      body: { body: 'Finished by someone else' },
    });

    expect(res.status).toBe(200);
    expect(prisma.messageDraft.update.mock.calls[0][0].data).toMatchObject({
      body: 'Finished by someone else',
      // Recorded so you can see who touched it last before sending it.
      updatedById: otherAdmin.id,
    });
  });

  it('leaves untouched fields alone rather than blanking them', async () => {
    await call('/api/master-communications/drafts/draft-1', {
      user: admin,
      method: 'PATCH',
      body: { subject: 'New subject' },
    });

    const data = prisma.messageDraft.update.mock.calls[0][0].data;
    expect(data.subject).toBe('New subject');
    expect('body' in data).toBe(false);
    expect('audience' in data).toBe(false);
  });

  it('404s for a draft that does not exist', async () => {
    prisma.messageDraft.findUnique.mockResolvedValue(null);
    const res = await call('/api/master-communications/drafts/nope', {
      user: admin,
      method: 'PATCH',
      body: { subject: 'x' },
    });
    expect(res.status).toBe(404);
  });
});

describe('listing and deleting', () => {
  it('shows who wrote each draft, since they are shared', async () => {
    const body = await (await call('/api/master-communications/drafts', { user: admin })).json();
    expect(body.drafts[0].creator).toMatchObject({ fullName: 'Admin One' });
  });

  it('orders by most recently touched - a draft list is a to-finish list', async () => {
    await call('/api/master-communications/drafts', { user: admin });
    expect(prisma.messageDraft.findMany.mock.calls[0][0].orderBy).toEqual({ updatedAt: 'desc' });
  });

  it('deletes one', async () => {
    const res = await call('/api/master-communications/drafts/draft-1', { user: admin, method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(prisma.messageDraft.delete).toHaveBeenCalledWith({ where: { id: 'draft-1' } });
  });

  it('404s deleting one that is already gone', async () => {
    prisma.messageDraft.findUnique.mockResolvedValue(null);
    const res = await call('/api/master-communications/drafts/nope', { user: admin, method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
