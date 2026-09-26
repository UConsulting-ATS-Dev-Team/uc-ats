// GET /api/active-cycle was once registered twice in public.js with two
// different response shapes. Express only ever ran the first, so every caller
// written against the second read undefined dates and filtered GTKUC slots
// wrong. These pin the one shape and the one registration.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { resolveCandidateCycle } from '../services/activeCycle.js';
import publicRoutes from './public.js';

vi.mock('../prismaClient.js', () => ({ default: {} }));
vi.mock('../services/activeCycle.js', () => ({ resolveCandidateCycle: vi.fn() }));

const app = express();
app.use('/api', publicRoutes);

let server;
let port;
const get = (path) => fetch(`http://localhost:${port}${path}`);

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('GET /api/active-cycle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is registered exactly once', () => {
    const handlers = publicRoutes.stack.filter(
      (layer) => layer.route?.path === '/active-cycle' && layer.route.methods.get
    );
    expect(handlers).toHaveLength(1);
  });

  it('wraps the cycle and returns only the fields callers need', async () => {
    resolveCandidateCycle.mockResolvedValue({
      id: 'cycle-1',
      name: 'Fall 2026',
      startDate: new Date('2026-09-01T00:00:00Z'),
      endDate: new Date('2026-10-15T00:00:00Z'),
      applicationDeadline: new Date('2026-10-02T06:59:00Z'),
      isActive: true,
      createdById: 'admin-1'
    });

    const res = await get('/api/active-cycle');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cycle: {
        id: 'cycle-1',
        name: 'Fall 2026',
        startDate: '2026-09-01T00:00:00.000Z',
        endDate: '2026-10-15T00:00:00.000Z',
        applicationDeadline: '2026-10-02T06:59:00.000Z'
      }
    });
  });

  it('returns { cycle: null } when no cycle is open', async () => {
    resolveCandidateCycle.mockResolvedValue(null);

    const res = await get('/api/active-cycle');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cycle: null });
  });
});
