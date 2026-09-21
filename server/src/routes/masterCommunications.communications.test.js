// The admin-facing read of the communications log.
//
// Worth pinning down: it is admin-only, it defaults to everything rather than to
// one cycle, and a filter in the query string reaches the query unchanged.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import routes from './masterCommunications.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    communicationLog: {
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
  },
}));

const admin = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Admin One' };
const member = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org' };
const ALL = [admin, member];

let server;
let port;

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

const call = (path, { user } = {}) =>
  fetch(`http://localhost:${port}${path}`, {
    headers: user ? { Authorization: `Bearer ${tokenFor(user)}` } : {},
  });

const row = (overrides = {}) => ({
  id: 'log-1',
  channel: 'email',
  category: 'APPLICATION_DECISION',
  trigger: 'AUTOMATED',
  status: 'SENT',
  recipient: 'ryan@example.com',
  recipientName: 'Ryan Kleczynski',
  subject: 'You are through to Round Two',
  bodyPreview: 'Congratulations',
  error: null,
  hasAttachments: false,
  messageLogId: null,
  sentAt: new Date('2026-09-19T17:00:00Z'),
  triggeredBy: null,
  cycle: null,
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
  prisma.communicationLog.findMany.mockResolvedValue([row()]);
  prisma.communicationLog.count.mockResolvedValue(1);
  prisma.communicationLog.groupBy.mockResolvedValue([]);
});

const whereOf = () => prisma.communicationLog.findMany.mock.calls[0][0].where;

describe('access', () => {
  it('is admin-only', async () => {
    expect((await call('/api/master-communications/communications', { user: member })).status).toBe(403);
  });

  it('refuses an unauthenticated request', async () => {
    expect((await call('/api/master-communications/communications')).status).toBe(401);
  });

  it('guards the filter options the same way', async () => {
    expect(
      (await call('/api/master-communications/communications/facets', { user: member })).status
    ).toBe(403);
  });
});

describe('listing', () => {
  it('returns the rows with the unpaged total', async () => {
    const res = await call('/api/master-communications/communications', { user: admin });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.rows[0]).toMatchObject({ recipient: 'ryan@example.com', status: 'SENT' });
  });

  // A password reset and an account verification belong to no cycle. Scoping the
  // log to one by default would hide exactly the messages an admin comes here
  // to find.
  it('is not scoped to a cycle unless one is asked for', async () => {
    await call('/api/master-communications/communications', { user: admin });
    expect(whereOf()).toEqual({});
  });

  it('passes each filter through to the query', async () => {
    await call(
      '/api/master-communications/communications?channel=email&category=ACCOUNT&status=FAILED&trigger=MANUAL&cycleId=cycle-1',
      { user: admin }
    );
    expect(whereOf()).toMatchObject({
      channel: 'email',
      category: 'ACCOUNT',
      status: 'FAILED',
      trigger: 'MANUAL',
      cycleId: 'cycle-1',
    });
  });

  it('searches recipient and subject together', async () => {
    await call('/api/master-communications/communications?search=ryan', { user: admin });
    expect(whereOf().OR).toHaveLength(3);
  });
});

describe('filter options', () => {
  it('offers the full vocabulary even before anything has been sent', async () => {
    const res = await call('/api/master-communications/communications/facets', { user: admin });
    const body = await res.json();
    expect(body.known.channels).toContain('imessage');
    expect(body.known.categories).toContain('MASTER_COMMUNICATION');
    expect(body.known.statuses).toContain('FAILED');
    expect(body.categories).toEqual([]);
  });

  it('reports what is actually present, with counts', async () => {
    prisma.communicationLog.groupBy.mockResolvedValue([
      { channel: 'email', category: 'ACCOUNT', status: 'SENT', _count: { _all: 7 } },
    ]);
    const res = await call('/api/master-communications/communications/facets', { user: admin });
    const body = await res.json();
    expect(body.channels).toEqual([{ value: 'email', count: 7 }]);
  });
});
