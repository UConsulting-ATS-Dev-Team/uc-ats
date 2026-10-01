// The case book leaks if a member can open it days early, so these pin down the
// one function every case-content read goes through: who it lets in, when, and
// what it says when it refuses.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import {
  CASE_LOCKED_CODE,
  DEFAULT_LEAD_TIME_HOURS,
  MAX_LEAD_TIME_HOURS,
  authorizeCaseRead,
  getLeadTimeHours,
  getVisibilitySetting,
  setLeadTimeHours,
  unlockTimeFor,
} from './caseVisibility.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    caseAssignment: { findMany: vi.fn() },
    caseVisibilitySetting: { findUnique: vi.fn(), upsert: vi.fn() },
    interviewSlot: { findMany: vi.fn() },
    interviewSlotAssignment: { findMany: vi.fn() },
    interviewAssignment: { findMany: vi.fn() },
  },
}));

const ADMIN = { id: 'admin-1', role: 'ADMIN' };
const MEMBER = { id: 'member-1', role: 'MEMBER' };
const CANDIDATE = { id: 'user-1', role: 'USER' };

const NOW = new Date('2026-09-18T12:00:00.000Z');
const hoursFromNow = (h) => new Date(NOW.getTime() + h * 60 * 60 * 1000);

// The member is assigned (through a session) to interviews starting at these times.
const assignedTo = (...startDates) => {
  const interviews = startDates.map((startDate, i) => ({ id: `iv-${i}`, startDate, description: null }));
  prisma.caseAssignment.findMany.mockResolvedValue(interviews.map((interview) => ({ interview })));
  prisma.interviewSlot.findMany.mockResolvedValue(interviews.map((iv) => ({ interviewId: iv.id })));
  prisma.interviewSlotAssignment.findMany.mockResolvedValue(interviews.map((iv) => ({ interviewId: iv.id })));
  prisma.interviewAssignment.findMany.mockResolvedValue([]);
};

const leadTimeIs = (hours) => {
  prisma.caseVisibilitySetting.findUnique.mockResolvedValue({ leadTimeHours: hours });
};

beforeEach(() => {
  vi.clearAllMocks();
  leadTimeIs(2);
});

