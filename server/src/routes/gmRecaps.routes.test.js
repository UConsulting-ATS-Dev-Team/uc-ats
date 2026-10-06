// What the route adds over the service: nobody reaches a recap without the
// admin role *and* a live executive unlock, and "Send now" only queues.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

import { issueUnlockToken, EXEC_UNLOCK_HEADER } from '../services/execAccess.js';
import { kickRecapQueue, listRecaps, scheduleRecap } from '../services/gmRecaps.js';
import routes from './gmRecaps.js';

let currentUser;
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.user = currentUser;
    next();
  },
  requireAdmin: (req, res, next) =>
    req.user.role === 'ADMIN' ? next() : res.status(403).json({ error: 'Admin access required' }),
}));

vi.mock('../services/emailImageStorage.js', () => ({ storeEmailImage: vi.fn() }));
vi.mock('../services/gmRecaps.js', () => ({
  createRecap: vi.fn(),
  deleteRecap: vi.fn(),
  getRecap: vi.fn(),
  kickRecapQueue: vi.fn(),
  listRecaps: vi.fn(),
  markRecapFailed: vi.fn(),
  recapAudience: vi.fn(),
  recapFields: vi.fn(),
  renderRecapPreview: vi.fn(),
  scheduleRecap: vi.fn(),
  sendRecapTest: vi.fn(),
  unscheduleRecap: vi.fn(),
  updateRecap: vi.fn(),
}));

const admin = { id: 'admin-1', role: 'ADMIN' };
const member = { id: 'member-1', role: 'MEMBER' };

let server;
let port;

const call = (method, path, { body, unlockFor } = {}) =>
  fetch(`http://localhost:${port}/api/exec-access/gm-recaps${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(unlockFor ? { [EXEC_UNLOCK_HEADER]: issueUnlockToken(unlockFor).token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/exec-access/gm-recaps', routes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = admin;
  listRecaps.mockResolvedValue([]);
});

describe('access', () => {
  it('refuses an admin without executive access', async () => {
    const res = await call('GET', '/');
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('EXEC_UNLOCK_REQUIRED');
    expect(listRecaps).not.toHaveBeenCalled();
  });

  it('refuses an unlock issued to somebody else', async () => {
    const res = await call('GET', '/', { unlockFor: 'admin-2' });
    expect(res.status).toBe(403);
  });

  it('refuses a member even with the password', async () => {
    currentUser = member;
    const res = await call('GET', '/', { unlockFor: 'member-1' });
    expect(res.status).toBe(403);
  });

  it('lets an unlocked admin in', async () => {
    const res = await call('GET', '/', { unlockFor: 'admin-1' });
    expect(res.status).toBe(200);
  });
});

describe('POST /:id/schedule', () => {
  it('starts sending straight away for "Send now"', async () => {
    scheduleRecap.mockResolvedValue({ id: 'r1', status: 'SCHEDULED', scheduledAt: new Date().toISOString() });
    const res = await call('POST', '/r1/schedule', { body: {}, unlockFor: 'admin-1' });
    expect(res.status).toBe(200);
    expect(scheduleRecap).toHaveBeenCalledWith({ id: 'r1', userId: 'admin-1', scheduledAt: null });
    expect(kickRecapQueue).toHaveBeenCalledTimes(1);
  });

  it('leaves a later time to the cron', async () => {
    const later = new Date(Date.now() + 3600 * 1000).toISOString();
    scheduleRecap.mockResolvedValue({ id: 'r1', status: 'SCHEDULED', scheduledAt: later });
    await call('POST', '/r1/schedule', { body: { scheduledAt: later }, unlockFor: 'admin-1' });
    expect(kickRecapQueue).not.toHaveBeenCalled();
  });

  it('passes a refusal through with its message', async () => {
    scheduleRecap.mockRejectedValue(Object.assign(new Error('That time has already passed.'), { status: 400, code: 'IN_THE_PAST' }));
    const res = await call('POST', '/r1/schedule', { body: { scheduledAt: '2020-01-01' }, unlockFor: 'admin-1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'That time has already passed.', code: 'IN_THE_PAST' });
  });
});
