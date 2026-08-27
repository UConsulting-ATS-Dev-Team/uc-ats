// Onboarding for a candidate with no application on file.
//
// The assertions worth having are the gates and the trigger condition, not the
// CRUD: an external talent account must not reach this even though it shares the
// USER role, an unverified address must not be able to submit, and the module
// must stop asking the moment an application exists - otherwise it re-collects
// information we already have and contradicts it.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import os from 'node:os';
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import prisma from '../prismaClient.js';
import onboardingRoutes from './candidateOnboarding.js';

vi.mock('../prismaClient.js', () => {
  const tx = {
    externalResume: { updateMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    clientResumeAssignment: { updateMany: vi.fn() }
  };
  return {
    default: {
      __tx: tx,
      user: { findUnique: vi.fn() },
      candidate: { findFirst: vi.fn() },
      application: { count: vi.fn() },
      candidateOnboarding: { upsert: vi.fn(), update: vi.fn() },
      externalResume: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
      clientResumeAssignment: { updateMany: vi.fn() },
      $transaction: vi.fn((fn) => fn(tx))
    }
  };
});

const verifiedCandidate = {
  id: 'user-1',
  role: 'USER',
  isActive: true,
  isExternalTalent: false,
  emailVerifiedAt: new Date('2026-08-20'),
  email: 'bruin@g.ucla.edu',
  studentId: '123456789',
  fullName: 'Joski Bruin'
};

const unverifiedCandidate = {
  ...verifiedCandidate,
  id: 'user-2',
  email: 'unverified@g.ucla.edu',
  studentId: '223456789',
  emailVerifiedAt: null
};

// Role USER as well. The flag is the whole difference, which is what makes it
// worth asserting - this account has its own portal and no Candidate row.
const talentUser = {
  ...verifiedCandidate,
  id: 'user-3',
  isExternalTalent: true,
  email: 'talent@g.ucla.edu',
  studentId: null
};

const memberUser = { ...verifiedCandidate, id: 'member-1', role: 'MEMBER', email: 'm@uc.org' };
const adminUser = { ...verifiedCandidate, id: 'admin-1', role: 'ADMIN', email: 'a@uc.org' };

const ALL_USERS = [verifiedCandidate, unverifiedCandidate, talentUser, memberUser, adminUser];

const candidateRow = (overrides = {}) => ({
  id: 'cand-1',
  studentId: '123456789',
  email: 'bruin@g.ucla.edu',
  firstName: 'Joski',
  lastName: 'Bruin',
  onboarding: null,
  applications: [],
  ...overrides
});

const onboardingRow = (overrides = {}) => ({
  id: 'onb-1',
  candidateId: 'cand-1',
  phoneNumber: '310-555-0134',
  graduationYear: '2028',
  cumulativeGpa: '3.85',
  major1: 'Economics',
  major2: null,
  gender: 'Female',
  isTransferStudent: false,
  isFirstGeneration: true,
  resumeStoragePath: 'candidate-onboarding/cand-1/resume.pdf',
  resumeOriginalName: 'resume.pdf',
  resumeFileSize: 2048,
  headshotStoragePath: null,
  headshotOriginalName: null,
  headshotFileSize: null,
  completedAt: new Date('2026-08-26'),
  updatedAt: new Date('2026-08-26'),
  ...overrides
});

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

let server;
let port;
let storageRoot;

const request = (path, { user } = {}) => {
  const headers = {};
  if (user) headers.Authorization = `Bearer ${tokenFor(user)}`;
  return fetch(`http://localhost:${port}${path}`, { headers });
};

const validFields = {
  phoneNumber: '310-555-0134',
  graduationYear: '2028',
  cumulativeGpa: '3.85',
  major1: 'Economics',
  gender: 'Female',
  isTransferStudent: 'false',
  isFirstGeneration: 'true',
  talentPoolOptIn: 'true'
};

const externalResumeRow = (overrides = {}) => ({
  id: 'er-1',
  userId: 'user-1',
  isCurrent: true,
  storagePath: 'external-resumes/er-1/resume.pdf',
  originalName: 'resume.pdf',
  fileSize: 2048,
  major1: 'Economics',
  major2: null,
  graduationYear: '2028',
  gender: 'Female',
  shareConsent: true,
  consentAt: new Date('2026-08-26'),
  consentRevokedAt: null,
  ...overrides
});

const submit = ({ user, resume = Buffer.from('%PDF-1.4 resume'), resumeType = 'application/pdf', headshot, fields = validFields }) => {
  const form = new FormData();
  if (resume) form.append('resume', new Blob([resume], { type: resumeType }), 'resume.pdf');
  if (headshot) form.append('headshot', new Blob([headshot], { type: 'image/png' }), 'me.png');
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  return fetch(`http://localhost:${port}/api/candidate/onboarding`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenFor(user)}` },
    body: form
  });
};

beforeAll(async () => {
  // The route writes under server/storage. Point it somewhere disposable so the
  // suite never leaves files in the real storage root.
  storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'onboarding-test-'));
  const app = express();
  app.use(express.json());
  app.use('/api/candidate/onboarding', onboardingRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsPromises.rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockImplementation(({ where: { id } }) =>
    ALL_USERS.find((u) => u.id === id) || null
  );
  prisma.candidate.findFirst.mockResolvedValue(candidateRow());
  prisma.application.count.mockResolvedValue(0);
  prisma.candidateOnboarding.upsert.mockImplementation(({ create, update }) =>
    Promise.resolve(onboardingRow({ ...create, ...update }))
  );
  prisma.externalResume.findFirst.mockResolvedValue(null);
  prisma.__tx.externalResume.create.mockResolvedValue(externalResumeRow());
  prisma.__tx.externalResume.updateMany.mockResolvedValue({ count: 0 });
  prisma.__tx.clientResumeAssignment.updateMany.mockResolvedValue({ count: 0 });
  prisma.externalResume.update.mockResolvedValue(externalResumeRow());
  prisma.candidateOnboarding.update.mockImplementation(({ data }) =>
    Promise.resolve(onboardingRow(data))
  );
});

describe('access gating', () => {
  it('refuses an external talent account, which shares the USER role but not the flag', async () => {
    const res = await request('/api/candidate/onboarding/status', { user: talentUser });
    expect(res.status).toBe(403);
  });

  it('refuses staff - there is no admin version of "my own onboarding"', async () => {
    for (const user of [memberUser, adminUser]) {
      const res = await request('/api/candidate/onboarding/status', { user });
      expect({ role: user.role, status: res.status }).toEqual({ role: user.role, status: 403 });
    }
  });

  it('refuses an unauthenticated request', async () => {
    const res = await request('/api/candidate/onboarding/status');
    expect(res.status).toBe(401);
  });

  it('lets an unverified candidate read status, so the app can render "check your email"', async () => {
    const res = await request('/api/candidate/onboarding/status', { user: unverifiedCandidate });
    expect(res.status).toBe(200);
    expect((await res.json()).emailVerified).toBe(false);
  });

  it('refuses an unverified candidate submitting, and says why', async () => {
    const res = await submit({ user: unverifiedCandidate });
    expect(res.status).toBe(403);
    expect((await res.json()).needsVerification).toBe(true);
  });
});

describe('whether onboarding is required', () => {
  it('is required for a candidate with no application and no onboarding', async () => {
    const res = await request('/api/candidate/onboarding/status', { user: verifiedCandidate });
    const body = await res.json();
    expect(body).toMatchObject({ required: true, hasApplication: false, completed: false });
  });

  it('is not required once an application exists - it carries everything this asks', async () => {
    prisma.application.count.mockResolvedValue(1);
    const body = await (await request('/api/candidate/onboarding/status', { user: verifiedCandidate })).json();
    expect(body).toMatchObject({ required: false, hasApplication: true });
  });

  it('is not required once it has been completed', async () => {
    prisma.candidate.findFirst.mockResolvedValue(candidateRow({ onboarding: onboardingRow() }));
    const body = await (await request('/api/candidate/onboarding/status', { user: verifiedCandidate })).json();
    expect(body).toMatchObject({ required: false, completed: true });
    expect(body.onboarding.major1).toBe('Economics');
  });

  it('never leaks a storage path to the owner, who reads the file through the route', async () => {
    prisma.candidate.findFirst.mockResolvedValue(candidateRow({ onboarding: onboardingRow() }));
    const body = await (await request('/api/candidate/onboarding/status', { user: verifiedCandidate })).json();
    expect(JSON.stringify(body)).not.toContain('candidate-onboarding/');
  });

  it('matches the candidate row on studentId as well as email', async () => {
    await request('/api/candidate/onboarding/status', { user: verifiedCandidate });
    expect(prisma.candidate.findFirst.mock.calls[0][0].where.OR).toEqual([
      { studentId: '123456789' },
      { email: 'bruin@g.ucla.edu' }
    ]);
  });
});

describe('submitting', () => {
  it('accepts a PDF resume with the required fields', async () => {
    const res = await submit({ user: verifiedCandidate });
    expect(res.status).toBe(201);
    const { onboarding } = await res.json();
    expect(onboarding).toMatchObject({ major1: 'Economics', graduationYear: '2028', hasHeadshot: false });
  });

  it('stores the phone number as bare digits, matching the rest of the data', async () => {
    await submit({ user: verifiedCandidate, fields: { ...validFields, phoneNumber: '(310) 555-0134' } });
    expect(prisma.candidateOnboarding.upsert.mock.calls[0][0].update.phoneNumber).toBe('3105550134');
  });

  it('stores the GPA pinned to two decimals, so 3.9 and 3.90 are one value', async () => {
    await submit({ user: verifiedCandidate, fields: { ...validFields, cumulativeGpa: '3.9' } });
    expect(prisma.candidateOnboarding.upsert.mock.calls[0][0].update.cumulativeGpa).toBe('3.90');
  });

  it('requires a resume - the one file the module does ask for', async () => {
    const res = await submit({ user: verifiedCandidate, resume: null });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/resume/i);
  });

  it('rejects a resume that is not a PDF', async () => {
    const res = await submit({ user: verifiedCandidate, resumeType: 'application/msword' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/PDF/);
  });

  it('accepts an optional headshot', async () => {
    const res = await submit({ user: verifiedCandidate, headshot: Buffer.from('png bytes') });
    expect(res.status).toBe(201);
    const data = prisma.candidateOnboarding.upsert.mock.calls[0][0].update;
    expect(data.headshotStoragePath).toMatch(/headshot\.png$/);
  });

  it('leaves an existing headshot alone when a resubmission omits one', async () => {
    await submit({ user: verifiedCandidate });
    const data = prisma.candidateOnboarding.upsert.mock.calls[0][0].update;
    expect('headshotStoragePath' in data).toBe(false);
  });

  it('refuses a candidate who already has an application', async () => {
    prisma.application.count.mockResolvedValue(1);
    const res = await submit({ user: verifiedCandidate });
    expect(res.status).toBe(409);
  });

  it.each([
    ['phoneNumber', { ...validFields, phoneNumber: 'call me' }, /10-digit/i],
    ['graduationYear', { ...validFields, graduationYear: '20277' }, /four digits/i],
    ['cumulativeGpa', { ...validFields, cumulativeGpa: '3.456' }, /two decimal places/i],
    ['major1', { ...validFields, major1: '  ' }, /major/i],
    ['isTransferStudent', { ...validFields, isTransferStudent: '' }, /transfer/i]
  ])('rejects a bad %s before writing anything', async (_field, fields, message) => {
    const res = await submit({ user: verifiedCandidate, fields });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(message);
    expect(prisma.candidateOnboarding.upsert).not.toHaveBeenCalled();
  });
});

describe('talent partner network opt-in', () => {
  it('puts the resume in the pool when the candidate opts in', async () => {
    const res = await submit({ user: verifiedCandidate });
    expect(res.status).toBe(201);
    expect((await res.json()).talentPool).toMatchObject({ shared: true });

    const created = prisma.__tx.externalResume.create.mock.calls[0][0].data;
    // The pool gate is shareConsent + consentRevokedAt + a verified email, so
    // these two fields are what actually make the resume assignable.
    expect(created).toMatchObject({ shareConsent: true, isCurrent: true, userId: 'user-1' });
    expect(created.consentAt).toBeInstanceOf(Date);
  });

  it('carries the onboarding metadata onto the pooled row so partner filters match', async () => {
    await submit({ user: verifiedCandidate });
    expect(prisma.__tx.externalResume.create.mock.calls[0][0].data).toMatchObject({
      major1: 'Economics',
      graduationYear: '2028',
      gender: 'Female'
    });
  });

  it('stores the pooled copy under external-resumes, where the client portal can serve it', async () => {
    await submit({ user: verifiedCandidate });
    expect(prisma.externalResume.update.mock.calls[0][0].data.storagePath)
      .toBe('external-resumes/er-1/resume.pdf');
  });

  it('supersedes an earlier pooled resume rather than overwriting it', async () => {
    await submit({ user: verifiedCandidate });
    expect(prisma.__tx.externalResume.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', isCurrent: true },
      data: { isCurrent: false }
    });
  });

  it('shares nothing when the candidate opts out', async () => {
    const res = await submit({
      user: verifiedCandidate,
      fields: { ...validFields, talentPoolOptIn: 'false' }
    });
    expect(res.status).toBe(201);
    expect((await res.json()).talentPool).toMatchObject({ shared: false });
    expect(prisma.__tx.externalResume.create).not.toHaveBeenCalled();
  });

  it('requires an explicit answer - a blank must never become permission', async () => {
    const fields = { ...validFields };
    delete fields.talentPoolOptIn;
    const res = await submit({ user: verifiedCandidate, fields });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/partner companies/i);
  });

  it('still saves the onboarding record when the answer is no', async () => {
    await submit({ user: verifiedCandidate, fields: { ...validFields, talentPoolOptIn: 'false' } });
    expect(prisma.candidateOnboarding.upsert).toHaveBeenCalled();
  });

  it('revokes live assignments the moment consent is withdrawn', async () => {
    prisma.externalResume.findFirst.mockResolvedValue(externalResumeRow());
    await submit({ user: verifiedCandidate, fields: { ...validFields, talentPoolOptIn: 'false' } });

    expect(prisma.__tx.clientResumeAssignment.updateMany).toHaveBeenCalledWith({
      where: { externalResumeId: 'er-1', revokedAt: null },
      data: { revokedAt: expect.any(Date), revokedById: 'user-1' }
    });
  });

  it('reports the current sharing state in status', async () => {
    prisma.externalResume.findFirst.mockResolvedValue(externalResumeRow());
    const body = await (await request('/api/candidate/onboarding/status', { user: verifiedCandidate })).json();
    expect(body.talentPool).toMatchObject({ shared: true });
  });

  it('reports not-shared when consent was revoked', async () => {
    prisma.externalResume.findFirst.mockResolvedValue(
      externalResumeRow({ shareConsent: false, consentRevokedAt: new Date('2026-08-27') })
    );
    const body = await (await request('/api/candidate/onboarding/status', { user: verifiedCandidate })).json();
    expect(body.talentPool.shared).toBe(false);
  });
});

describe('finding a past application', () => {
  it('looks in the applications table, not through the candidate relation', async () => {
    // Regression. Signup creates its own Candidate row, so an applicant who
    // signed up with a different address than they applied with has two: the
    // new empty one, and the one their application hangs off. Reading the
    // relation found the empty one and told four real past applicants to
    // complete onboarding and verify an email they never had a link for.
    prisma.candidate.findFirst.mockResolvedValue(candidateRow({ applications: [] }));
    prisma.application.count.mockResolvedValue(2);

    const body = await (await request('/api/candidate/onboarding/status', { user: verifiedCandidate })).json();
    expect(body).toMatchObject({ required: false, hasApplication: true });
  });

  it('matches on student ID as well as email, like the Forms sync', async () => {
    await request('/api/candidate/onboarding/status', { user: verifiedCandidate });
    expect(prisma.application.count).toHaveBeenCalledWith({
      where: { OR: [{ studentId: '123456789' }, { email: 'bruin@g.ucla.edu' }] }
    });
  });

  it('still onboards someone with genuinely no application anywhere', async () => {
    prisma.candidate.findFirst.mockResolvedValue(candidateRow({ applications: [] }));
    prisma.application.count.mockResolvedValue(0);

    const body = await (await request('/api/candidate/onboarding/status', { user: verifiedCandidate })).json();
    expect(body).toMatchObject({ required: true, hasApplication: false });
  });
});

describe('editing details without re-uploading', () => {
  const patch = (user, body) =>
    fetch(`http://localhost:${port}/api/candidate/onboarding`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenFor(user)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

  const details = {
    phoneNumber: '3105550134',
    graduationYear: '2029',
    cumulativeGpa: '3.90',
    major1: 'Social Sciences',
    isTransferStudent: 'false',
    isFirstGeneration: 'true'
  };

  beforeEach(() => {
    prisma.candidate.findFirst.mockResolvedValue(candidateRow({ onboarding: onboardingRow() }));
  });

  it('updates the record without asking for a file', async () => {
    const res = await patch(verifiedCandidate, details);
    expect(res.status).toBe(200);
    expect((await res.json()).onboarding).toMatchObject({ major1: 'Social Sciences', graduationYear: '2029' });
  });

  it('does not require a sharing answer - that was settled at submission', async () => {
    const res = await patch(verifiedCandidate, details);
    expect(res.status).toBe(200);
  });

  it('carries corrections onto the pooled resume, which partners filter on', async () => {
    prisma.externalResume.findFirst.mockResolvedValue(externalResumeRow());
    await patch(verifiedCandidate, details);

    expect(prisma.externalResume.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ major1: 'Social Sciences', graduationYear: '2029' })
      })
    );
  });

  it('is fine when there is no pooled resume to carry them to', async () => {
    prisma.externalResume.findFirst.mockResolvedValue(null);
    const res = await patch(verifiedCandidate, details);
    expect(res.status).toBe(200);
    expect(prisma.externalResume.update).not.toHaveBeenCalled();
  });

  it('validates the same way the submission does', async () => {
    const res = await patch(verifiedCandidate, { ...details, cumulativeGpa: '3.456' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/two decimal places/);
    expect(prisma.candidateOnboarding.update).not.toHaveBeenCalled();
  });

  it('refuses an unverified account', async () => {
    const res = await patch(unverifiedCandidate, details);
    expect(res.status).toBe(403);
  });

  it('404s for someone who has not onboarded', async () => {
    prisma.candidate.findFirst.mockResolvedValue(candidateRow({ onboarding: null }));
    const res = await patch(verifiedCandidate, details);
    expect(res.status).toBe(404);
  });
});
