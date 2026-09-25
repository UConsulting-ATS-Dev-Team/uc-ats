// Member accountability points: what each type is worth, where the credit for
// it comes from, and whether a member has reached the target.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../prismaClient.js', () => ({ default: {} }));
vi.mock('./emailNotifications.js', () => ({ sendEmail: vi.fn() }));

const { sendEmail } = await import('./emailNotifications.js');
const {
  POINT_TYPES,
  EVENT_POINT_TYPES,
  loadPointConfig,
  updatePointConfig,
  loadCompletions,
  scoreMember,
  renderReminder,
  sendReminders,
} = await import('./accountabilityPoints.js');

const missingTable = () => Object.assign(new Error('missing'), { code: 'P2021' });

function fakeClient(overrides = {}) {
  const empty = () => vi.fn().mockResolvedValue([]);
  const client = {
    accountabilityPointValue: { findMany: empty(), upsert: vi.fn((args) => args) },
    accountabilitySetting: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn((args) => args) },
    meetingSlot: { findMany: empty() },
    memberEventAttendance: { findMany: empty() },
    resumeScore: { findMany: empty() },
    coverLetterScore: { findMany: empty() },
    videoScore: { findMany: empty() },
    interview: { findMany: empty() },
    interviewSlotAssignment: { findMany: empty() },
    interviewAssignment: { findMany: empty() },
    $transaction: vi.fn(async (ops) => ops),
  };
  for (const [model, methods] of Object.entries(overrides)) Object.assign(client[model], methods);
  return client;
}

const config = (targetPoints = 3) => ({
  targetPoints,
  types: POINT_TYPES.map((t) => ({ ...t, points: t.defaultPoints })),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the point types', () => {
  it('ship with the agreed values and a target of 3', async () => {
    const loaded = await loadPointConfig(fakeClient());
    expect(loaded.targetPoints).toBe(3);
    expect(Object.fromEntries(loaded.types.map((t) => [t.label, t.points]))).toEqual({
      GTKUC: 0.5,
      'Info Sesh': 0.5,
      "Women's Night": 0.5,
      'Case Workshop': 0.5,
      'Application Screen': 1,
      'Coffee Chats': 1,
      'First Round Interviews': 1,
      'Case Buddies': 0.5,
      'Final Round Interviews': 1,
    });
  });

  it('only lets an event carry the types that are credited by attending one', () => {
    expect(EVENT_POINT_TYPES).toEqual(['INFO_SESSION', 'WOMENS_NIGHT', 'CASE_WORKSHOP', 'CASE_BUDDIES']);
  });
});

describe('loadPointConfig', () => {
  it('uses a stored value over the default, per type', async () => {
    const client = fakeClient({
      accountabilityPointValue: { findMany: vi.fn().mockResolvedValue([{ type: 'GTKUC', points: '1.25' }]) },
      accountabilitySetting: { findUnique: vi.fn().mockResolvedValue({ targetPoints: '4' }) },
    });
    const loaded = await loadPointConfig(client);
    expect(loaded.targetPoints).toBe(4);
    expect(loaded.types.find((t) => t.key === 'GTKUC')).toMatchObject({ points: 1.25, defaultPoints: 0.5 });
    expect(loaded.types.find((t) => t.key === 'FINAL_ROUND').points).toBe(1);
  });

  it('falls back to the defaults when the migration has not been applied', async () => {
    const client = fakeClient({
      accountabilityPointValue: { findMany: vi.fn().mockRejectedValue(missingTable()) },
      accountabilitySetting: { findUnique: vi.fn().mockRejectedValue(missingTable()) },
    });
    const loaded = await loadPointConfig(client);
    expect(loaded.targetPoints).toBe(3);
    expect(loaded.types.every((t) => t.points === t.defaultPoints)).toBe(true);
  });
});

