// Round-one questions for one specific candidate: create/list/edit/delete on the
// member and admin routers, the guards that keep them off group-wide rows, and
// the regression that matters most - saving the shared list must never delete a
// candidate's questions.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import memberRoutes from './member.js';
import adminRoutes from './admin.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    interview: { findUnique: vi.fn(), update: vi.fn() },
    application: { findUnique: vi.fn(), findMany: vi.fn() },
    candidate: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    // Consulted by services/interviewRoster.js to decide which group id a
    // question is read and written under. Empty by default: these tests use raw
    // group ids that no slot claims, which is the legacy path the roster service
    // falls back to, so behaviour here is unchanged from before slots existed.
    interviewSlot: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    behavioralQuestion: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn()
    }
  }
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'admin@example.com', fullName: 'Admin' };
const memberUser = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'member@example.com', fullName: 'Member One' };
const candidateUser = { id: 'user-1', role: 'USER', isActive: true, email: 'cand@example.com', fullName: 'Candidate' };

const roundOne = {
  id: 'int-1',
  interviewType: 'ROUND_ONE',
  description: JSON.stringify({ applicationGroups: [{ id: 'grp-1', applicationIds: ['app-1', 'app-2'] }] })
};

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

let server;
let port;

const request = (path, { user = memberUser, method = 'GET', body } = {}) => {
  const headers = { Authorization: `Bearer ${tokenFor(user)}` };
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(`http://localhost:${port}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {})
  });
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/member', memberRoutes);
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
  prisma.user.findUnique.mockImplementation(({ where: { id } }) =>
    [adminUser, memberUser, candidateUser].find((u) => u.id === id) || null
  );
  // Neither sealed nor the caller's own application.
  prisma.application.findUnique.mockResolvedValue(null);
  prisma.interview.findUnique.mockResolvedValue(roundOne);
  prisma.behavioralQuestion.create.mockImplementation(({ data }) => ({
    id: 'bq-new',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data
  }));
});

describe('candidate-specific questions', () => {
  it('adds a question for one candidate, filed under that candidate’s group', async () => {
    prisma.behavioralQuestion.findFirst.mockResolvedValue({ order: 1 });

    const res = await request('/api/member/interviews/int-1/candidate-questions', {
      method: 'POST',
      body: { applicationId: 'app-2', questionText: '  Tell us about the startup on your resume.  ' }
    });

    expect(res.status).toBe(200);
    expect(prisma.behavioralQuestion.create).toHaveBeenCalledWith({
      data: {
        interviewId: 'int-1',
        groupId: 'grp-1',
        applicationId: 'app-2',
        questionText: 'Tell us about the startup on your resume.',
        order: 2,
        createdBy: 'member-1'
      }
    });
    const body = await res.json();
    expect(body).toMatchObject({ id: 'bq-new', applicationId: 'app-2', text: 'Tell us about the startup on your resume.' });
  });

  it('works for admins on the admin router too', async () => {
    prisma.behavioralQuestion.findFirst.mockResolvedValue(null);
    const res = await request('/api/admin/interviews/int-1/candidate-questions', {
      user: adminUser,
      method: 'POST',
      body: { applicationId: 'app-1', questionText: 'Why the major switch?' }
    });
    expect(res.status).toBe(200);
    expect(prisma.behavioralQuestion.create.mock.calls[0][0].data.order).toBe(0);
  });

  it('refuses a candidate who is not in the interview', async () => {
    const res = await request('/api/member/interviews/int-1/candidate-questions', {
      method: 'POST',
      body: { applicationId: 'app-elsewhere', questionText: 'Hi?' }
    });
    expect(res.status).toBe(400);
    expect(prisma.behavioralQuestion.create).not.toHaveBeenCalled();
  });

  it('is only available in first-round interviews', async () => {
    prisma.interview.findUnique.mockResolvedValue({ ...roundOne, interviewType: 'COFFEE_CHAT' });
    const res = await request('/api/member/interviews/int-1/candidate-questions', {
      method: 'POST',
      body: { applicationId: 'app-1', questionText: 'Hi?' }
    });
    expect(res.status).toBe(400);
    expect(prisma.behavioralQuestion.create).not.toHaveBeenCalled();
  });

  it('rejects a blank question', async () => {
    const res = await request('/api/member/interviews/int-1/candidate-questions', {
      method: 'POST',
      body: { applicationId: 'app-1', questionText: '   ' }
    });
    expect(res.status).toBe(400);
  });

  it('keeps applicant accounts out', async () => {
    const res = await request('/api/member/interviews/int-1/candidate-questions?applicationIds=app-1', {
      user: candidateUser
    });
    expect(res.status).toBe(403);
    expect(prisma.behavioralQuestion.findMany).not.toHaveBeenCalled();
  });

  it('lists questions grouped by candidate', async () => {
    prisma.behavioralQuestion.findMany.mockResolvedValue([
      { id: 'bq-1', applicationId: 'app-1', groupId: 'grp-1', questionText: 'A', order: 0 },
      { id: 'bq-2', applicationId: 'app-1', groupId: 'grp-1', questionText: 'B', order: 1 },
      { id: 'bq-3', applicationId: 'app-2', groupId: 'grp-1', questionText: 'C', order: 0 }
    ]);

    const res = await request('/api/member/interviews/int-1/candidate-questions?applicationIds=app-1,app-2');

    expect(res.status).toBe(200);
    expect(prisma.behavioralQuestion.findMany.mock.calls[0][0].where).toEqual({
      interviewId: 'int-1',
      applicationId: { in: ['app-1', 'app-2'] }
    });
    const body = await res.json();
    expect(body['app-1'].map((q) => q.text)).toEqual(['A', 'B']);
    expect(body['app-2'].map((q) => q.text)).toEqual(['C']);
  });

  it('edits and deletes a candidate’s own question', async () => {
    const row = { id: 'bq-1', interviewId: 'int-1', applicationId: 'app-1', groupId: 'grp-1', questionText: 'Old', order: 0 };
    prisma.behavioralQuestion.findUnique.mockResolvedValue(row);
    prisma.behavioralQuestion.update.mockImplementation(({ data }) => ({ ...row, ...data }));

    const edit = await request('/api/member/interviews/int-1/candidate-questions/bq-1', {
      method: 'PATCH',
      body: { questionText: 'New' }
    });
    expect(edit.status).toBe(200);
    expect((await edit.json()).text).toBe('New');

    const del = await request('/api/member/interviews/int-1/candidate-questions/bq-1', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(prisma.behavioralQuestion.delete).toHaveBeenCalledWith({ where: { id: 'bq-1' } });
  });

  it('cannot reach a group-wide question', async () => {
    prisma.behavioralQuestion.findUnique.mockResolvedValue({ id: 'bq-shared', interviewId: 'int-1', applicationId: null });

    const edit = await request('/api/member/interviews/int-1/candidate-questions/bq-shared', {
      method: 'PATCH',
      body: { questionText: 'Hijacked' }
    });
    const del = await request('/api/member/interviews/int-1/candidate-questions/bq-shared', { method: 'DELETE' });

    expect(edit.status).toBe(404);
    expect(del.status).toBe(404);
    expect(prisma.behavioralQuestion.update).not.toHaveBeenCalled();
    expect(prisma.behavioralQuestion.delete).not.toHaveBeenCalled();
  });

  it('cannot reach another interview’s question', async () => {
    prisma.behavioralQuestion.findUnique.mockResolvedValue({ id: 'bq-9', interviewId: 'int-other', applicationId: 'app-1' });
    const del = await request('/api/member/interviews/int-1/candidate-questions/bq-9', { method: 'DELETE' });
    expect(del.status).toBe(404);
    expect(prisma.behavioralQuestion.delete).not.toHaveBeenCalled();
  });
});

describe('shared question config leaves candidate questions alone', () => {
  const shrinkSharedList = (base, user) =>
    request(`/api/${base}/interviews/int-1/config`, {
      user,
      method: 'PATCH',
      body: { type: 'behavioral_questions', config: { behavioralQuestions: true, groupId: 'grp-1', questions: ['Only one'] } }
    });

  it.each([
    ['member', memberUser],
    ['admin', adminUser]
  ])('%s: removing shared questions only deletes group-wide rows', async (base, user) => {
    prisma.behavioralQuestion.findMany.mockResolvedValue([
      { id: 'bq-a', questionText: 'Only one', order: 0 },
      { id: 'bq-b', questionText: 'Dropped', order: 1 }
    ]);

    const res = await shrinkSharedList(base, user);

    expect(res.status).toBe(200);
    expect(prisma.behavioralQuestion.findMany.mock.calls[0][0].where).toEqual({
      interviewId: 'int-1',
      groupId: 'grp-1',
      applicationId: null
    });
    expect(prisma.behavioralQuestion.deleteMany).toHaveBeenCalledWith({
      where: { interviewId: 'int-1', groupId: 'grp-1', applicationId: null, order: { gte: 1 } }
    });
  });

  it.each([
    ['member', memberUser],
    ['admin', adminUser]
  ])('%s: the shared list does not include candidate questions', async (base, user) => {
    prisma.behavioralQuestion.findMany.mockResolvedValue([]);
    const res = await request(`/api/${base}/interviews/int-1/config?groupIds=grp-1`, { user });
    expect(res.status).toBe(200);
    expect(prisma.behavioralQuestion.findMany.mock.calls[0][0].where).toMatchObject({ applicationId: null });
  });
});
