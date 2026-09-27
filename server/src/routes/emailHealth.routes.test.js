// Thin over the service; what is tested is the wiring: the window is clamped,
// the test email goes through sendEmail labelled as a manual TEST, and a refused
// send is reported as refused.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

import { emailHealthReport } from '../services/emailHealth.js';
import { sendEmail } from '../services/emailNotifications.js';
import routes from './emailHealth.js';

vi.mock('../services/emailHealth.js', () => ({ emailHealthReport: vi.fn() }));
vi.mock('../services/emailNotifications.js', () => ({ sendEmail: vi.fn() }));

const admin = { id: 'admin-1', role: 'ADMIN', email: 'admin@uc.org', fullName: 'Ada Admin' };

let server;
let port;

const call = (method, path, body) =>
  fetch(`http://localhost:${port}/api/admin/email-health${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = admin;
    next();
  });
  app.use('/api/admin/email-health', routes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  emailHealthReport.mockResolvedValue({ overall: 'ok', sections: [] });
  sendEmail.mockResolvedValue({ success: true, messageId: '<abc@us-west-1.amazonses.com>' });
});

describe('GET /api/admin/email-health', () => {
  it('passes an allowed window through and clamps anything else to a week', async () => {
    await call('GET', '?days=30');
    expect(emailHealthReport).toHaveBeenLastCalledWith({ days: 30 });
    await call('GET', '?days=9999');
    expect(emailHealthReport).toHaveBeenLastCalledWith({ days: 7 });
  });

  it('answers 500 when the report itself fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    emailHealthReport.mockRejectedValue(new Error('db down'));
    expect((await call('GET', '')).status).toBe(500);
  });
});

describe('POST /api/admin/email-health/test', () => {
  it('sends to the admin by default, logged as a manual TEST', async () => {
    const res = await call('POST', '/test', {});
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledWith(
      'admin@uc.org',
      expect.any(String),
      expect.any(String),
      [],
      expect.objectContaining({ category: 'TEST', trigger: 'MANUAL', triggeredById: 'admin-1' })
    );
  });

  it('sends to another address when given one', async () => {
    await call('POST', '/test', { to: ' Check@Mail-Tester.com ' });
    expect(sendEmail.mock.calls[0][0]).toBe('check@mail-tester.com');
  });

  it('refuses something that is not an address', async () => {
    const res = await call('POST', '/test', { to: 'nope' });
    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('reports a send SES refused', async () => {
    sendEmail.mockResolvedValue({ success: false, error: 'Email address is not verified.' });
    const res = await call('POST', '/test', {});
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('not verified');
  });
});
