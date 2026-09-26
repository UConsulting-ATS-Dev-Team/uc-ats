// Sealed records have to stay sealed on every read path, so these check the
// shared pieces every route leans on: what a sealed row still shows, how a row is
// matched to its person, and what the guards answer.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { EXEC_UNLOCK_HEADER, issueUnlockToken } from '../services/execAccess.js';
import {
  OWN_RECORD_CODE,
  RECORD_LOCKED_CODE,
  applicationParamGuard,
  guardCandidate,
  lockedApplicationIds,
  lockedRowPredicate,
  redactApplication,
  redactCandidate,
  redactLockedApplications
} from './lockedRecords.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    candidate: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
    application: { findUnique: vi.fn(), findMany: vi.fn() }
  }
}));

const exec = { id: 'exec-1', role: 'ADMIN', email: 'exec@ucla.edu', studentId: '999' };

const requestAs = (user, { unlocked = false, method = 'GET', params = {}, body = {} } = {}) => ({
  user,
  method,
  params,
  body,
  headers: unlocked ? { [EXEC_UNLOCK_HEADER]: issueUnlockToken(user.id).token } : {}
});

const responseRecorder = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = vi.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body) => {
    res.body = body;
    return res;
  });
  return res;
};

const application = (overrides = {}) => ({
  id: 'app-1',
  candidateId: 'cand-sealed',
  cycleId: 'cycle-1',
  firstName: 'Sam',
  lastName: 'Lee',
  email: 'sam@ucla.edu',
  studentId: '111',
  status: 'ACCEPTED',
  approved: true,
  currentRound: '5',
  finalRoundDecision: 'yes',
  cumulativeGpa: '3.90',
  resumeUrl: '/api/files/abc/pdf',
  rawResponses: { why: 'An essay' },
  averageGrades: { overall: '9.1' },
  comments: [{ content: 'Strong hire' }],
  ...overrides
});

// Stand-in for the candidates table. Only Sam is sealed.
const SEALED = [{ id: 'cand-sealed', studentId: '111', email: 'sam@ucla.edu' }];

beforeEach(() => {
  vi.clearAllMocks();
  prisma.candidate.findMany.mockImplementation(({ where }) => Promise.resolve(
    SEALED.filter((candidate) => where.OR.some((clause) =>
      clause.id?.in.includes(candidate.id) ||
      clause.studentId?.in.includes(candidate.studentId) ||
      clause.email?.in.includes(candidate.email)
    ))
  ));
  prisma.candidate.findFirst.mockImplementation(({ where }) => Promise.resolve(
    SEALED.some((candidate) => candidate.id === where.id) ? { id: where.id } : null
  ));
});

describe('redaction', () => {
  it('keeps who the person is and drops how they were judged', () => {
    expect(redactApplication(application())).toEqual({
      id: 'app-1',
      candidateId: 'cand-sealed',
      cycleId: 'cycle-1',
      firstName: 'Sam',
      lastName: 'Lee',
      email: 'sam@ucla.edu',
      studentId: '111',
      status: 'ACCEPTED',
      comments: [],
      locked: true
    });
  });

  it('empties every list on a candidate and redacts its applications', () => {
    const redacted = redactCandidate({
      id: 'cand-sealed',
      firstName: 'Sam',
      lastName: 'Lee',
      email: 'sam@ucla.edu',
      studentId: '111',
      resumeScores: [{ overallScore: 9, notes: 'Great' }],
      assignedGroup: { id: 'g1' },
      applications: [application()]
    });
    expect(redacted.resumeScores).toEqual([]);
    expect(redacted.assignedGroup).toBeUndefined();
    expect(redacted.applications).toEqual([redactApplication(application())]);
    expect(redacted.locked).toBe(true);
  });
});

