// Route-level coverage for candidate self-service editing of their applicant
// information: ownership, which fields are writable, and validation.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import applicantInfoRoutes, { EDITABLE_FIELDS } from './applicantInfo.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    application: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

const candidateUser = {
  id: 'user-1',
  role: 'USER',
  isActive: true,
  email: 'cand@example.com',
  fullName: 'Cand Idate',
  studentId: '405123456',
};
const otherCandidate = {
  id: 'user-2',
  role: 'USER',
  isActive: true,
  email: 'other@example.com',
  fullName: 'Other Person',
  studentId: '405999999',
};
const adminUser = {
  id: 'admin-1',
  role: 'ADMIN',
  isActive: true,
  email: 'admin@example.com',
  fullName: 'Admin One',
  studentId: null,
};

const application = (overrides = {}) => ({
  id: 'app-1',
  email: candidateUser.email,
  studentId: candidateUser.studentId,
  firstName: 'Cand',
  lastName: 'Idate',
  phoneNumber: '860-555-0100',
  graduationYear: '2028',
  major1: 'Finance',
  major2: null,
  cumulativeGpa: 3.85,
  majorGpa: null,
  isTransferStudent: false,
  priorCollegeYears: null,
  gender: null,
  isFirstGeneration: false,
  status: 'SUBMITTED',
  currentRound: '1',
  submittedAt: new Date('2026-09-01T12:00:00Z'),
  candidate: { email: candidateUser.email, studentId: candidateUser.studentId },
  cycle: { id: 'cycle-1', name: 'Fall 2026', isActive: true },
  ...overrides,
});

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

let server;
let port;

const request = (path, { user, method = 'GET', body } = {}) => {
  const headers = {};
  if (user) headers.Authorization = `Bearer ${tokenFor(user)}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`http://localhost:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
};

const patch = (body, user = candidateUser) =>
  request('/api/applicant-info/applications/app-1', { user, method: 'PATCH', body });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/applicant-info', applicantInfoRoutes);
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
    [candidateUser, otherCandidate, adminUser].find((u) => u.id === id) || null
  );
  prisma.application.findUnique.mockResolvedValue(application());
  prisma.application.update.mockImplementation(({ data }) =>
    Promise.resolve(application(data))
  );
});

describe('GET /api/applicant-info/applications/:applicationId', () => {
  it('returns the applicant information to the owner', async () => {
    const res = await request('/api/applicant-info/applications/app-1', { user: candidateUser });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.firstName).toBe('Cand');
    expect(body.email).toBe(candidateUser.email);
  });

  it('serializes GPA as a plain number the form can use', async () => {
    const res = await request('/api/applicant-info/applications/app-1', { user: candidateUser });
    const body = await res.json();
    expect(body.cumulativeGpa).toBe(3.85);
    expect(typeof body.cumulativeGpa).toBe('number');
  });

  it('refuses a candidate who does not own the application', async () => {
    const res = await request('/api/applicant-info/applications/app-1', { user: otherCandidate });
    expect(res.status).toBe(403);
  });

  it('404s an application that does not exist', async () => {
    prisma.application.findUnique.mockResolvedValue(null);
    const res = await request('/api/applicant-info/applications/app-1', { user: candidateUser });
    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const res = await request('/api/applicant-info/applications/app-1');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/applicant-info/applications/:applicationId', () => {
  it('updates an editable field', async () => {
    const res = await patch({ phoneNumber: '860-555-0199' });
    expect(res.status).toBe(200);
    expect(prisma.application.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { phoneNumber: '860-555-0199' } })
    );
  });

  it('accepts a partial update without disturbing untouched fields', async () => {
    await patch({ major1: 'Economics' });
    const { data } = prisma.application.update.mock.calls[0][0];
    expect(Object.keys(data)).toEqual(['major1']);
  });

  it('trims surrounding whitespace', async () => {
    await patch({ firstName: '  Candace  ' });
    expect(prisma.application.update.mock.calls[0][0].data.firstName).toBe('Candace');
  });

  // The whole reason these two are excluded: they are the ownership keys.
  it('ignores an attempt to change the email', async () => {
    const res = await patch({ email: 'attacker@example.com', phoneNumber: '860-555-0111' });
    expect(res.status).toBe(200);
    const { data } = prisma.application.update.mock.calls[0][0];
    expect(data).not.toHaveProperty('email');
  });

  it('ignores an attempt to change the student ID', async () => {
    await patch({ studentId: '405999999', phoneNumber: '860-555-0111' });
    const { data } = prisma.application.update.mock.calls[0][0];
    expect(data).not.toHaveProperty('studentId');
  });

  it('ignores non-editable process fields like status', async () => {
    await patch({ status: 'ACCEPTED', resumeUrl: '/evil.pdf', phoneNumber: '860-555-0111' });
    const { data } = prisma.application.update.mock.calls[0][0];
    expect(data).not.toHaveProperty('status');
    expect(data).not.toHaveProperty('resumeUrl');
  });

  it('rejects a payload with nothing editable in it', async () => {
    const res = await patch({ email: 'attacker@example.com' });
    expect(res.status).toBe(400);
    expect(prisma.application.update).not.toHaveBeenCalled();
  });

  it('refuses a candidate who does not own the application', async () => {
    const res = await patch({ phoneNumber: '860-555-0199' }, otherCandidate);
    expect(res.status).toBe(403);
    expect(prisma.application.update).not.toHaveBeenCalled();
  });

  it('refuses an admin too — staff edits belong on the admin surface', async () => {
    const res = await patch({ phoneNumber: '860-555-0199' }, adminUser);
    expect(res.status).toBe(403);
  });

  it('rejects a required field cleared to empty', async () => {
    const res = await patch({ firstName: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/First name is required/);
  });

  it('allows an optional field to be cleared to null', async () => {
    await patch({ major2: '' });
    expect(prisma.application.update.mock.calls[0][0].data.major2).toBeNull();
  });

  it('rejects a GPA outside the plausible range', async () => {
    const res = await patch({ cumulativeGpa: '385' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/between 0.00 and 5.00/);
  });

  it('rejects a GPA that is not a number', async () => {
    const res = await patch({ cumulativeGpa: 'very good' });
    expect(res.status).toBe(400);
  });

  it('rounds a GPA to the two decimals the column stores', async () => {
    await patch({ cumulativeGpa: '3.856' });
    expect(prisma.application.update.mock.calls[0][0].data.cumulativeGpa).toBe(3.86);
  });

  it('accepts a weighted GPA above 4.0', async () => {
    const res = await patch({ cumulativeGpa: '4.3' });
    expect(res.status).toBe(200);
  });

  it('rejects a non-boolean for a yes/no field', async () => {
    const res = await patch({ isTransferStudent: 'maybe' });
    expect(res.status).toBe(400);
  });

  it('clears prior college years when transfer status is turned off', async () => {
    prisma.application.findUnique.mockResolvedValue(
      application({ isTransferStudent: true, priorCollegeYears: '2' })
    );
    await patch({ isTransferStudent: false });
    expect(prisma.application.update.mock.calls[0][0].data.priorCollegeYears).toBeNull();
  });

  it('rejects a value longer than the column allows', async () => {
    const res = await patch({ firstName: 'x'.repeat(101) });
    expect(res.status).toBe(400);
  });

  it('exposes exactly the fields the page is allowed to edit', () => {
    expect(EDITABLE_FIELDS).not.toContain('email');
    expect(EDITABLE_FIELDS).not.toContain('studentId');
    expect(EDITABLE_FIELDS).toContain('phoneNumber');
  });
});
