// Route-level coverage for the GTKUC member profile workflow: role denial,
// the per-cycle confirmation gate on slot creation, admin hide/unhide, and the
// candidate-facing projection on the public slot list.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import memberRoutes from './member.js';
import adminRoutes from './admin.js';
import publicRoutes from './public.js';
import { GTKUC_INDUSTRIES, GTKUC_INTERESTS } from '../utils/gtkucProfile.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    recruitingCycle: { findFirst: vi.fn() },
    memberGtkucProfile: { findUnique: vi.fn(), upsert: vi.fn() },
    memberGtkucProfileConfirmation: { upsert: vi.fn() },
    meetingSlot: { create: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn((ops) => Promise.all(ops))
  }
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'admin@example.com', fullName: 'Admin' };
const memberUser = {
  id: 'member-1',
  role: 'MEMBER',
  isActive: true,
  email: 'member@example.com',
  fullName: 'Member One',
  profileImage: 'https://example.com/photo.jpg',
  graduationClass: 'Spring 2027'
};
const candidateUser = { id: 'user-1', role: 'USER', isActive: true, email: 'cand@example.com', fullName: 'Candidate' };

const activeCycle = { id: 'cycle-2026', name: 'Fall 2026', isActive: true };

const completeProfile = (overrides = {}) => ({
  id: 'profile-1',
  memberId: memberUser.id,
  industries: [GTKUC_INDUSTRIES[0]],
  interests: [GTKUC_INTERESTS[0]],
  relevance: 'Happy to talk recruiting timelines.',
  candidateVisible: true,
  hiddenFromGtkuc: false,
  updatedAt: new Date(),
  confirmations: [],
  ...overrides
});

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

let server;
let port;

