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
  setLeadTimeHours,
  unlockTimeFor,
} from './caseVisibility.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    caseAssignment: { findMany: vi.fn() },
    caseVisibilitySetting: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

const ADMIN = { id: 'admin-1', role: 'ADMIN' };
const MEMBER = { id: 'member-1', role: 'MEMBER' };
const CANDIDATE = { id: 'user-1', role: 'USER' };

const NOW = new Date('2026-09-18T12:00:00.000Z');
const hoursFromNow = (h) => new Date(NOW.getTime() + h * 60 * 60 * 1000);

// The member is assigned to interviews starting at these times.
const assignedTo = (...startDates) => {
  prisma.caseAssignment.findMany.mockResolvedValue(
    startDates.map((startDate) => ({ interview: { startDate } }))
  );
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

  it('scopes the assignment lookup to this case and this member', async () => {
    assignedTo(hoursFromNow(1));

    await authorizeCaseRead('case-42', MEMBER, NOW);

    expect(prisma.caseAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          caseId: 'case-42',
          interview: { assignments: { some: { userId: 'member-1' } } },
        },
      })
    );
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
