// The external talent portal.
//
// The assertions worth having here are the gates, not the CRUD: an applicant
// must not reach this portal even though they share the USER role, an
// unverified account must not be able to put a resume where a partner can see
// it, and withdrawing consent must actually pull the resume back.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import talentRoutes from './talent.js';

vi.mock('../prismaClient.js', () => {
  const tx = {
    externalResume: { updateMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    clientResumeAssignment: { updateMany: vi.fn() }
  };
  return {
    default: {
      __tx: tx,
      user: { findUnique: vi.fn(), update: vi.fn() },
      externalResume: {
        findFirst: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        updateMany: vi.fn()
      },
      clientResumeAssignment: { count: vi.fn(), updateMany: vi.fn() },
      $transaction: vi.fn((fn) => fn(tx))
    }
  };
});

const verifiedTalent = {
  id: 'talent-1',
  role: 'USER',
  isActive: true,
  isExternalTalent: true,
  emailVerifiedAt: new Date('2026-08-20'),
  email: 'joski@g.ucla.edu',
  fullName: 'Joski Bruin',
  graduationClass: '2027'
};

const unverifiedTalent = {
  ...verifiedTalent,
  id: 'talent-2',
  email: 'unverified@g.ucla.edu',
  emailVerifiedAt: null
};

// Role USER, same as a talent account, but reached this app by applying. The
// distinguishing flag is isExternalTalent, which is exactly what makes this
// worth asserting.
const applicantUser = {
  id: 'user-1',
  role: 'USER',
  isActive: true,
  isExternalTalent: false,
  emailVerifiedAt: null,
  email: 'applicant@g.ucla.edu',
  fullName: 'Applicant'
};

const memberUser = {
  id: 'member-1',
  role: 'MEMBER',
  isActive: true,
  isExternalTalent: false,
  emailVerifiedAt: null,
  email: 'm@uc.org',
  fullName: 'Member One'
};

const adminUser = {
  id: 'admin-1',
  role: 'ADMIN',
  isActive: true,
  isExternalTalent: false,
  emailVerifiedAt: null,
  email: 'a@uc.org',
  fullName: 'Admin'
};

const ALL_USERS = [verifiedTalent, unverifiedTalent, applicantUser, memberUser, adminUser];

const existingResume = (overrides = {}) => ({
  id: 'er-1',
  userId: verifiedTalent.id,
  isCurrent: true,
  storagePath: 'external-resumes/er-1/resume.pdf',
  originalName: 'resume.pdf',
  fileSize: 1024,
  major1: 'Economics',
  major2: null,
  graduationYear: '2027',
  gender: 'Female',
  shareConsent: true,
  consentAt: new Date('2026-08-21'),
  consentRevokedAt: null,
  createdAt: new Date('2026-08-21'),
  updatedAt: new Date('2026-08-21'),
  ...overrides
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

const uploadRequest = ({ user, fileBuffer, fileName = 'resume.pdf', mimeType = 'application/pdf', fields = {} }) => {
  const form = new FormData();
  if (fileBuffer) {
    form.append('resume', new Blob([fileBuffer], { type: mimeType }), fileName);
  }
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  return fetch(`http://localhost:${port}/api/talent/resume`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenFor(user)}` },
    body: form
  });
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/talent', talentRoutes);
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
  prisma.externalResume.findFirst.mockResolvedValue(null);
  prisma.clientResumeAssignment.count.mockResolvedValue(0);
});

describe('access gating', () => {
  it('refuses an applicant, who shares the USER role but not the flag', async () => {
    const res = await request('/api/talent/me', { user: applicantUser });
    expect(res.status).toBe(403);
  });

  it('refuses staff - there is no admin version of "my own talent profile"', async () => {
    for (const user of [memberUser, adminUser]) {
      const res = await request('/api/talent/me', { user });
      expect({ role: user.role, status: res.status }).toEqual({ role: user.role, status: 403 });
    }
  });

  it('refuses an unauthenticated request', async () => {
    const res = await request('/api/talent/me');
    expect(res.status).toBe(401);
  });

  it('lets an unverified account read its own profile', async () => {
    // It has to: the portal renders the "check your email" state from this.
    const res = await request('/api/talent/me', { user: unverifiedTalent });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.emailVerified).toBe(false);
  });
});

describe('the verification gate', () => {
  it('refuses an upload from an unverified account', async () => {
    const res = await uploadRequest({
      user: unverifiedTalent,
      fileBuffer: Buffer.from('%PDF-1.4'),
      fields: { major1: 'Economics', graduationYear: '2027', shareConsent: 'true' }
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.needsVerification).toBe(true);
    // The gate runs ahead of multer and the transaction, so nothing was written
    // and no file was accepted.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a consent change from an unverified account', async () => {
    prisma.externalResume.findFirst.mockResolvedValue(existingResume({ userId: unverifiedTalent.id }));
    const res = await request('/api/talent/resume/consent', {
      user: unverifiedTalent,
      method: 'PATCH',
      body: { shareConsent: true }
    });
    expect(res.status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('still lets an unverified account delete its own resume', async () => {
    // Removing your own data is never gated. The verification gate exists to
    // stop an unproven address reaching a partner, not to trap data.
    prisma.externalResume.findFirst.mockResolvedValue(existingResume({ userId: unverifiedTalent.id }));
    const res = await request('/api/talent/resume', { user: unverifiedTalent, method: 'DELETE' });
    expect(res.status).toBe(200);
  });
});

describe('upload validation returns JSON, not an HTML 500', () => {
  it('rejects a non-PDF with a usable message', async () => {
    const res = await uploadRequest({
      user: verifiedTalent,
      fileBuffer: Buffer.from('not a pdf'),
      fileName: 'resume.png',
      mimeType: 'image/png',
      fields: { major1: 'Economics', graduationYear: '2027' }
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/PDF/i);
  });

  it('rejects a missing file', async () => {
    const res = await uploadRequest({
      user: verifiedTalent,
      fields: { major1: 'Economics', graduationYear: '2027' }
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Attach a PDF/i);
  });

  it('rejects a graduation year that is not four digits', async () => {
    for (const graduationYear of ['', 'Spring 2027', '27', '20277']) {
      const res = await uploadRequest({
        user: verifiedTalent,
        fileBuffer: Buffer.from('%PDF-1.4'),
        fields: { major1: 'Economics', graduationYear }
      });
      expect({ graduationYear, status: res.status }).toEqual({ graduationYear, status: 400 });
    }
  });
});

describe('withdrawing consent', () => {
  it('revokes every live assignment immediately, not on an admin noticing', async () => {
    const resume = existingResume();
    prisma.externalResume.findFirst.mockResolvedValue(resume);
    prisma.__tx.externalResume.update.mockResolvedValue({
      ...resume,
      shareConsent: false,
      consentRevokedAt: new Date()
    });

    const res = await request('/api/talent/resume/consent', {
      user: verifiedTalent,
      method: 'PATCH',
      body: { shareConsent: false }
    });

    expect(res.status).toBe(200);
    expect(prisma.__tx.clientResumeAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { externalResumeId: resume.id, revokedAt: null }
      })
    );
  });

  it('does not revoke anything when consent is being granted', async () => {
    const resume = existingResume({ shareConsent: false });
    prisma.externalResume.findFirst.mockResolvedValue(resume);
    prisma.__tx.externalResume.update.mockResolvedValue({ ...resume, shareConsent: true });

    await request('/api/talent/resume/consent', {
      user: verifiedTalent,
      method: 'PATCH',
      body: { shareConsent: true }
    });

    expect(prisma.__tx.clientResumeAssignment.updateMany).not.toHaveBeenCalled();
  });

  it('reads anything but an explicit yes as a withdrawal', async () => {
    const resume = existingResume();
    prisma.externalResume.findFirst.mockResolvedValue(resume);
    prisma.__tx.externalResume.update.mockResolvedValue({ ...resume, shareConsent: false });

    await request('/api/talent/resume/consent', {
      user: verifiedTalent,
      method: 'PATCH',
      body: { shareConsent: 'maybe' }
    });

    expect(prisma.__tx.clientResumeAssignment.updateMany).toHaveBeenCalled();
  });

  it('404s when there is no resume to consent about', async () => {
    const res = await request('/api/talent/resume/consent', {
      user: verifiedTalent,
      method: 'PATCH',
      body: { shareConsent: true }
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /me', () => {
  it('never leaks the storage path', async () => {
    prisma.externalResume.findFirst.mockResolvedValue(existingResume());
    const res = await request('/api/talent/me', { user: verifiedTalent });
    const text = await res.text();
    expect(text).not.toMatch(/external-resumes/);
  });

  it('falls back to the signup year so a first upload is prefilled', async () => {
    const res = await request('/api/talent/me', { user: verifiedTalent });
    const body = await res.json();
    expect(body.profile.graduationYear).toBe('2027');
    expect(body.resume).toBeNull();
  });
});

describe('PATCH /profile', () => {
  it('rejects a graduation year that is not four digits', async () => {
    const res = await request('/api/talent/profile', {
      user: verifiedTalent,
      method: 'PATCH',
      body: { fullName: 'Joski Bruin', graduationYear: '20277' }
    });
    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects an empty name', async () => {
    const res = await request('/api/talent/profile', {
      user: verifiedTalent,
      method: 'PATCH',
      body: { fullName: '   ', graduationYear: '2027' }
    });
    expect(res.status).toBe(400);
  });

  it('is reachable while unverified, so a typo can be fixed before the link arrives', async () => {
    prisma.user.update.mockResolvedValue({ ...unverifiedTalent, fullName: 'Fixed Name' });
    const res = await request('/api/talent/profile', {
      user: unverifiedTalent,
      method: 'PATCH',
      body: { fullName: 'Fixed Name', graduationYear: '2027' }
    });
    expect(res.status).toBe(200);
  });
});
