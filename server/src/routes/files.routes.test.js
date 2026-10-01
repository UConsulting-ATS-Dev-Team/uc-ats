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
import { getFileMetadata, getFileStream } from '../services/google/drive.js';
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

// "Open in new tab" was a bare link, and a new tab sends no Authorization
// header, so it answered 401 for everyone. The page now asks for a link signed
// for one file and opens that.
describe('signed links for opening a document in a new tab', () => {
  const OTHER_FILE = '1zzzOtherFileIdzzzzzzzzzzzzzzzzz';

  const signLink = async (user, fileId = FILE_ID) => {
    const res = await fetch(`http://localhost:${port}/api/files/${fileId}/link`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenFor(user)}` },
    });
    return { status: res.status, body: await res.json() };
  };

  const open = (path) => fetch(`http://localhost:${port}${path}`);

  it('opens the file it was signed for, with no session header', async () => {
    prisma.application.findFirst.mockResolvedValue({ id: 'app-1' });
    const { status, body } = await signLink(admin);
    expect(status).toBe(200);

    const res = await open(`/api/files/${FILE_ID}/pdf?access=${encodeURIComponent(body.access)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.4 drive');
  });

  it('is not signed for a file the caller may not open', async () => {
    expect((await signLink(candidate)).status).toBe(403);
  });

  it('does not open a different file', async () => {
    prisma.application.findFirst.mockResolvedValue({ id: 'app-1' });
    const { body } = await signLink(admin);
    const res = await open(`/api/files/${OTHER_FILE}/pdf?access=${encodeURIComponent(body.access)}`);
    expect(res.status).toBe(401);
  });

  it('still checks access when the link is used', async () => {
    prisma.application.findFirst.mockResolvedValueOnce({ id: 'app-1' });
    const { body } = await signLink(candidate);
    // The document has since been detached from their application.
    prisma.application.findFirst.mockResolvedValue(null);
    const res = await open(`/api/files/${FILE_ID}/pdf?access=${encodeURIComponent(body.access)}`);
    expect(res.status).toBe(403);
  });

  it('is never accepted as a sign-in token', async () => {
    prisma.application.findFirst.mockResolvedValue({ id: 'app-1' });
    const { body } = await signLink(admin);
    const res = await fetch(`http://localhost:${port}/api/files/${FILE_ID}/pdf`, {
      headers: { Authorization: `Bearer ${body.access}` },
    });
    expect(res.status).toBe(401);
  });

  it('does not take a sign-in token as a link', async () => {
    prisma.application.findFirst.mockResolvedValue({ id: 'app-1' });
    const res = await open(`/api/files/${FILE_ID}/pdf?access=${tokenFor(admin)}`);
    expect(res.status).toBe(401);
  });

  it('refuses an expired link', async () => {
    prisma.application.findFirst.mockResolvedValue({ id: 'app-1' });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { body } = await signLink(admin);
      vi.setSystemTime(Date.now() + 16 * 60 * 1000);
      const res = await open(`/api/files/${FILE_ID}/pdf?access=${encodeURIComponent(body.access)}`);
      expect(res.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });
});

// A whole video in one response is cut off by Vercel's proxy part way through,
// so a <video> asking for ranges gets bounded slices (services/byteRange.js).
describe('range requests', () => {
  const MB = 1024 * 1024;
  const SIZE = 10 * MB;
  // A file whose every byte says where it is, so a wrong slice cannot pass.
  const FILE = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i += 1) FILE[i] = (i * 7 + (i >> 8)) & 0xff;

  const getRange = (range) =>
    fetch(`http://localhost:${port}/api/files/${FILE_ID}/pdf`, {
      headers: { Authorization: `Bearer ${tokenFor(admin)}`, ...(range ? { Range: range } : {}) },
    });
  const bytesOf = async (res) => Buffer.from(await res.arrayBuffer());

  beforeEach(() => {
    prisma.application.findFirst.mockResolvedValue({ id: 'app-1' });
    getFileMetadata.mockResolvedValue({ name: 'video.mov', mimeType: 'video/quicktime', size: String(SIZE) });
    // Drive serves exactly the slice it is asked for, as the real API does.
    getFileStream.mockImplementation(async (fileId, { range } = {}) => {
      const { Readable } = await import('node:stream');
      return Readable.from([range ? FILE.subarray(range.start, range.end + 1) : FILE]);
    });
  });

  it('answers an open-ended range with one bounded slice', async () => {
    const res = await getRange('bytes=0-');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-${4 * MB - 1}/${SIZE}`);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('video/quicktime');
    expect((await bytesOf(res)).equals(FILE.subarray(0, 4 * MB))).toBe(true);
  });

  it('sends exactly the slice asked for', async () => {
    const start = 5 * MB + 3;
    const res = await getRange(`bytes=${start}-${start + 99}`);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-length')).toBe('100');
    expect(getFileStream).toHaveBeenCalledWith(FILE_ID, { range: { start, end: start + 99 } });
    expect((await bytesOf(res)).equals(FILE.subarray(start, start + 100))).toBe(true);
  });

  it('sends the end of the file for a large suffix', async () => {
    const res = await getRange(`bytes=-${6 * MB}`);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes ${SIZE - 4 * MB}-${SIZE - 1}/${SIZE}`);
    expect((await bytesOf(res)).equals(FILE.subarray(SIZE - 4 * MB))).toBe(true);
  });

  it('refuses a range past the end of the file', async () => {
    const res = await getRange(`bytes=${SIZE}-`);
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${SIZE}`);
    expect(getFileStream).not.toHaveBeenCalled();
  });

  it('serves the whole file, with its length, when no range is asked for', async () => {
    const res = await getRange();
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe(String(SIZE));
    expect((await bytesOf(res)).equals(FILE)).toBe(true);
  });
});
