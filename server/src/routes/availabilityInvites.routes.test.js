// Final round availability is asked of picked members only.
//
// Admin side: picking members invites and emails exactly them, a bare press
// chases the invited, uninviting stops their answer counting. Member side: the
// form, its read and its save are open only to the invited. First round is
// unchanged: everybody is asked and everybody may answer.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { queueNotificationsBulk } from '../services/interviewSlotComms.js';
import adminRoutes from './interviewSlotsAdmin.js';
import memberRoutes from './interviewSlotsMember.js';

const db = vi.hoisted(() => ({ interviews: [], users: [], invites: [], windows: [] }));

vi.mock('../prismaClient.js', () => {
  const pick = (row, select) =>
    select ? Object.fromEntries(Object.keys(select).filter((k) => k in row).map((k) => [k, row[k]])) : row;
  const inList = (cond, value) => cond === undefined || (cond?.in ? cond.in.includes(value) : cond === value);
  const userMatches = (u, where = {}) =>
    inList(where.id, u.id) && inList(where.role, u.role) && (where.isActive === undefined || u.isActive === where.isActive);
  const windowMatches = (w, where = {}) => inList(where.interviewId, w.interviewId) && inList(where.userId, w.userId);
  return {
    default: {
      interview: {
        findUnique: vi.fn(async ({ where, select }) => {
          const row = db.interviews.find((i) => i.id === where.id);
          return row ? { ...pick(row, select), slots: [] } : null;
        }),
        findMany: vi.fn(async () => db.interviews),
      },
      user: { findMany: vi.fn(async ({ where }) => db.users.filter((u) => userMatches(u, where))) },
      availabilityInvite: {
        findMany: vi.fn(async ({ where }) => db.invites.filter((i) => windowMatches(i, where))),
        findUnique: vi.fn(async ({ where }) => {
          const { interviewId, userId } = where.interviewId_userId;
          return db.invites.find((i) => i.interviewId === interviewId && i.userId === userId) ?? null;
        }),
        createMany: vi.fn(async ({ data }) => {
          for (const row of data) {
            if (!db.invites.some((i) => i.interviewId === row.interviewId && i.userId === row.userId)) db.invites.push(row);
          }
          return { count: data.length };
        }),
        deleteMany: vi.fn(async ({ where }) => {
          const before = db.invites.length;
          db.invites = db.invites.filter((i) => !windowMatches(i, where));
          return { count: before - db.invites.length };
        }),
      },
      interviewerAvailability: {
        findMany: vi.fn(async ({ where }) =>
          db.windows
            .filter((w) => windowMatches(w, where))
            .map((w) => ({ ...w, user: db.users.find((u) => u.id === w.userId) }))
        ),
        deleteMany: vi.fn(async ({ where }) => {
          db.windows = db.windows.filter((w) => !windowMatches(w, where));
          return { count: 0 };
        }),
        createMany: vi.fn(async ({ data }) => {
          db.windows.push(...data.map((row, i) => ({ id: `w-${db.windows.length + i}`, ...row })));
          return { count: data.length };
        }),
      },
      interviewSlotAssignment: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(async (ops) => Promise.all(ops)),
    },
  };
});

vi.mock('../services/activeCycle.js', () => ({ resolveAdminCycle: vi.fn(async () => ({ id: 'cycle-1' })) }));

vi.mock('../services/interviewSlotComms.js', () => ({
  slotNotificationSubject: vi.fn(async () => 'When are you free?'),
  slotSubjectFormatter: vi.fn(),
  flushNotifications: vi.fn(async () => {}),
  queueNotifications: vi.fn(),
  queueNotificationsBulk: vi.fn(async (entries) => entries.map((_, i) => `n-${i}`)),
}));

vi.mock('../services/interviewerInvites.js', () => ({
  notifyInterviewer: vi.fn(),
  notifyInterviewersBulk: vi.fn(async () => []),
}));

let server;
let port;

