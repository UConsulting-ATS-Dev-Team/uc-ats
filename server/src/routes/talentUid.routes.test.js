// POST /api/talent/uid and /uid/confirm: the gate and how each outcome of
// claimUid / confirmUidCode reaches the page. The rules themselves are tested
// in services/applicantAccounts.test.js.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

const service = vi.hoisted(() => ({ claimUid: vi.fn(), confirmUidCode: vi.fn() }));
const mailer = vi.hoisted(() => ({ sendUidLinkCode: vi.fn() }));
const auth = vi.hoisted(() => ({ user: null }));

vi.mock('../services/applicantAccounts.js', () => service);
vi.mock('../services/emailNotifications.js', () => mailer);
vi.mock('../prismaClient.js', () => ({ default: {} }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.user = auth.user; next(); },
  invalidateUserCache: vi.fn(),
}));

const { default: talentRoutes } = await import('./talent.js');

const talent = { id: 'talent-1', role: 'USER', isActive: true, isExternalTalent: true, email: 'diyaanne9@gmail.com' };

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/talent', talentRoutes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/talent`;
});
afterAll(() => server.close());
beforeEach(() => {
  vi.resetAllMocks();
  auth.user = talent;
});

const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

describe('POST /api/talent/uid', () => {
  it('is for talent accounts only: an applicant already has their UID', async () => {
    auth.user = { ...talent, isExternalTalent: false, studentId: '306917258' };
    expect((await post('/uid', { uid: '306917258' })).status).toBe(403);
    expect(service.claimUid).not.toHaveBeenCalled();
  });

  it('mails the code as this account and names no address', async () => {
    service.claimUid.mockImplementation(async (_user, _uid, { sendCode }) => {
      await sendCode({ to: 'diya@g.ucla.edu', name: 'Diya', code: '12345678' });
      return { status: 'CODE_SENT' };
    });

    const res = await post('/uid', { uid: '306917258' });

    expect(res).toEqual({ status: 200, body: { status: 'CODE_SENT' } });
    expect(mailer.sendUidLinkCode).toHaveBeenCalledWith({
      to: 'diya@g.ucla.edu', name: 'Diya', code: '12345678', triggeredById: 'talent-1',
    });
  });

  it('answers 409 when another account holds the UID', async () => {
    service.claimUid.mockResolvedValue({ status: 'TAKEN' });
    const res = await post('/uid', { uid: '306917258' });
    expect(res.status).toBe(409);
    expect(res.body.status).toBe('TAKEN');
  });

  it('answers 429 for a second try inside a minute', async () => {
    service.claimUid.mockResolvedValue({ status: 'TOO_SOON' });
    expect((await post('/uid', { uid: '306917258' })).status).toBe(429);
  });

  it('never sends the linked user row back', async () => {
    service.claimUid.mockResolvedValue({ status: 'LINKED', user: { id: 'talent-1', password: 'hash' } });
    expect(await post('/uid', { uid: '306917258' })).toEqual({ status: 200, body: { status: 'LINKED' } });
  });
});

describe('POST /api/talent/uid/confirm', () => {
  it('links on the right code', async () => {
    service.confirmUidCode.mockResolvedValue({ status: 'LINKED', user: {} });
    expect(await post('/uid/confirm', { code: '12345678' })).toEqual({ status: 200, body: { status: 'LINKED' } });
    expect(service.confirmUidCode).toHaveBeenCalledWith('talent-1', '12345678');
  });

  it('says how many tries are left on a wrong code', async () => {
    service.confirmUidCode.mockResolvedValue({ status: 'WRONG', attemptsLeft: 2 });
    const res = await post('/uid/confirm', { code: '00000000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('That code is not right. 2 tries left.');
  });
});
