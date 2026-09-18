// Every write to an interview's live question list has to tell the other panelists,
// and nothing else may. A missed nudge leaves a co-interviewer reading a stale list
// until their fallback poll catches up; a nudge on a rejected write sends the whole
// panel to refetch something that never changed.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import memberRoutes from './member.js';
import { nudgeSessionQuestions } from '../services/realtime.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    interviewAssignment: { findFirst: vi.fn() },
    interviewQuestion: { findFirst: vi.fn() },
    interviewSessionQuestion: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn()
    },
    $transaction: vi.fn()
  }
}));

vi.mock('../services/realtime.js', async (importOriginal) => ({
  ...(await importOriginal()),
  nudgeSessionQuestions: vi.fn()
}));

const member = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org' };
const stranger = { id: 'member-2', role: 'MEMBER', isActive: true, email: 's@uc.org' };
const USERS = [member, stranger];

const INTERVIEW = 'int-1';
const row = (overrides = {}) => ({
  id: 'sq-1',
  interviewId: INTERVIEW,
  prompt: 'Why consulting?',
  position: 0,
  addedBy: member.id,
  updatedAt: new Date('2026-08-27T10:00:00.000Z'),
  deletedAt: null,
  ...overrides
});

let server;
let port;

const request = (path, { user = member, method = 'GET', body } = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt.sign({ userId: user.id }, process.env.JWT_SECRET)}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

const base = `/api/member/interviews/${INTERVIEW}/session-questions`;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/member', memberRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockImplementation(async ({ where }) =>
    USERS.find((u) => u.id === where.id) || null
  );
  // Assigned to the interview unless a test says otherwise.
  prisma.interviewAssignment.findFirst.mockResolvedValue({ id: 'ia-1' });
});

describe('live interview question nudges', () => {
  it('nudges when an interviewer writes their own question', async () => {
    const created = row({ updatedAt: new Date('2026-08-27T10:03:00.000Z') });
    prisma.interviewSessionQuestion.findFirst.mockResolvedValue({ position: 4 });
    prisma.interviewSessionQuestion.create.mockResolvedValue(created);

    const res = await request(base, { method: 'POST', body: { prompt: 'Walk me through it.' } });

    expect(res.status).toBe(201);
    expect(nudgeSessionQuestions).toHaveBeenCalledWith(INTERVIEW, { at: created.updatedAt });
  });

  it('nudges when a bank question is pulled into the session', async () => {
    const created = row({ questionBankId: 'bank-1', updatedAt: new Date('2026-08-27T10:04:00.000Z') });
    prisma.interviewQuestion.findFirst.mockResolvedValue({ id: 'bank-1', prompt: 'Size it.', guidance: null });
    prisma.interviewSessionQuestion.findFirst.mockResolvedValue({ position: 0 });
    prisma.interviewSessionQuestion.create.mockResolvedValue(created);

    const res = await request(`${base}/bank`, { method: 'POST', body: { questionId: 'bank-1' } });

    expect(res.status).toBe(201);
    expect(nudgeSessionQuestions).toHaveBeenCalledWith(INTERVIEW, { at: created.updatedAt });
  });

  it('nudges on a soft delete, so peers learn to drop the row', async () => {
    const removed = row({ deletedAt: new Date(), updatedAt: new Date('2026-08-27T10:06:00.000Z') });
    prisma.interviewSessionQuestion.findFirst.mockResolvedValue(row());
    prisma.interviewSessionQuestion.update.mockResolvedValue(removed);

    const res = await request(`${base}/sq-1`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(nudgeSessionQuestions).toHaveBeenCalledWith(INTERVIEW, { at: removed.updatedAt });
  });

  it('nudges with the newest stamp of a reorder, not the first', async () => {
    const rows = [
      row({ id: 'sq-1', position: 0, updatedAt: new Date('2026-08-27T10:07:00.000Z') }),
      row({ id: 'sq-2', position: 1, updatedAt: new Date('2026-08-27T10:07:05.000Z') })
    ];
    prisma.interviewSessionQuestion.findMany.mockResolvedValue([{ id: 'sq-1' }, { id: 'sq-2' }]);
    prisma.$transaction.mockResolvedValue(rows);

    const res = await request(`${base}/reorder`, { method: 'PATCH', body: { order: ['sq-2', 'sq-1'] } });

    expect(res.status).toBe(200);
    expect(nudgeSessionQuestions).toHaveBeenCalledWith(INTERVIEW, { at: rows[1].updatedAt });
  });

  it('stays quiet on a read', async () => {
    prisma.interviewSessionQuestion.findMany.mockResolvedValue([row()]);

    const res = await request(base);

    expect(res.status).toBe(200);
    expect(nudgeSessionQuestions).not.toHaveBeenCalled();
  });

  it('stays quiet when a reorder is rejected as stale', async () => {
    prisma.interviewSessionQuestion.findMany.mockResolvedValue([{ id: 'sq-1' }, { id: 'sq-2' }]);

    const res = await request(`${base}/reorder`, { method: 'PATCH', body: { order: ['sq-1'] } });

    expect(res.status).toBe(409);
    expect(nudgeSessionQuestions).not.toHaveBeenCalled();
  });

  it('stays quiet when the caller is not on the interview', async () => {
    prisma.interviewAssignment.findFirst.mockResolvedValue(null);

    const res = await request(base, {
      user: stranger,
      method: 'POST',
      body: { prompt: 'Let me in.' }
    });

    expect(res.status).toBe(403);
    expect(nudgeSessionQuestions).not.toHaveBeenCalled();
  });
});