describe('authorizeCaseRead', () => {
  it('lets an admin read any case at any time, without even looking at assignments', async () => {
    assignedTo(); // no assignment at all
    leadTimeIs(720); // and the strictest possible clock

    await expect(authorizeCaseRead('case-1', ADMIN, NOW)).resolves.toEqual({ allowed: true });
    expect(prisma.caseAssignment.findMany).not.toHaveBeenCalled();
  });

  it('refuses a member who is not assigned to the case at all', async () => {
    assignedTo();

    await expect(authorizeCaseRead('case-1', MEMBER, NOW)).resolves.toEqual({
      allowed: false,
      reason: 'FORBIDDEN',
    });
  });

  it('refuses a candidate outright, assigned or not', async () => {
    assignedTo(hoursFromNow(1));

    await expect(authorizeCaseRead('case-1', CANDIDATE, NOW)).resolves.toEqual({
      allowed: false,
      reason: 'FORBIDDEN',
    });
  });

  it('locks an assigned case that is still outside the window, and says when it opens', async () => {
    leadTimeIs(2);
    assignedTo(hoursFromNow(9));

    const verdict = await authorizeCaseRead('case-1', MEMBER, NOW);

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('LOCKED');
    // 9 hours out, 2 hours of lead time: 7 hours to wait.
    expect(verdict.unlocksAt.toISOString()).toBe(hoursFromNow(7).toISOString());
  });

  it('opens the case once the window is reached', async () => {
    leadTimeIs(2);
    assignedTo(hoursFromNow(2));

    await expect(authorizeCaseRead('case-1', MEMBER, NOW)).resolves.toEqual({ allowed: true });
  });

  it('opens the case a moment inside the window but not a moment outside it', async () => {
    leadTimeIs(2);

    assignedTo(new Date(NOW.getTime() + 2 * 60 * 60 * 1000 + 1000));
    expect((await authorizeCaseRead('case-1', MEMBER, NOW)).allowed).toBe(false);

    assignedTo(new Date(NOW.getTime() + 2 * 60 * 60 * 1000 - 1000));
    expect((await authorizeCaseRead('case-1', MEMBER, NOW)).allowed).toBe(true);
  });

  it('does not retroactively lock an interview that is under way or already past', async () => {
    leadTimeIs(2);

    assignedTo(hoursFromNow(-0.5));
    expect((await authorizeCaseRead('case-1', MEMBER, NOW)).allowed).toBe(true);

    assignedTo(hoursFromNow(-72));
    expect((await authorizeCaseRead('case-1', MEMBER, NOW)).allowed).toBe(true);
  });

  it('uses the earliest unlock when the member runs the same case in several interviews', async () => {
    leadTimeIs(2);
    // Far interview first, so this fails if the code takes the first row rather
    // than the minimum.
    assignedTo(hoursFromNow(100), hoursFromNow(3));

    const verdict = await authorizeCaseRead('case-1', MEMBER, NOW);

    expect(verdict.reason).toBe('LOCKED');
    expect(verdict.unlocksAt.toISOString()).toBe(hoursFromNow(1).toISOString());
  });

  it('opens as soon as any one of the member’s interviews is in the window', async () => {
    leadTimeIs(2);
    assignedTo(hoursFromNow(100), hoursFromNow(1));

    await expect(authorizeCaseRead('case-1', MEMBER, NOW)).resolves.toEqual({ allowed: true });
  });

  it('with a lead time of 0, opens exactly at the interview start and not before', async () => {
    leadTimeIs(0);

    assignedTo(hoursFromNow(0.001));
    expect((await authorizeCaseRead('case-1', MEMBER, NOW)).allowed).toBe(false);

    assignedTo(NOW);
    expect((await authorizeCaseRead('case-1', MEMBER, NOW)).allowed).toBe(true);
  });

  it('with the maximum lead time, a month-out interview is already open', async () => {
    leadTimeIs(MAX_LEAD_TIME_HOURS);
    assignedTo(hoursFromNow(29 * 24));

    await expect(authorizeCaseRead('case-1', MEMBER, NOW)).resolves.toEqual({ allowed: true });
  });

  it('falls back to the default lead time when the settings row does not exist yet', async () => {
    prisma.caseVisibilitySetting.findUnique.mockResolvedValue(null);
    // Just outside the default window.
    assignedTo(hoursFromNow(DEFAULT_LEAD_TIME_HOURS + 1));

    const verdict = await authorizeCaseRead('case-1', MEMBER, NOW);

    expect(verdict.reason).toBe('LOCKED');
    expect(verdict.unlocksAt.toISOString()).toBe(hoursFromNow(1).toISOString());
  });

  it('excludes cancelled interviews, which would otherwise hold the case open forever', async () => {
    assignedTo(hoursFromNow(9));

    await authorizeCaseRead('case-1', MEMBER, NOW);

    const where = prisma.caseAssignment.findMany.mock.calls[0][0].where;
    expect(where.interview.status).toEqual({ not: 'CANCELLED' });
  });

  it('still counts a DRAFT or UPCOMING interview, so a real one does not lock the member out', async () => {
    assignedTo(hoursFromNow(1));

    await authorizeCaseRead('case-1', MEMBER, NOW);

    // Only CANCELLED is filtered out; nothing narrows it to one status.
    const where = prisma.caseAssignment.findMany.mock.calls[0][0].where;
    expect(where.interview.status).toEqual({ not: 'CANCELLED' });
    expect(where.interview.status.in).toBeUndefined();
  });

  it('scopes the lookup to this case, and the roster check to this member', async () => {
    assignedTo(hoursFromNow(1));

    await authorizeCaseRead('case-42', MEMBER, NOW);

    expect(prisma.caseAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { caseId: 'case-42', interview: { status: { not: 'CANCELLED' } } } })
    );
    expect(prisma.interviewSlotAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'member-1', removedAt: null }) })
    );
  });
});

