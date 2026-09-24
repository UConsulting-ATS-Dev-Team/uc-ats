// The public unsubscribe endpoints. A GET never changes anything - mail
// scanners follow every link - and only a valid token acts.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import routes from './unsubscribe.js';
import { unsubscribeToken } from '../services/emailSuppression.js';
import * as suppression from '../services/emailSuppression.js';

vi.mock('../prismaClient.js', () => ({ default: {} }));
vi.mock('../services/emailSuppression.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isSuppressed: vi.fn(async () => false),
    suppressEmail: vi.fn(async () => ({})),
    resubscribeEmail: vi.fn(async () => true),
  };
});

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/unsubscribe', routes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  base = `http://localhost:${server.address().port}/api/unsubscribe`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => vi.clearAllMocks());

const token = encodeURIComponent(unsubscribeToken('joe@ucla.edu'));
const post = (path, body) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

it('reports status on GET without unsubscribing', async () => {
  const res = await fetch(`${base}?t=${token}`);
  expect(await res.json()).toEqual({ email: 'joe@ucla.edu', unsubscribed: false });
  expect(suppression.suppressEmail).not.toHaveBeenCalled();
});

it('unsubscribes on POST from the page', async () => {
  const res = await post('', { t: unsubscribeToken('joe@ucla.edu') });
  expect(res.status).toBe(200);
  expect(suppression.suppressEmail).toHaveBeenCalledWith({ email: 'joe@ucla.edu', reason: 'UNSUBSCRIBED', source: 'LINK' });
});

it('resubscribes', async () => {
  await post('/resubscribe', { t: unsubscribeToken('joe@ucla.edu') });
  expect(suppression.resubscribeEmail).toHaveBeenCalledWith('joe@ucla.edu');
});

it('accepts the RFC 8058 one-click POST, form-encoded body and all', async () => {
  const res = await fetch(`${base}/one-click?t=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  });
  expect(res.status).toBe(200);
  expect(suppression.suppressEmail).toHaveBeenCalledWith({ email: 'joe@ucla.edu', reason: 'UNSUBSCRIBED', source: 'ONE_CLICK' });
});

it('refuses a forged or missing token', async () => {
  expect((await fetch(`${base}?t=nope.nope`)).status).toBe(400);
  expect((await post('', {})).status).toBe(400);
  expect((await fetch(`${base}/one-click`, { method: 'POST' })).status).toBe(400);
  expect(suppression.suppressEmail).not.toHaveBeenCalled();
});
