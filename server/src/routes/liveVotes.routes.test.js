// Who can reach which live vote endpoint, and that service errors reach the
// client with their code and details intact.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import liveVoteRoutes from './liveVotes.js';
import * as service from '../services/liveVotes.js';

vi.mock('../prismaClient.js', () => ({ default: { user: { findUnique: vi.fn() } } }));
vi.mock('../services/liveVotes.js', () => {
  const names = [
    'applyDecision', 'beginSession', 'castVote', 'closeBallot', 'endSession', 'getActiveSession', 'getRubrics',
    'getState', 'joinSession', 'launchSession', 'leaveSession', 'navigateSession', 'reopenBallot', 'saveRubric'
  ];
  return Object.fromEntries(names.map((name) => [name, vi.fn()]));
});

const users = {
  admin: { id: 'u-admin', role: 'ADMIN', email: 'a@ucla.edu', isActive: true },
  member: { id: 'u-member', role: 'MEMBER', email: 'm@ucla.edu', isActive: true },
  candidate: { id: 'u-cand', role: 'USER', email: 'c@ucla.edu', isActive: true }
};

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/live-votes', liveVoteRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/api/live-votes`;
      resolve();
    });
  });
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockImplementation(async ({ where }) =>
    Object.values(users).find((user) => user.id === where.id) || null
  );
});

const call = (who, method, path, body) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt.sign({ userId: users[who].id }, process.env.JWT_SECRET)}`
    },
    body: body ? JSON.stringify(body) : undefined
  });

describe('live vote routes', () => {
  it('keeps candidates out entirely', async () => {
    const res = await call('candidate', 'GET', '/active');
    expect(res.status).toBe(403);
    expect(service.getActiveSession).not.toHaveBeenCalled();
  });

  it('lets members join, read state and vote', async () => {
    service.joinSession.mockResolvedValue({ version: 1 });
    service.getState.mockResolvedValue({ version: 2 });
    service.castVote.mockResolvedValue({ ballotId: 'b1', myVote: 'YES', version: 3 });

    expect((await call('member', 'POST', '/s1/join')).status).toBe(200);
    expect((await call('member', 'GET', '/s1/state')).status).toBe(200);
    const voted = await call('member', 'POST', '/s1/votes', { ballotId: 'b1', value: 'YES' });
    expect(voted.status).toBe(200);
    expect(service.castVote).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1', ballotId: 'b1', value: 'YES', user: expect.objectContaining({ id: 'u-member' })
    }));
  });

  it.each([
    ['POST', '/', 'launchSession'],
    ['GET', '/rubrics', 'getRubrics'],
    ['PUT', '/rubrics/final', 'saveRubric'],
    ['POST', '/s1/begin', 'beginSession'],
    ['POST', '/s1/close', 'closeBallot'],
    ['POST', '/s1/reopen', 'reopenBallot'],
    ['POST', '/s1/navigate', 'navigateSession'],
    ['POST', '/s1/decision', 'applyDecision'],
    ['POST', '/s1/end', 'endSession']
  ])('refuses members on %s %s', async (method, path, fn) => {
    const res = await call('member', method, path, method === 'GET' ? undefined : {});
    expect(res.status).toBe(403);
    expect(service[fn]).not.toHaveBeenCalled();
  });

  it('answers a launch with 201', async () => {
    service.launchSession.mockResolvedValue({ session: { id: 's1', status: 'LOBBY' } });
    const res = await call('admin', 'POST', '/', { phase: 'final', applicationIds: ['a1'] });
    expect(res.status).toBe(201);
    expect(service.launchSession).toHaveBeenCalledWith(expect.objectContaining({ phase: 'final', applicationIds: ['a1'], saveRubricAsDefault: false }));
  });

  it('passes service error codes and details through', async () => {
    service.launchSession.mockRejectedValue(Object.assign(new Error('Some candidates cannot be voted on'), {
      status: 422, code: 'INVALID_CANDIDATES', rejected: [{ applicationId: 'a1', reason: 'SEALED' }]
    }));
    const res = await call('admin', 'POST', '/', { phase: 'final', applicationIds: ['a1'] });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'Some candidates cannot be voted on',
      code: 'INVALID_CANDIDATES',
      rejected: [{ applicationId: 'a1', reason: 'SEALED' }]
    });

    service.navigateSession.mockRejectedValue(Object.assign(new Error('moved'), { status: 409, code: 'STALE_INDEX' }));
    const stale = await call('admin', 'POST', '/s1/navigate', { fromIndex: 0, toIndex: 1 });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('STALE_INDEX');
  });

  it('hides unexpected errors behind a generic 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    service.getState.mockRejectedValue(new Error('connection reset by pgbouncer'));
    const res = await call('member', 'GET', '/s1/state');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Live vote request failed' });
    spy.mockRestore();
  });

  it('answers leave with no content', async () => {
    service.leaveSession.mockResolvedValue(undefined);
    expect((await call('member', 'POST', '/s1/leave')).status).toBe(204);
  });
});
