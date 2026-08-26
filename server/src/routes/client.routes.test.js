// Security coverage for the Talent Partner Network portal. The assertions that
// matter: a client cannot read a resume that is not currently assigned to them,
// a BLIND client is never served an unredacted file, and no Drive id or storage
// path ever crosses the response boundary.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import clientRoutes from './client.js';
import { getFileStream } from '../services/google/drive.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    talentPartnerClient: { findUnique: vi.fn() },
    clientResumeAssignment: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    clientResumeAccessLog: { create: vi.fn(), createMany: vi.fn() }
  }
}));

vi.mock('../services/google/drive.js', () => ({
  getFileStream: vi.fn(),
  getFileMetadata: vi.fn()
}));

const DRIVE_REAL = 'drive-real-resume-id';
const DRIVE_BLIND = 'drive-blind-resume-id';

// What the column actually holds: a proxy URL wrapping the Drive id. The
// assertions below check getFileStream receives the bare id, so storing the
// bare id in the fixture would make them tautological - and did, until a
// wrapped URL reached the Drive SDK in the browser and 500'd.
const RESUME_URL_REAL = `/api/files/${DRIVE_REAL}/pdf`;
const RESUME_URL_BLIND = `https://uconsultingats.com/api/files/${DRIVE_BLIND}/pdf`;

const clientUser = { id: 'client-user-1', role: 'CLIENT', isActive: true, email: 'p@acme.com', fullName: 'Acme' };
const otherClientUser = { id: 'client-user-2', role: 'CLIENT', isActive: true, email: 'q@other.com', fullName: 'Other' };
const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Admin' };
const memberUser = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org', fullName: 'Member' };
const candidateUser = { id: 'user-1', role: 'USER', isActive: true, email: 'c@uc.org', fullName: 'Candidate' };

const ALL_USERS = [clientUser, otherClientUser, adminUser, memberUser, candidateUser];

const partnerFor = (visibility) => ({
  id: 'partner-1',
  userId: clientUser.id,
  organization: 'Acme Recruiting',
  visibility
});

const assignmentRow = (overrides = {}) => ({
  id: 'assign-1',
  assignedAt: new Date('2026-08-01T00:00:00.000Z'),
  application: {
    id: 'app-1',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@ucla.edu',
    phoneNumber: '310-555-0100',
    graduationYear: '2030',
    major1: 'Economics',
    major2: null,
    gender: 'Female',
    cumulativeGpa: '3.85',
    majorGpa: '3.90',
    resumeUrl: RESUME_URL_REAL,
    blindResumeUrl: RESUME_URL_BLIND
  },
  memberResume: null,
  ...overrides
});

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

let server;
let port;

const request = (path, { user } = {}) => {
  const headers = {};
  if (user) headers.Authorization = `Bearer ${tokenFor(user)}`;
  return fetch(`http://localhost:${port}${path}`, { headers });
};

// A minimal readable that satisfies .pipe(res).
const fakeStream = () => {
  const { Readable } = require('node:stream');
  return Readable.from([Buffer.from('%PDF-1.4 fake')]);
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/client', clientRoutes);
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
    ALL_USERS.find((u) => u.id === id) || null
  );
  prisma.talentPartnerClient.findUnique.mockResolvedValue(partnerFor('BASIC'));
  prisma.clientResumeAssignment.count.mockResolvedValue(0);
  prisma.clientResumeAssignment.findMany.mockResolvedValue([]);
  prisma.clientResumeAssignment.findFirst.mockResolvedValue(null);
  prisma.clientResumeAccessLog.create.mockResolvedValue({ id: 'log-1' });
  prisma.clientResumeAccessLog.createMany.mockResolvedValue({ count: 1 });
  getFileStream.mockImplementation(async () => fakeStream());
});

const post = (path, body, { user } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (user) headers.Authorization = `Bearer ${tokenFor(user)}`;
  return fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
};

