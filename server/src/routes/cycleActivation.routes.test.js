// Every admin route that can activate a recruiting cycle must go through the
// ordered, transactional path, and must surface the database's single-active
// index as a conflict rather than reporting a success that did not happen.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import adminRoutes from './admin.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    recruitingCycle: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn()
    },
    $transaction: vi.fn()
  }
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'admin@example.com', fullName: 'Admin' };

let server;
let port;
let rows;
let calls;
// Set to simulate the loser of a concurrent activation: the partial unique index
// rejects the write that would produce a second active cycle.
let indexRejects;

const singleActiveViolation = () =>
  Object.assign(new Error('Unique constraint failed on the fields: (`recruiting_cycles_single_active`)'), {
    code: 'P2002',
    meta: { target: ['recruiting_cycles_single_active'] }
  });

const request = (path, method, body) =>
  fetch(`http://localhost:${port}/api/admin${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt.sign({ userId: adminUser.id }, process.env.JWT_SECRET)}`,
      'Content-Type': 'application/json'
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

const activeIds = () => rows.filter((row) => row.isActive).map((row) => row.id);

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue(adminUser);
  rows = [
    { id: 'current', name: 'Fall 2025', isActive: true },
    { id: 'next', name: 'Fall 2026', isActive: false }
  ];
  calls = [];
  indexRejects = false;

  const tx = {
    recruitingCycle: {
      create: vi.fn(async ({ data }) => {
        calls.push('create');
        const row = { id: 'created', ...data };
        rows.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        calls.push('deactivate-others');
        let count = 0;
        rows.forEach((row, index) => {
          if (where.id?.not === row.id) return;
          if (where.isActive === true && !row.isActive) return;
          rows[index] = { ...row, ...data };
          count += 1;
        });
        return { count };
      }),
      update: vi.fn(async ({ where, data }) => {
        calls.push(data.isActive === true ? 'activate' : 'update');
        if (data.isActive === true && indexRejects) throw singleActiveViolation();
        const index = rows.findIndex((row) => row.id === where.id);
        rows[index] = { ...rows[index], ...data };
        return rows[index];
      })
    }
  };
  // Rolls back like a real transaction: a rejected activation must not leave the
  // previous cycle deactivated.
  prisma.$transaction.mockImplementation(async (fn) => {
    const snapshot = rows.map((row) => ({ ...row }));
    try {
      return await fn(tx);
    } catch (error) {
      rows = snapshot;
      throw error;
    }
  });
});

describe('POST /api/admin/cycles/:id/activate', () => {
  it('deactivates the others before activating, leaving exactly one active', async () => {
    const res = await request('/cycles/next/activate', 'POST');

    expect(res.status).toBe(200);
    expect(activeIds()).toEqual(['next']);
    expect(calls).toEqual(['deactivate-others', 'activate']);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when a concurrent activation already claimed the slot', async () => {
    indexRejects = true;

    const res = await request('/cycles/next/activate', 'POST');

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/activated at the same time/i);
    expect(activeIds()).toEqual(['current']);
  });
});

describe('PATCH /api/admin/cycles/:id', () => {
  it('routes an isActive edit through the same exclusive activation', async () => {
    const res = await request('/cycles/next', 'PATCH', { name: 'Fall 2026', isActive: true });

    expect(res.status).toBe(200);
    expect(activeIds()).toEqual(['next']);
    // The field edit itself never writes isActive: true directly.
    expect(calls).toEqual(['update', 'deactivate-others', 'activate']);
  });

  it('returns 409 instead of a stale success when the invariant rejects it', async () => {
    indexRejects = true;

    const res = await request('/cycles/next', 'PATCH', { isActive: true });

    expect(res.status).toBe(409);
    expect(activeIds()).toEqual(['current']);
  });

  it('still allows deactivating a cycle outright', async () => {
    const res = await request('/cycles/current', 'PATCH', { isActive: false });

    expect(res.status).toBe(200);
    expect(activeIds()).toEqual([]);
    expect(calls).toEqual(['update']);
  });
});

describe('POST /api/admin/cycles', () => {
  it('creates inactive and activates in the same transaction', async () => {
    const res = await request('/cycles', 'POST', { name: 'Fall 2027', isActive: true });

    expect(res.status).toBe(201);
    expect(activeIds()).toEqual(['created']);
    expect(calls).toEqual(['create', 'deactivate-others', 'activate']);
  });

  it('returns 409 when the new cycle loses the activation race', async () => {
    indexRejects = true;

    const res = await request('/cycles', 'POST', { name: 'Fall 2027', isActive: true });

    expect(res.status).toBe(409);
    expect(activeIds()).toEqual(['current']);
  });
});
