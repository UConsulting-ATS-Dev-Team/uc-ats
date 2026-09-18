// The case book time restriction, at the HTTP edge.
//
// The service decides who may read a case and when; these check that the routes
// carry that decision faithfully: a case that is not yours is still a flat 403,
// a case that is yours but early is 423 CASE_LOCKED with the unlock time, and no
// case content rides along with either.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import routes from './cases.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    case: { findUnique: vi.fn() },
    casePage: { findFirst: vi.fn() },
    caseAssignment: { findMany: vi.fn() },
    caseVisibilitySetting: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

const admin = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Admin One' };
const member = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org', fullName: 'Member One' };
const ALL = [admin, member];

const CASE = {
  id: 'case-1',
  title: 'Widget Co. profitability',
  description: 'Interviewer guide and exhibits',
  status: 'ACTIVE',
  cycleId: null,
  cycle: null,
  pageCount: 2,
  pdfStoragePath: 'cases/case-1/source.pdf',
  pages: [
    { id: 'page-1', pageNumber: 1, pageType: 'NORMAL', exhibitLabel: null, width: 1, height: 1 },
    { id: 'page-2', pageNumber: 2, pageType: 'INTERVIEWER_ONLY', exhibitLabel: null, width: 1, height: 1 },
  ],
};

let server;
let port;

const call = (path, { user, method = 'GET', body } = {}) =>
  fetch(`http://localhost:${port}${path}`, {
    method,
    headers: {
      ...(user ? { Authorization: `Bearer ${jwt.sign({ userId: user.id }, process.env.JWT_SECRET)}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const hoursFromNow = (h) => new Date(Date.now() + h * 60 * 60 * 1000);

const assignedTo = (...startDates) =>
  prisma.caseAssignment.findMany.mockResolvedValue(
    startDates.map((startDate) => ({ interview: { startDate } }))
  );

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cases', routes);
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
  prisma.case.findUnique.mockResolvedValue(CASE);
  prisma.caseVisibilitySetting.findUnique.mockResolvedValue({ leadTimeHours: 2 });
});

describe('GET /api/cases/:id', () => {
  it('answers 423 CASE_LOCKED with the unlock time when the member is early', async () => {
    assignedTo(hoursFromNow(9));

    const res = await call('/api/cases/case-1', { user: member });
    const body = await res.json();

    expect(res.status).toBe(423);
    expect(body.code).toBe('CASE_LOCKED');
    expect(new Date(body.unlocksAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('leaks nothing about the case while it is locked', async () => {
    assignedTo(hoursFromNow(9));

    const body = await (await call('/api/cases/case-1', { user: member })).json();
    const serialized = JSON.stringify(body);

    expect(body.pages).toBeUndefined();
    expect(body.title).toBeUndefined();
    expect(body.pageCount).toBeUndefined();
    expect(serialized).not.toContain('Widget');
    expect(serialized).not.toContain('page-1');
  });

  it('serves the case once the window opens', async () => {
    assignedTo(hoursFromNow(1));

    const res = await call('/api/cases/case-1', { user: member });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.title).toBe('Widget Co. profitability');
    expect(body.pages).toHaveLength(2);
  });

  it('still answers a flat 403 when the case is not the member’s at all', async () => {
    assignedTo();

    const res = await call('/api/cases/case-1', { user: member });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBeUndefined();
    expect(body.unlocksAt).toBeUndefined();
  });

  it('never locks an admin out, however far off the interview is', async () => {
    assignedTo(hoursFromNow(1000));

    const res = await call('/api/cases/case-1', { user: admin });

    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe('Widget Co. profitability');
  });
});

describe('GET /api/cases/:id/pages/:pageId/image', () => {
  it('is locked too, so a direct image URL is not a way around the viewer', async () => {
    assignedTo(hoursFromNow(9));

    const res = await call('/api/cases/case-1/pages/page-1/image', { user: member });

    expect(res.status).toBe(423);
    expect((await res.json()).code).toBe('CASE_LOCKED');
    // The page row is never even looked up, so no storage path is touched.
    expect(prisma.casePage.findFirst).not.toHaveBeenCalled();
  });
});

describe('the visibility setting', () => {
  it('is readable by a member, so the viewer can explain the wait', async () => {
    const res = await call('/api/cases/visibility-setting', { user: member });

    expect(res.status).toBe(200);
    expect((await res.json()).leadTimeHours).toBe(2);
  });

  it('is not writable by a member', async () => {
    const res = await call('/api/cases/visibility-setting', {
      user: member,
      method: 'PATCH',
      body: { leadTimeHours: 720 },
    });

    expect(res.status).toBe(403);
    expect(prisma.caseVisibilitySetting.upsert).not.toHaveBeenCalled();
  });

  it('is writable by an admin', async () => {
    prisma.caseVisibilitySetting.upsert.mockResolvedValue({ leadTimeHours: 6 });

    const res = await call('/api/cases/visibility-setting', {
      user: admin,
      method: 'PATCH',
      body: { leadTimeHours: 6 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).leadTimeHours).toBe(6);
  });

  it('refuses a value outside the range with a 400, not a 500', async () => {
    const res = await call('/api/cases/visibility-setting', {
      user: admin,
      method: 'PATCH',
      body: { leadTimeHours: 5000 },
    });

    expect(res.status).toBe(400);
    expect(prisma.caseVisibilitySetting.upsert).not.toHaveBeenCalled();
  });

  it('refuses a non-integer with a 400', async () => {
    const res = await call('/api/cases/visibility-setting', {
      user: admin,
      method: 'PATCH',
      body: { leadTimeHours: '6' },
    });

    expect(res.status).toBe(400);
    expect(prisma.caseVisibilitySetting.upsert).not.toHaveBeenCalled();
  });

  it('is not shadowed by the /:id route', async () => {
    // The regression this guards: registering /visibility-setting after /:id
    // makes Express treat "visibility-setting" as a case id.
    const res = await call('/api/cases/visibility-setting', { user: admin });

    expect(res.status).toBe(200);
    expect(prisma.case.findUnique).not.toHaveBeenCalled();
  });
});
