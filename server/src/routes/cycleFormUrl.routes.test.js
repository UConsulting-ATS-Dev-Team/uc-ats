// A cycle's form link must be one the application sync can read. Saving a
// shortlink or published link would give candidates an "Apply Here" whose
// responses never reach the ATS, so both cycle routes refuse it up front.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import adminRoutes from './admin.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    recruitingCycle: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn()
  }
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'admin@example.com', fullName: 'Admin' };

let server;
let port;

const request = (path, method, body) =>
  fetch(`http://localhost:${port}/api/admin${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt.sign({ userId: adminUser.id }, process.env.JWT_SECRET)}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue(adminUser);
  prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
  prisma.recruitingCycle.create.mockImplementation(async ({ data }) => ({ id: 'created', ...data }));
  prisma.recruitingCycle.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
});

const UNSYNCABLE = [
  'https://forms.gle/AbC123xyz',
  'https://docs.google.com/forms/d/e/1FAIpQLSd-pub/viewform',
  'https://example.com/forms/d/abc/edit'
];

describe('cycle form links', () => {
  it.each(UNSYNCABLE)('refuses to create a cycle with %s', async (formUrl) => {
    const res = await request('/cycles', 'POST', { name: 'Fall 2026', formUrl });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/editor link/);
    expect(prisma.recruitingCycle.create).not.toHaveBeenCalled();
  });

  it.each(UNSYNCABLE)('refuses to update a cycle to %s', async (formUrl) => {
    const res = await request('/cycles/cycle-1', 'PATCH', { formUrl });

    expect(res.status).toBe(400);
    expect(prisma.recruitingCycle.update).not.toHaveBeenCalled();
  });

  it('lets a cycle saved with an old shortlink be edited without replacing it', async () => {
    prisma.recruitingCycle.findUnique.mockResolvedValue({ formUrl: 'https://forms.gle/AbC123xyz' });

    const res = await request('/cycles/cycle-1', 'PATCH', {
      name: 'Fall 2026 (renamed)',
      formUrl: 'https://forms.gle/AbC123xyz'
    });

    expect(res.status).not.toBe(400);
    expect(prisma.recruitingCycle.update).toHaveBeenCalled();
    // Never written back: a fix another admin saved meanwhile must survive.
    const writes = prisma.recruitingCycle.update.mock.calls.map(([args]) => args.data);
    expect(writes.some((data) => 'formUrl' in data)).toBe(false);
    expect(writes.some((data) => data.name === 'Fall 2026 (renamed)')).toBe(true);
  });

  it('accepts the editor link', async () => {
    const res = await request('/cycles', 'POST', {
      name: 'Fall 2026',
      formUrl: 'https://docs.google.com/forms/d/abc123/edit'
    });

    expect(res.status).toBe(201);
    expect(prisma.recruitingCycle.create).toHaveBeenCalled();
  });

  it('still lets a cycle be saved with no form, or have its form cleared', async () => {
    expect((await request('/cycles', 'POST', { name: 'Fall 2026' })).status).toBe(201);
    expect((await request('/cycles/cycle-1', 'PATCH', { formUrl: '' })).status).not.toBe(400);
  });
});
