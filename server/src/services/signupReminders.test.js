// Reminding a round's unbooked people to pick a time: who counts as unbooked,
// how "last reminded" is read back out of the communications log, and the email.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../prismaClient.js', () => ({ default: {} }));
vi.mock('./emailNotifications.js', () => ({ sendEmail: vi.fn() }));
vi.mock('./emailTheme.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveEmailTheme: vi.fn(async () => ({ ...actual.THEME_DEFAULTS })) };
});

const { sendEmail } = await import('./emailNotifications.js');
const {
  DEFAULT_SIGNUP_REMINDER_MESSAGE,
  SIGNUP_REMINDER_MERGE_FIELDS,
  findUnbookedApplications,
  lastRemindedAt,
  lastRemindedByRound,
  openSignupSessions,
  parseAttemptKey,
  renderSignupReminder,
  sendSignupReminders,
  signupDeadline,
} = await import('./signupReminders.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findUnbookedApplications', () => {
  it('asks for the round, without rejected people or anyone holding a live signup on a session of it', async () => {
    const client = { application: { findMany: vi.fn().mockResolvedValue([{ id: 'a1' }]) } };

    const result = await findUnbookedApplications({ cycleId: 'cycle-1', round: '2' }, client);

    expect(result).toEqual([{ id: 'a1' }]);
    const { where, orderBy } = client.application.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ cycleId: 'cycle-1', currentRound: '2', status: { notIn: ['REJECTED'] } });
    expect(where.slotSignups.none).toEqual({
      status: { in: ['CONFIRMED', 'WAITLISTED', 'NEEDS_PLACEMENT'] },
      slot: {
        interview: { cycleId: 'cycle-1', interviewType: { in: ['COFFEE_CHAT'] }, status: { notIn: ['CANCELLED'] } },
      },
    });
    expect(orderBy).toEqual([{ lastName: 'asc' }, { firstName: 'asc' }]);
  });
});

describe('openSignupSessions and signupDeadline', () => {
  const now = new Date('2026-10-03T12:00:00Z');

  it('keeps only sessions a candidate could book now', async () => {
    const client = {
      interviewSlot: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'open', candidateCapacity: 10, signupOpensAt: null, signupClosesAt: new Date('2026-10-05T00:00:00Z') },
          { id: 'closed', candidateCapacity: 10, signupOpensAt: null, signupClosesAt: new Date('2026-10-01T00:00:00Z') },
          { id: 'not-yet', candidateCapacity: 10, signupOpensAt: new Date('2026-10-04T00:00:00Z'), signupClosesAt: null },
        ]),
      },
    };
    const sessions = await openSignupSessions({ cycleId: 'cycle-1', round: '3', now }, client);
    expect(sessions.map((s) => s.id)).toEqual(['open']);
  });

  it('quotes the latest close, and nothing when any open session never closes', () => {
    expect(signupDeadline([])).toBe('');
    expect(
      signupDeadline([
        { signupClosesAt: new Date('2026-10-05T01:00:00Z') },
        { signupClosesAt: new Date('2026-10-07T01:00:00Z') },
      ])
    ).toMatch(/October 6, 2026/); // 6 PM Pacific on the 6th
    expect(signupDeadline([{ signupClosesAt: new Date('2026-10-07T01:00:00Z') }, { signupClosesAt: null }])).toBe('');
  });
});

describe('lastRemindedAt', () => {
  const rows = [
    { attemptKey: 'signup-reminder:2:app-1:send-a|pat@example.com', sentAt: new Date('2026-10-01T10:00:00Z') },
    { attemptKey: 'signup-reminder:2:app-1:send-b|pat@example.com', sentAt: new Date('2026-10-02T10:00:00Z') },
    { attemptKey: 'signup-reminder:3:app-1:send-c|pat@example.com', sentAt: new Date('2026-10-03T10:00:00Z') },
    { attemptKey: 'signup-reminder:2:app-2:send-a|sam@example.com', sentAt: new Date('2026-10-01T10:00:00Z') },
    { attemptKey: 'something-else:2:app-3:x|x@example.com', sentAt: new Date('2026-10-01T10:00:00Z') },
  ];
  const client = () => ({ communicationLog: { findMany: vi.fn().mockResolvedValue(rows) } });

  it('parses only its own keys', () => {
    expect(parseAttemptKey('signup-reminder:2:app-1:send-a|pat@example.com')).toEqual({ round: '2', applicationId: 'app-1' });
    expect(parseAttemptKey('signup-reminder:2:app-1')).toBeNull();
    expect(parseAttemptKey(null)).toBeNull();
  });

  it('takes the latest reminder per round, ignoring other rounds', async () => {
    const c = client();
    const result = await lastRemindedAt({ cycleId: 'cycle-1', round: '2' }, c);

    expect([...result.entries()]).toEqual([
      ['app-1', new Date('2026-10-02T10:00:00Z')],
      ['app-2', new Date('2026-10-01T10:00:00Z')],
    ]);
    expect(c.communicationLog.findMany.mock.calls[0][0].where).toEqual({
      category: 'SIGNUP_REMINDER',
      cycleId: 'cycle-1',
      status: { not: 'FAILED' },
      attemptKey: { startsWith: 'signup-reminder:' },
    });
  });

  it('answers every round from one query, narrowed to the ids asked for', async () => {
    const c = client();
    const byRound = await lastRemindedByRound({ cycleId: 'cycle-1', applicationIds: ['app-1'] }, c);

    expect(c.communicationLog.findMany).toHaveBeenCalledTimes(1);
    expect(byRound.get('2')).toEqual(new Map([['app-1', new Date('2026-10-02T10:00:00Z')]]));
    expect(byRound.get('3')).toEqual(new Map([['app-1', new Date('2026-10-03T10:00:00Z')]]));
  });
});

