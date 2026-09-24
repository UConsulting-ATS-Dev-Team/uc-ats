// Uploading a profile image. Rejected files used to reach Express's default
// HTML 500 because multer reports them outside the route's try/catch.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import { storeProfileImage, removeProfileImage } from '../services/profileImageStorage.js';
import routes from './users.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../services/profileImageStorage.js', () => ({
  storeProfileImage: vi.fn(),
  removeProfileImage: vi.fn(),
}));

const OLD_URL = 'https://proj.supabase.co/storage/v1/object/public/profile-images/member-1/old.jpg';
const NEW_URL = 'https://proj.supabase.co/storage/v1/object/public/profile-images/member-1/new.jpg';

const admin = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Admin One' };
const member = {
  id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org', fullName: 'Member One', profileImage: OLD_URL,
};
const other = { id: 'member-2', role: 'MEMBER', isActive: true, email: 'o@uc.org', fullName: 'Member Two' };
const ALL = [admin, member, other];

let server;
let port;

const upload = (targetId, { user, file, type = 'image/png', name = 'me.png' }) => {
  const form = new FormData();
  if (file) form.append('profileImage', new Blob([file], { type }), name);
  return fetch(`http://localhost:${port}/api/users/${targetId}/profile-image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt.sign({ userId: user.id }, process.env.JWT_SECRET)}` },
    body: form,
  });
};

beforeAll(async () => {
  const app = express();
  app.use('/api/users', routes);
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
  prisma.user.update.mockImplementation(({ where: { id }, data }) => ({ ...ALL.find((u) => u.id === id), ...data }));
  storeProfileImage.mockResolvedValue(NEW_URL);
  removeProfileImage.mockResolvedValue();
});

describe('POST /api/users/:id/profile-image', () => {
  it('stores the image, saves its URL and deletes the one it replaced', async () => {
    const res = await upload('member-1', { user: member, file: Buffer.from('png bytes') });

    expect(res.status).toBe(200);
    expect((await res.json()).user.profileImage).toBe(NEW_URL);
    expect(storeProfileImage).toHaveBeenCalledWith('member-1', expect.any(Buffer));
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({ profileImage: NEW_URL });
    expect(removeProfileImage).toHaveBeenCalledWith(OLD_URL);
  });

  it("refuses a member uploading onto someone else's account", async () => {
    const res = await upload('member-2', { user: member, file: Buffer.from('x') });
    expect(res.status).toBe(403);
    expect(storeProfileImage).not.toHaveBeenCalled();
  });

  it('answers a non-image with a 400 the page can show, not an HTML 500', async () => {
    const res = await upload('member-1', {
      user: member, file: Buffer.from('%PDF'), type: 'application/pdf', name: 'resume.pdf',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/only image files/i);
  });

  it('answers a file over 10MB with a 400', async () => {
    const res = await upload('member-1', { user: member, file: Buffer.alloc(10 * 1024 * 1024 + 1) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/10MB/);
  });

  it('passes an unreadable image back as a 400 with the reason', async () => {
    storeProfileImage.mockRejectedValue(
      Object.assign(new Error('HEIC photos need to be exported as JPG first.'), { code: 'IMAGE_UNREADABLE' })
    );
    const res = await upload('member-1', { user: member, file: Buffer.from('heic'), type: 'image/heic' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/HEIC/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('answers 503 when storage is not configured, and keeps the old image', async () => {
    storeProfileImage.mockRejectedValue(
      Object.assign(new Error('File storage is not configured.'), { code: 'STORAGE_NOT_CONFIGURED' })
    );
    const res = await upload('member-1', { user: member, file: Buffer.from('x') });

    expect(res.status).toBe(503);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(removeProfileImage).not.toHaveBeenCalled();
  });
});