describe('portal access control', () => {
  it('refuses every non-CLIENT role', async () => {
    for (const user of [adminUser, memberUser, candidateUser]) {
      const res = await request('/api/client/resumes', { user });
      expect({ role: user.role, status: res.status }).toEqual({ role: user.role, status: 403 });
    }
  });

  it('refuses an unauthenticated request with 401, not 403', async () => {
    const res = await request('/api/client/resumes');
    expect(res.status).toBe(401);
  });

  it('refuses a CLIENT with no partner row', async () => {
    prisma.talentPartnerClient.findUnique.mockResolvedValue(null);
    const res = await request('/api/client/resumes', { user: clientUser });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not configured/i);
  });
});

describe('resume list', () => {
  it('scopes the query to this client and excludes revoked assignments', async () => {
    await request('/api/client/resumes', { user: clientUser });

    const where = prisma.clientResumeAssignment.findMany.mock.calls[0][0].where;
    expect(where.clientId).toBe('partner-1');
    expect(where.revokedAt).toBeNull();
  });

  it('never emits a Drive id or a /api/files URL', async () => {
    prisma.clientResumeAssignment.findMany.mockResolvedValue([assignmentRow()]);
    prisma.clientResumeAssignment.count.mockResolvedValue(1);

    const res = await request('/api/client/resumes', { user: clientUser });
    const body = await res.text();

    expect(body).not.toContain(DRIVE_REAL);
    expect(body).not.toContain(DRIVE_BLIND);
    expect(body).not.toContain('/api/files/');
    expect(JSON.parse(body).items[0].pdfUrl).toBe('/api/client/resumes/assign-1/pdf');
  });

  it('omits names for a BLIND client', async () => {
    prisma.talentPartnerClient.findUnique.mockResolvedValue(partnerFor('BLIND'));
    prisma.clientResumeAssignment.findMany.mockResolvedValue([assignmentRow()]);

    const res = await request('/api/client/resumes', { user: clientUser });
    const item = (await res.json()).items[0];

    expect(item).not.toHaveProperty('firstName');
    expect(item).not.toHaveProperty('email');
    expect(item.major1).toBe('Economics');
  });

  it('does not let a BLIND client search by name', async () => {
    prisma.talentPartnerClient.findUnique.mockResolvedValue(partnerFor('BLIND'));
    await request('/api/client/resumes?q=Jane', { user: clientUser });

    const where = prisma.clientResumeAssignment.findMany.mock.calls[0][0].where;
    const searched = JSON.stringify(where.AND);
    expect(searched).not.toContain('firstName');
    expect(searched).not.toContain('lastName');
    expect(searched).toContain('major1');
  });

  it('allows name search once identity is already visible', async () => {
    await request('/api/client/resumes?q=Jane', { user: clientUser });
    const where = prisma.clientResumeAssignment.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where.AND)).toContain('firstName');
  });

  // Paging moved into memory when sorting did (an assignment points at an
  // application OR a member resume, and no orderBy interleaves the two), so the
  // cap is now on what the response carries rather than on the query's take.
  it('caps page size', async () => {
    prisma.clientResumeAssignment.count.mockResolvedValue(500);
    prisma.clientResumeAssignment.findMany.mockResolvedValue(
      Array.from({ length: 500 }, (_, i) => assignmentRow({ id: `assign-${i}` }))
    );

    const res = await request('/api/client/resumes?limit=100000', { user: clientUser });
    const body = await res.json();

    expect(body.limit).toBe(100);
    expect(body.items).toHaveLength(100);
  });

  it('bounds what it materializes, and says so rather than serving a prefix silently', async () => {
    prisma.clientResumeAssignment.count.mockResolvedValue(5000);
    prisma.clientResumeAssignment.findMany.mockResolvedValue(
      Array.from({ length: 2000 }, (_, i) => assignmentRow({ id: `assign-${i}` }))
    );

    const res = await request('/api/client/resumes', { user: clientUser });
    const body = await res.json();

    expect(prisma.clientResumeAssignment.findMany.mock.calls[0][0].take).toBe(2000);
    expect(body.total).toBe(5000);
    expect(body.truncated).toBe(true);
    expect(body.notes.join(' ')).toContain('2000');
  });
});

