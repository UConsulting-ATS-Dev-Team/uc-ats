import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockBroadcast = vi.fn().mockResolvedValue(undefined);
vi.mock('./realtime.js', () => ({ broadcast: (...args) => mockBroadcast(...args) }));

vi.mock('../prismaClient.js', () => ({
  default: {
    interview: { findUnique: vi.fn() },
    interviewSlot: { findFirst: vi.fn() },
    interviewSlotAssignment: { findMany: vi.fn() },
    interviewAssignment: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    conversation: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    conversationParticipant: { findUnique: vi.fn() },
    message: { count: vi.fn() }
  }
}));

import prisma from '../prismaClient.js';
import {
  interviewIdOfThread,
  listChatPeople,
  MAX_THREAD_PARTICIPANTS,
  openThread,
  threadContextId
} from './interviewThreads.js';

const me = { id: 'm1', role: 'MEMBER' };

// int-1 is a coffee chat staffed on sessions by `onSession`; `admins` are the
// active admins; `inactive` are deactivated accounts.
function setup({ onSession = ['m1', 'm2', 'm3'], admins = ['a1'], inactive = [] } = {}) {
  prisma.interview.findUnique.mockResolvedValue({ id: 'int-1', description: null, interviewType: 'COFFEE_CHAT' });
  prisma.interviewSlot.findFirst.mockResolvedValue({ id: 'slot-1' });
  prisma.interviewSlotAssignment.findMany.mockImplementation(({ select }) =>
    Promise.resolve(
      onSession.map((userId) => (select.slot ? { userId, slot: { label: 'Morning', startTime: new Date(0) } } : { userId }))
    )
  );
  prisma.user.findMany.mockImplementation(({ where }) => {
    if (where.role === 'ADMIN') return Promise.resolve(admins.map((id) => ({ id })));
    const ids = where.id.in.filter((id) => !inactive.includes(id));
    return Promise.resolve(ids.map((id) => ({ id, fullName: id.toUpperCase(), email: `${id}@x`, role: 'MEMBER' })));
  });
}

describe('interview threads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  describe('threadContextId', () => {
    it('is the same whoever opens it and in whatever order people were picked', () => {
      expect(threadContextId('int-1', ['m1', 'm2', 'm3'])).toBe(threadContextId('int-1', ['m3', 'm1', 'm2']));
    });

    it('differs for a different set of people or a different interview', () => {
      const pair = threadContextId('int-1', ['m1', 'm2']);
      expect(threadContextId('int-1', ['m1', 'm2', 'm3'])).not.toBe(pair);
      expect(threadContextId('int-2', ['m1', 'm2'])).not.toBe(pair);
    });

    it('reads back the interview it belongs to', () => {
      const contextId = threadContextId('int-1', ['m1', 'm2']);
      expect(interviewIdOfThread({ contextType: 'DIRECT_MESSAGE', contextId })).toBe('int-1');
      expect(interviewIdOfThread({ contextType: 'INTERVIEW', contextId: 'int-1' })).toBeNull();
      expect(interviewIdOfThread({ contextType: 'DIRECT_MESSAGE', contextId: 'something-else' })).toBeNull();
    });
  });

  describe('openThread', () => {
    it('creates a thread for the user and the people they picked', async () => {
      prisma.conversation.findUnique.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-new' });

      expect(await openThread('int-1', me, ['m2'])).toBe('conv-new');
      const { data } = prisma.conversation.create.mock.calls[0][0];
      expect(data.contextType).toBe('DIRECT_MESSAGE');
      expect(data.contextId).toBe(threadContextId('int-1', ['m1', 'm2']));
      expect(data.participants.create).toEqual([{ userId: 'm1' }, { userId: 'm2' }]);
      expect(mockBroadcast).toHaveBeenCalledWith('interview-threads:int-1', 'threads:changed', expect.any(Object));
    });

    it('reopens the existing thread for the same people instead of making a second', async () => {
      prisma.conversation.findUnique.mockResolvedValue({ id: 'conv-old' });
      expect(await openThread('int-1', me, ['m2'])).toBe('conv-old');
      expect(prisma.conversation.create).not.toHaveBeenCalled();
    });

    it('can add an admin who is not on a session', async () => {
      prisma.conversation.findUnique.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-new' });
      expect(await openThread('int-1', me, ['a1'])).toBe('conv-new');
    });

    it('settles two people opening the same thread at once on the one row', async () => {
      prisma.conversation.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'conv-raced' });
      prisma.conversation.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
      expect(await openThread('int-1', me, ['m2'])).toBe('conv-raced');
    });

    it('refuses nobody, only yourself, or too many people', async () => {
      await expect(openThread('int-1', me, [])).rejects.toMatchObject({ status: 400, code: 'NO_PARTICIPANTS' });
      await expect(openThread('int-1', me, ['m1'])).rejects.toMatchObject({ code: 'NO_PARTICIPANTS' });
      const crowd = Array.from({ length: MAX_THREAD_PARTICIPANTS }, (_, i) => `x${i}`);
      await expect(openThread('int-1', me, crowd)).rejects.toMatchObject({ code: 'TOO_MANY_PARTICIPANTS' });
    });

    it('refuses someone not working this coffee chat, or a deactivated account', async () => {
      await expect(openThread('int-1', me, ['stranger'])).rejects.toMatchObject({ status: 400, code: 'NOT_ELIGIBLE' });
      setup({ inactive: ['m2'] });
      await expect(openThread('int-1', me, ['m2'])).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
      expect(prisma.conversation.create).not.toHaveBeenCalled();
    });
  });

  describe('listChatPeople', () => {
    it('lists the staff and admins other than the user, with their sessions', async () => {
      const people = await listChatPeople('int-1', me);
      expect(people.map((p) => p.id)).toEqual(['a1', 'm2', 'm3']);
      expect(people.find((p) => p.id === 'm2').sessions).toEqual([{ label: 'Morning', startTime: new Date(0) }]);
      expect(people.find((p) => p.id === 'a1').sessions).toEqual([]);
    });
  });
});
