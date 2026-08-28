// Coverage for the admin side of the Talent Partner Network.
//
// The load-bearing test in this file is "assign honours the trimmed keys and
// never re-runs the filter" - that is the whole snapshot guarantee. The rest
// prove the consent gates cannot be bypassed by posting keys directly.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import talentPoolAdminRoutes from './talentPoolAdmin.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { PREVIEW_CAP } from '../utils/talentPoolFilters.js';

vi.mock('../prismaClient.js', () => {
  const tx = {
    user: { create: vi.fn() },
    talentPartnerClient: { create: vi.fn() },
    clientAssignmentBatch: { create: vi.fn() },
    clientResumeAssignment: { createMany: vi.fn() }
  };
  return {
    default: {
      __tx: tx,
      user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
      talentPartnerClient: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        count: vi.fn()
      },
      application: { count: vi.fn(), findMany: vi.fn() },
      memberResume: { count: vi.fn(), findMany: vi.fn() },
      recruitingCycle: { findFirst: vi.fn(), findMany: vi.fn() },
      clientResumeAssignment: {
        findMany: vi.fn(),
        updateMany: vi.fn(),
        groupBy: vi.fn(),
        count: vi.fn()
      },
      clientAssignmentBatch: { create: vi.fn() },
      $transaction: vi.fn((fn) => fn(tx))
    }
  };
});

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Admin' };
const memberUser = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org', fullName: 'Member' };
const clientUser = { id: 'client-1', role: 'CLIENT', isActive: true, email: 'p@acme.com', fullName: 'Acme' };
const ALL_USERS = [adminUser, memberUser, clientUser];

const partner = (visibility = 'BASIC') => ({
  id: 'partner-1',
  userId: clientUser.id,
  organization: 'Acme Recruiting',
  visibility
});

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

let server;
let port;

const request = (path, { user, method = 'GET', body } = {}) => {
  const headers = {};
  if (user) headers.Authorization = `Bearer ${tokenFor(user)}`;
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
  app.use('/api/admin/talent-pool', requireAuth, requireAdmin, talentPoolAdminRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockImplementation(({ where }) => {
    if (where.id) return ALL_USERS.find((u) => u.id === where.id) || null;
    return null; // by email: no existing user
  });
  prisma.talentPartnerClient.findUnique.mockResolvedValue(partner());
  prisma.recruitingCycle.findFirst.mockResolvedValue({ id: 'cycle-1' });
  prisma.clientResumeAssignment.findMany.mockResolvedValue([]);
  prisma.application.count.mockResolvedValue(0);
  prisma.application.findMany.mockResolvedValue([]);
  prisma.memberResume.count.mockResolvedValue(0);
  prisma.memberResume.findMany.mockResolvedValue([]);
  prisma.__tx.clientAssignmentBatch.create.mockResolvedValue({ id: 'batch-1' });
  prisma.__tx.clientResumeAssignment.createMany.mockResolvedValue({ count: 0 });
  prisma.__tx.user.create.mockResolvedValue({ id: 'new-client-user' });
  prisma.__tx.talentPartnerClient.create.mockResolvedValue(partner());
});

describe('admin only', () => {
  it('refuses MEMBER and CLIENT on every endpoint', async () => {
    const paths = [
      ['/api/admin/talent-pool/clients', 'GET'],
      ['/api/admin/talent-pool/clients', 'POST'],
      ['/api/admin/talent-pool/clients/partner-1/preview', 'POST'],
      ['/api/admin/talent-pool/clients/partner-1/assign', 'POST']
    ];
    for (const user of [memberUser, clientUser]) {
      for (const [path, method] of paths) {
        const res = await request(path, { user, method, body: method === 'POST' ? {} : undefined });
        expect({ path, role: user.role, status: res.status }).toEqual({
          path,
          role: user.role,
          status: 403
        });
      }
    }
  });
});