describe('resume PDF - the assignment id is the only key', () => {
  it('scopes the lookup to this client and to live assignments', async () => {
    prisma.clientResumeAssignment.findFirst.mockResolvedValue(assignmentRow());
    await request('/api/client/resumes/assign-1/pdf', { user: clientUser });

    const where = prisma.clientResumeAssignment.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: 'assign-1', clientId: 'partner-1', revokedAt: null });
  });

  it('answers 404 - not 403 - for an assignment belonging to another client', async () => {
    // findFirst is already scoped by clientId, so another client's id simply
    // does not match.
    prisma.clientResumeAssignment.findFirst.mockResolvedValue(null);

    const res = await request('/api/client/resumes/someone-elses-assignment/pdf', { user: clientUser });

    expect(res.status).toBe(404);
    expect(getFileStream).not.toHaveBeenCalled();
  });

  it('answers 404 for a revoked assignment and streams nothing', async () => {
    prisma.clientResumeAssignment.findFirst.mockResolvedValue(null);
    const res = await request('/api/client/resumes/assign-1/pdf', { user: clientUser });
    expect(res.status).toBe(404);
    expect(getFileStream).not.toHaveBeenCalled();
  });

  it('serves the redacted file to a BLIND client, and never the real one', async () => {
    prisma.talentPartnerClient.findUnique.mockResolvedValue(partnerFor('BLIND'));
    prisma.clientResumeAssignment.findFirst.mockResolvedValue(assignmentRow());

    await request('/api/client/resumes/assign-1/pdf', { user: clientUser });

    expect(getFileStream).toHaveBeenCalledWith(DRIVE_BLIND);
    expect(getFileStream).not.toHaveBeenCalledWith(DRIVE_REAL);
  });

  it('refuses rather than falling back when a BLIND client has no redacted file', async () => {
    prisma.talentPartnerClient.findUnique.mockResolvedValue(partnerFor('BLIND'));
    const row = assignmentRow();
    row.application.blindResumeUrl = null;
    prisma.clientResumeAssignment.findFirst.mockResolvedValue(row);

    const res = await request('/api/client/resumes/assign-1/pdf', { user: clientUser });

    expect(res.status).toBe(404);
    // The important half: it did not quietly serve the unredacted resume.
    expect(getFileStream).not.toHaveBeenCalled();
  });

  it('refuses a member resume for a BLIND client', async () => {
    prisma.talentPartnerClient.findUnique.mockResolvedValue(partnerFor('BLIND'));
    prisma.clientResumeAssignment.findFirst.mockResolvedValue({
      id: 'assign-2',
      assignedAt: new Date(),
      application: null,
      memberResume: {
        id: 'mr-1',
        storagePath: 'member-resumes/mr-1/resume.pdf',
        graduationYear: '2027',
        major1: 'Statistics',
        member: { fullName: 'Alex Rivera' }
      }
    });

    const res = await request('/api/client/resumes/assign-2/pdf', { user: clientUser });
    expect(res.status).toBe(404);
  });

  it('serves the real file at BASIC and FULL', async () => {
    for (const visibility of ['BASIC', 'FULL']) {
      vi.clearAllMocks();
      prisma.user.findUnique.mockImplementation(({ where: { id } }) =>
        ALL_USERS.find((u) => u.id === id) || null
      );
      prisma.talentPartnerClient.findUnique.mockResolvedValue(partnerFor(visibility));
      prisma.clientResumeAssignment.findFirst.mockResolvedValue(assignmentRow());
      prisma.clientResumeAccessLog.create.mockResolvedValue({ id: 'log' });
      getFileStream.mockImplementation(async () => fakeStream());

      await request('/api/client/resumes/assign-1/pdf', { user: clientUser });
      expect(getFileStream).toHaveBeenCalledWith(DRIVE_REAL);
    }
  });

  it('streams inline and never as an attachment', async () => {
    prisma.clientResumeAssignment.findFirst.mockResolvedValue(assignmentRow());
    const res = await request('/api/client/resumes/assign-1/pdf', { user: clientUser });

    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('content-disposition')).not.toMatch(/attachment/);
    // No filename - it would carry the applicant's name past a BLIND projection.
    expect(res.headers.get('content-disposition')).not.toMatch(/filename/);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('access logging', () => {
  it('records a successful view', async () => {
    prisma.clientResumeAssignment.findFirst.mockResolvedValue(assignmentRow());
    await request('/api/client/resumes/assign-1/pdf', { user: clientUser });

    expect(prisma.clientResumeAccessLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.clientResumeAccessLog.create.mock.calls[0][0].data).toMatchObject({
      clientId: 'partner-1',
      userId: clientUser.id,
      assignmentId: 'assign-1'
    });
  });

  it('records a refused view too - the denied attempts are the interesting ones', async () => {
    prisma.clientResumeAssignment.findFirst.mockResolvedValue(null);
    await request('/api/client/resumes/not-mine/pdf', { user: clientUser });

    expect(prisma.clientResumeAccessLog.create).toHaveBeenCalledTimes(1);
  });

  it('still serves the resume if logging fails', async () => {
    prisma.clientResumeAssignment.findFirst.mockResolvedValue(assignmentRow());
    prisma.clientResumeAccessLog.create.mockRejectedValue(new Error('log table down'));

    const res = await request('/api/client/resumes/assign-1/pdf', { user: clientUser });
    expect(res.status).toBe(200);
  });
});

describe('access actions', () => {
  it('labels a successful view VIEW', async () => {
    prisma.clientResumeAssignment.findFirst.mockResolvedValue(assignmentRow());
    await request('/api/client/resumes/assign-1/pdf', { user: clientUser });

    expect(prisma.clientResumeAccessLog.create.mock.calls[0][0].data.action).toBe('VIEW');
  });

  it('labels an unknown assignment VIEW_DENIED', async () => {
    prisma.clientResumeAssignment.findFirst.mockResolvedValue(null);
    await request('/api/client/resumes/not-mine/pdf', { user: clientUser });

    expect(prisma.clientResumeAccessLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'VIEW_DENIED',
      assignmentId: null
    });
  });

  it('labels a BLIND miss VIEW_DENIED and names the assignment it refused', async () => {
    prisma.talentPartnerClient.findUnique.mockResolvedValue(partnerFor('BLIND'));
    const row = assignmentRow();
    row.application.blindResumeUrl = null;
    prisma.clientResumeAssignment.findFirst.mockResolvedValue(row);

    const res = await request('/api/client/resumes/assign-1/pdf', { user: clientUser });

    expect(res.status).toBe(404);
    expect(prisma.clientResumeAccessLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'VIEW_DENIED',
      assignmentId: 'assign-1'
    });
    expect(getFileStream).not.toHaveBeenCalled();
  });
});