describe('matching rows to sealed candidates', () => {
  it('goes by candidate when the row has one', async () => {
    const rows = [application(), application({ id: 'app-2', candidateId: 'cand-open' })];
    const isLocked = await lockedRowPredicate(requestAs(exec), rows);
    expect(rows.map(isLocked)).toEqual([true, false]);
  });

  it('seals a row with no candidate under the g.ucla.edu spelling of a sealed address', async () => {
    const twin = application({ id: 'g', candidateId: null, studentId: null, email: 'Sam@g.ucla.edu' });
    const isLocked = await lockedRowPredicate(requestAs(exec), [twin]);
    expect(isLocked(twin)).toBe(true);
  });

  it('falls back to student ID and case-insensitive email for rows with no candidate', async () => {
    const byStudentId = application({ id: 'a', candidateId: null, email: 'someone-else@ucla.edu' });
    const byEmail = application({ id: 'b', candidateId: null, studentId: null, email: 'SAM@UCLA.EDU' });
    const stranger = application({ id: 'c', candidateId: null, studentId: '333', email: 'c@ucla.edu' });

    const isLocked = await lockedRowPredicate(requestAs(exec), [byStudentId, byEmail, stranger]);
    expect([byStudentId, byEmail, stranger].map(isLocked)).toEqual([true, true, false]);
  });

  it('skips the database entirely for an unlocked request', async () => {
    const isLocked = await lockedRowPredicate(requestAs(exec, { unlocked: true }), [application()]);
    expect(isLocked(application())).toBe(false);
    expect(prisma.candidate.findMany).not.toHaveBeenCalled();
  });

  it('redacts sealed rows of a list and passes the rest through untouched', async () => {
    const open = application({ id: 'app-2', candidateId: 'cand-open' });
    const [sealed, passed] = await redactLockedApplications(requestAs(exec), [application(), open]);
    expect(sealed.locked).toBe(true);
    expect(sealed.rawResponses).toBeUndefined();
    expect(passed).toBe(open);
  });

  it('lists which application ids are sealed', async () => {
    prisma.application.findMany.mockResolvedValue([
      { id: 'app-1', candidateId: 'cand-sealed', studentId: '111', email: 'sam@ucla.edu' },
      { id: 'app-2', candidateId: 'cand-open', studentId: '222', email: 'o@ucla.edu' }
    ]);
    expect(await lockedApplicationIds(requestAs(exec), ['app-1', 'app-2', 'app-1'])).toEqual(new Set(['app-1']));
  });
});

describe('guards', () => {
  const OWNER = { id: 'admin-owner', role: 'ADMIN', email: 'o@ucla.edu', studentId: '222' };

  beforeEach(() => {
    prisma.application.findUnique.mockImplementation(({ where }) => Promise.resolve(
      where.id === 'app-1'
        ? { candidateId: 'cand-sealed', studentId: '111', email: 'sam@ucla.edu', candidate: { studentId: '111', email: 'sam@ucla.edu' } }
        : { candidateId: 'cand-open', studentId: '222', email: 'o@ucla.edu', candidate: { studentId: '222', email: 'o@ucla.edu' } }
    ));
  });

  it('answer 423 for a sealed record', async () => {
    const res = responseRecorder();
    const next = vi.fn();
    await applicationParamGuard(requestAs(exec), res, next, 'app-1');
    expect(res.statusCode).toBe(423);
    expect(res.body.code).toBe(RECORD_LOCKED_CODE);
    expect(next).not.toHaveBeenCalled();
  });

  it('let an unlocked request through', async () => {
    const next = vi.fn();
    await applicationParamGuard(requestAs(exec, { unlocked: true }), responseRecorder(), next, 'app-1');
    expect(next).toHaveBeenCalled();
  });

  it('let staff read an unsealed application of their own', async () => {
    const next = vi.fn();
    await applicationParamGuard(requestAs(OWNER), responseRecorder(), next, 'app-2');
    expect(next).toHaveBeenCalled();
  });

  it('stop staff writing to their own application, even with an unlock', async () => {
    const res = responseRecorder();
    const next = vi.fn();
    await applicationParamGuard(requestAs(OWNER, { unlocked: true, method: 'POST' }), res, next, 'app-2');
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe(OWN_RECORD_CODE);
    expect(next).not.toHaveBeenCalled();
  });

  it('check the candidate a middleware guard picks out of the request', async () => {
    prisma.candidate.findUnique.mockResolvedValue({ studentId: '111', email: 'sam@ucla.edu' });
    const res = responseRecorder();
    const next = vi.fn();
    await guardCandidate((req) => req.body.candidateId)(
      requestAs(exec, { method: 'POST', body: { candidateId: 'cand-sealed' } }),
      res,
      next
    );
    expect(res.statusCode).toBe(423);
    expect(next).not.toHaveBeenCalled();
  });

  it('fail closed when the check itself fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.application.findUnique.mockRejectedValue(new Error('database unavailable'));
    const res = responseRecorder();
    const next = vi.fn();
    await applicationParamGuard(requestAs(exec), res, next, 'app-1');
    expect(res.statusCode).toBe(500);
    expect(next).not.toHaveBeenCalled();
  });
});
