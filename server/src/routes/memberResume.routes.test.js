// Member resume upload and the consent that makes it assignable.
//
// The two assertions worth having here: a bad upload produces a usable JSON 400
// rather than the HTML 500 an unwrapped multer error would give, and
// withdrawing consent actually pulls the resume back from every client.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import memberRoutes from './member.js';

vi.mock('../prismaClient.js', () => {
  const tx = {
    memberResume: { updateMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    clientResumeAssignment: { updateMany: vi.fn() }
  };
  return {
    default: {
      __tx: tx,
      user: { findUnique: vi.fn() },
      memberResume: {
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

const memberUser = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org', fullName: 'Member One' };
const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Admin' };
const candidateUser = { id: 'user-1', role: 'USER', isActive: true, email: 'c@uc.org', fullName: 'Candidate' };
const ALL_USERS = [memberUser, adminUser, candidateUser];

const existingResume = (overrides = {}) => ({
  id: 'mr-1',
  memberId: memberUser.id,
  isCurrent: true,
  storagePath: 'member-resumes/mr-1/resume.pdf',
  originalName: 'resume.pdf',
  fileSize: 1024,
  major1: 'Statistics',
  major2: null,
  graduationYear: '2027',
  gender: 'Other',
  shareConsent: true,
  consentAt: new Date('2026-08-01'),
  consentRevokedAt: null,
  createdAt: new Date('2026-08-01'),
  updatedAt: new Date('2026-08-01'),
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
  return fetch(`http://localhost:${port}/api/member/resume`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenFor(user)}` },
    body: form
  });
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/member', memberRoutes);
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
  prisma.memberResume.findFirst.mockResolvedValue(null);
  prisma.clientResumeAssignment.count.mockResolvedValue(0);
});

describe('role gating', () => {
  it('refuses admins and candidates - an admin uploading a member resume is meaningless', async () => {
    for (const user of [adminUser, candidateUser]) {
      const res = await request('/api/member/resume', { user });
      expect({ role: user.role, status: res.status }).toEqual({ role: user.role, status: 403 });
    }
  });

  it('refuses an unauthenticated request', async () => {
    const res = await request('/api/member/resume');
    expect(res.status).toBe(401);
  });
});

describe('upload validation returns JSON, not an HTML 500', () => {
  it('rejects a non-PDF with a usable message', async () => {
    const res = await uploadRequest({
      user: memberUser,
      fileBuffer: Buffer.from('not a pdf'),
      fileName: 'resume.png',
      mimeType: 'image/png',
      fields: { major1: 'Statistics', graduationYear: '2027' }
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect((await res.json()).error).toMatch(/must be a PDF/i);
  });

  it('rejects an oversize file with a usable message', async () => {
    const res = await uploadRequest({
      user: memberUser,
      fileBuffer: Buffer.alloc(11 * 1024 * 1024, 1),
      fields: { major1: 'Statistics', graduationYear: '2027' }
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect((await res.json()).error).toMatch(/10MB or smaller/i);
  });

  it('rejects a request with no file attached', async () => {
    const res = await uploadRequest({
      user: memberUser,
      fileBuffer: null,
      fields: { major1: 'Statistics', graduationYear: '2027' }
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/attach a pdf/i);
  });

  it('rejects a missing or malformed graduation year', async () => {
    for (const graduationYear of ['', 'Spring 2027', '27']) {
      const res = await uploadRequest({
        user: memberUser,
        fileBuffer: Buffer.from('%PDF-1.4'),
        fields: { major1: 'Statistics', graduationYear }
      });
      expect({ graduationYear, status: res.status }).toEqual({ graduationYear, status: 400 });
    }
  });

  it('rejects a missing major', async () => {
    const res = await uploadRequest({
      user: memberUser,
      fileBuffer: Buffer.from('%PDF-1.4'),
      fields: { graduationYear: '2027' }
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/major/i);
  });
});

describe('consent withdrawal', () => {
  it('revokes every live assignment immediately rather than waiting for an admin', async () => {
    prisma.memberResume.findFirst.mockResolvedValue(existingResume());
    prisma.__tx.memberResume.update.mockResolvedValue(
      existingResume({ shareConsent: false, consentRevokedAt: new Date() })
    );
    prisma.__tx.clientResumeAssignment.updateMany.mockResolvedValue({ count: 3 });

    const res = await request('/api/member/resume/consent', {
      user: memberUser,
      method: 'PATCH',
      body: { shareConsent: false }
    });

    expect(res.status).toBe(200);
    const revokeCall = prisma.__tx.clientResumeAssignment.updateMany.mock.calls[0][0];
    expect(revokeCall.where).toMatchObject({ memberResumeId: 'mr-1', revokedAt: null });
    expect(revokeCall.data.revokedAt).toBeInstanceOf(Date);
  });

  it('does not revoke anything when consent is granted', async () => {
    prisma.memberResume.findFirst.mockResolvedValue(existingResume({ shareConsent: false }));
    prisma.__tx.memberResume.update.mockResolvedValue(existingResume({ shareConsent: true }));

    await request('/api/member/resume/consent', {
      user: memberUser,
      method: 'PATCH',
      body: { shareConsent: true }
    });

    expect(prisma.__tx.clientResumeAssignment.updateMany).not.toHaveBeenCalled();
  });

  it('treats anything other than an explicit true as no consent', async () => {
    prisma.memberResume.findFirst.mockResolvedValue(existingResume());
    prisma.__tx.memberResume.update.mockResolvedValue(existingResume({ shareConsent: false }));
    prisma.__tx.clientResumeAssignment.updateMany.mockResolvedValue({ count: 0 });

    await request('/api/member/resume/consent', {
      user: memberUser,
      method: 'PATCH',
      body: { shareConsent: 'maybe' }
    });

    expect(prisma.__tx.memberResume.update.mock.calls[0][0].data.shareConsent).toBe(false);
  });

  it('404s when there is no resume to withdraw', async () => {
    prisma.memberResume.findFirst.mockResolvedValue(null);
    const res = await request('/api/member/resume/consent', {
      user: memberUser,
      method: 'PATCH',
      body: { shareConsent: false }
    });
    expect(res.status).toBe(404);
  });
});

describe('reading your own resume', () => {
  it('reports how many clients currently hold it', async () => {
    prisma.memberResume.findFirst.mockResolvedValue(existingResume());
    prisma.clientResumeAssignment.count.mockResolvedValue(4);

    const res = await request('/api/member/resume', { user: memberUser });
    const body = await res.json();

    expect(body.resume.assignedCount).toBe(4);
    // The member reads their file through the endpoint, not by path.
    expect(body.resume).not.toHaveProperty('storagePath');
  });

  it('scopes the lookup to the caller, never a route param', async () => {
    await request('/api/member/resume', { user: memberUser });
    expect(prisma.memberResume.findFirst.mock.calls[0][0].where).toEqual({
      memberId: memberUser.id,
      isCurrent: true
    });
  });

  it('404s the PDF when nothing is on file', async () => {
    prisma.memberResume.findFirst.mockResolvedValue(null);
    const res = await request('/api/member/resume/pdf', { user: memberUser });
    expect(res.status).toBe(404);
  });
});

describe('removing a resume', () => {
  it('supersedes the row and revokes assignments rather than deleting history', async () => {
    prisma.memberResume.findFirst.mockResolvedValue(existingResume());
    prisma.__tx.memberResume.update.mockResolvedValue(existingResume({ isCurrent: false }));
    prisma.__tx.clientResumeAssignment.updateMany.mockResolvedValue({ count: 2 });

    const res = await request('/api/member/resume', { user: memberUser, method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(prisma.__tx.memberResume.update.mock.calls[0][0].data).toMatchObject({
      isCurrent: false,
      shareConsent: false
    });
    expect(prisma.__tx.clientResumeAssignment.updateMany).toHaveBeenCalled();
  });
});