describe('creating a client account', () => {
  it('creates the user and the partner row together, with the CLIENT role and a hashed password', async () => {
    const res = await request('/api/admin/talent-pool/clients', {
      user: adminUser,
      method: 'POST',
      body: {
        email: 'buyer@acme.com',
        password: 'a-long-enough-password',
        fullName: 'Buyer Contact',
        organization: 'Acme Recruiting',
        visibility: 'BASIC'
      }
    });

    expect(res.status).toBe(201);
    const created = prisma.__tx.user.create.mock.calls[0][0].data;
    expect(created.role).toBe('CLIENT');
    expect(created.password).not.toBe('a-long-enough-password');
    expect(created.password.startsWith('$2')).toBe(true);
    expect(prisma.__tx.talentPartnerClient.create).toHaveBeenCalled();
  });

  it('never echoes the password back', async () => {
    const res = await request('/api/admin/talent-pool/clients', {
      user: adminUser,
      method: 'POST',
      body: {
        email: 'buyer@acme.com',
        password: 'a-long-enough-password',
        fullName: 'Buyer',
        organization: 'Acme'
      }
    });
    expect(await res.text()).not.toContain('a-long-enough-password');
  });

  it('rejects a duplicate email', async () => {
    prisma.user.findUnique.mockImplementation(({ where }) =>
      where.email ? { id: 'existing' } : ALL_USERS.find((u) => u.id === where.id) || null
    );
    const res = await request('/api/admin/talent-pool/clients', {
      user: adminUser,
      method: 'POST',
      body: { email: 'taken@acme.com', password: 'a-long-enough-password', fullName: 'X', organization: 'Y' }
    });
    expect(res.status).toBe(400);
  });

  it('rejects a short password - there is no self-service reset for these accounts', async () => {
    const res = await request('/api/admin/talent-pool/clients', {
      user: adminUser,
      method: 'POST',
      body: { email: 'b@acme.com', password: 'short', fullName: 'X', organization: 'Y' }
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown visibility level', async () => {
    const res = await request('/api/admin/talent-pool/clients', {
      user: adminUser,
      method: 'POST',
      body: {
        email: 'b@acme.com',
        password: 'a-long-enough-password',
        fullName: 'X',
        organization: 'Y',
        visibility: 'EVERYTHING'
      }
    });
    expect(res.status).toBe(400);
  });
});

describe('preview', () => {
  it('previews the whole pool when no filter was written, and says so', async () => {
    const res = await request('/api/admin/talent-pool/clients/partner-1/preview', {
      user: adminUser,
      method: 'POST',
      body: { filter: { pools: ['APPLICANTS'], rows: [] } }
    });
    expect(res.status).toBe(200);
    expect((await res.json()).notes[0]).toMatch(/No filters/i);
  });

  it('still refuses a filter whose every row was rejected', async () => {
    // Not the same as no filter: the admin meant to narrow, and running the
    // unnarrowed set would show them more people than they asked for.
    const res = await request('/api/admin/talent-pool/clients/partner-1/preview', {
      user: adminUser,
      method: 'POST',
      body: { filter: { pools: ['APPLICANTS'], rows: [{ field: 'salaryExpectation', values: ['x'] }] } }
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    // The headline names the offending field - more use than the summary - and
    // the summary rides along in `errors`.
    expect(body.error).toMatch(/salaryExpectation/);
    expect(body.errors.join(' ')).toMatch(/None of those filters could be used/i);
  });

  it('spends the row cap as one budget, so a full applicant pool cannot starve the others', async () => {
    // The bug this replaces: every pool took the full cap and the concatenated
    // list was sliced back down at the end, so cap-many applicants pushed every
    // member row out of the response - counted in `total`, then dropped without
    // a word. That is the "ticking Members shows nothing" symptom again.
    const applicants = Array.from({ length: PREVIEW_CAP }, (_, i) => ({
      id: `app-${i}`,
      firstName: 'A',
      lastName: String(i),
      graduationYear: '2029'
    }));
    prisma.application.count.mockResolvedValue(PREVIEW_CAP + 300);
    prisma.application.findMany.mockImplementation(({ take }) => applicants.slice(0, take));
    prisma.memberResume.count.mockResolvedValue(6);
    prisma.memberResume.findMany.mockImplementation(({ take }) =>
      Array.from({ length: Math.min(6, take) }, (_, i) => ({
        id: `mr-${i}`,
        member: { fullName: `Member ${i}` }
      }))
    );

    const res = await request('/api/admin/talent-pool/clients/partner-1/preview', {
      user: adminUser,
      method: 'POST',
      body: { filter: { pools: ['APPLICANTS', 'MEMBERS'], rows: [] } }
    });

    const body = await res.json();
    // Never more than the cap, and the count the UI prints matches the rows it got.
    expect(body.rows.length).toBe(PREVIEW_CAP);
    expect(body.truncated).toBe(true);
    // And the truncation is now something the admin can act on, rather than a
    // page that returns identically forever.
    expect(body.notes.join(' ')).toMatch(/narrow it/i);
  });

  it('collapses repeat applicants to one row per person', async () => {
    // 762 assignable applications are 627 people. Assigning both of someone's
    // forms puts them in a client's library twice, which is how one client came
    // to hold 521 rows for 456 people.
    const apps = [
      { id: 'a1', firstName: 'Jin', lastName: 'Kim', candidateId: 'cand-1' },
      { id: 'a2', firstName: 'Jin', lastName: 'Kim', candidateId: 'cand-1' },
      { id: 'a3', firstName: 'Ada', lastName: 'L', email: 'Ada@ucla.edu' },
      { id: 'a4', firstName: 'Ada', lastName: 'L', email: 'ada@ucla.edu' },
      { id: 'a5', firstName: 'Solo', lastName: 'One', candidateId: 'cand-2' }
    ];
    prisma.application.count.mockResolvedValue(apps.length);
    prisma.application.findMany.mockResolvedValue(apps);

    const res = await request('/api/admin/talent-pool/clients/partner-1/preview', {
      user: adminUser,
      method: 'POST',
      body: { filter: { pools: ['APPLICANTS'], rows: [] } }
    });

    const body = await res.json();
    expect(body.rows.map((r) => r.key)).toEqual([
      'APPLICATION:a1',
      'APPLICATION:a3',
      'APPLICATION:a5'
    ]);
    // The headline count is people, not submissions, when the whole pool fit.
    expect(body.total).toBe(3);
    expect(body.excluded.duplicateApplications).toBe(2);
  });

  it('keeps the row count when the fetch was capped, since duplicates past the cap are unknown', async () => {
    prisma.application.count.mockResolvedValue(5000);
    prisma.application.findMany.mockResolvedValue(
      Array.from({ length: PREVIEW_CAP }, (_, i) => ({ id: `a${i}`, candidateId: `c${i}` }))
    );
    const res = await request('/api/admin/talent-pool/clients/partner-1/preview', {
      user: adminUser,
      method: 'POST',
      body: { filter: { pools: ['APPLICANTS'], rows: [] } }
    });
    const body = await res.json();
    expect(body.total).toBe(5000);
    expect(body.truncated).toBe(true);
  });

  it('reports how many rows each consent gate excluded', async () => {
    // 10 match the filter, 7 have not opted out, 5 of those have a blind resume.
    prisma.application.count
      .mockResolvedValueOnce(5) // fully gated
      .mockResolvedValueOnce(10) // filter only
      .mockResolvedValueOnce(7); // filter + not-opted-out

    const res = await request('/api/admin/talent-pool/clients/partner-1/preview', {
      user: adminUser,
      method: 'POST',
      body: { filter: { pool: 'APPLICANTS', rows: [{ field: 'graduationYear', values: ['2030'] }] } }
    });

    const body = await res.json();
    expect(body.excluded.optedOut).toBe(3);
    expect(body.excluded.noBlindResume).toBe(2);
  });
});

describe('assign - the snapshot guarantee', () => {
  const tenApplications = Array.from({ length: 10 }, (_, i) => ({
    id: `app-${i}`,
    talentPoolOptIn: true,
    resumeUrl: `drive-${i}`,
    blindResumeUrl: `blind-${i}`
  }));

  it('assigns exactly the keys it was given, ignoring a filter that would match more', async () => {
    prisma.application.findMany.mockResolvedValue(
      tenApplications.filter((a) => ['app-1', 'app-2'].includes(a.id))
    );

    const res = await request('/api/admin/talent-pool/clients/partner-1/assign', {
      user: adminUser,
      method: 'POST',
      body: {
        // A filter that would have matched all ten.
        filter: { pool: 'APPLICANTS', rows: [{ field: 'graduationYear', values: ['2030'] }] },
        keys: ['APPLICATION:app-1', 'APPLICATION:app-2']
      }
    });

    expect(res.status).toBe(201);
    expect((await res.json()).created).toBe(2);

    const rows = prisma.__tx.clientResumeAssignment.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.applicationId).sort()).toEqual(['app-1', 'app-2']);

    // The filter is recorded as documentation only, never used to select rows.
    expect(prisma.application.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['app-1', 'app-2'] } } })
    );
  });

  it('stores the filter on the batch purely as a record', async () => {
    prisma.application.findMany.mockResolvedValue([tenApplications[0]]);
    const filter = { pool: 'APPLICANTS', rows: [{ field: 'graduationYear', values: ['2030'] }] };

    await request('/api/admin/talent-pool/clients/partner-1/assign', {
      user: adminUser,
      method: 'POST',
      body: { filter, keys: ['APPLICATION:app-0'] }
    });

    expect(prisma.__tx.clientAssignmentBatch.create.mock.calls[0][0].data.filterJson).toEqual(filter);
  });

  it('rejects an empty selection', async () => {
    const res = await request('/api/admin/talent-pool/clients/partner-1/assign', {
      user: adminUser,
      method: 'POST',
      body: { keys: [] }
    });
    expect(res.status).toBe(400);
  });
});

