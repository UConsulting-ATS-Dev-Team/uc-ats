// Who hears about an edited session, and in which words.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { flushNotifications, queueNotificationsBulk, slotSubjectFormatter } from './interviewSlotComms.js';
import { queueInterviewerNotices } from './interviewerInvites.js';
import { notifySessionChanged, sessionChanged } from './sessionChangeNotices.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    interviewSlotSignup: { findMany: vi.fn() },
    interviewSlotAssignment: { findMany: vi.fn() },
  },
}));

vi.mock('./interviewSlotComms.js', () => ({
  flushNotifications: vi.fn(async () => {}),
  queueNotificationsBulk: vi.fn(async (entries) => entries.map((_, i) => `n-${i}`)),
  slotSubjectFormatter: vi.fn(async () => (title) => `Your interview details have changed - ${title}`),
}));

vi.mock('./interviewerInvites.js', () => ({
  queueInterviewerNotices: vi.fn(async (pairs) => pairs.map((_, i) => `i-${i}`)),
}));

vi.mock('./emailNotifications.js', () => ({ renderInterviewSlotEmail: vi.fn() }));

const signup = (id, email) => ({
  id,
  slotId: 'slot-1',
  application: { email },
  slot: { interview: { title: 'First Round' } },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('notifySessionChanged', () => {
  it('emails confirmed candidates and current interviewers, worded as a changed session', async () => {
    prisma.interviewSlotSignup.findMany.mockResolvedValue([signup('s1', 'a@ucla.edu'), signup('s2', 'b@ucla.edu')]);
    prisma.interviewSlotAssignment.findMany.mockResolvedValue([{ userId: 'u1' }]);

    const result = await notifySessionChanged('slot-1');

    expect(prisma.interviewSlotSignup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slotId: 'slot-1', status: 'CONFIRMED' } })
    );
    expect(prisma.interviewSlotAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slotId: 'slot-1', removedAt: null } })
    );
    expect(slotSubjectFormatter).toHaveBeenCalledWith('MOVED_BY_ADMIN', { sessionChanged: true });
    expect(queueNotificationsBulk).toHaveBeenCalledWith([
      expect.objectContaining({ signupId: 's1', type: 'MOVED_BY_ADMIN', recipient: 'a@ucla.edu', subject: 'Your interview details have changed - First Round' }),
      expect.objectContaining({ signupId: 's2', type: 'MOVED_BY_ADMIN', recipient: 'b@ucla.edu' }),
    ]);
    expect(flushNotifications).toHaveBeenCalledWith(['n-0', 'n-1'], expect.any(Function));
    expect(queueInterviewerNotices).toHaveBeenCalledWith([{ slotId: 'slot-1', userId: 'u1' }], 'INTERVIEWER_MOVED', {
      sessionChanged: true,
    });
    expect(result).toEqual({ candidates: 2, interviewers: 1, failed: [] });
  });

  it('skips a candidate with no address, and queues nothing for an empty session', async () => {
    prisma.interviewSlotSignup.findMany.mockResolvedValue([signup('s1', null)]);
    prisma.interviewSlotAssignment.findMany.mockResolvedValue([]);

    const result = await notifySessionChanged('slot-1');

    expect(queueNotificationsBulk).not.toHaveBeenCalled();
    expect(result).toEqual({ candidates: 0, interviewers: 0, failed: [] });
  });

  it('reports an interviewer queue failure without losing the candidates it sent', async () => {
    prisma.interviewSlotSignup.findMany.mockResolvedValue([signup('s1', 'a@ucla.edu')]);
    prisma.interviewSlotAssignment.findMany.mockResolvedValue([{ userId: 'u1' }]);
    queueInterviewerNotices.mockRejectedValueOnce(new Error('pool timeout'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await notifySessionChanged('slot-1');

    expect(result).toEqual({ candidates: 1, interviewers: 0, failed: ['interviewers'] });
    quiet.mockRestore();
  });

  it('still tells the interviewers when the candidate queue fails', async () => {
    prisma.interviewSlotSignup.findMany.mockRejectedValue(new Error('pool timeout'));
    prisma.interviewSlotAssignment.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await notifySessionChanged('slot-1');

    expect(result).toEqual({ candidates: 0, interviewers: 2, failed: ['candidates'] });
    quiet.mockRestore();
  });
});

describe('sessionChanged', () => {
  const at = (location, interviewLocation = 'Ackerman', start = '2026-10-08T16:00:00Z') => ({
    startTime: new Date(start),
    endTime: new Date('2026-10-08T17:00:00Z'),
    location,
    interview: { location: interviewLocation },
  });

  it('compares the room people were told, the session’s own or else the interview’s', () => {
    expect(sessionChanged(at('Ackerman'), at(null))).toBe(false);
    expect(sessionChanged(at(null), at('Bunche 2150'))).toBe(true);
    expect(sessionChanged(at('Bunche 2150'), at('Bunche 2150'))).toBe(false);
  });

  it('sees a new start time', () => {
    expect(sessionChanged(at(null), at(null, 'Ackerman', '2026-10-08T15:00:00Z'))).toBe(true);
  });
});
