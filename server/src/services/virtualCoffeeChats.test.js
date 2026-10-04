import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../prismaClient.js', () => {
  const model = () => ({
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  });
  return {
    default: {
      interview: model(),
      interviewSlot: model(),
      interviewSlotSignup: model(),
      interviewSlotAssignment: model(),
      application: model(),
      user: model(),
      $queryRaw: vi.fn(),
      $transaction: vi.fn(),
    },
  };
});

vi.mock('./interviewSignups.js', () => ({
  LIVE_STATUSES: ['CONFIRMED', 'WAITLISTED', 'NEEDS_PLACEMENT'],
  placeCandidate: vi.fn(),
  moveSignup: vi.fn(),
  cancelSignup: vi.fn(),
  closeInterviewToBookings: vi.fn(),
}));

vi.mock('./interviewSlotComms.js', () => ({
  queueNotificationsBulk: vi.fn(async (entries) => entries.map((_, i) => `n${i}`)),
  flushNotifications: vi.fn(async () => {}),
  slotSubjectFormatter: vi.fn(async (type) => (title) => `${type}: ${title}`),
}));

vi.mock('./emailNotifications.js', () => ({ renderInterviewSlotEmail: vi.fn() }));

vi.mock('./interviewerInvites.js', () => ({
  notifyInterviewer: vi.fn(async () => {}),
  notifyInterviewersBulk: vi.fn(async () => []),
}));

const prisma = (await import('../prismaClient.js')).default;
const signups = await import('./interviewSignups.js');
const comms = await import('./interviewSlotComms.js');
const invites = await import('./interviewerInvites.js');
const {
  NO_LINK_YET,
  addApplicants,
  addInterviewers,
  cancelVirtualCoffeeChat,
  createVirtualCoffeeChat,
  parseChatDetails,
  listVirtualCoffeeChats,
  removeInterviewer,
  updateVirtualCoffeeChat,
} = await import('./virtualCoffeeChats.js');

const SCOPE = { cycleId: 'c1' };

const chatInterview = (overrides = {}) => ({
  id: 'chat-1',
  cycleId: 'c1',
  status: 'UPCOMING',
  isVirtual: true,
  title: 'Virtual Coffee Chat',
  location: 'https://zoom.us/j/1',
  slots: [
    {
      id: 'slot-v',
      interviewId: 'chat-1',
      startTime: new Date('2026-10-10T02:00:00Z'),
      endTime: new Date('2026-10-10T02:30:00Z'),
    },
  ],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation((arg) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma)));
  prisma.$queryRaw.mockResolvedValue([{ status: 'UPCOMING' }]);
  prisma.interview.findFirst.mockResolvedValue(chatInterview());
  prisma.interviewSlotSignup.findMany.mockResolvedValue([]);
});

describe('parseChatDetails', () => {
  it('turns a Pacific day and times into instants, and defaults the title', () => {
    const details = parseChatDetails({ day: '2026-10-09', start: '19:00', end: '19:30', meetingUrl: 'https://zoom.us/j/1' });
    expect(details.title).toBe('Virtual Coffee Chat');
    // 7pm PDT is 02:00 UTC the next day.
    expect(details.startTime.toISOString()).toBe('2026-10-10T02:00:00.000Z');
    expect(details.endTime.toISOString()).toBe('2026-10-10T02:30:00.000Z');
    expect(details.location).toBe('https://zoom.us/j/1');
  });

  it('stores a placeholder rather than nothing when there is no link yet', () => {
    expect(parseChatDetails({ day: '2026-10-09', start: '19:00', end: '19:30' }).location).toBe(NO_LINK_YET);
  });

  it('refuses a link that is not a web address', () => {
    expect(() =>
      parseChatDetails({ day: '2026-10-09', start: '19:00', end: '19:30', meetingUrl: 'javascript:alert(1)' })
    ).toThrow(/https/);
  });

  it('refuses a chat that ends before it starts', () => {
    expect(() => parseChatDetails({ day: '2026-10-09', start: '19:30', end: '19:00' })).toThrow(/end after/);
  });

  it('lets an edit leave the time alone', () => {
    expect(parseChatDetails({ title: 'Evening' }, { partial: true })).toEqual({ title: 'Evening' });
  });
});