describe('updatePointConfig', () => {
  it('saves every value and the target in one transaction', async () => {
    const client = fakeClient();
    await updatePointConfig({ points: { GTKUC: '0.75', FINAL_ROUND: 2 }, targetPoints: '3.5' }, 'admin-1', client);
    expect(client.$transaction).toHaveBeenCalledTimes(1);
    expect(client.accountabilityPointValue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { type: 'GTKUC', points: 0.75, updatedById: 'admin-1' } })
    );
    expect(client.accountabilitySetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { targetPoints: 3.5, updatedById: 'admin-1' } })
    );
  });

  it.each([
    [{ points: { NOT_A_TYPE: 1 } }, /Unknown point type/],
    [{ points: { GTKUC: -1 } }, /zero or more/],
    [{ points: { GTKUC: 'abc' } }, /must be a number/],
    [{ points: { GTKUC: '' } }, /must be a number/],
    [{ points: { GTKUC: 0.125 } }, /two decimal places/],
    [{ points: { GTKUC: 100 } }, /at most 99.99/],
    [{ targetPoints: 0 }, /more than zero/],
  ])('refuses %j and writes nothing', async (input, message) => {
    const client = fakeClient();
    await expect(updatePointConfig(input, 'admin-1', client)).rejects.toMatchObject({
      code: 'INVALID_ACCOUNTABILITY_CONFIG',
      message: expect.stringMatching(message),
    });
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it('allows a type to be worth nothing', async () => {
    const client = fakeClient();
    await updatePointConfig({ points: { CASE_BUDDIES: 0 } }, null, client);
    expect(client.accountabilityPointValue.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('scoreMember', () => {
  it('counts each type once and reports what is left', () => {
    const standing = scoreMember(config(), new Set(['GTKUC', 'FIRST_ROUND']));
    expect(standing).toMatchObject({ points: 1.5, remainingPoints: 1.5, met: false, targetPoints: 3 });
    expect(standing.types.filter((t) => t.done).map((t) => t.key)).toEqual(['GTKUC', 'FIRST_ROUND']);
  });

  it('adds in hundredths, so nine 0.1s are 0.9 and not 0.8999999999999999', () => {
    const tenths = { ...config(), types: config().types.map((t) => ({ ...t, points: 0.1 })) };
    expect(scoreMember(tenths, new Set(POINT_TYPES.map((t) => t.key))).points).toBe(0.9);
  });

  it('meets the target exactly at the target', () => {
    const standing = scoreMember(config(), new Set(['GTKUC', 'INFO_SESSION', 'COFFEE_CHATS', 'FIRST_ROUND']));
    expect(standing).toMatchObject({ points: 3, met: true, remainingPoints: 0 });
  });

  it('treats a member with no record as having done nothing', () => {
    expect(scoreMember(config(), undefined)).toMatchObject({ points: 0, remainingPoints: 3, met: false });
  });
});

describe('loadCompletions', () => {
  const cycle = { id: 'cycle-1', startDate: new Date('2026-09-01'), endDate: new Date('2026-12-01') };
  const now = new Date('2026-10-15T12:00:00Z');

  it('credits each type from the record that already proves it', async () => {
    const client = fakeClient({
      meetingSlot: { findMany: vi.fn().mockResolvedValue([{ memberId: 'gtkuc-host' }]) },
      memberEventAttendance: {
        findMany: vi.fn().mockResolvedValue([{ memberId: 'attendee', event: { pointType: 'WOMENS_NIGHT' } }]),
      },
      videoScore: { findMany: vi.fn().mockResolvedValue([{ evaluatorId: 'grader' }]) },
      interview: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'cc', interviewType: 'COFFEE_CHAT', startDate: new Date('2026-10-01'), description: null },
          {
            id: 'final',
            interviewType: 'FINAL_ROUND',
            startDate: new Date('2026-10-10'),
            description: JSON.stringify({ memberGroups: [{ memberIds: ['finalist'] }] }),
          },
          { id: 'r1-later', interviewType: 'ROUND_ONE', startDate: new Date('2026-11-01'), description: null },
        ]),
      },
      interviewSlotAssignment: { findMany: vi.fn().mockResolvedValue([{ interviewId: 'cc', userId: 'chatter' }]) },
      interviewAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const ids = ['gtkuc-host', 'attendee', 'grader', 'chatter', 'finalist', 'idle'];
    const completions = await loadCompletions({ cycle, memberIds: ids, now }, client);

    expect(Object.fromEntries([...completions].map(([id, set]) => [id, [...set]]))).toEqual({
      'gtkuc-host': ['GTKUC'],
      attendee: ['WOMENS_NIGHT'],
      grader: ['APPLICATION_SCREEN'],
      chatter: ['COFFEE_CHATS'],
      finalist: ['FINAL_ROUND'],
      idle: [],
    });

    // Only slots that have started count, and legacy assignments only on started interviews.
    expect(client.interviewSlotAssignment.findMany.mock.calls[0][0].where.slot).toEqual({ startTime: { lte: now } });
    expect(client.interviewAssignment.findMany.mock.calls[0][0].where.interviewId.in).toEqual(['cc', 'final']);
    // GTKUC is bounded by the cycle's dates, scores by the cycle itself.
    expect(client.meetingSlot.findMany.mock.calls[0][0].where.startTime).toEqual({
      gte: cycle.startDate,
      lte: cycle.endDate,
    });
    expect(client.resumeScore.findMany.mock.calls[0][0].where.OR[0]).toEqual({ cycleId: 'cycle-1' });
  });

  it('credits a score saved without a cycle when the candidate applied in this one', async () => {
    const client = fakeClient();
    await loadCompletions({ cycle, memberIds: ['grader'], now }, client);
    expect(client.resumeScore.findMany.mock.calls[0][0].where.OR[1]).toEqual({
      cycleId: null,
      candidate: { applications: { some: { cycleId: 'cycle-1' } } },
    });
  });

  it('bounds GTKUC by when a dateless cycle was created, so older slots do not count', async () => {
    const client = fakeClient();
    const createdAt = new Date('2026-08-15');
    await loadCompletions({ cycle: { id: 'c', startDate: null, endDate: null, createdAt }, memberIds: ['m'], now }, client);
    expect(client.meetingSlot.findMany.mock.calls[0][0].where.startTime).toEqual({ gte: createdAt });
  });

  it('ignores credit for someone it was not asked about', async () => {
    const client = fakeClient({
      meetingSlot: { findMany: vi.fn().mockResolvedValue([{ memberId: 'stranger' }]) },
    });
    const completions = await loadCompletions({ cycle, memberIds: ['me'], now }, client);
    expect([...completions.keys()]).toEqual(['me']);
  });

  it('asks nothing when there is nobody to score', async () => {
    const client = fakeClient();
    expect((await loadCompletions({ cycle, memberIds: [] }, client)).size).toBe(0);
    expect(client.meetingSlot.findMany).not.toHaveBeenCalled();
  });
});

describe('reminders', () => {
  const member = {
    id: 'm1',
    email: 'pat@example.com',
    fullName: 'Pat <script>',
    ...scoreMember(config(), new Set(['GTKUC'])),
  };

  it('fills merge fields, escapes the name, and lists what is still open', () => {
    const { subject, html } = renderReminder(member, { cycleName: 'Fall 2026', dashboardUrl: 'https://ats.example/dashboard' });
    expect(subject).toBe('Accountability reminder: 0.5 of 3 points');
    expect(html).toContain('Hi Pat,');
    expect(html).not.toContain('<script>');
    expect(html).toContain('you need <strong>2.5</strong> more');
    expect(html).toContain('Sign up to interview at final rounds');
    expect(html).toContain('https://ats.example/dashboard');
    // Open items come before done ones.
    expect(html.indexOf('Info Sesh')).toBeLessThan(html.indexOf('GTKUC'));
  });

  it('uses the admin wording when given', () => {
    const { subject, html } = renderReminder(member, { subject: '{{remainingPoints}} to go', message: 'Hey **{{fullName}}**' });
    expect(subject).toBe('2.5 to go');
    expect(html).toContain('Hey <strong>Pat &lt;script&gt;</strong>');
  });

  it('sends one logged email per member and reports failures without stopping', async () => {
    sendEmail.mockResolvedValueOnce({ success: false, error: 'bounced' }).mockResolvedValueOnce({ success: true });
    const other = { ...member, id: 'm2', email: 'sam@example.com', fullName: 'Sam' };

    const result = await sendReminders([member, other], { cycle: { id: 'cycle-1', name: 'Fall' }, triggeredById: 'admin-1' });

    expect(result).toEqual({ sent: ['m2'], failed: [{ id: 'm1', email: 'pat@example.com', error: 'bounced' }] });
    expect(sendEmail).toHaveBeenCalledWith('sam@example.com', expect.any(String), expect.any(String), [], {
      category: 'ACCOUNTABILITY_REMINDER',
      trigger: 'MANUAL',
      recipientName: 'Sam',
      triggeredById: 'admin-1',
      cycleId: 'cycle-1',
    });
  });
});
