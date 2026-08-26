// Route-level coverage for candidate resume replacement: ownership, the
// deadline/active-cycle window, PDF validation, and the version history that
// keeps the file a reviewer actually scored reachable after a swap.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import resumeUploadRoutes, { resumeDeadlineAt, replacementWindow } from './resumeUploads.js';

// The upload path genuinely writes to server/storage; the successful cases below
// leave real files behind, so this is torn down at the end of the run.
const STORAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../storage');

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    application: { findUnique: vi.fn(), update: vi.fn() },
    resumeUpload: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn((ops) => Promise.all(ops)),
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
const memberUser = {
  id: 'member-1',
  role: 'MEMBER',
  isActive: true,
  email: 'member@example.com',
  fullName: 'Member One',
  studentId: null,
};

// Far enough out that the window stays open without freezing the clock.
const openDeadline = `${new Date().getFullYear() + 5}-10-04`;

const application = (overrides = {}) => ({
  id: 'app-1',
  email: candidateUser.email,
  studentId: candidateUser.studentId,
  resumeUrl: '/api/files/drive-file-1/pdf',
  submittedAt: new Date('2026-09-01T12:00:00Z'),
  candidate: { email: candidateUser.email, studentId: candidateUser.studentId },
  cycle: { id: 'cycle-1', name: 'Fall 2026', isActive: true, resumeDeadline: openDeadline },
  ...overrides,
});

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

let server;
let port;

const request = (path, { user, method = 'GET' } = {}) => {
  const headers = {};
  if (user) headers.Authorization = `Bearer ${tokenFor(user)}`;
  return fetch(`http://localhost:${port}${path}`, { method, headers });
};

// A minimal but genuinely PDF-signed payload, so the magic-byte check passes.
const pdfBytes = () => new Blob([Buffer.from('%PDF-1.4\n%fake resume\n')], { type: 'application/pdf' });

const upload = (path, { user, blob = pdfBytes(), filename = 'resume.pdf' } = {}) => {
  const body = new FormData();
  body.append('resume', blob, filename);
  const headers = {};
  if (user) headers.Authorization = `Bearer ${tokenFor(user)}`;
  return fetch(`http://localhost:${port}${path}`, { method: 'POST', headers, body });
};