describe('createVirtualCoffeeChat', () => {
  it('creates a coffee chat interview with one session nobody can sign up for', async () => {
    prisma.interview.create.mockResolvedValue({ id: 'chat-1' });
    await createVirtualCoffeeChat({
      cycleId: 'c1',
      actorId: 'admin-1',
      body: { day: '2026-10-09', start: '19:00', end: '19:30', meetingUrl: 'https://zoom.us/j/1' },
    });

    const { data } = prisma.interview.create.mock.calls[0][0];
    expect(data).toMatchObject({ interviewType: 'COFFEE_CHAT', isVirtual: true, cycleId: 'c1', createdBy: 'admin-1' });
    expect(data.slots.create).toHaveLength(1);
    expect(data.slots.create[0].candidateCapacity).toBeNull();
  });
});

describe('addApplicants', () => {
  it('places, moves and skips each applicant, and emails the ones it changed', async () => {
    prisma.application.findMany.mockResolvedValue([
      { id: 'new', cycleId: 'c1', currentRound: '2', status: 'UNDER_REVIEW' },
      { id: 'inperson', cycleId: 'c1', currentRound: '2', status: 'UNDER_REVIEW' },
      { id: 'later', cycleId: 'c1', currentRound: '3', status: 'UNDER_REVIEW' },
      { id: 'rejected', cycleId: 'c1', currentRound: '2', status: 'REJECTED' },
      { id: 'elsewhere', cycleId: 'c0', currentRound: '2', status: 'UNDER_REVIEW' },
    ]);
    signups.placeCandidate.mockImplementation(async ({ applicationId }) =>
      applicationId === 'new' ? { placed: { id: 'su-new' } } : { placed: null, moveInstead: 'su-old' }
    );
    signups.moveSignup.mockResolvedValue({
      moved: { id: 'su-old' },
      fromSlot: { interviewId: 'morning', label: 'Morning Block' },
      promotions: [{ signupId: 'su-promoted' }],
    });
    prisma.interview.findUnique.mockResolvedValue({ title: 'Coffee Chat - Round 1' });
    prisma.interviewSlotSignup.findMany.mockResolvedValue([
      { id: 'su-new', slotId: 'slot-v', application: { email: 'new@ucla.edu' }, slot: { interview: { title: 'Virtual Coffee Chat' } } },
      { id: 'su-old', slotId: 'slot-v', application: { email: 'ip@ucla.edu' }, slot: { interview: { title: 'Virtual Coffee Chat' } } },
      { id: 'su-promoted', slotId: 'slot-m', application: { email: 'wl@ucla.edu' }, slot: { interview: { title: 'Coffee Chat - Round 1' } } },
    ]);

    const outcomes = await addApplicants('chat-1', ['new', 'inperson', 'later', 'rejected', 'elsewhere', 'missing'], 'admin-1', SCOPE);

    expect(outcomes).toEqual([
      { applicationId: 'new', outcome: 'PLACED', signupId: 'su-new' },
      { applicationId: 'inperson', outcome: 'MOVED', signupId: 'su-old', from: 'Morning Block' },
      { applicationId: 'later', outcome: 'SKIPPED', reason: 'Not in the coffee chat round' },
      { applicationId: 'rejected', outcome: 'SKIPPED', reason: 'Not advancing' },
      { applicationId: 'elsewhere', outcome: 'SKIPPED', reason: 'Applied in a different cycle' },
      { applicationId: 'missing', outcome: 'SKIPPED', reason: 'Application not found' },
    ]);
    // Placement is forced (the session has no capacity) and goes through the
    // round-locked service, never a direct write.
    expect(signups.placeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ interviewId: 'chat-1', slotId: 'slot-v', force: true })
    );
    expect(signups.moveSignup).toHaveBeenCalledWith(
      expect.objectContaining({ signupId: 'su-old', toSlotId: 'slot-v', isAdmin: true, force: true })
    );

    const sent = comms.queueNotificationsBulk.mock.calls[0][0];
    expect(sent.map((e) => [e.recipient, e.type])).toEqual([
      ['new@ucla.edu', 'CONFIRMATION'],
      ['ip@ucla.edu', 'MOVED_BY_ADMIN'],
      ['wl@ucla.edu', 'PROMOTED'],
    ]);
  });

  it('reports somebody already in the chat rather than failing the batch', async () => {
    prisma.application.findMany.mockResolvedValue([{ id: 'a1', cycleId: 'c1', currentRound: '2', status: 'UNDER_REVIEW' }]);
    signups.placeCandidate.mockRejectedValue(
      Object.assign(new Error('That candidate is already in this time slot'), { status: 409 })
    );
    expect(await addApplicants('chat-1', ['a1'], 'admin-1', SCOPE)).toEqual([{ applicationId: 'a1', outcome: 'ALREADY_HERE' }]);
  });

  it('refuses a cancelled chat', async () => {
    prisma.interview.findFirst.mockResolvedValue(chatInterview({ status: 'CANCELLED' }));
    await expect(addApplicants('chat-1', ['a1'], 'admin-1', SCOPE)).rejects.toMatchObject({ status: 409 });
  });

  it('only finds interviews flagged virtual', async () => {
    prisma.interview.findFirst.mockResolvedValue(null);
    await expect(addApplicants('in-person', ['a1'], 'admin-1', SCOPE)).rejects.toMatchObject({ status: 404 });
    expect(prisma.interview.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'in-person', isVirtual: true, cycleId: 'c1' });
  });
});

