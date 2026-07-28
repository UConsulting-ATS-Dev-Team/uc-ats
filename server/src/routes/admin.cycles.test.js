import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import adminRoutes from './admin.js';

const adminUser = {
  id: 'admin-1',
  role: 'ADMIN',
  isActive: true,
  email: 'admin@example.com',
  fullName: 'Admin User',
};

function tokenFor(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
}

vi.mock('../prismaClient.js', () => {
  const cycles = [];

  function matches(record, where) {
    if (!where) return true;
    for (const [key, value] of Object.entries(where)) {
      if (key === 'id') {
        if (typeof value === 'string' && record.id !== value) return false;
        if (value?.in && !value.in.includes(record.id)) return false;
        if (value?.not && value.not === record.id) return false;
        continue;
      }
      if (key === 'isActive' && value === true && !record.isActive) return false;
      if (record[key] !== value) return false;
    }
    return true;
  }

  return {
    default: {
      user: {
        findUnique: vi.fn(async ({ where: { id } }) => {
          if (id === adminUser.id) return adminUser;
          return null;
        }),
      },
      recruitingCycle: {
        findFirst: vi.fn(async (args) => cycles.find((c) => matches(c, args?.where)) || null),
        findMany: vi.fn(async (args) => cycles.filter((c) => matches(c, args?.where))),
        findUnique: vi.fn(async ({ where: { id } }) => cycles.find((c) => c.id === id) || null),
        create: vi.fn(async ({ data }) => {
          const record = { id: `cycle-${cycles.length + 1}`, ...data };
          cycles.push(record);
          return record;
        }),
        update: vi.fn(async ({ where: { id }, data }) => {
          const idx = cycles.findIndex((c) => c.id === id);
          if (idx === -1) throw new Error('Record not found');
          cycles[idx] = { ...cycles[idx], ...data };
          return cycles[idx];
        }),
        updateMany: vi.fn(async ({ where, data }) => {
          const matched = cycles.filter((c) => matches(c, where));
          matched.forEach((c) => Object.assign(c, data));
          return { count: matched.length };
        }),
        delete: vi.fn(async ({ where: { id } }) => {
          const idx = cycles.findIndex((c) => c.id === id);
          if (idx === -1) throw new Error('Record not found');
          cycles.splice(idx, 1);
        }),
      },
      application: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      $transaction: vi.fn((ops) => Promise.all(ops)),
    },
  };
});

import prisma from '../prismaClient.js';