const call = (method, path, body, userId = 'admin-1') =>
  fetch(`http://localhost:${port}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-user': userId },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

const emailed = () => queueNotificationsBulk.mock.calls.at(-1)?.[0].map((e) => e.recipient) ?? [];

const window = { startTime: '2026-10-10T17:00:00Z', endTime: '2026-10-10T19:00:00Z' };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const id = req.get('x-user');
    req.user = { id, role: id === 'admin-1' ? 'ADMIN' : 'MEMBER' };
    next();
  });
  app.use('/api/admin', adminRoutes);
  app.use('/api/member', memberRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  const day = { startDate: new Date('2026-10-10T16:00:00Z'), endDate: new Date('2026-10-11T00:00:00Z') };
  db.interviews = [
    { id: 'final', title: 'Final Round', interviewType: 'FINAL_ROUND', location: 'Room', ...day },
    { id: 'first', title: 'First Round', interviewType: 'ROUND_ONE', location: 'Room', ...day },
  ];
  db.users = [
    { id: 'admin-1', email: 'admin@ucla.edu', fullName: 'Admin', role: 'ADMIN', isActive: true },
    { id: 'm1', email: 'm1@ucla.edu', fullName: 'Member One', role: 'MEMBER', isActive: true },
    { id: 'm2', email: 'm2@ucla.edu', fullName: 'Member Two', role: 'MEMBER', isActive: true },
    { id: 'm3', email: 'm3@ucla.edu', fullName: 'Member Three', role: 'MEMBER', isActive: true },
    { id: 'gone', email: 'gone@ucla.edu', fullName: 'Gone', role: 'MEMBER', isActive: false },
  ];
  db.invites = [];
  db.windows = [];
});

describe('asking for final round availability', () => {
  it('invites and emails exactly the members picked', async () => {
    const res = await call('POST', '/admin/interviews/final/request-availability', { userIds: ['m1', 'm2'] });
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(2);
    expect(emailed().sort()).toEqual(['m1@ucla.edu', 'm2@ucla.edu']);
    expect(db.invites.map((i) => i.userId).sort()).toEqual(['m1', 'm2']);
    expect(db.invites[0].invitedById).toBe('admin-1');
  });

  it('refuses a bare press before anyone is picked, and emails nobody', async () => {
    const res = await call('POST', '/admin/interviews/final/request-availability', {});
    expect(res.status).toBe(400);
    expect(queueNotificationsBulk).not.toHaveBeenCalled();
  });

  it('refuses an inactive member and invites nobody', async () => {
    const res = await call('POST', '/admin/interviews/final/request-availability', { userIds: ['m1', 'gone'] });
    expect(res.status).toBe(400);
    expect(db.invites).toEqual([]);
    expect(queueNotificationsBulk).not.toHaveBeenCalled();
  });

  it('chases only the invited who have not answered', async () => {
    db.invites = [
      { interviewId: 'final', userId: 'm1' },
      { interviewId: 'final', userId: 'm2' },
    ];
    db.windows = [{ id: 'w1', interviewId: 'final', userId: 'm1', ...window }];
    const res = await call('POST', '/admin/interviews/final/request-availability', {});
    expect(res.body.queued).toBe(1);
    expect(emailed()).toEqual(['m2@ucla.edu']);
  });

  it('leaves first round asking the whole roster', async () => {
    const res = await call('POST', '/admin/interviews/first/request-availability', {});
    expect(res.body.queued).toBe(4);
    expect(db.invites).toEqual([]);
  });
});

describe('the coverage read on final round', () => {
  it('counts only invited answers and marks who is invited', async () => {
    db.invites = [{ interviewId: 'final', userId: 'm1' }];
    db.windows = [
      { id: 'w1', interviewId: 'final', userId: 'm1', ...window },
      // Answered, then uninvited: kept in the table, not counted.
      { id: 'w2', interviewId: 'final', userId: 'm2', ...window },
    ];
    const res = await call('GET', '/admin/interviews/final/availability');
    expect(res.status).toBe(200);
    expect(res.body.interview.inviteOnly).toBe(true);
    expect(res.body.interviewers.map((i) => i.user.id)).toEqual(['m1']);
    const byId = Object.fromEntries(res.body.staff.map((u) => [u.id, u]));
    expect(byId.m1).toMatchObject({ invited: true, responded: true });
    expect(byId.m2).toMatchObject({ invited: false, responded: false });
  });

  it('uninviting stops their answer counting but keeps it', async () => {
    db.invites = [{ interviewId: 'final', userId: 'm1' }];
    db.windows = [{ id: 'w1', interviewId: 'final', userId: 'm1', ...window }];
    const del = await call('DELETE', '/admin/interviews/final/availability-invites/m1');
    expect(del.status).toBe(200);
    const res = await call('GET', '/admin/interviews/final/availability');
    expect(res.body.interviewers).toEqual([]);
    expect(db.windows).toHaveLength(1);
  });
});

describe('a member and the final round form', () => {
  it('lists final round only once they are invited', async () => {
    let res = await call('GET', '/member/interviews/open-for-availability', undefined, 'm1');
    expect(res.body.map((i) => i.id)).toEqual(['first']);

    db.invites = [{ interviewId: 'final', userId: 'm1' }];
    res = await call('GET', '/member/interviews/open-for-availability', undefined, 'm1');
    expect(res.body.map((i) => i.id).sort()).toEqual(['final', 'first']);
  });

  it('refuses to read or save final round availability when not invited', async () => {
    const read = await call('GET', '/member/interviews/final/availability', undefined, 'm2');
    expect(read.status).toBe(403);
    expect(read.body.code).toBe('NOT_INVITED');
    const save = await call('PUT', '/member/interviews/final/availability', { windows: [window] }, 'm2');
    expect(save.status).toBe(403);
    expect(db.windows).toEqual([]);
  });

  it('saves when invited, and first round needs no invite', async () => {
    db.invites = [{ interviewId: 'final', userId: 'm1' }];
    const final = await call('PUT', '/member/interviews/final/availability', { windows: [window] }, 'm1');
    expect(final.status).toBe(200);
    const first = await call('PUT', '/member/interviews/first/availability', { windows: [window] }, 'm2');
    expect(first.status).toBe(200);
    expect(db.windows.map((w) => `${w.interviewId}:${w.userId}`).sort()).toEqual(['final:m1', 'first:m2']);
  });
});