describe('addInterviewers', () => {
  it('assigns active members, revives an old assignment, and skips anyone else', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
    prisma.interviewSlotAssignment.findMany.mockResolvedValue([{ id: 'as-2', userId: 'm2', removedAt: new Date() }]);

    const outcomes = await addInterviewers('chat-1', ['m1', 'm2', 'candidate'], SCOPE);

    expect(outcomes).toEqual([
      { userId: 'm1', outcome: 'ASSIGNED' },
      { userId: 'm2', outcome: 'ASSIGNED' },
      { userId: 'candidate', outcome: 'SKIPPED', reason: 'Not an active member' },
    ]);
    expect(prisma.interviewSlotAssignment.create).toHaveBeenCalledWith({
      data: { slotId: 'slot-v', interviewId: 'chat-1', userId: 'm1' },
    });
    expect(prisma.interviewSlotAssignment.update).toHaveBeenCalledWith({
      where: { id: 'as-2' },
      data: { removedAt: null, removedBy: null },
    });
    expect(invites.notifyInterviewersBulk).toHaveBeenCalledWith(
      [
        { slotId: 'slot-v', userId: 'm1' },
        { slotId: 'slot-v', userId: 'm2' },
      ],
      'INTERVIEWER_ASSIGNED'
    );
  });
});

describe('removeInterviewer', () => {
  it('only removes an assignment on this chat', async () => {
    prisma.interviewSlotAssignment.findFirst.mockResolvedValue(null);
    await expect(removeInterviewer('chat-1', 'as-other', 'admin-1', SCOPE)).rejects.toMatchObject({ status: 404 });
    expect(prisma.interviewSlotAssignment.findFirst.mock.calls[0][0].where).toMatchObject({ slotId: 'slot-v' });
  });
});