describe('POST /api/admin/cycles feedback enablement gate', () => {
  let app;
  let server;
  let port;

  beforeAll(async () => {
    app = express();
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
    process.env.FEEDBACK_APPROVER = 'test-admin';
    prisma.recruitingCycle.findMany.mockImplementation(async () => []);
  });

  function postCycle(body) {
    return fetch(`http://localhost:${port}/api/admin/cycles`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenFor(adminUser)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('rejects enabling feedback until the configured approver is set', async () => {
    process.env.FEEDBACK_APPROVER = '';
    const res = await postCycle({
      name: 'Fall 2026',
      feedbackEnabled: true,
      feedbackPrivacyPolicy: 'Confidential, retained 30 days, admin readers.',
      feedbackRetentionDays: '30',
      feedbackAccessModel: 'CONFIDENTIAL',
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.details).toMatch(/Feedback cannot be enabled until Ryan approves/);
  });

  it('rejects enabling feedback with an anonymous access model', async () => {
    const res = await postCycle({
      name: 'Fall 2026',
      feedbackEnabled: true,
      feedbackPrivacyPolicy: 'Confidential, retained 30 days, admin readers.',
      feedbackRetentionDays: '30',
      feedbackAccessModel: 'ANONYMOUS',
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.details).toMatch(/Feedback access model must be CONFIDENTIAL/);
  });

  it('parses a string retention payload and creates an enabled cycle approved by the configured approver', async () => {
    const res = await postCycle({
      name: 'Fall 2026',
      feedbackEnabled: true,
      feedbackPrivacyPolicy: 'Confidential, retained 365 days, admin readers.',
      feedbackRetentionDays: '365',
      feedbackAccessModel: 'CONFIDENTIAL',
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.feedbackEnabled).toBe(true);
    expect(body.feedbackRetentionDays).toBe(365);
    expect(body.feedbackAccessModel).toBe('CONFIDENTIAL');
    expect(body.feedbackApprovedBy).toBe('test-admin');
  });
});

describe('PATCH /api/admin/cycles/:id partial payload validation', () => {
  let app;
  let server;
  let port;
  const cycleId = 'cycle-partial';

  beforeAll(async () => {
    app = express();
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
    process.env.FEEDBACK_APPROVER = 'test-admin';
    prisma.recruitingCycle.findMany.mockImplementation(async () => []);
    // Seed an enabled cycle with a valid, approved feedback configuration.
    prisma.recruitingCycle.findUnique.mockImplementation(async ({ where: { id } }) => {
      if (id !== cycleId) return null;
      return {
        id: cycleId,
        name: 'Fall 2026',
        isActive: false,
        formUrl: null,
        startDate: null,
        endDate: null,
        resumeDeadline: null,
        coverLetterDeadline: null,
        videoDeadline: null,
        feedbackEnabled: true,
        feedbackCadenceHours: 48,
        feedbackPrompt: null,
        feedbackQuestions: [],
        feedbackPrivacyPolicy: 'Confidential, retained 30 days, admin readers.',
        feedbackRetentionDays: 30,
        feedbackAccessModel: 'CONFIDENTIAL',
        feedbackApproved: true,
        feedbackApprovedBy: 'test-admin',
        feedbackApprovedAt: new Date(),
      };
    });
    prisma.recruitingCycle.update.mockImplementation(async ({ where: { id }, data }) => {
      if (id !== cycleId) throw new Error('Record not found');
      const existingRecord = {
        id: cycleId,
        name: 'Fall 2026',
        isActive: false,
        formUrl: null,
        startDate: null,
        endDate: null,
        resumeDeadline: null,
        coverLetterDeadline: null,
        videoDeadline: null,
        feedbackEnabled: true,
        feedbackCadenceHours: 48,
        feedbackPrompt: null,
        feedbackQuestions: [],
        feedbackPrivacyPolicy: 'Confidential, retained 30 days, admin readers.',
        feedbackRetentionDays: 30,
        feedbackAccessModel: 'CONFIDENTIAL',
        feedbackApproved: true,
        feedbackApprovedBy: 'test-admin',
        feedbackApprovedAt: new Date(),
      };
      return { ...existingRecord, ...data };
    });
  });

  function patchCycle(body) {
    return fetch(`http://localhost:${port}/api/admin/cycles/${cycleId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenFor(adminUser)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('rejects a partial PATCH that clears the privacy policy on an enabled cycle', async () => {
    const res = await patchCycle({ feedbackPrivacyPolicy: '' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.details).toMatch(/A feedback privacy\/retention policy is required/);
  });

  it('rejects a partial PATCH that clears the retention period on an enabled cycle', async () => {
    const res = await patchCycle({ feedbackRetentionDays: '' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.details).toMatch(/A positive integer feedback retention period/);
  });

  it('rejects a partial PATCH that sets an invalid retention period string on an enabled cycle', async () => {
    const res = await patchCycle({ feedbackRetentionDays: 'abc' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.details).toMatch(/A positive integer feedback retention period/);
  });

  it('rejects a partial PATCH that switches to ANONYMOUS on an enabled cycle', async () => {
    const res = await patchCycle({ feedbackAccessModel: 'ANONYMOUS' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.details).toMatch(/Feedback access model must be CONFIDENTIAL/);
  });

  it('ignores a partial PATCH that tries to un-approve an enabled cycle and preserves the approved reader/retention policy', async () => {
    const res = await patchCycle({ feedbackApproved: false, feedbackApprovedBy: '' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.feedbackEnabled).toBe(true);
    expect(body.feedbackApprovedBy).toBe('test-admin');
    expect(body.feedbackAccessModel).toBe('CONFIDENTIAL');
  });

  it('accepts a partial PATCH with a valid string retention payload on an enabled cycle', async () => {
    const res = await patchCycle({ feedbackRetentionDays: '365' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.feedbackRetentionDays).toBe(365);
  });
});
