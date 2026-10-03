// GET /api/files/:id/image: headshots, full size or as an avatar thumbnail.
//
// What has to hold: the access check runs before any byte is served, cached
// thumbnail or not; a signed `?access=` link opens it (an <img src> sends no
// header); the browser may keep the answer; and a file that cannot be
// thumbnailed still shows, as the original.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { Readable } from 'node:stream';
import express from 'express';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import prisma from '../prismaClient.js';
import { getFileMetadata, getFileStream } from '../services/google/drive.js';
import filesRoutes from './files.js';
import { clearDocumentStreamCache } from '../services/documentStreamCache.js';
import { clearHeadshotThumbnailCache } from '../services/headshotThumbnails.js';
import { signDocumentLink } from '../services/documentLinks.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    application: { findFirst: vi.fn() },
    resumeUpload: { findFirst: vi.fn() },
  },
}));

vi.mock('../services/google/drive.js', () => ({
  getFileStream: vi.fn(),
  getFileMetadata: vi.fn(async () => ({ name: 'headshot.jpg', mimeType: 'image/jpeg' })),
}));

const member = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org' };
const candidate = { id: 'user-1', role: 'USER', isActive: true, email: 'c@ucla.edu', studentId: '912345786' };
const ALL = [member, candidate];
const FILE_ID = '1headshotFileIdAbCdEf';

let server;
let port;
let original;

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
const get = (path, user, headers = {}) =>
  fetch(`http://localhost:${port}${path}`, {
    headers: { ...(user ? { Authorization: `Bearer ${tokenFor(user)}` } : {}), ...headers },
  });

beforeAll(async () => {
  original = await sharp({ create: { width: 1200, height: 1600, channels: 3, background: '#996633' } })
    .jpeg()
    .toBuffer();
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
  clearDocumentStreamCache();
  clearHeadshotThumbnailCache();
  prisma.user.findUnique.mockImplementation(({ where: { id } }) => ALL.find((u) => u.id === id) || null);
  prisma.application.findFirst.mockResolvedValue({ id: 'app-1' });
  prisma.resumeUpload.findFirst.mockResolvedValue(null);
  getFileStream.mockImplementation(async () => Readable.from([original]));
});

describe('a thumbnail', () => {
  it('is a small WebP the browser may keep for a week', async () => {
    const res = await get(`/api/files/${FILE_ID}/image?size=256`, member);
    const body = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toBe('private, max-age=604800');
    expect(res.headers.get('etag')).toBeTruthy();
    expect(body.length).toBeLessThan(original.length);
    const meta = await sharp(body).metadata();
    expect(Math.min(meta.width, meta.height)).toBe(256);
  });

  it('answers 304 to a browser revalidating the copy it has', async () => {
    const first = await get(`/api/files/${FILE_ID}/image?size=256`, member);
    await first.arrayBuffer();
    // node:http rather than fetch: fetch marks a hand-set If-None-Match request
    // `Cache-Control: no-cache`, which a browser revalidating does not.
    const status = await new Promise((resolve, reject) => {
      http
        .get(
          `http://localhost:${port}/api/files/${FILE_ID}/image?size=256`,
          { headers: { Authorization: `Bearer ${tokenFor(member)}`, 'If-None-Match': first.headers.get('etag') } },
          (res) => { res.resume(); resolve(res.statusCode); }
        )
        .on('error', reject);
    });
    expect(status).toBe(304);
  });

  it('is fetched from Drive once and then served from memory', async () => {
    await (await get(`/api/files/${FILE_ID}/image?size=256`, member)).arrayBuffer();
    await (await get(`/api/files/${FILE_ID}/image?size=256`, member)).arrayBuffer();
    expect(getFileStream).toHaveBeenCalledTimes(1);
  });

  it('refuses a size that is not on the list', async () => {
    expect((await get(`/api/files/${FILE_ID}/image?size=999`, member)).status).toBe(400);
    expect(getFileStream).not.toHaveBeenCalled();
  });

  it('falls back to the original when the file is not something sharp can read', async () => {
    const heic = Buffer.from('....ftypheic not decodable here');
    getFileStream.mockImplementation(async () => Readable.from([heic]));
    getFileMetadata.mockResolvedValueOnce({ name: 'IMG_0001.HEIC', mimeType: 'image/heic' });

    const res = await get(`/api/files/${FILE_ID}/image?size=256`, member);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/heic');
    expect(Buffer.from(await res.arrayBuffer()).equals(heic)).toBe(true);
  });
});

describe('the original', () => {
  it('is still what a URL without ?size= returns', async () => {
    const res = await get(`/api/files/${FILE_ID}/image`, member);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await res.arrayBuffer()).equals(original)).toBe(true);
  });
});

describe('access', () => {
  it('needs a session', async () => {
    expect((await get(`/api/files/${FILE_ID}/image?size=256`)).status).toBe(401);
  });

  it('is refused for a file no application references, before Drive is asked', async () => {
    prisma.application.findFirst.mockResolvedValue(null);
    expect((await get(`/api/files/${FILE_ID}/image?size=256`, member)).status).toBe(403);
    expect(getFileStream).not.toHaveBeenCalled();
  });

  it('is checked even when the thumbnail is already cached', async () => {
    await (await get(`/api/files/${FILE_ID}/image?size=256`, member)).arrayBuffer();

    // A candidate whose own applications do not include this file.
    prisma.application.findFirst.mockResolvedValue(null);
    expect((await get(`/api/files/${FILE_ID}/image?size=256`, candidate)).status).toBe(403);
  });

  it('lets a candidate see the headshot on their own application', async () => {
    expect((await get(`/api/files/${FILE_ID}/image?size=256`, candidate)).status).toBe(200);
  });

  it('opens through a signed link for this file, with the access check still run', async () => {
    const access = signDocumentLink(`file:${FILE_ID}`, member.id);
    const res = await get(`/api/files/${FILE_ID}/image?size=256&access=${encodeURIComponent(access)}`);
    expect(res.status).toBe(200);
    expect(prisma.application.findFirst).toHaveBeenCalled();

    prisma.application.findFirst.mockResolvedValue(null);
    clearDocumentStreamCache();
    const refused = await get(`/api/files/${FILE_ID}/image?size=256&access=${encodeURIComponent(access)}`);
    expect(refused.status).toBe(403);
  });

  it('does not open with a link signed for a different file', async () => {
    const access = signDocumentLink('file:someOtherFile', member.id);
    const res = await get(`/api/files/${FILE_ID}/image?size=256&access=${encodeURIComponent(access)}`);
    expect(res.status).toBe(401);
  });
});