beforeAll(async () => {
  const app = express();
  app.use('/api/resume-uploads', resumeUploadRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(path.join(STORAGE_DIR, 'resumes', 'app-1'), { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockImplementation(({ where: { id } }) =>
    [candidateUser, otherCandidate, memberUser].find((u) => u.id === id) || null
  );
  prisma.application.findUnique.mockResolvedValue(application());
  prisma.resumeUpload.findMany.mockResolvedValue([]);
  prisma.resumeUpload.create.mockImplementation(({ data }) => Promise.resolve({ ...data }));
  prisma.resumeUpload.updateMany.mockResolvedValue({ count: 0 });
  prisma.application.update.mockResolvedValue({});
});

describe('resume deadline parsing', () => {
  it('closes an ISO deadline at the end of that day, not at midnight', () => {
    const deadline = resumeDeadlineAt({ id: 'c', resumeDeadline: '2026-10-04' });
    expect(deadline.getFullYear()).toBe(2026);
    expect(deadline.getMonth()).toBe(9);
    expect(deadline.getDate()).toBe(4);
    expect(deadline.getHours()).toBe(23);
  });

  it('treats legacy free-text deadlines as no deadline rather than locking candidates out', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resumeDeadlineAt({ id: 'c', resumeDeadline: 'Oct 4th, Morning' })).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('treats a null or blank deadline as no deadline', () => {
    expect(resumeDeadlineAt({ id: 'c', resumeDeadline: null })).toBeNull();
    expect(resumeDeadlineAt({ id: 'c', resumeDeadline: '   ' })).toBeNull();
  });
});

describe('replacement window', () => {
  it('is open for the applicant before the deadline', () => {
    expect(replacementWindow(application(), candidateUser).canReplace).toBe(true);
  });

  it('closes once the deadline has passed', () => {
    const window = replacementWindow(
      application({ cycle: { id: 'c', name: 'Fall 2026', isActive: true, resumeDeadline: '2026-10-04' } }),
      candidateUser,
      new Date('2026-10-05T00:00:01')
    );
    expect(window.canReplace).toBe(false);
    expect(window.reason).toMatch(/deadline/i);
  });

  it('closes for a cycle that is no longer active', () => {
    const window = replacementWindow(
      application({ cycle: { id: 'c', name: 'Fall 2025', isActive: false, resumeDeadline: openDeadline } }),
      candidateUser
    );
    expect(window.canReplace).toBe(false);
    expect(window.reason).toMatch(/closed/i);
  });

  it('matches an applicant by student ID when the emails differ', () => {
    const window = replacementWindow(
      application({ email: 'old-address@example.com', candidate: null }),
      candidateUser
    );
    expect(window.canReplace).toBe(true);
  });
});

describe('GET /api/resume-uploads/applications/:applicationId', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request('/api/resume-uploads/applications/app-1');
    expect(res.status).toBe(401);
  });

  it('refuses to show one candidate another candidate\'s resume history', async () => {
    const res = await request('/api/resume-uploads/applications/app-1', { user: otherCandidate });
    expect(res.status).toBe(403);
  });

  it('reports the single implicit version for an application never replaced', async () => {
    const res = await request('/api/resume-uploads/applications/app-1', { user: candidateUser });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.canReplace).toBe(true);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({
      id: null,
      url: '/api/files/drive-file-1/pdf',
      isCurrent: true,
      replacedByCandidate: false,
    });
  });

  it('lets staff read the history but not replace the resume', async () => {
    const res = await request('/api/resume-uploads/applications/app-1', { user: memberUser });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.canReplace).toBe(false);
    expect(body.reason).toMatch(/only the applicant/i);
  });

  it('404s on an application that does not exist', async () => {
    prisma.application.findUnique.mockResolvedValue(null);
    const res = await request('/api/resume-uploads/applications/nope', { user: candidateUser });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/resume-uploads/applications/:applicationId', () => {
  it('stores the new resume, supersedes the old one, and repoints the application', async () => {
    const res = await upload('/api/resume-uploads/applications/app-1', { user: candidateUser });
    const body = await res.json();

    expect(res.status).toBe(201);

    // The resume being replaced is captured first, so a score recorded against
    // the Drive-hosted original still resolves to a file.
    const captured = prisma.resumeUpload.create.mock.calls[0][0].data;
    expect(captured).toMatchObject({
      applicationId: 'app-1',
      storagePath: null,
      sourceUrl: '/api/files/drive-file-1/pdf',
    });
    expect(captured.supersededAt).toBeInstanceOf(Date);

    expect(prisma.resumeUpload.updateMany).toHaveBeenCalledWith({
      where: { applicationId: 'app-1', supersededAt: null },
      data: { supersededAt: expect.any(Date) },
    });

    const created = prisma.resumeUpload.create.mock.calls[1][0].data;
    expect(created.storagePath).toMatch(/^resumes\/app-1\/[0-9a-f-]+\.pdf$/);
    expect(created.originalName).toBe('resume.pdf');
    expect(created.uploadedById).toBe(candidateUser.id);

    expect(prisma.application.update).toHaveBeenCalledWith({
      where: { id: 'app-1' },
      data: { resumeUrl: created.sourceUrl, blindResumeUrl: null },
    });
    expect(body.currentResumeUrl).toBe(created.sourceUrl);

    // The bytes really landed where the row says they did.
    expect(fs.existsSync(path.join(STORAGE_DIR, created.storagePath))).toBe(true);
  });

  it('does not re-capture the original once a version history exists', async () => {
    prisma.resumeUpload.findMany.mockResolvedValue([
      {
        id: 'v1',
        applicationId: 'app-1',
        storagePath: null,
        sourceUrl: '/api/files/drive-file-1/pdf',
        uploadedAt: new Date('2026-09-01T12:00:00Z'),
        supersededAt: new Date('2026-09-10T12:00:00Z'),
        originalName: null,
        sizeBytes: null,
      },
    ]);

    const res = await upload('/api/resume-uploads/applications/app-1', { user: candidateUser });
    expect(res.status).toBe(201);
    expect(prisma.resumeUpload.create).toHaveBeenCalledTimes(1);
  });

  it('refuses an upload from anyone but the applicant', async () => {
    const [other, staff] = await Promise.all([
      upload('/api/resume-uploads/applications/app-1', { user: otherCandidate }),
      upload('/api/resume-uploads/applications/app-1', { user: memberUser }),
    ]);

    expect([other.status, staff.status]).toEqual([403, 403]);
    expect(prisma.application.update).not.toHaveBeenCalled();
  });

  it('refuses an upload after the deadline has passed', async () => {
    prisma.application.findUnique.mockResolvedValue(
      application({ cycle: { id: 'c', name: 'Fall 2026', isActive: true, resumeDeadline: '2020-10-04' } })
    );

    const res = await upload('/api/resume-uploads/applications/app-1', { user: candidateUser });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/deadline/i);
    expect(prisma.application.update).not.toHaveBeenCalled();
  });

  it('refuses a file that is not really a PDF', async () => {
    const res = await upload('/api/resume-uploads/applications/app-1', {
      user: candidateUser,
      blob: new Blob([Buffer.from('PK\x03\x04 not a pdf')], { type: 'application/pdf' }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not a readable pdf/i);
    expect(prisma.application.update).not.toHaveBeenCalled();
  });

  it('refuses a non-PDF content type outright', async () => {
    const res = await upload('/api/resume-uploads/applications/app-1', {
      user: candidateUser,
      blob: new Blob([Buffer.from('hello')], { type: 'image/png' }),
      filename: 'resume.png',
    });

    expect(res.status).toBe(400);
    expect(prisma.application.update).not.toHaveBeenCalled();
  });
});

describe('GET /api/resume-uploads/:uploadId/file', () => {
  it('refuses to serve one candidate another candidate\'s stored resume', async () => {
    prisma.resumeUpload.findUnique.mockResolvedValue({
      storagePath: 'resumes/app-1/v2.pdf',
      originalName: 'resume.pdf',
      application: application(),
    });

    const res = await request('/api/resume-uploads/v2/file', { user: otherCandidate });
    expect(res.status).toBe(403);
  });

  it('404s for a version whose file lives in Drive rather than our storage', async () => {
    prisma.resumeUpload.findUnique.mockResolvedValue({
      storagePath: null,
      originalName: null,
      application: application(),
    });

    const res = await request('/api/resume-uploads/v1/file', { user: candidateUser });
    expect(res.status).toBe(404);
  });
});
