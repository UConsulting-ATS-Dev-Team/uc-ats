// emailVerifiedAt proves the address it was set for. Changing the stored
// address must drop it, or a verified account could point itself at someone
// else's address and be trusted with it: the talent portal's resume gate and
// the hand-over to an applicant's account (services/applicantAccounts.js) both
// read it as proof of the address stored now.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import routes from './users.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  },
}));

const talent = {
  id: 'talent-1', role: 'USER', isActive: true, isExternalTalent: true,
  email: 'diyaanne9@gmail.com', fullName: 'Diya Anne', emailVerifiedAt: new Date('2026-10-01'),
};

let server;
let port;

const patch = (body) =>
  fetch(`http://localhost:${port}/api/users/talent-1`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${jwt.sign({ userId: talent.id }, process.env.JWT_SECRET)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
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
  prisma.user.findUnique.mockResolvedValue(talent);
  prisma.user.update.mockImplementation(({ data }) => ({ ...talent, ...data }));
});

describe('changing your own email', () => {
  it('drops the verification and any pending link when the address changes', async () => {
    const res = await patch({ email: 'diya@g.ucla.edu' });

    expect(res.status).toBe(200);
    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({
      email: 'diya@g.ucla.edu',
      emailVerifiedAt: null,
      emailVerificationToken: null,
      emailVerificationExpiry: null,
    });
  });

  it('keeps it for the same inbox written differently', async () => {
    await patch({ email: 'DiyaAnne9@gmail.com' });
    expect(prisma.user.update.mock.calls[0][0].data).not.toHaveProperty('emailVerifiedAt');
  });

  it('keeps it when the address is not being changed', async () => {
    await patch({ fullName: 'Diya A.' });
    expect(prisma.user.update.mock.calls[0][0].data).not.toHaveProperty('emailVerifiedAt');
  });
});