describe('updateVirtualCoffeeChat', () => {
  const withPeople = () => ({
    ...chatInterview(),
    _count: { evaluations: 0 },
    slots: [
      {
        ...chatInterview().slots[0],
        signups: [{ id: 'su-1', status: 'CONFIRMED', applicationId: 'a1', application: { email: 'a@ucla.edu' } }],
        assignments: [{ id: 'as-1', user: { id: 'm1' } }],
      },
    ],
  });

  it('emails everyone when the link changes', async () => {
    prisma.interview.findFirst
      .mockResolvedValueOnce(chatInterview())
      .mockResolvedValue(withPeople());
    prisma.interviewSlotSignup.findMany.mockResolvedValue([
      { id: 'su-1', slotId: 'slot-v', application: { email: 'a@ucla.edu' }, slot: { interview: { title: 'Virtual Coffee Chat' } } },
    ]);

    await updateVirtualCoffeeChat('chat-1', { meetingUrl: 'https://meet.google.com/abc' }, SCOPE);

    expect(comms.queueNotificationsBulk.mock.calls[0][0]).toEqual([
      expect.objectContaining({ recipient: 'a@ucla.edu', type: 'MOVED_BY_ADMIN' }),
    ]);
    expect(invites.notifyInterviewersBulk).toHaveBeenCalledWith([{ slotId: 'slot-v', userId: 'm1' }], 'INTERVIEWER_MOVED');
  });

  it('emails nobody for a title change', async () => {
    prisma.interview.findFirst.mockResolvedValueOnce(chatInterview()).mockResolvedValue(withPeople());
    await updateVirtualCoffeeChat('chat-1', { title: 'Evening chat' }, SCOPE);
    expect(comms.queueNotificationsBulk).not.toHaveBeenCalled();
    expect(invites.notifyInterviewersBulk).not.toHaveBeenCalled();
  });
});