describe('account capabilities', () => {
  it('tells the UI which controls to render, per visibility level', async () => {
    prisma.talentPartnerClient.findUnique.mockResolvedValue(partnerFor('BLIND'));
    const blind = await (await request('/api/client/me', { user: clientUser })).json();

    // The UI renders columns, filters and sort headers from these lists, so a
    // level that hides a field must not advertise a control for it.
    expect(blind.filterableFields).not.toContain('gender');
    expect(blind.filterableFields).not.toContain('gpa');
    expect(blind.sortableFields).not.toContain('name');

    prisma.talentPartnerClient.findUnique.mockResolvedValue(partnerFor('FULL'));
    const full = await (await request('/api/client/me', { user: clientUser })).json();

    expect(full.filterableFields).toEqual(expect.arrayContaining(['gender', 'gpa']));
    expect(full.sortableFields).toContain('cumulativeGpa');
  });
});

describe('filters', () => {
  it('scopes the facet query to this client and offers no gender under BLIND', async () => {
    prisma.talentPartnerClient.findUnique.mockResolvedValue(partnerFor('BLIND'));
    prisma.clientResumeAssignment.findMany.mockResolvedValue([assignmentRow()]);

    const res = await request('/api/client/facets', { user: clientUser });
    const body = await res.json();

    expect(prisma.clientResumeAssignment.findMany.mock.calls[0][0].where).toMatchObject({
      clientId: 'partner-1',
      revokedAt: null
    });
    expect(body.graduationYear).toEqual(['2030']);
    expect(body).not.toHaveProperty('gender');
  });

  it('translates a graduation year into a clause against both pools', async () => {
    await request('/api/client/resumes?graduationYear=2030,2029', { user: clientUser });

    const where = prisma.clientResumeAssignment.findMany.mock.calls[0][0].where;
    const json = JSON.stringify(where.AND);
    expect(json).toContain('2030');
    expect(json).toContain('memberResume');
  });

  it('ignores a gender filter from a BLIND client instead of honouring it', async () => {
    prisma.talentPartnerClient.findUnique.mockResolvedValue(partnerFor('BLIND'));
    await request('/api/client/resumes?gender=Female', { user: clientUser });

    const where = prisma.clientResumeAssignment.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where.AND || [])).not.toContain('Female');
  });

  it('honours a GPA range at FULL and warns that it excludes members', async () => {
    prisma.talentPartnerClient.findUnique.mockResolvedValue(partnerFor('FULL'));
    const res = await request('/api/client/resumes?gpaMin=3.50', { user: clientUser });
    const body = await res.json();

    const where = prisma.clientResumeAssignment.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where.AND)).toContain('3.50');
    expect(body.notes.join(' ')).toMatch(/do not record a GPA/);
  });

  it('rejects a malformed GPA rather than dropping it silently', async () => {
    prisma.talentPartnerClient.findUnique.mockResolvedValue(partnerFor('FULL'));
    const res = await request('/api/client/resumes?gpaMin=abc', { user: clientUser });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Minimum GPA/);
  });
});

