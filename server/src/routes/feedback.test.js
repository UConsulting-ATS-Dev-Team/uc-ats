import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import feedbackRoutes from './feedback.js';

vi.mock('../prismaClient.js', () => {
  // Minimal in-memory Prisma for the feedback route. Supports concurrent
  // transaction serialization with a mutex so the race test is deterministic.
  const state = {
    jobs: [],
    responses: [],
    idCounter: 0,
  };

  function uid(prefix) {
    return `${prefix}-${++state.idCounter}`;
  }

  const methods = {
    findUnique: async ({ where }) => {
      if (where.feedbackToken) {
        return state.jobs.find((j) => j.feedbackToken === where.feedbackToken) || null;
      }
      return null;
    },
    updateMany: async ({ where, data }) => {
      const matches = state.jobs.filter((j) => {
        let ok = true;
        if (where.id !== undefined && j.id !== where.id) ok = false;
        if (where.status !== undefined && j.status !== where.status) ok = false;
        if (where.responded !== undefined && j.responded !== where.responded) ok = false;
        return ok;
      });
      matches.forEach((j) => {
        Object.assign(j, data);
      });
      return { count: matches.length };
    },
    create: async ({ data }) => {
      const record = { id: uid('response'), ...data };
      state.responses.push(record);
      return record;
    },
  };

  let txLock = Promise.resolve();
  const prisma = {
    __state: state,
    applicationFeedbackJob: methods,
    feedbackResponse: { create: methods.create },
    $transaction: async (callback) => {
      let release;
      const nextLock = new Promise((resolve) => {
        release = resolve;
      });
      const prevLock = txLock;
      txLock = nextLock;
      await prevLock;
      try {
        return await callback(prisma);
      } finally {
        release();
      }
    },
    $reset: () => {
      state.jobs.length = 0;
      state.responses.length = 0;
      state.idCounter = 0;
      txLock = Promise.resolve();
    },
  };

  return { default: prisma };
});

import prisma from '../prismaClient.js';

describe('GET /api/feedback/:token', () => {
  let app;
  let server;
  let port;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/feedback', feedbackRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    prisma.$reset();
  });

  async function get(token) {
    return fetch(`http://localhost:${port}/api/feedback/${token}`);
  }

  it('returns prompt and questions for an active feedback link', async () => {
    prisma.__state.jobs.push({
      id: 'job-1',
      feedbackToken: 'token-1',
      status: 'SENT',
      responded: false,
      cycleId: 'cycle-1',
      feedbackPrompt: 'Please share your thoughts.',
      feedbackQuestions: [{ id: 'q1', label: 'What went well?', required: false }],
      cycle: { name: 'Fall 2026' },
    });

    const res = await get('token-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.prompt).toBe('Please share your thoughts.');
    expect(body.questions).toHaveLength(1);
    expect(body.cycleName).toBe('Fall 2026');
  });

  it('returns 409 once feedback has already been submitted', async () => {
    prisma.__state.jobs.push({
      id: 'job-1',
      feedbackToken: 'token-1',
      status: 'SENT',
      responded: true,
      cycleId: 'cycle-1',
      feedbackPrompt: null,
      feedbackQuestions: null,
      cycle: { name: 'Fall 2026' },
    });

    const res = await get('token-1');
    expect(res.status).toBe(409);
  });
});

describe('POST /api/feedback/:token', () => {
  let app;
  let server;
  let port;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/feedback', feedbackRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    prisma.$reset();
  });

  async function post(token, body) {
    return fetch(`http://localhost:${port}/api/feedback/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('creates a confidential response and consumes the token', async () => {
    prisma.__state.jobs.push({
      id: 'job-1',
      feedbackToken: 'token-1',
      status: 'SENT',
      responded: false,
      cycleId: 'cycle-1',
      feedbackPrompt: 'Tell us more.',
      feedbackQuestions: [{ id: 'q1', label: 'Overall experience', required: false }],
      cycle: { name: 'Fall 2026' },
    });

    const res = await post('token-1', { answers: { q1: 'It was great' } });
    expect(res.status).toBe(201);
    expect(prisma.__state.responses).toHaveLength(1);
    expect(prisma.__state.responses[0].content).toBe('Overall experience: It was great');
    expect(prisma.__state.responses[0].promptSnapshot).toBe('Tell us more.');
    expect(prisma.__state.responses[0].questionsSnapshot).toEqual([
      { id: 'q1', label: 'Overall experience', required: false },
    ]);
    expect(prisma.__state.jobs[0].responded).toBe(true);
  });

  it('returns 409 for a second submission after the token is consumed', async () => {
    prisma.__state.jobs.push({
      id: 'job-1',
      feedbackToken: 'token-1',
      status: 'SENT',
      responded: true,
      cycleId: 'cycle-1',
      feedbackPrompt: null,
      feedbackQuestions: null,
      cycle: { name: 'Fall 2026' },
    });

    const res = await post('token-1', { content: 'Too late' });
    expect(res.status).toBe(409);
    expect(prisma.__state.responses).toHaveLength(0);
  });

  it('only creates one response under two concurrent submissions', async () => {
    prisma.__state.jobs.push({
      id: 'job-1',
      feedbackToken: 'token-1',
      status: 'SENT',
      responded: false,
      cycleId: 'cycle-1',
      feedbackPrompt: 'Thoughts?',
      feedbackQuestions: [{ id: 'q1', label: 'Feedback', required: false }],
      cycle: { name: 'Fall 2026' },
    });

    const [res1, res2] = await Promise.all([
      post('token-1', { answers: { q1: 'first' } }),
      post('token-1', { answers: { q1: 'second' } }),
    ]);

    const statuses = [res1.status, res2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    expect(prisma.__state.responses).toHaveLength(1);
  });
});