describe('renderSignupReminder', () => {
  const application = { id: 'app-1', firstName: 'Pat', lastName: '<O’Brien>', email: 'pat@example.com' };

  it('fills the merge fields and links to the signup page', async () => {
    const { subject, html } = await renderSignupReminder(application, {
      subject: '{{firstName}}, pick your {{round}} time by {{deadline}}',
      message: 'Hi **{{fullName}}**, book {{round}} by {{deadline}}.',
      roundLabel: 'Coffee Chats',
      deadline: 'Monday, October 5, 2026, 6:00 PM',
      signupUrl: 'https://ats.example/interview-signup',
    });

    expect(subject).toBe('Pat, pick your Coffee Chats time by Monday, October 5, 2026, 6:00 PM');
    expect(html).toContain('Hi <strong>Pat &lt;O’Brien&gt;</strong>');
    expect(html).toContain('book Coffee Chats by Monday, October 5, 2026, 6:00 PM.');
    expect(html).toContain('href="https://ats.example/interview-signup"');
    expect(html).toContain('Pick a time');
  });

  it('defaults read well with no deadline', async () => {
    expect(DEFAULT_SIGNUP_REMINDER_MESSAGE).not.toContain('{{deadline}}');
    expect(SIGNUP_REMINDER_MERGE_FIELDS).toEqual(['firstName', 'fullName', 'round', 'deadline']);

    const { subject, html } = await renderSignupReminder(application, {
      roundLabel: 'First Round Interviews',
      deadline: '',
      signupUrl: 'https://ats.example/interview-signup',
    });
    expect(subject).toBe('Pick your First Round Interviews time');
    expect(html).toContain('Hi Pat,');
    expect(html).not.toContain('{{');
  });
});

describe('sendSignupReminders', () => {
  it('sends one logged email each and reports a failure without stopping', async () => {
    sendEmail.mockResolvedValueOnce({ success: false, error: 'bounced' }).mockResolvedValueOnce({ success: true });
    const people = [
      { id: 'app-1', firstName: 'Pat', lastName: 'Lee', email: 'pat@example.com' },
      { id: 'app-2', firstName: 'Sam', lastName: 'Park', email: 'sam@example.com' },
    ];

    const result = await sendSignupReminders(people, {
      roundLabel: 'Coffee Chats',
      deadline: '',
      signupUrl: 'https://ats.example/interview-signup',
      cycleId: 'cycle-1',
      round: '2',
      triggeredById: 'admin-1',
    });

    expect(result).toEqual({ sent: ['app-2'], failed: [{ id: 'app-1', email: 'pat@example.com', error: 'bounced' }] });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const metas = sendEmail.mock.calls.map((call) => call[4]);
    expect(metas[1]).toEqual({
      category: 'SIGNUP_REMINDER',
      trigger: 'MANUAL',
      recipientName: 'Sam Park',
      triggeredById: 'admin-1',
      cycleId: 'cycle-1',
      attemptKey: expect.stringMatching(/^signup-reminder:2:app-2:[\w-]+$/),
    });
    // One send id for the whole batch, so the keys differ only by person.
    const sendIds = metas.map((m) => m.attemptKey.split(':')[3]);
    expect(sendIds[0]).toBe(sendIds[1]);
  });

  it('keeps five sends in flight at once, and one failing does not stop the rest', async () => {
    let inFlight = 0;
    let peak = 0;
    sendEmail.mockImplementation(async (to) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (to === 'p3@example.com') throw new Error('SES throttled');
      if (to === 'p7@example.com') return { success: false, error: 'bounced' };
      return { success: true };
    });
    const people = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, firstName: `P${i}`, email: `p${i}@example.com` }));

    const result = await sendSignupReminders(people, { signupUrl: 'https://ats.example/interview-signup', round: '2' });

    expect(peak).toBe(5);
    expect(sendEmail).toHaveBeenCalledTimes(12);
    expect(result.sent).toHaveLength(10);
    expect(result.failed).toEqual(
      expect.arrayContaining([
        { id: 'p3', email: 'p3@example.com', error: 'SES throttled' },
        { id: 'p7', email: 'p7@example.com', error: 'bounced' },
      ])
    );
    expect(result.failed).toHaveLength(2);
  });

  it('turns a thrown send into a failure', async () => {
    sendEmail.mockRejectedValueOnce(new Error('SES down'));
    const result = await sendSignupReminders([{ id: 'app-1', firstName: 'Pat', email: 'pat@example.com' }], {
      signupUrl: 'https://ats.example/interview-signup',
      round: '2',
    });
    expect(result).toEqual({ sent: [], failed: [{ id: 'app-1', email: 'pat@example.com', error: 'SES down' }] });
  });
});
