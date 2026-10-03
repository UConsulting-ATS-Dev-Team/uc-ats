// Who can reach which review team deliberation endpoint, and that service errors
// reach the client with their code and details intact. Which team a member may
// watch is the service's check, covered in reviewDelibs.test.js.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import reviewDelibRoutes from './reviewDelibs.js';
import * as service from '../services/reviewDelibs/reviewDelibs.js';

vi.mock('../prismaClient.js', () => ({ default: { user: { findUnique: vi.fn() } } }));
vi.mock('../services/reviewDelibs/reviewDelibs.js', () => {
  const names = [
    'endSession', 'getActiveSessions', 'getCandidateCard', 'getChanges', 'getGroupStatuses', 'getState',
    'getTeamView', 'joinSession', 'launchSession', 'leaveSession', 'overrideScore', 'setDecision', 'setThreshold'
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
  app.use('/api/review-delibs', reviewDelibRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/api/review-delibs`;
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

describe('review delib routes', () => {
  it('keeps candidates out entirely', async () => {
    const res = await call('candidate', 'GET', '/active');
    expect(res.status).toBe(403);
    expect(service.getActiveSessions).not.toHaveBeenCalled();
  });

  it('lets members join and read', async () => {
    for (const name of ['joinSession', 'getState', 'getTeamView', 'getCandidateCard', 'getChanges']) {
      service[name].mockResolvedValue({ version: 1 });
    }
    expect((await call('member', 'POST', '/s1/join')).status).toBe(200);
    expect((await call('member', 'GET', '/s1/state')).status).toBe(200);
    expect((await call('member', 'GET', '/s1/team')).status).toBe(200);
    expect((await call('member', 'GET', '/s1/candidates/app1')).status).toBe(200);
    expect((await call('member', 'GET', '/s1/changes')).status).toBe(200);
    expect(service.getCandidateCard).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1', applicationId: 'app1', user: expect.objectContaining({ id: 'u-member' })
    }));
  });

  it.each([
    ['GET', '/groups'],
    ['POST', '/'],
    ['POST', '/s1/threshold'],
    ['POST', '/s1/scores/resume/score1'],
    ['POST', '/s1/decision'],
    ['POST', '/s1/end']
  ])('refuses members %s %s', async (method, path) => {
    const res = await call('member', method, path, method === 'GET' ? undefined : {});
    expect(res.status).toBe(403);
  });

  it('has no shared navigation any more: each viewer moves on their own', async () => {
    expect((await call('admin', 'POST', '/s1/navigate', { step: 'ALL' })).status).toBe(404);
  });

  it('launches with 201 and passes the threshold through', async () => {
    service.launchSession.mockResolvedValue({ session: { id: 's1' } });
    const res = await call('admin', 'POST', '/', { groupId: 'g1', thresholdPct: 0.25 });
    expect(res.status).toBe(201);
    expect(service.launchSession).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'g1', thresholdPct: 0.25 }));
  });

  it('passes an override through with its document type and score', async () => {
    service.overrideScore.mockResolvedValue({ version: 4 });
    await call('admin', 'POST', '/s1/scores/coverLetter/sc9', { adminScore: 2.5 });
    expect(service.overrideScore).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1', type: 'coverLetter', scoreId: 'sc9', adminScore: 2.5
    }));
  });

  it('returns the running session on a duplicate launch, and the team on a refusal', async () => {
    service.launchSession.mockRejectedValue(Object.assign(new Error('running'), { status: 409, code: 'DELIB_ACTIVE', sessionId: 's0' }));
    const duplicate = await call('admin', 'POST', '/', { groupId: 'g1' });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: 'running', code: 'DELIB_ACTIVE', sessionId: 's0' });

    service.getState.mockRejectedValue(Object.assign(new Error('not yours'), { status: 403, code: 'NOT_ON_TEAM', groupName: 'Team Beta' }));
    const refused = await call('member', 'GET', '/s1/state');
    expect(await refused.json()).toEqual({ error: 'not yours', code: 'NOT_ON_TEAM', groupName: 'Team Beta' });
  });

  it('answers 204 for a leave and a generic 500 for an unexpected error', async () => {
    service.leaveSession.mockResolvedValue(undefined);
    expect((await call('member', 'POST', '/s1/leave')).status).toBe(204);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    service.getState.mockRejectedValue(new Error('database exploded'));
    const res = await call('member', 'GET', '/s1/state');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Deliberation request failed' });
  });
});