// Against a fake database that applies every filter it is given, the way Postgres
// would: which interviews use the case, which are cancelled, which have sessions, and
// who is on which interview, decide whether the case opens.
describe('authorizeCaseRead, by how the member is staffed', () => {
  const OPEN = hoursFromNow(1); // inside the 2-hour window
  let db;

  const interview = (id, over = {}) => ({ id, startDate: OPEN, status: 'UPCOMING', description: null, ...over });

  beforeEach(() => {
    db = {
      interviews: [interview('iv-final'), interview('iv-other')],
      caseLinks: [{ caseId: 'case-1', interviewId: 'iv-final' }],
      slots: [{ interviewId: 'iv-final' }, { interviewId: 'iv-other' }],
      slotAssignments: [],
      legacyAssignments: [],
    };
    const byId = (id) => db.interviews.find((iv) => iv.id === id);
    prisma.caseAssignment.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        db.caseLinks
          .filter((link) => link.caseId === where.caseId)
          .map((link) => byId(link.interviewId))
          .filter((iv) => !(where.interview?.status?.not && iv.status === where.interview.status.not))
          .map((iv) => ({ interview: { id: iv.id, startDate: iv.startDate, description: iv.description } }))
      )
    );
    const inIds = (where, row) => !where.interviewId?.in || where.interviewId.in.includes(row.interviewId);
    prisma.interviewSlot.findMany.mockImplementation(({ where }) =>
      Promise.resolve(db.slots.filter((row) => inIds(where, row)).map((row) => ({ interviewId: row.interviewId })))
    );
    prisma.interviewSlotAssignment.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        db.slotAssignments
          .filter((row) => row.userId === where.userId && inIds(where, row) && (where.removedAt !== null || !row.removedAt))
          .map((row) => ({ interviewId: row.interviewId }))
      )
    );
    prisma.interviewAssignment.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        db.legacyAssignments.filter((row) => row.userId === where.userId && inIds(where, row)).map((row) => ({ interviewId: row.interviewId }))
      )
    );
  });

  const read = () => authorizeCaseRead('case-1', MEMBER, NOW);

  it('opens the case for a member on one of its interview sessions', async () => {
    // How members are staffed now. Nothing writes InterviewAssignment any more, so
    // requiring it locked every member out.
    db.slotAssignments.push({ userId: 'member-1', interviewId: 'iv-final' });
    await expect(read()).resolves.toEqual({ allowed: true });
  });

  it('refuses a member on a session of a different interview', async () => {
    db.slotAssignments.push({ userId: 'member-1', interviewId: 'iv-other' });
    await expect(read()).resolves.toEqual({ allowed: false, reason: 'FORBIDDEN' });
  });

  it('refuses a member removed from the session', async () => {
    db.slotAssignments.push({ userId: 'member-1', interviewId: 'iv-final', removedAt: new Date() });
    await expect(read()).resolves.toEqual({ allowed: false, reason: 'FORBIDDEN' });
  });

  it('does not let old member groups in once the interview has sessions', async () => {
    // Converted to sessions, the description still lists the old groups.
    db.interviews[0].description = JSON.stringify({ memberGroups: [{ id: 'mg', memberIds: ['member-1'] }] });
    db.slotAssignments.push({ userId: 'member-1', interviewId: 'iv-final', removedAt: new Date() });
    await expect(read()).resolves.toEqual({ allowed: false, reason: 'FORBIDDEN' });
  });

  it('still reads member groups for an interview without sessions', async () => {
    db.slots = [];
    db.interviews[0].description = JSON.stringify({ memberGroups: [{ id: 'mg', memberIds: ['member-1'] }] });
    await expect(read()).resolves.toEqual({ allowed: true });
  });

  it('still opens it for a member on the older table, for an interview without sessions', async () => {
    db.slots = [];
    db.legacyAssignments.push({ userId: 'member-1', interviewId: 'iv-final' });
    await expect(read()).resolves.toEqual({ allowed: true });
  });

  it('ignores a cancelled interview that uses the case', async () => {
    db.interviews[0].status = 'CANCELLED';
    db.slotAssignments.push({ userId: 'member-1', interviewId: 'iv-final' });
    await expect(read()).resolves.toEqual({ allowed: false, reason: 'FORBIDDEN' });
  });
});

describe('getLeadTimeHours', () => {
  it('returns the stored value', async () => {
    leadTimeIs(6);
    await expect(getLeadTimeHours()).resolves.toBe(6);
  });

  it('returns the default when nothing is stored', async () => {
    prisma.caseVisibilitySetting.findUnique.mockResolvedValue(null);
    await expect(getLeadTimeHours()).resolves.toBe(DEFAULT_LEAD_TIME_HOURS);
  });

  it('keeps a stored 0 rather than treating it as missing', async () => {
    leadTimeIs(0);
    await expect(getLeadTimeHours()).resolves.toBe(0);
  });
});

