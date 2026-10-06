// Who hears about an edited session, and in which words.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { flushNotifications, queueNotificationsBulk, slotSubjectFormatter } from './interviewSlotComms.js';
import { queueInterviewerNotices } from './interviewerInvites.js';
import {
  SEND_CLAIM_TTL_MS,
  SessionUpdateRefused,
  notifySessionChanged,
  sendSessionUpdate,
  sessionChanged,
} from './sessionChangeNotices.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    interviewSlotSignup: { findMany: vi.fn() },
    interviewSlotAssignment: { findMany: vi.fn() },
    interviewSlot: { findUnique: vi.fn(), updateMany: vi.fn() },
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

describe('sendSessionUpdate', () => {
  const PENDING = new Date('2026-10-01T00:00:00Z');

  beforeEach(() => {
    prisma.interviewSlot.findUnique.mockResolvedValue({ updatePendingSince: PENDING });
    prisma.interviewSlot.updateMany.mockResolvedValue({ count: 1 });
    prisma.interviewSlotSignup.findMany.mockResolvedValue([signup('s1', 'a@ucla.edu')]);
    prisma.interviewSlotAssignment.findMany.mockResolvedValue([{ userId: 'u1' }]);
  });

  const writes = () => prisma.interviewSlot.updateMany.mock.calls.map(([arg]) => arg);

  it('claims the session, queues the notices, then clears the mark it read and the claim', async () => {
    const result = await sendSessionUpdate('slot-1');

    expect(result).toMatchObject({ candidates: 1, interviewers: 1, pending: false });
    const [claim, clear, release] = writes();
    expect(claim.where).toMatchObject({ id: 'slot-1', updatePendingSince: { not: null } });
    expect(claim.data.updateSendingSince).toBeInstanceOf(Date);
    // The claim lands before anything is queued.
    expect(prisma.interviewSlot.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      queueNotificationsBulk.mock.invocationCallOrder[0]
    );
    expect(clear).toEqual({ where: { id: 'slot-1', updatePendingSince: PENDING }, data: { updatePendingSince: null } });
    expect(release).toEqual({
      where: { id: 'slot-1', updateSendingSince: claim.data.updateSendingSince },
      data: { updateSendingSince: null },
    });
  });

  it('lets a stale claim from a dead server be taken over', async () => {
    await sendSessionUpdate('slot-1');

    const { OR } = writes()[0].where;
    expect(OR[0]).toEqual({ updateSendingSince: null });
    const cutoff = OR[1].updateSendingSince.lt.getTime();
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(SEND_CLAIM_TTL_MS - 1000);
  });

  it('refuses while another send holds the claim, and sends nothing', async () => {
    prisma.interviewSlot.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(sendSessionUpdate('slot-1')).rejects.toMatchObject({ status: 409, code: 'SEND_IN_PROGRESS' });
    expect(queueNotificationsBulk).not.toHaveBeenCalled();
    expect(queueInterviewerNotices).not.toHaveBeenCalled();
  });

  it('refuses a session with nothing waiting', async () => {
    prisma.interviewSlot.findUnique.mockResolvedValue({ updatePendingSince: null });

    await expect(sendSessionUpdate('slot-1')).rejects.toMatchObject({ status: 409, code: 'NO_PENDING_UPDATE' });
    expect(prisma.interviewSlot.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a missing session', async () => {
    prisma.interviewSlot.findUnique.mockResolvedValue(null);

    await expect(sendSessionUpdate('slot-1')).rejects.toBeInstanceOf(SessionUpdateRefused);
  });

  it('keeps the mark when the only half with anyone in it failed', async () => {
    prisma.interviewSlotSignup.findMany.mockResolvedValue([]);
    queueInterviewerNotices.mockRejectedValueOnce(new Error('pool exhausted'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sendSessionUpdate('slot-1');

    expect(result).toMatchObject({ candidates: 0, interviewers: 0, failed: ['interviewers'], pending: true });
    // Only the claim and its release: the mark is left for another press.
    expect(writes().map((w) => Object.keys(w.data)[0])).toEqual(['updateSendingSince', 'updateSendingSince']);
    quiet.mockRestore();
  });

  it('clears the mark when one half went out, so that half is not sent twice', async () => {
    queueInterviewerNotices.mockRejectedValueOnce(new Error('pool exhausted'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sendSessionUpdate('slot-1');

    expect(result).toMatchObject({ candidates: 1, failed: ['interviewers'], pending: false });
    expect(writes()[1].data).toEqual({ updatePendingSince: null });
    quiet.mockRestore();
  });

  it('does not fail once the notices are queued, even if clearing the mark does', async () => {
    prisma.interviewSlot.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('connection reset'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    // This send went out, so it does not invite another press, and the claim
    // is kept so one is refused until it goes stale.
    await expect(sendSessionUpdate('slot-1')).resolves.toMatchObject({ candidates: 1, pending: false });
    expect(prisma.interviewSlot.updateMany).toHaveBeenCalledTimes(2);
    quiet.mockRestore();
  });

  it('says the button stays when a save restamped the session mid-send', async () => {
    // The conditional clear finds a newer stamp than the one read, and leaves it.
    prisma.interviewSlot.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await expect(sendSessionUpdate('slot-1')).resolves.toMatchObject({ candidates: 1, failed: [], pending: true });
  });
});
