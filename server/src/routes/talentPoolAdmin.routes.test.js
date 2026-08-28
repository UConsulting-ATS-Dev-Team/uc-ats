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
      { id: 'app-1', talentPoolOptIn: true, resumeUrl: 'drive-1', blindResumeUrl: 'blind-1' }
    ]);
    prisma.clientResumeAssignment.findMany.mockResolvedValue([
      { applicationId: 'app-1', memberResumeId: null }
    ]);

    const res = await request('/api/admin/talent-pool/clients/partner-1/assign', {
      user: adminUser,
      method: 'POST',
      body: { keys: ['APPLICATION:app-1'] }
    });
    expect((await res.json()).skipped[0].reason).toMatch(/already assigned/i);
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
    const keys = Array.from({ length: 501 }, (_, i) => `APPLICATION:app-${i}`);
    const res = await request('/api/admin/talent-pool/clients/partner-1/assign', {
      user: adminUser,
      method: 'POST',
      body: { keys }
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at most 500/i);
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