describe('when the settings table has not been migrated yet', () => {
  const missingTable = Object.assign(new Error('table does not exist'), { code: 'P2021' });

  it('keeps the case book working on the default rather than 500ing every read', async () => {
    prisma.caseVisibilitySetting.findUnique.mockRejectedValue(missingTable);
    assignedTo(hoursFromNow(DEFAULT_LEAD_TIME_HOURS + 1));

    const verdict = await authorizeCaseRead('case-1', MEMBER, NOW);

    expect(verdict.reason).toBe('LOCKED');
    expect(verdict.unlocksAt.toISOString()).toBe(hoursFromNow(1).toISOString());
  });

  it('still gates: a member far out is locked, not waved through', async () => {
    prisma.caseVisibilitySetting.findUnique.mockRejectedValue(missingTable);
    assignedTo(hoursFromNow(48));

    expect((await authorizeCaseRead('case-1', MEMBER, NOW)).allowed).toBe(false);
  });

  it('reports the default through getVisibilitySetting', async () => {
    prisma.caseVisibilitySetting.findUnique.mockRejectedValue(missingTable);

    await expect(getVisibilitySetting()).resolves.toMatchObject({
      leadTimeHours: DEFAULT_LEAD_TIME_HOURS,
    });
  });

  it('does not swallow a real database failure', async () => {
    prisma.caseVisibilitySetting.findUnique.mockRejectedValue(
      Object.assign(new Error('connection refused'), { code: 'P1001' })
    );

    await expect(getLeadTimeHours()).rejects.toThrow('connection refused');
  });
});

describe('setLeadTimeHours', () => {
  const rejects = async (value) => {
    await expect(setLeadTimeHours(value, 'admin-1')).rejects.toMatchObject({
      code: 'INVALID_LEAD_TIME',
    });
    expect(prisma.caseVisibilitySetting.upsert).not.toHaveBeenCalled();
  };

  it('rejects a negative value', () => rejects(-1));
  it('rejects a value past the maximum', () => rejects(MAX_LEAD_TIME_HOURS + 1));
  it('rejects a fraction', () => rejects(2.5));
  it('rejects a numeric string, so a raw form value cannot slip through', () => rejects('4'));
  it('rejects null', () => rejects(null));
  it('rejects NaN', () => rejects(Number.NaN));

  it('accepts both ends of the range', async () => {
    prisma.caseVisibilitySetting.upsert.mockResolvedValue({ leadTimeHours: 0 });
    await expect(setLeadTimeHours(0, 'admin-1')).resolves.toMatchObject({ leadTimeHours: 0 });

    prisma.caseVisibilitySetting.upsert.mockResolvedValue({ leadTimeHours: MAX_LEAD_TIME_HOURS });
    await expect(setLeadTimeHours(MAX_LEAD_TIME_HOURS, 'admin-1')).resolves.toMatchObject({
      leadTimeHours: MAX_LEAD_TIME_HOURS,
    });
  });

  it('records who changed it', async () => {
    prisma.caseVisibilitySetting.upsert.mockResolvedValue({ leadTimeHours: 5 });

    await setLeadTimeHours(5, 'admin-7');

    expect(prisma.caseVisibilitySetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'singleton' },
        update: { leadTimeHours: 5, updatedById: 'admin-7' },
        create: { id: 'singleton', leadTimeHours: 5, updatedById: 'admin-7' },
      })
    );
  });
});

describe('unlockTimeFor', () => {
  it('subtracts the lead time from the start', () => {
    expect(unlockTimeFor(new Date('2026-09-18T18:00:00.000Z'), 2).toISOString()).toBe(
      '2026-09-18T16:00:00.000Z'
    );
  });

  it('handles a start time given as a string', () => {
    expect(unlockTimeFor('2026-09-18T18:00:00.000Z', 3).toISOString()).toBe(
      '2026-09-18T15:00:00.000Z'
    );
  });
});

describe('CASE_LOCKED_CODE', () => {
  it('is the code the client branches on', () => {
    expect(CASE_LOCKED_CODE).toBe('CASE_LOCKED');
  });
});