describe('assign - consent gates cannot be bypassed by posting keys directly', () => {
  it('skips an applicant who opted out', async () => {
    prisma.application.findMany.mockResolvedValue([
      { id: 'app-1', talentPoolOptIn: false, resumeUrl: 'drive-1', blindResumeUrl: 'blind-1' }
    ]);

    const res = await request('/api/admin/talent-pool/clients/partner-1/assign', {
      user: adminUser,
      method: 'POST',
      body: { keys: ['APPLICATION:app-1'] }
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.skipped[0].reason).toMatch(/opted out/i);
    expect(prisma.__tx.clientResumeAssignment.createMany).not.toHaveBeenCalled();
  });

  it('assigns an applicant who was never asked - a null opt-in is not a refusal', async () => {
    prisma.application.findMany.mockResolvedValue([
      { id: 'app-1', talentPoolOptIn: null, resumeUrl: 'drive-1', blindResumeUrl: 'blind-1' }
    ]);
    const res = await request('/api/admin/talent-pool/clients/partner-1/assign', {
      user: adminUser,
      method: 'POST',
      body: { keys: ['APPLICATION:app-1'] }
    });
    expect(res.status).toBe(201);
    expect((await res.json()).created).toBe(1);
  });

  it('skips an applicant with no blind resume when the client is BLIND', async () => {
    prisma.talentPartnerClient.findUnique.mockResolvedValue(partner('BLIND'));
    prisma.application.findMany.mockResolvedValue([
      { id: 'app-1', talentPoolOptIn: true, resumeUrl: 'drive-1', blindResumeUrl: null }
    ]);

    const res = await request('/api/admin/talent-pool/clients/partner-1/assign', {
      user: adminUser,
      method: 'POST',
      body: { keys: ['APPLICATION:app-1'] }
    });
    expect((await res.json()).skipped[0].reason).toMatch(/redacted/i);
  });

  it('skips a member resume without consent', async () => {
    prisma.memberResume.findMany.mockResolvedValue([
      { id: 'mr-1', isCurrent: true, shareConsent: false, consentRevokedAt: null }
    ]);
    const res = await request('/api/admin/talent-pool/clients/partner-1/assign', {
      user: adminUser,
      method: 'POST',
      body: { keys: ['MEMBER_RESUME:mr-1'] }
    });
    expect((await res.json()).skipped[0].reason).toMatch(/consent/i);
  });

  it('skips a member resume whose consent was withdrawn', async () => {
    prisma.memberResume.findMany.mockResolvedValue([
      { id: 'mr-1', isCurrent: true, shareConsent: true, consentRevokedAt: new Date() }
    ]);
    const res = await request('/api/admin/talent-pool/clients/partner-1/assign', {
      user: adminUser,
      method: 'POST',
      body: { keys: ['MEMBER_RESUME:mr-1'] }
    });
    expect((await res.json()).skipped[0].reason).toMatch(/consent/i);
  });

  it('skips a superseded member resume', async () => {
    prisma.memberResume.findMany.mockResolvedValue([
      { id: 'mr-1', isCurrent: false, shareConsent: true, consentRevokedAt: null }
    ]);
    const res = await request('/api/admin/talent-pool/clients/partner-1/assign', {
      user: adminUser,
      method: 'POST',
      body: { keys: ['MEMBER_RESUME:mr-1'] }
    });
    expect((await res.json()).skipped[0].reason).toMatch(/replaced/i);
  });

  it('skips a resume already live-assigned to this client', async () => {
    prisma.application.findMany.mockResolvedValue([
      { id: 'app-1', candidateId: 'cand-1', talentPoolOptIn: true, resumeUrl: 'drive-1', blindResumeUrl: 'blind-1' }
    ]);
    prisma.clientResumeAssignment.findMany.mockResolvedValue([
      { applicationId: 'app-1', memberResumeId: null, application: { id: 'app-1', candidateId: 'cand-1' } }
    ]);

    const res = await request('/api/admin/talent-pool/clients/partner-1/assign', {
      user: adminUser,
      method: 'POST',
      body: { keys: ['APPLICATION:app-1'] }
    });
    expect((await res.json()).skipped[0].reason).toMatch(/already assigned/i);
  });

  it('skips a DIFFERENT application by someone the client already holds', async () => {
    // Dedupe hands back everyone's newest application. If the client was
    // assigned an older one, an id-only check reads as not-assigned and the
    // person lands in the library twice.
    prisma.application.findMany.mockResolvedValue([
      { id: 'app-new', candidateId: 'cand-1', talentPoolOptIn: null, resumeUrl: 'drive-2', blindResumeUrl: 'blind-2' }
    ]);
    prisma.clientResumeAssignment.findMany.mockResolvedValue([
      { applicationId: 'app-old', memberResumeId: null, application: { id: 'app-old', candidateId: 'cand-1' } }
    ]);

    const res = await request('/api/admin/talent-pool/clients/partner-1/assign', {
      user: adminUser,
      method: 'POST',
      body: { keys: ['APPLICATION:app-new'] }
    });
    expect((await res.json()).skipped[0].reason).toMatch(/already assigned/i);
  });

  it('assigns only one row when two applications by the same person are ticked', async () => {
    prisma.application.findMany.mockResolvedValue([
      { id: 'app-a', candidateId: 'cand-9', talentPoolOptIn: null, resumeUrl: 'd1', blindResumeUrl: 'b1' },
      { id: 'app-b', candidateId: 'cand-9', talentPoolOptIn: null, resumeUrl: 'd2', blindResumeUrl: 'b2' }
    ]);
    prisma.clientResumeAssignment.findMany.mockResolvedValue([]);

    const res = await request('/api/admin/talent-pool/clients/partner-1/assign', {
      user: adminUser,
      method: 'POST',
      body: { keys: ['APPLICATION:app-a', 'APPLICATION:app-b'] }
    });
    const body = await res.json();
    expect(body.created).toBe(1);
    expect(body.skipped[0].reason).toMatch(/already assigned/i);
  });

  it('rejects a malformed key rather than guessing', async () => {
    const res = await request('/api/admin/talent-pool/clients/partner-1/assign', {
      user: adminUser,
      method: 'POST',
      body: { keys: ['DROP TABLE users'] }
    });
    expect((await res.json()).skipped[0].reason).toMatch(/unrecognised/i);
  });

  it('caps a single assignment batch', async () => {
    const keys = Array.from({ length: PREVIEW_CAP + 1 }, (_, i) => `APPLICATION:app-${i}`);
    const res = await request('/api/admin/talent-pool/clients/partner-1/assign', {
      user: adminUser,
      method: 'POST',
      body: { keys }
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(new RegExp(`at most ${PREVIEW_CAP}`, 'i'));
  });
});

describe('revocation is soft', () => {
  it('sets revokedAt rather than deleting the row', async () => {
    prisma.clientResumeAssignment.updateMany.mockResolvedValue({ count: 1 });

    const res = await request('/api/admin/talent-pool/clients/partner-1/assignments/assign-1', {
      user: adminUser,
      method: 'DELETE'
    });

    expect(res.status).toBe(200);
    const call = prisma.clientResumeAssignment.updateMany.mock.calls[0][0];
    expect(call.data.revokedAt).toBeInstanceOf(Date);
    expect(call.data.revokedById).toBe(adminUser.id);
    expect(call.where).toMatchObject({ id: 'assign-1', clientId: 'partner-1', revokedAt: null });
  });

  it('404s an assignment that is not this client\'s', async () => {
    prisma.clientResumeAssignment.updateMany.mockResolvedValue({ count: 0 });
    const res = await request('/api/admin/talent-pool/clients/partner-1/assignments/not-mine', {
      user: adminUser,
      method: 'DELETE'
    });
    expect(res.status).toBe(404);
  });

  it('revokes a whole batch at once', async () => {
    prisma.clientResumeAssignment.updateMany.mockResolvedValue({ count: 12 });
    const res = await request('/api/admin/talent-pool/clients/partner-1/batches/batch-1', {
      user: adminUser,
      method: 'DELETE'
    });
    expect((await res.json()).revoked).toBe(12);
  });
});