const request = (path, { user, method = 'GET', body } = {}) => {
  const headers = {};
  if (user) headers.Authorization = `Bearer ${tokenFor(user)}`;
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(`http://localhost:${port}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {})
  });
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/member', memberRoutes);
  app.use('/api/admin', adminRoutes);
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
  prisma.user.findUnique.mockImplementation(({ where: { id } }) =>
    [adminUser, memberUser, candidateUser].find((u) => u.id === id) || null
  );
  prisma.recruitingCycle.findFirst.mockResolvedValue(activeCycle);
  prisma.memberGtkucProfile.findUnique.mockResolvedValue(null);
  prisma.meetingSlot.findMany.mockResolvedValue([]);
});

describe('member GTKUC profile authorization', () => {
  it('denies candidate accounts the member profile endpoints and slot creation', async () => {
    const [read, write, slot] = await Promise.all([
      request('/api/member/gtkuc-profile', { user: candidateUser }),
      request('/api/member/gtkuc-profile', { user: candidateUser, method: 'PUT', body: { industries: [] } }),
      request('/api/member/meeting-slots', {
        user: candidateUser,
        method: 'POST',
        body: { location: 'Kerckhoff', startTime: '2026-09-25T10:00' }
      })
    ]);

    expect([read.status, write.status, slot.status]).toEqual([403, 403, 403]);
    expect(prisma.memberGtkucProfile.upsert).not.toHaveBeenCalled();
    expect(prisma.meetingSlot.create).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request('/api/member/gtkuc-profile');
    expect(res.status).toBe(401);
  });

  it('lets a member read their own profile state', async () => {
    prisma.memberGtkucProfile.findUnique.mockResolvedValue(
      completeProfile({ confirmations: [{ cycleId: activeCycle.id, confirmedAt: new Date() }] })
    );

    const res = await request('/api/member/gtkuc-profile', { user: memberUser });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.confirmationRequired).toBe(false);
    expect(body.complete).toBe(true);
    expect(body.taxonomy.industries).toEqual(GTKUC_INDUSTRIES);
  });
});

describe('per-cycle confirmation gate on slot creation', () => {
  const createSlot = () =>
    request('/api/member/meeting-slots', {
      user: memberUser,
      method: 'POST',
      body: { location: 'Kerckhoff 300', startTime: '2026-09-25T10:00', endTime: '2026-09-25T10:30' }
    });

  it('blocks the first slot of a cycle until the profile is confirmed', async () => {
    prisma.memberGtkucProfile.findUnique.mockResolvedValue(completeProfile({ confirmations: [] }));

    const res = await createSlot();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('GTKUC_PROFILE_CONFIRMATION_REQUIRED');
    expect(prisma.meetingSlot.create).not.toHaveBeenCalled();
  });

  it('blocks members whose profile is missing required fields', async () => {
    prisma.memberGtkucProfile.findUnique.mockResolvedValue(
      completeProfile({ relevance: '', confirmations: [{ cycleId: activeCycle.id, confirmedAt: new Date() }] })
    );

    const res = await createSlot();

    expect(res.status).toBe(409);
    expect((await res.json()).missingFields).toContain('relevance');
  });

  it('allows further slots in the same cycle without re-prompting', async () => {
    prisma.memberGtkucProfile.findUnique.mockResolvedValue(
      completeProfile({ confirmations: [{ cycleId: activeCycle.id, confirmedAt: new Date() }] })
    );
    prisma.meetingSlot.create.mockResolvedValue({ id: 'slot-1' });

    const res = await createSlot();

    expect(res.status).toBe(200);
    expect(prisma.meetingSlot.create).toHaveBeenCalledTimes(1);
  });

  it('prompts again in a new cycle, with no reset job', async () => {
    prisma.memberGtkucProfile.findUnique.mockResolvedValue(
      completeProfile({ confirmations: [{ cycleId: 'cycle-2025', confirmedAt: new Date() }] })
    );

    const res = await createSlot();

    expect(res.status).toBe(409);
  });

  it('records the active-cycle confirmation when the profile is saved', async () => {
    prisma.memberGtkucProfile.upsert.mockResolvedValue(completeProfile());
    prisma.memberGtkucProfileConfirmation.upsert.mockResolvedValue({});
    prisma.memberGtkucProfile.findUnique.mockResolvedValue(
      completeProfile({ confirmations: [{ cycleId: activeCycle.id, confirmedAt: new Date() }] })
    );

    const res = await request('/api/member/gtkuc-profile', {
      user: memberUser,
      method: 'PUT',
      body: {
        industries: [GTKUC_INDUSTRIES[0], 'McKinsey & Company'],
        interests: [GTKUC_INTERESTS[0]],
        relevance: 'Happy to talk recruiting timelines.'
      }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Company names never reach the database.
    expect(prisma.memberGtkucProfile.upsert.mock.calls[0][0].create.industries).toEqual([GTKUC_INDUSTRIES[0]]);
    expect(body.rejectedValues).toContain('McKinsey & Company');
    expect(prisma.memberGtkucProfileConfirmation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { profileId_cycleId: { profileId: 'profile-1', cycleId: activeCycle.id } }
      })
    );
    expect(body.confirmationRequired).toBe(false);
  });
});

describe('admin GTKUC visibility', () => {
  it('hides a member from candidate-facing GTKUC', async () => {
    prisma.memberGtkucProfile.upsert.mockResolvedValue(completeProfile({ hiddenFromGtkuc: true }));

    const res = await request(`/api/admin/gtkuc-profiles/${memberUser.id}/visibility`, {
      user: adminUser,
      method: 'PATCH',
      body: { hiddenFromGtkuc: true }
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ memberId: memberUser.id, hiddenFromGtkuc: true });
  });

  it('rejects a non-boolean visibility flag and unknown members', async () => {
    const [badBody, unknownMember] = await Promise.all([
      request(`/api/admin/gtkuc-profiles/${memberUser.id}/visibility`, {
        user: adminUser,
        method: 'PATCH',
        body: { hiddenFromGtkuc: 'yes' }
      }),
      request('/api/admin/gtkuc-profiles/nobody/visibility', {
        user: adminUser,
        method: 'PATCH',
        body: { hiddenFromGtkuc: true }
      })
    ]);

    expect([badBody.status, unknownMember.status]).toEqual([400, 404]);
  });

  it('denies members the admin visibility endpoint', async () => {
    const res = await request(`/api/admin/gtkuc-profiles/${memberUser.id}/visibility`, {
      user: memberUser,
      method: 'PATCH',
      body: { hiddenFromGtkuc: true }
    });

    expect(res.status).toBe(403);
  });
});

describe('public slot list projection', () => {
  const slotFor = (profile) => ({
    id: 'slot-1',
    location: 'Kerckhoff 300',
    startTime: new Date(),
    endTime: new Date(),
    capacity: 2,
    signups: [],
    member: { ...memberUser, gtkucProfile: profile }
  });

  it('exposes only allowlisted profile fields', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([slotFor(completeProfile())]);

    const res = await request('/api/meeting-slots');
    const [slot] = await res.json();

    expect(Object.keys(slot.memberProfile).sort()).toEqual([
      'graduationClass',
      'industries',
      'interests',
      'photo',
      'relevance'
    ]);
  });

  it('drops slots hosted by a member an admin hid', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([slotFor(completeProfile({ hiddenFromGtkuc: true }))]);

    const res = await request('/api/meeting-slots');

    expect(await res.json()).toEqual([]);
  });

  it('keeps the slot but omits the card when the member opted out', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([slotFor(completeProfile({ candidateVisible: false }))]);

    const res = await request('/api/meeting-slots');
    const [slot] = await res.json();

    expect(slot.memberProfile).toBeNull();
  });
});
