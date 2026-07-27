import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import publicRoutes from './public.js';
import prisma from '../prismaClient.js';

vi.mock('../prismaClient.js', () => ({
  default: createMockPrisma()
}));

function createMockPrisma() {
  // Simple async mutex to simulate row-level locking.
  class Mutex {
    constructor() {
      this._promise = Promise.resolve();
    }
    runExclusive(callback) {
      const release = () => {};
      const next = this._promise.then(() => callback());
      this._promise = next.catch(() => {}).finally(release);
      return next;
    }
  }

  // In-memory data stores shared across all requests.
  let activeCycle = null;
  const slots = new Map();
  const signups = [];
  const lock = new Mutex();

  const store = { activeCycle, slots, signups, lock };

  function findSlot(id) {
    return store.slots.get(id) || null;
  }

  function signupsForSlot(slotId) {
    return store.signups.filter(s => s.slotId === slotId).map(s => ({ id: s.id }));
  }

  function signupsForEmail(email) {
    return store.signups
      .filter(s => s.email === email)
      .map(s => ({
        id: s.id,
        slotId: s.slotId,
        email: s.email,
        fullName: s.fullName,
        studentId: s.studentId,
        slot: { startTime: findSlot(s.slotId)?.startTime }
      }));
  }

  function txObject() {
    return {
      $queryRaw: vi.fn(async () => {
        return store.activeCycle ? [store.activeCycle] : [];
      }),
      recruitingCycle: {
        findFirst: vi.fn(async ({ where }) => {
          return where.isActive && store.activeCycle?.isActive ? store.activeCycle : null;
        })
      },
      meetingSlot: {
        findUnique: vi.fn(async ({ where, include }) => {
          const slot = findSlot(where.id);
          if (!slot) return null;
          const result = { ...slot };
          if (include?.signups) {
            result.signups = signupsForSlot(slot.id);
          }
          if (include?.member) {
            const m = slot.member;
            result.member = {};
            for (const key of include.member.select ? Object.keys(include.member.select) : Object.keys(m)) {
              if (m[key] !== undefined) result.member[key] = m[key];
            }
          }
          return result;
        }),
        findMany: vi.fn(async ({ where, orderBy, include }) => {
          let result = Array.from(store.slots.values());
          if (where?.startTime) {
            result = result.filter(s => {
              if (where.startTime.gte && s.startTime < where.startTime.gte) return false;
              if (where.startTime.lt && s.startTime >= where.startTime.lt) return false;
              return true;
            });
          }
          if (orderBy?.startTime === 'asc') {
            result.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
          }
          return result.map(slot => {
            const copy = { ...slot };
            if (include?.signups) copy.signups = signupsForSlot(slot.id);
            if (include?.member) copy.member = { id: slot.member.id, fullName: slot.member.fullName, profileImage: slot.member.profileImage };
            return copy;
          });
        })
      },
      meetingSignup: {
        findMany: vi.fn(async ({ where, include }) => {
          if (where.email) {
            return signupsForEmail(where.email);
          }
          return [];
        }),
        create: vi.fn(async ({ data }) => {
          const slot = findSlot(data.slotId);
          const signup = {
            id: `signup-${store.signups.length + 1}`,
            ...data
          };
          store.signups.push(signup);
          return signup;
        })
      },
      user: {
        findUnique: vi.fn(async () => null)
      }
    };
  }

  const instance = {
    ...txObject(),
    $transaction: vi.fn(async (callback, _options) => {
      // Serialize on the active-cycle lock to simulate FOR UPDATE serialization.
      return await store.lock.runExclusive(async () => {
        const tx = txObject();
        return await callback(tx);
      });
    })
  };

  instance.__store = store;
  return instance;
}

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    req.user = { id: 'user-1', email: 'candidate@example.com', fullName: 'Candidate One', studentId: '123456789' };
    next();
  },
  requireAdmin: (req, res, next) => next()
}));

vi.mock('../services/emailNotifications.js', () => ({
  sendMeetingSignupConfirmation: vi.fn().mockResolvedValue({ success: true }),
  sendMeetingSignupNotification: vi.fn().mockResolvedValue({ success: true }),
  sendMeetingCancellationToMember: vi.fn().mockResolvedValue({ success: true })
}));

vi.mock('../services/meetingComms.js', () => ({
  sendAndLogMeetingCommunication: vi.fn((fn) => fn()),
  MEETING_COMM_SUBJECTS: {
    CONFIRMATION: 'Meeting signup confirmation',
    HOST_NOTIFICATION: (name) => `New signup for ${name}`,
    CANCELLATION: 'Meeting cancellation',
    CANCELLATION_TO_HOST: 'Signup cancelled'
  }
}));

describe('public meeting slot signup concurrency', () => {
  let app;
  let server;
  let port;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use('/api', publicRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date('2026-01-10T00:00:00Z'));
    const store = prisma.__store;
    store.activeCycle = {
      id: 'cycle-1',
      name: 'Winter 2026',
      isActive: true,
      startDate: new Date('2026-01-05T00:00:00Z'),
      endDate: new Date('2026-01-20T00:00:00Z')
    };
    store.slots.clear();
    store.signups.length = 0;

    const member = { id: 'member-1', fullName: 'Alex Host', email: 'alex@uconsulting.com', profileImage: null };
    store.slots.set('slot-1', {
      id: 'slot-1',
      memberId: member.id,
      member,
      location: 'Student Union',
      startTime: new Date('2026-01-15T18:00:00Z'),
      endTime: new Date('2026-01-15T19:00:00Z'),
      capacity: 1,
      signups: []
    });
    store.slots.set('slot-2', {
      id: 'slot-2',
      memberId: member.id,
      member,
      location: 'Zoom',
      startTime: new Date('2026-01-18T18:00:00Z'),
      endTime: new Date('2026-01-18T19:00:00Z'),
      capacity: 2,
      signups: []
    });
  });

  function post(slotId) {
    return fetch(`http://localhost:${port}/api/meeting-slots/${slotId}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
  }

  it('allows only one of two concurrent requests to book the last seat', async () => {
    const [resA, resB] = await Promise.all([post('slot-1'), post('slot-1')]);

    const codes = [resA.status, resB.status].sort((a, b) => a - b);
    expect(codes).toEqual([200, 400]);

    const bodies = await Promise.all([resA.json(), resB.json()]);
    const success = bodies.find(b => b.success);
    const failure = bodies.find(b => !b.success);

    expect(success).toBeTruthy();
    expect(failure.error).toMatch(/full/i);

    expect(prisma.__store.signups.length).toBe(1);
  });

  it('prevents the same candidate from booking two different slots in the active cycle concurrently', async () => {
    const [resA, resB] = await Promise.all([post('slot-1'), post('slot-2')]);

    const codes = [resA.status, resB.status].sort((a, b) => a - b);
    expect(codes).toEqual([200, 400]);

    const bodies = await Promise.all([resA.json(), resB.json()]);
    const successCount = bodies.filter(b => b.success).length;
    expect(successCount).toBe(1);

    expect(prisma.__store.signups.length).toBe(1);
  });
});