describe('cancelVirtualCoffeeChat', () => {
  it('closes the chat under the round lock first, then releases the seats it reports', async () => {
    const order = [];
    signups.closeInterviewToBookings.mockImplementation(async () => {
      order.push('close');
      // Includes a seat added after the page loaded: the list comes from the
      // close, not from a roster read before it.
      return [{ id: 'su-1' }, { id: 'su-late' }];
    });
    signups.cancelSignup.mockImplementation(async ({ signupId }) => order.push(`release ${signupId}`));
    prisma.interviewSlotAssignment.findMany.mockResolvedValue([{ userId: 'm1' }]);

    const result = await cancelVirtualCoffeeChat('chat-1', 'admin-1', SCOPE);

    expect(order).toEqual(['close', 'release su-1', 'release su-late']);
    expect(signups.closeInterviewToBookings).toHaveBeenCalledWith({ interviewId: 'chat-1', slotId: 'slot-v' });
    expect(invites.notifyInterviewersBulk).toHaveBeenCalledWith([{ slotId: 'slot-v', userId: 'm1' }], 'INTERVIEWER_REMOVED');
    expect(result).toEqual({ cancelled: true, applicants: 2, interviewers: 1 });
  });

  it('refuses a chat that has already happened', async () => {
    signups.closeInterviewToBookings.mockResolvedValue(null);
    await expect(cancelVirtualCoffeeChat('chat-1', 'admin-1', SCOPE)).rejects.toMatchObject({ status: 409 });
    expect(signups.cancelSignup).not.toHaveBeenCalled();
  });

  it('keeps releasing past a seat that fails, emails the rest, and says to cancel again', async () => {
    signups.closeInterviewToBookings.mockResolvedValue([{ id: 'su-1' }, { id: 'su-bad' }, { id: 'su-3' }]);
    signups.cancelSignup.mockImplementation(async ({ signupId }) => {
      if (signupId === 'su-bad') throw new Error('deadlock');
    });
    prisma.interviewSlotAssignment.findMany.mockResolvedValue([]);
    prisma.interviewSlotSignup.findMany.mockResolvedValue([
      { id: 'su-1', slotId: 'slot-v', application: { email: 'one@ucla.edu' }, slot: { interview: { title: 'Virtual Coffee Chat' } } },
      { id: 'su-3', slotId: 'slot-v', application: { email: 'three@ucla.edu' }, slot: { interview: { title: 'Virtual Coffee Chat' } } },
    ]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(cancelVirtualCoffeeChat('chat-1', 'admin-1', SCOPE)).rejects.toMatchObject({
      status: 500,
      message: expect.stringMatching(/1 applicant is still booked.*Cancel it again/),
    });
    expect(signups.cancelSignup).toHaveBeenCalledTimes(3);
    expect(comms.queueNotificationsBulk.mock.calls[0][0].map((e) => e.recipient)).toEqual([
      'one@ucla.edu',
      'three@ucla.edu',
    ]);
    spy.mockRestore();
  });

  it('does not count a seat another cancellation already released as a failure', async () => {
    signups.closeInterviewToBookings.mockResolvedValue([{ id: 'su-1' }, { id: 'su-taken' }]);
    signups.cancelSignup.mockReset();
    signups.cancelSignup.mockImplementation(async ({ signupId }) => {
      if (signupId === 'su-taken') {
        throw Object.assign(new Error('That booking has already been cancelled'), { status: 409 });
      }
    });
    prisma.interviewSlotAssignment.findMany.mockResolvedValue([]);
    prisma.interviewSlotSignup.findMany.mockResolvedValue([
      { id: 'su-1', slotId: 'slot-v', application: { email: 'one@ucla.edu' }, slot: { interview: { title: 'Virtual Coffee Chat' } } },
    ]);

    const result = await cancelVirtualCoffeeChat('chat-1', 'admin-1', SCOPE);

    expect(result.applicants).toBe(1);
    // Only the seat this request released is emailed; the other request emails its own.
    expect(comms.queueNotificationsBulk.mock.calls[0][0].map((e) => e.signupId)).toEqual(['su-1']);
  });

  it('can be run again on a chat a failed cancellation left behind', async () => {
    prisma.interview.findFirst.mockResolvedValue(chatInterview({ status: 'CANCELLED' }));
    signups.closeInterviewToBookings.mockResolvedValue([{ id: 'su-bad' }]);
    signups.cancelSignup.mockReset();
    prisma.interviewSlotAssignment.findMany.mockResolvedValue([]);

    const result = await cancelVirtualCoffeeChat('chat-1', 'admin-1', SCOPE);

    expect(signups.cancelSignup).toHaveBeenCalledWith(expect.objectContaining({ signupId: 'su-bad' }));
    expect(result.applicants).toBe(1);
  });

  it('still lists a cancelled chat while someone is booked into it', async () => {
    prisma.interview.findMany.mockResolvedValue([]);
    await listVirtualCoffeeChats('c1');
    expect(prisma.interview.findMany.mock.calls[0][0].where.OR).toEqual([
      { status: { not: 'CANCELLED' } },
      { slots: { some: { signups: { some: { status: { in: ['CONFIRMED', 'WAITLISTED', 'NEEDS_PLACEMENT'] } } } } } },
    ]);
  });
});

describe('addApplicants after a move has committed', () => {
  it('reports and emails the move even if naming the old session fails', async () => {
    prisma.application.findMany.mockResolvedValue([{ id: 'a1', cycleId: 'c1', currentRound: '2', status: 'UNDER_REVIEW' }]);
    signups.placeCandidate.mockReset();
    signups.placeCandidate.mockResolvedValue({ placed: null, moveInstead: 'su-old' });
    signups.moveSignup.mockResolvedValue({
      moved: { id: 'su-old' },
      fromSlot: { interviewId: 'morning', label: null },
      promotions: [],
    });
    prisma.interview.findUnique.mockRejectedValue(new Error('connection reset'));
    prisma.interviewSlotSignup.findMany.mockResolvedValue([
      { id: 'su-old', slotId: 'slot-v', application: { email: 'a1@ucla.edu' }, slot: { interview: { title: 'Virtual Coffee Chat' } } },
    ]);

    const outcomes = await addApplicants('chat-1', ['a1'], 'admin-1', SCOPE);

    expect(outcomes).toEqual([{ applicationId: 'a1', outcome: 'MOVED', signupId: 'su-old', from: null }]);
    expect(comms.queueNotificationsBulk.mock.calls[0][0]).toEqual([
      expect.objectContaining({ recipient: 'a1@ucla.edu', type: 'MOVED_BY_ADMIN' }),
    ]);
  });
});

describe('addApplicants when one placement fails unexpectedly', () => {
  it('reports only that applicant, and still emails the ones placed', async () => {
    prisma.application.findMany.mockResolvedValue([
      { id: 'a1', cycleId: 'c1', currentRound: '2', status: 'UNDER_REVIEW' },
      { id: 'a2', cycleId: 'c1', currentRound: '2', status: 'UNDER_REVIEW' },
    ]);
    signups.placeCandidate.mockImplementation(async ({ applicationId }) => {
      if (applicationId === 'a2') throw new Error('connection reset');
      return { placed: { id: 'su-a1' } };
    });
    prisma.interviewSlotSignup.findMany.mockResolvedValue([
      { id: 'su-a1', slotId: 'slot-v', application: { email: 'a1@ucla.edu' }, slot: { interview: { title: 'Virtual Coffee Chat' } } },
    ]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcomes = await addApplicants('chat-1', ['a1', 'a2'], 'admin-1', SCOPE);

    expect(outcomes).toEqual([
      { applicationId: 'a1', outcome: 'PLACED', signupId: 'su-a1' },
      { applicationId: 'a2', outcome: 'SKIPPED', reason: 'Could not be added; try again' },
    ]);
    expect(comms.queueNotificationsBulk.mock.calls[0][0]).toEqual([
      expect.objectContaining({ recipient: 'a1@ucla.edu', type: 'CONFIRMATION' }),
    ]);
    spy.mockRestore();
  });
});

describe('cycle scoping', () => {
  it('will not touch a chat outside the admin cycle', async () => {
    prisma.interview.findFirst.mockResolvedValue(null);
    await expect(cancelVirtualCoffeeChat('old-chat', 'admin-1', { cycleId: 'c2' })).rejects.toMatchObject({ status: 404 });
    expect(prisma.interview.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'old-chat', cycleId: 'c2' });
  });

  it('refuses outright when there is no cycle, rather than matching any', async () => {
    await expect(updateVirtualCoffeeChat('chat-1', { title: 'x' }, { cycleId: null })).rejects.toMatchObject({ status: 409 });
    expect(prisma.interview.findFirst).not.toHaveBeenCalled();
  });
});

describe('addInterviewers and cancellation', () => {
  it('re-reads the status under a row lock and refuses once the chat is cancelled', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'm1' }]);
    prisma.$queryRaw.mockResolvedValue([{ status: 'CANCELLED' }]);
    await expect(addInterviewers('chat-1', ['m1'], SCOPE)).rejects.toMatchObject({ status: 409 });
    expect(prisma.interviewSlotAssignment.create).not.toHaveBeenCalled();
  });
});

describe('createVirtualCoffeeChat when filling it fails', () => {
  it('still returns the chat, with the failure reported per person', async () => {
    prisma.interview.create.mockResolvedValue({ id: 'chat-1' });
    prisma.user.findMany.mockRejectedValue(new Error('connection reset'));
    prisma.application.findMany.mockResolvedValue([]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await createVirtualCoffeeChat({
      cycleId: 'c1',
      actorId: 'admin-1',
      body: { day: '2026-10-09', start: '19:00', end: '19:30', interviewerIds: ['m1'], applicationIds: [] },
    });

    expect(result.interviewers).toEqual([
      { userId: 'm1', outcome: 'SKIPPED', reason: 'Could not be added; try again from the chat' },
    ]);
    spy.mockRestore();
  });
});
