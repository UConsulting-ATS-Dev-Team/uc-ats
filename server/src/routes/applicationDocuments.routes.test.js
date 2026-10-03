// Who may open an uploaded blind resume or video, and how it is served.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { Readable } from 'node:stream';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import applicationDocumentsRoutes from './applicationDocuments.js';
import { createVideoUpload } from '../services/applicationDocuments.js';
import { MAX_RANGE_BYTES } from '../services/byteRange.js';

const VIDEO_ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b.mp4';
const VIDEO_URL = `/api/application-documents/${VIDEO_ID}/file`;

// Storage is mocked: these tests are about the route's rules. The id and URL
// helpers stay real.
const content = { value: Buffer.alloc(0) };
vi.mock('../services/applicationDocuments.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createVideoUpload: vi.fn(),
  documentSize: vi.fn(async () => content.value.length || null),
  openDocument: vi.fn(async (id, range) =>
    Readable.from([range ? content.value.subarray(range.start, range.end + 1) : content.value])
  ),
}));

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    application: { findFirst: vi.fn() },
  },
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'admin@example.com' };
const memberUser = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'member@example.com' };
const candidateUser = { id: 'user-1', role: 'USER', isActive: true, email: 'cand@example.com', studentId: '405123456' };

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

let server;
let port;

const request = (path, { user, method = 'GET', headers = {}, body } = {}) =>
  fetch(`http://localhost:${port}${path}`, {
    method,
    headers: {
      ...(user ? { Authorization: `Bearer ${tokenFor(user)}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/application-documents', applicationDocumentsRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  content.value = Buffer.from('0123456789');
  prisma.user.findUnique.mockImplementation(({ where: { id } }) =>
    [adminUser, memberUser, candidateUser].find((u) => u.id === id) || null
  );
  prisma.application.findFirst.mockResolvedValue({ id: 'app-1' });
});

describe('GET /api/application-documents/:documentId/file', () => {
  it('needs a sign-in', async () => {
    expect((await request(VIDEO_URL)).status).toBe(401);
  });

  it('serves staff a document an application names', async () => {
    const res = await request(VIDEO_URL, { user: memberUser });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(await res.text()).toBe('0123456789');
    expect(prisma.application.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ blindResumeUrl: VIDEO_URL }, { videoUrl: VIDEO_URL }] } })
    );
  });

  it('serves nobody a document no application names', async () => {
    prisma.application.findFirst.mockResolvedValue(null);
    expect((await request(VIDEO_URL, { user: adminUser })).status).toBe(403);
  });

  it('limits an applicant to documents on their own application', async () => {
    await request(VIDEO_URL, { user: candidateUser });
    const { where } = prisma.application.findFirst.mock.calls[0][0];
    expect(where.AND[0]).toEqual({ OR: [{ studentId: '405123456' }, { email: 'cand@example.com' }] });
  });

  it('answers a range with that slice', async () => {
    const res = await request(VIDEO_URL, { user: adminUser, headers: { Range: 'bytes=2-5' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await res.text()).toBe('2345');
  });

  it('caps an open-ended range so no response is long', async () => {
    content.value = Buffer.alloc(MAX_RANGE_BYTES + 100);
    const res = await request(VIDEO_URL, { user: adminUser, headers: { Range: 'bytes=0-' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-length')).toBe(String(MAX_RANGE_BYTES));
    await res.arrayBuffer();
  });

  it('is 404 for an id that is not a document, without asking the database', async () => {
    const res = await request('/api/application-documents/not-a-document/file', { user: adminUser });
    expect(res.status).toBe(404);
    expect(prisma.application.findFirst).not.toHaveBeenCalled();
  });

  it('is 404 when the application names a file storage does not have', async () => {
    content.value = Buffer.alloc(0);
    expect((await request(VIDEO_URL, { user: adminUser })).status).toBe(404);
  });
});

describe('POST /api/application-documents/:documentId/link', () => {
  it('signs a link that opens the file with no Authorization header', async () => {
    const link = await request(`/api/application-documents/${VIDEO_ID}/link`, { user: memberUser, method: 'POST' });
    expect(link.status).toBe(200);
    const { access } = await link.json();
    const res = await request(`${VIDEO_URL}?access=${encodeURIComponent(access)}`);
    expect(res.status).toBe(200);
  });

  it('refuses a document the caller may not open', async () => {
    prisma.application.findFirst.mockResolvedValue(null);
    const link = await request(`/api/application-documents/${VIDEO_ID}/link`, { user: candidateUser, method: 'POST' });
    expect(link.status).toBe(403);
  });
});

describe('POST /api/application-documents/video-uploads', () => {
  it('is admin only', async () => {
    const res = await request('/api/application-documents/video-uploads', {
      user: memberUser, method: 'POST', body: { fileName: 'a.mp4', sizeBytes: 10 },
    });
    expect(res.status).toBe(403);
    expect(createVideoUpload).not.toHaveBeenCalled();
  });

  it('hands an admin the upload URL and the id the video will have', async () => {
    createVideoUpload.mockResolvedValue({ documentId: VIDEO_ID, uploadUrl: 'https://storage.example/upload', contentType: 'video/mp4' });
    const res = await request('/api/application-documents/video-uploads', {
      user: adminUser, method: 'POST', body: { fileName: 'a.mp4', sizeBytes: 10 },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ documentId: VIDEO_ID });
    expect(createVideoUpload).toHaveBeenCalledWith({ fileName: 'a.mp4', sizeBytes: 10 });
  });

  it('reports a file that is not a video as a 400', async () => {
    createVideoUpload.mockRejectedValue(Object.assign(new Error('The video must be one of: .mp4'), { code: 'UNSUPPORTED_VIDEO' }));
    const res = await request('/api/application-documents/video-uploads', {
      user: adminUser, method: 'POST', body: { fileName: 'a.pdf', sizeBytes: 10 },
    });
    expect(res.status).toBe(400);
  });

  it('reports unconfigured storage as a 503', async () => {
    createVideoUpload.mockRejectedValue(Object.assign(new Error('File storage is not configured.'), { code: 'STORAGE_NOT_CONFIGURED' }));
    const res = await request('/api/application-documents/video-uploads', {
      user: adminUser, method: 'POST', body: { fileName: 'a.mp4', sizeBytes: 10 },
    });
    expect(res.status).toBe(503);
  });
});
