// Who may read the decision guide and who may change it. Members are the people
// the guide is written for, so they have to be able to read it; only admins get
// to put words in their mouths.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import decisionGuideRoutes from './decisionGuides.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    decisionGuide: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() }
  }
}));

const users = {
  admin: { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'admin@example.com', fullName: 'Admin' },
  member: { id: 'member-1', role: 'MEMBER', isActive: true, email: 'member@example.com', fullName: 'Member' },
  candidate: { id: 'user-1', role: 'USER', isActive: true, email: 'user@example.com', fullName: 'Applicant' }
};

let server;
let port;

const request = (path, { as = 'admin', method = 'GET', body } = {}) =>
  fetch(`http://localhost:${port}/api/decision-guides${path}`, {
    method,
    headers: {
      ...(as ? { Authorization: `Bearer ${jwt.sign({ userId: users[as].id }, process.env.JWT_SECRET)}` } : {}),
      'Content-Type': 'application/json'
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/decision-guides', decisionGuideRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.decisionGuide.findMany.mockResolvedValue([]);
  prisma.decisionGuide.upsert.mockResolvedValue({ phase: 'final', guide: {}, updatedAt: new Date() });
  prisma.decisionGuide.deleteMany.mockResolvedValue({ count: 1 });
});

const authAs = (who) => prisma.user.findUnique.mockResolvedValue(users[who]);

describe('reading', () => {
  it('lets a member read the guide for a round', async () => {
    authAs('member');
    const response = await request('/final', { as: 'member' });

    expect(response.status).toBe(200);
    const { guide } = await response.json();
    expect(guide.phase).toBe('final');
    expect(guide.decisions.map((entry) => entry.value)).toEqual(['YES', 'MAYBE_YES', 'MAYBE_NO', 'NO']);
  });

  it('turns an unknown round away instead of inventing one', async () => {
    authAs('admin');
    const response = await request('/deliberations');

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_PHASE' });
  });

  it('keeps candidates out', async () => {
    authAs('candidate');
    expect((await request('/final', { as: 'candidate' })).status).toBe(403);
  });

  it('keeps anonymous callers out', async () => {
    expect((await request('/final', { as: null })).status).toBe(401);
  });
});

describe('writing', () => {
  it('lets an admin save a round', async () => {
    authAs('admin');
    const response = await request('/final', {
      method: 'PUT',
      body: { intro: 'House rules.', criteria: { YES: 'Advance them.' } }
    });

    expect(response.status).toBe(200);
    expect(prisma.decisionGuide.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { phase: 'final' },
      create: expect.objectContaining({
        phase: 'final',
        updatedById: 'admin-1',
        guide: { intro: 'House rules.', criteria: { YES: 'Advance them.', MAYBE_YES: '', MAYBE_NO: '', NO: '' } }
      })
    }));
  });

  it('refuses a member trying to rewrite it', async () => {
    authAs('member');
    const response = await request('/final', { as: 'member', method: 'PUT', body: { intro: 'Mine now.' } });

    expect(response.status).toBe(403);
    expect(prisma.decisionGuide.upsert).not.toHaveBeenCalled();
  });

  it('refuses a member trying to reset it', async () => {
    authAs('member');
    expect((await request('/final', { as: 'member', method: 'DELETE' })).status).toBe(403);
    expect(prisma.decisionGuide.deleteMany).not.toHaveBeenCalled();
  });

  it('is what a member reads afterwards', async () => {
    // One store shared by both calls, so this is the real round trip through
    // the routes rather than two independent assertions about mocks.
    const rows = [];
    prisma.decisionGuide.upsert.mockImplementation(async ({ where, create, update }) => {
      const existing = rows.find((row) => row.phase === where.phase);
      if (existing) return Object.assign(existing, update);
      const row = { id: 'row-1', updatedAt: new Date(), ...create };
      rows.push(row);
      return row;
    });
    prisma.decisionGuide.findMany.mockImplementation(async ({ where } = {}) => (
      where?.phase?.in ? rows.filter((row) => where.phase.in.includes(row.phase)) : rows
    ));

    authAs('admin');
    const saved = await request('/firstRound', {
      method: 'PUT',
      body: { intro: 'Ask the group before you pick a maybe.', criteria: { NO: 'Not for a client-facing meeting.' } }
    });
    expect(saved.status).toBe(200);

    authAs('member');
    const { guide } = await (await request('/firstRound', { as: 'member' })).json();

    expect(guide.intro).toBe('Ask the group before you pick a maybe.');
    expect(guide.decisions.find((entry) => entry.value === 'NO')).toMatchObject({
      criteria: 'Not for a client-facing meeting.',
      source: 'firstRound'
    });
    // The decisions the admin said nothing about still read, from the defaults.
    expect(guide.decisions.find((entry) => entry.value === 'YES').criteria).toBeTruthy();
    expect(guide.decisions.find((entry) => entry.value === 'YES').source).toBe('default');
  });

  it('reports copy that is too long as a bad request, not a crash', async () => {
    authAs('admin');
    const response = await request('/final', { method: 'PUT', body: { intro: 'x'.repeat(2001) } });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_GUIDE' });
    expect(prisma.decisionGuide.upsert).not.toHaveBeenCalled();
  });
});
