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
const { resolveEmailTheme } = await import('./emailTheme.js');
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

  const later = new Date('2026-10-10T17:00:00Z');
  const slot = (id, extra = {}) => ({
    id,
    startTime: later,
    candidateCapacity: 10,
    signupOpensAt: null,
    signupClosesAt: null,
    interview: { status: 'UPCOMING' },
    ...extra,
  });

  it('keeps only sessions a candidate could book now, by the booking rule', async () => {
    const client = {
      interviewSlot: {
        findMany: vi.fn().mockResolvedValue([
          slot('open', { signupClosesAt: new Date('2026-10-05T00:00:00Z') }),
          slot('closed', { signupClosesAt: new Date('2026-10-01T00:00:00Z') }),
          slot('not-yet', { signupOpensAt: new Date('2026-10-04T00:00:00Z') }),
          slot('completed', { interview: { status: 'COMPLETED' } }),
          // Starts in 6 hours: inside the 12-hour self-booking cutoff.
          slot('too-soon', { startTime: new Date('2026-10-03T18:00:00Z') }),
        ]),
      },
    };
    const sessions = await openSignupSessions({ cycleId: 'cycle-1', round: '3', now }, client);
    expect(sessions.map((s) => s.id)).toEqual(['open']);
    expect(client.interviewSlot.findMany.mock.calls[0][0].where.interview.status).toEqual({
      notIn: ['CANCELLED', 'COMPLETED'],
    });
  });

  it('quotes the latest moment anyone can still book, cutoff included', () => {
    expect(signupDeadline([])).toBe('');
    expect(
      signupDeadline([
        slot('a', { signupClosesAt: new Date('2026-10-05T01:00:00Z') }),
        slot('b', { signupClosesAt: new Date('2026-10-07T01:00:00Z') }),
      ])
    ).toMatch(/October 6, 2026/); // 6 PM Pacific on the 6th
    // No closing time of its own: closes 12 hours before its 10 AM Pacific start.
    expect(signupDeadline([slot('c')])).toBe('Friday, October 9, 2026, 10:00 PM');
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
      status: { notIn: ['FAILED', 'BOUNCED', 'COMPLAINED'] },
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

// Enough of Postgres for the claim: a try-lock held for the length of the
// transaction, the unbooked re-check, and a communication log to find rows in.
function claimClient({ booked = [], rows = [] } = {}) {
  const held = new Set();
  const log = [...rows];
  const client = {
    log,
    communicationLog: {
      updateMany: vi.fn(async ({ where, data }) => {
        const hits = log.filter((row) => row.attemptKey === where.attemptKey && row.status === where.status);
        for (const row of hits) Object.assign(row, data);
        return { count: hits.length };
      }),
    },
    $transaction: vi.fn(async (fn) => {
      const mine = [];
      const tx = {
        $queryRaw: vi.fn(async (strings, key) => {
          if (held.has(key)) return [{ locked: false }];
          held.add(key);
          mine.push(key);
          return [{ locked: true }];
        }),
        application: {
          count: vi.fn(async ({ where }) => (booked.includes(where.id) ? 0 : 1)),
        },
        communicationLog: {
          findFirst: vi.fn(async ({ where }) =>
            log.find(
              (row) =>
                row.attemptKey.startsWith(where.attemptKey.startsWith) &&
                !where.status.notIn.includes(row.status) &&
                row.sentAt >= where.sentAt.gte
            ) ?? null
          ),
          create: vi.fn(async ({ data }) => {
            // Let another transaction run in between, as a real write would.
            await new Promise((resolve) => setTimeout(resolve, 1));
            log.push({ ...data, sentAt: new Date() });
            return data;
          }),
        },
      };
      try {
        return await fn(tx);
      } finally {
        for (const key of mine) held.delete(key);
      }
    }),
  };
  return client;
}

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
    }, claimClient());

    expect(result).toEqual({ sent: ['app-2'], skipped: [], failed: [{ id: 'app-1', email: 'pat@example.com', error: 'bounced' }] });
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

    const result = await sendSignupReminders(people, { signupUrl: 'https://ats.example/interview-signup', round: '2' }, claimClient());

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
    }, claimClient());
    expect(result).toEqual({ sent: [], skipped: [], failed: [{ id: 'app-1', email: 'pat@example.com', error: 'SES down' }] });
  });

  const pat = { id: 'app-1', firstName: 'Pat', lastName: 'Lee', email: 'pat@example.com' };
  const opts = { signupUrl: 'https://ats.example/interview-signup', round: '2', cycleId: 'cycle-1', triggeredById: 'admin-1' };

  it('claims each send with a SENDING row under the key sendEmail will overwrite', async () => {
    sendEmail.mockResolvedValue({ success: true });
    const client = claimClient();

    await sendSignupReminders([pat], opts, client);

    expect(client.log).toHaveLength(1);
    const [claim] = client.log;
    expect(claim).toMatchObject({ status: 'SENDING', category: 'SIGNUP_REMINDER', trigger: 'MANUAL', cycleId: 'cycle-1', recipient: 'pat@example.com' });
    expect(claim.attemptKey).toBe(`${sendEmail.mock.calls[0][4].attemptKey}|pat@example.com`);
  });

  it('skips someone reminded for this round within the cooldown', async () => {
    const client = claimClient({
      rows: [
        { attemptKey: 'signup-reminder:2:app-1:earlier|pat@example.com', status: 'SENT', sentAt: new Date(Date.now() - 20 * 60 * 1000) },
      ],
    });

    const result = await sendSignupReminders([pat], opts, client);

    expect(result).toEqual({ sent: [], skipped: ['app-1'], failed: [] });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends again once the cooldown has passed, or when the earlier one bounced', async () => {
    sendEmail.mockResolvedValue({ success: true });
    const client = claimClient({
      rows: [
        { attemptKey: 'signup-reminder:2:app-1:old|pat@example.com', status: 'SENT', sentAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
        { attemptKey: 'signup-reminder:2:app-1:recent|pat@example.com', status: 'BOUNCED', sentAt: new Date() },
        // Another round's reminder is not this round's.
        { attemptKey: 'signup-reminder:3:app-1:recent|pat@example.com', status: 'SENT', sentAt: new Date() },
      ],
    });

    const result = await sendSignupReminders([pat], opts, client);
    expect(result.sent).toEqual(['app-1']);
  });

  it('skips someone who booked after the list was read', async () => {
    const result = await sendSignupReminders([pat], opts, claimClient({ booked: ['app-1'] }));
    expect(result).toEqual({ sent: [], skipped: ['app-1'], failed: [] });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends once when two presses race for the same person', async () => {
    sendEmail.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { success: true };
    });
    const client = claimClient();

    const [first, second] = await Promise.all([
      sendSignupReminders([pat], opts, client),
      sendSignupReminders([pat], opts, client),
    ]);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect([...first.sent, ...second.sent]).toEqual(['app-1']);
    expect([...first.skipped, ...second.skipped]).toEqual(['app-1']);
  });

  it('claims nothing when the email cannot be rendered, so a retry sends', async () => {
    resolveEmailTheme.mockRejectedValueOnce(new Error('theme store exploded'));
    sendEmail.mockResolvedValue({ success: true });
    const client = claimClient();

    const first = await sendSignupReminders([pat], opts, client);

    expect(first).toEqual({ sent: [], skipped: [], failed: [{ id: 'app-1', email: 'pat@example.com', error: 'theme store exploded' }] });
    expect(client.log).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();

    const retry = await sendSignupReminders([pat], opts, client);
    expect(retry.sent).toEqual(['app-1']);
  });

  it('marks the claim FAILED when the send throws after claiming, so a retry sends', async () => {
    sendEmail.mockRejectedValueOnce(new Error('connection reset')).mockResolvedValue({ success: true });
    const client = claimClient();

    const first = await sendSignupReminders([pat], opts, client);

    expect(first.failed).toEqual([{ id: 'app-1', email: 'pat@example.com', error: 'connection reset' }]);
    expect(client.log).toHaveLength(1);
    expect(client.log[0]).toMatchObject({ status: 'FAILED', error: 'connection reset' });

    const retry = await sendSignupReminders([pat], opts, client);
    expect(retry.sent).toEqual(['app-1']);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('still reports the failure when releasing the claim fails too', async () => {
    sendEmail.mockRejectedValueOnce(new Error('connection reset'));
    const client = claimClient();
    client.communicationLog.updateMany.mockRejectedValueOnce(new Error('db down'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sendSignupReminders([pat], opts, client);

    expect(result.failed).toEqual([{ id: 'app-1', email: 'pat@example.com', error: 'connection reset' }]);
    quiet.mockRestore();
  });

  it('counts a claim left SENDING as reminded: it may have gone out', async () => {
    const client = claimClient({
      rows: [{ attemptKey: 'signup-reminder:2:app-1:died|pat@example.com', status: 'SENDING', sentAt: new Date() }],
    });
    const result = await sendSignupReminders([pat], opts, client);
    expect(result.skipped).toEqual(['app-1']);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends once when a retry follows a finished send', async () => {
    sendEmail.mockResolvedValue({ success: true });
    const client = claimClient();

    await sendSignupReminders([pat], opts, client);
    const retry = await sendSignupReminders([pat], opts, client);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(retry).toEqual({ sent: [], skipped: ['app-1'], failed: [] });
  });
});