describe('CSV export', () => {
  const twoRows = [assignmentRow({ id: 'assign-1' }), assignmentRow({ id: 'assign-2' })];

  it('scopes the lookup to this client and to live assignments', async () => {
    prisma.clientResumeAssignment.findMany.mockResolvedValue(twoRows);

    await post(
      '/api/client/resumes/export',
      { assignmentIds: ['assign-1', 'assign-2'] },
      { user: clientUser }
    );

    expect(prisma.clientResumeAssignment.findMany.mock.calls[0][0].where).toMatchObject({
      clientId: 'partner-1',
      revokedAt: null
    });
  });

  it('exports only the columns this visibility already shows', async () => {
    prisma.talentPartnerClient.findUnique.mockResolvedValue(partnerFor('BLIND'));
    prisma.clientResumeAssignment.findMany.mockResolvedValue([assignmentRow()]);

    const res = await post('/api/client/resumes/export', { assignmentIds: ['assign-1'] }, {
      user: clientUser
    });
    const csv = await res.text();

    // The CSV is a spreadsheet of the table, not a second and more generous API.
    expect(csv).not.toContain('Jane');
    expect(csv).not.toContain('jane@ucla.edu');
    expect(csv).not.toContain('3.85');
    expect(csv).not.toContain(DRIVE_REAL);
    expect(csv).not.toContain(DRIVE_BLIND);
    expect(csv).toContain('Economics');
  });

  it('includes identity and contact at FULL', async () => {
    prisma.talentPartnerClient.findUnique.mockResolvedValue(partnerFor('FULL'));
    prisma.clientResumeAssignment.findMany.mockResolvedValue([assignmentRow()]);

    const csv = await (
      await post('/api/client/resumes/export', { assignmentIds: ['assign-1'] }, { user: clientUser })
    ).text();

    expect(csv).toContain('Jane');
    expect(csv).toContain('jane@ucla.edu');
    expect(csv).toContain('3.85');
  });

  it('sends a CSV attachment that browsers will not sniff', async () => {
    prisma.clientResumeAssignment.findMany.mockResolvedValue([assignmentRow()]);

    const res = await post('/api/client/resumes/export', { assignmentIds: ['assign-1'] }, {
      user: clientUser
    });

    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('content-disposition')).toMatch(/attachment/);
    expect(res.headers.get('content-disposition')).toMatch(/acme-recruiting-resumes-/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('records one EXPORT row per resume actually exported', async () => {
    prisma.clientResumeAssignment.findMany.mockResolvedValue(twoRows);

    await post(
      '/api/client/resumes/export',
      { assignmentIds: ['assign-1', 'assign-2'] },
      { user: clientUser }
    );

    const logged = prisma.clientResumeAccessLog.createMany.mock.calls[0][0].data;
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({
      clientId: 'partner-1',
      userId: clientUser.id,
      action: 'EXPORT'
    });
    expect(logged.map((r) => r.assignmentId).sort()).toEqual(['assign-1', 'assign-2']);
  });

  it('drops a borrowed id rather than exporting it or announcing that it exists', async () => {
    // findMany is already scoped by clientId, so another client's id simply does
    // not come back - and 404ing on it would confirm it exists.
    prisma.clientResumeAssignment.findMany.mockResolvedValue([assignmentRow({ id: 'assign-1' })]);

    const res = await post(
      '/api/client/resumes/export',
      { assignmentIds: ['assign-1', 'someone-elses-assignment'] },
      { user: clientUser }
    );

    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv.trim().split('\r\n')).toHaveLength(2); // header + one row
  });

  it('refuses an empty selection', async () => {
    const res = await post('/api/client/resumes/export', { assignmentIds: [] }, {
      user: clientUser
    });
    expect(res.status).toBe(400);
    expect(prisma.clientResumeAccessLog.createMany).not.toHaveBeenCalled();
  });

  it('refuses a selection larger than the export cap', async () => {
    const res = await post(
      '/api/client/resumes/export',
      { assignmentIds: Array.from({ length: 1001 }, (_, i) => `assign-${i}`) },
      { user: clientUser }
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at most 1000/);
    expect(prisma.clientResumeAssignment.findMany).not.toHaveBeenCalled();
  });

  it('answers 404 when nothing in the selection is exportable', async () => {
    prisma.clientResumeAssignment.findMany.mockResolvedValue([]);
    const res = await post('/api/client/resumes/export', { assignmentIds: ['gone'] }, {
      user: clientUser
    });
    expect(res.status).toBe(404);
  });

  it('refuses every non-CLIENT role', async () => {
    for (const user of [adminUser, memberUser, candidateUser]) {
      const res = await post(
        '/api/client/resumes/export',
        { assignmentIds: ['assign-1'] },
        { user }
      );
      expect({ role: user.role, status: res.status }).toEqual({ role: user.role, status: 403 });
    }
  });

  it('still returns the CSV if logging fails', async () => {
    prisma.clientResumeAssignment.findMany.mockResolvedValue([assignmentRow()]);
    prisma.clientResumeAccessLog.createMany.mockRejectedValue(new Error('log table down'));

    const res = await post('/api/client/resumes/export', { assignmentIds: ['assign-1'] }, {
      user: clientUser
    });
    expect(res.status).toBe(200);
  });
});
