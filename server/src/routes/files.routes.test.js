// Drive file access.
//
// The rule is that a candidate may open their own application documents and
// nobody else's. The case worth pinning down is the one that broke: replacing a
// resume repoints Application.resumeUrl at the new upload, so the file the
// applicant originally submitted stops being referenced by any URL column — and
// they were refused their own previous resume.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import filesRoutes from './files.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    application: { findFirst: vi.fn() },
    resumeUpload: { findFirst: vi.fn() },
  },
}));

vi.mock('../services/google/drive.js', () => ({
  getFileStream: vi.fn(async () => {
    const { Readable } = await import('node:stream');
    return Readable.from([Buffer.from('%PDF-1.4 drive')]);
  }),
  getFileMetadata: vi.fn(async () => ({ name: 'resume.pdf', mimeType: 'application/pdf' })),
}));

const candidate = {
  id: 'user-1',
  role: 'USER',
  isActive: true,
  email: 'rk@kw.com',
  studentId: '912345786',
};

const admin = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org' };

const ALL = [candidate, admin];
const FILE_ID = '1jmfVKDm1MyzIHNbqe2oARQkrsU0TW32';

let server;
let port;

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

const get = (path, user) =>
  fetch(`http://localhost:${port}${path}`, {
    headers: user ? { Authorization: `Bearer ${tokenFor(user)}` } : {},
  });

beforeAll(async () => {
  const app = express();
  app.use('/api/files', filesRoutes);
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
  prisma.application.findFirst.mockResolvedValue(null);
  prisma.resumeUpload.findFirst.mockResolvedValue(null);
});

describe('a candidate opening a Drive document', () => {
  it('is allowed when it is a current document on their own application', async () => {
    prisma.application.findFirst.mockResolvedValue({ id: 'app-1' });
    expect((await get(`/api/files/${FILE_ID}/pdf`, candidate)).status).toBe(200);
  });

  it('is allowed when it is a resume they replaced', async () => {
    // Regression: resumeUrl now points at the replacement, so the reference
    // check finds nothing and used to return 403 for their own old resume.
    prisma.application.findFirst.mockResolvedValue(null);
    prisma.resumeUpload.findFirst.mockResolvedValue({ id: 'upload-1' });

    expect((await get(`/api/files/${FILE_ID}/pdf`, candidate)).status).toBe(200);
  });

  it('scopes the version-history lookup to applications they own', async () => {
    prisma.resumeUpload.findFirst.mockResolvedValue({ id: 'upload-1' });
    await get(`/api/files/${FILE_ID}/pdf`, candidate);

    const where = prisma.resumeUpload.findFirst.mock.calls[0][0].where;
    expect(where.sourceUrl).toEqual({ contains: FILE_ID });
    // Without this an owner check would let anyone read any superseded resume.
    expect(where.application).toBeTruthy();
  });

  it('is refused for a document that is neither current nor theirs', async () => {
    expect((await get(`/api/files/${FILE_ID}/pdf`, candidate)).status).toBe(403);
  });

  it('is refused without a session', async () => {
    expect((await get(`/api/files/${FILE_ID}/pdf`)).status).toBe(401);
  });
});

describe('staff', () => {
  it('may open a superseded resume too', async () => {
    prisma.resumeUpload.findFirst.mockResolvedValue({ id: 'upload-1' });
    expect((await get(`/api/files/${FILE_ID}/pdf`, admin)).status).toBe(200);
  });

  it('reads version history unscoped, unlike a candidate', async () => {
    prisma.resumeUpload.findFirst.mockResolvedValue({ id: 'upload-1' });
    await get(`/api/files/${FILE_ID}/pdf`, admin);
    expect(prisma.resumeUpload.findFirst.mock.calls[0][0].where.application).toBeUndefined();
  });

  it('is still refused a file referenced by nothing at all', async () => {
    expect((await get(`/api/files/${FILE_ID}/pdf`, admin)).status).toBe(403);
  });
});
