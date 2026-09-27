import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../prismaClient.js', () => ({ default: {} }));
vi.mock('../audiences/audiencePeople.js', () => ({ resolveAudience: vi.fn() }));

import { resolveAudience } from '../audiences/audiencePeople.js';
import { STALE_AFTER, findOccurrences, isDue, seedExisting } from './automaticEmailFinders.js';
import { describeTrigger, mergeFieldsFor, normalizeTrigger } from './automaticEmailRules.js';

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-10-14T18:00:00Z');
const hoursAgo = (h) => new Date(now.getTime() - h * HOUR);
const hoursAhead = (h) => new Date(now.getTime() + h * HOUR);

const client = {
  application: { findMany: vi.fn() },
  eventRsvp: { findMany: vi.fn() },
  meetingSignup: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  events: { findMany: vi.fn() },
  interviewSlot: { findMany: vi.fn() },
  recruitingCycle: { findMany: vi.fn() },
  savedAudience: { findUnique: vi.fn() },
  automaticEmailSend: { createMany: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(client)) for (const fn of Object.values(model)) fn.mockResolvedValue([]);
});

describe('trigger rules', () => {
  it('refuses a configuration it cannot act on', () => {
    expect(() => normalizeTrigger('APPLICATION_STATUS', { status: 'MAYBE' })).toThrow(/status/);
    expect(() => normalizeTrigger('EVENT_TIME', { offsetHours: 1.5 })).toThrow(/whole number/);
    expect(() => normalizeTrigger('EVENT_TIME', { offsetHours: 24 * 90 })).toThrow(/at most/);
    expect(() => normalizeTrigger('CYCLE_DATE', { field: 'applicationDeadline', offsetHours: -72 })).toThrow(/audience/);
    expect(() => normalizeTrigger('NOPE', {})).toThrow(/Unknown/);
  });

  it('offers only the merge fields a trigger can fill', () => {
    expect(mergeFieldsFor('EVENT_TIME')).toContain('eventName');
    expect(mergeFieldsFor('EVENT_TIME')).not.toContain('interviewTime');
    expect(mergeFieldsFor('RECORD_CREATED', { record: 'GTKUC_SIGNUP' })).toContain('memberName');
    expect(mergeFieldsFor('RECORD_CREATED', { record: 'ACCOUNT' })).toEqual(['firstName', 'lastName', 'fullName', 'email']);
  });

  it('describes a trigger in words', () => {
    expect(describeTrigger('EVENT_TIME', { offsetHours: -48 })).toBe('2 days before the start of an event they RSVPed to');
    expect(describeTrigger('INTERVIEW_TIME', { offsetHours: -1 })).toBe('1 hour before the start of their interview');
    expect(describeTrigger('APPLICATION_STATUS', { status: 'WAITLISTED' })).toBe('When an application becomes Waitlisted');
  });
});

describe('isDue', () => {
  const enabledAt = hoursAgo(100);

  it('fires once the moment has passed', () => {
    expect(isDue(hoursAgo(1), { now, enabledAt })).toBe(true);
    expect(isDue(hoursAhead(1), { now, enabledAt })).toBe(false);
  });

  it('never fires for a moment before the email was turned on', () => {
    expect(isDue(hoursAgo(2), { now, enabledAt: hoursAgo(1) })).toBe(false);
  });

  it('never works through a backlog older than two days', () => {
    expect(isDue(new Date(now.getTime() - STALE_AFTER - HOUR), { now, enabledAt })).toBe(false);
  });
});

describe('application status', () => {
  const rule = { id: 'r1', trigger: 'APPLICATION_STATUS', triggerConfig: { status: 'REJECTED' }, enabledAt: hoursAgo(1) };

  it('seeds everyone already in the status as skipped, keyed as the finder keys them', async () => {
    client.application.findMany.mockResolvedValue([{ id: 'a1', email: 'x@ucla.edu', firstName: 'X', lastName: 'Y', cycle: null }]);
    client.automaticEmailSend.createMany.mockResolvedValue({ count: 1 });

    await seedExisting(rule, { client });
    const [{ data, skipDuplicates }] = client.automaticEmailSend.createMany.mock.calls[0];
    const [occurrence] = await findOccurrences(rule, { client, now });

    expect(skipDuplicates).toBe(true);
    expect(data[0]).toMatchObject({ status: 'SKIPPED', subjectKey: occurrence.subjectKey });
  });

  it('keys by status, so pointing the rule at another status is a fresh start', async () => {
    client.application.findMany.mockResolvedValue([{ id: 'a1', email: 'x@ucla.edu', firstName: 'X', lastName: 'Y' }]);
    const [a] = await findOccurrences(rule, { client, now });
    const [b] = await findOccurrences({ ...rule, triggerConfig: { status: 'WAITLISTED' } }, { client, now });
    expect(a.subjectKey).not.toBe(b.subjectKey);
  });
});

describe('something created', () => {
  it('only counts what was created after the email was turned on', async () => {
    const rule = { id: 'r', trigger: 'RECORD_CREATED', triggerConfig: { record: 'ACCOUNT' }, enabledAt: hoursAgo(3) };
    await findOccurrences(rule, { client, now });

    expect(client.user.findMany.mock.calls[0][0].where).toMatchObject({
      createdAt: { gte: rule.enabledAt },
      isActive: true,
      role: { not: 'CLIENT' },
    });
  });

  it('fills the GTKUC host and time', async () => {
    client.meetingSignup.findMany.mockResolvedValue([
      { id: 's1', email: 'j@ucla.edu', fullName: 'Jo Doe', slot: { startTime: now, location: 'Kerckhoff', member: { fullName: 'Avery Chen' } } },
    ]);
    const [o] = await findOccurrences(
      { id: 'r', trigger: 'RECORD_CREATED', triggerConfig: { record: 'GTKUC_SIGNUP' }, enabledAt: hoursAgo(1) },
      { client, now }
    );
    expect(o.values).toMatchObject({ firstName: 'Jo', memberName: 'Avery Chen', meetingLocation: 'Kerckhoff' });
  });
});

describe('before an event', () => {
  const rule = { id: 'r', trigger: 'EVENT_TIME', triggerConfig: { offsetHours: -24 }, enabledAt: hoursAgo(200) };
  const event = (start) => ({
    id: 'e1',
    eventName: 'Info Session',
    eventStartDate: start,
    eventLocation: 'Ackerman',
    eventRsvp: [{ id: 'rsvp1', candidate: { email: 'c@ucla.edu', firstName: 'C', lastName: 'D' } }],
  });

  it('reminds everyone who RSVPed once the moment arrives', async () => {
    client.events.findMany.mockResolvedValue([event(hoursAhead(23))]);
    const out = await findOccurrences(rule, { client, now });
    expect(out).toHaveLength(1);
    expect(out[0].values.eventName).toBe('Info Session');
  });

  it('stays quiet before the moment', async () => {
    client.events.findMany.mockResolvedValue([event(hoursAhead(30))]);
    expect(await findOccurrences(rule, { client, now })).toHaveLength(0);
  });

  it('does not send a "before" reminder once the event has started', async () => {
    client.events.findMany.mockResolvedValue([event(hoursAgo(1))]);
    expect(await findOccurrences(rule, { client, now })).toHaveLength(0);
  });

  it('treats a rescheduled event as a new reminder', async () => {
    client.events.findMany.mockResolvedValue([event(hoursAhead(23))]);
    const [first] = await findOccurrences(rule, { client, now });
    client.events.findMany.mockResolvedValue([event(hoursAhead(20))]);
    const [second] = await findOccurrences(rule, { client, now });
    expect(first.subjectKey).not.toBe(second.subjectKey);
  });
});

describe('a cycle date, to a saved audience', () => {
  const rule = {
    id: 'r',
    trigger: 'CYCLE_DATE',
    triggerConfig: { field: 'applicationDeadline', offsetHours: -72, savedAudienceId: 'aud' },
    enabledAt: hoursAgo(200),
  };

  it('resolves the audience on the day, not when the email was written', async () => {
    client.recruitingCycle.findMany.mockResolvedValue([{ id: 'c1', name: 'Fall 2026', applicationDeadline: hoursAhead(71) }]);
    client.savedAudience.findUnique.mockResolvedValue({ filters: { version: 2 } });
    resolveAudience.mockResolvedValue({
      recipients: [{ email: 'Pat@G.UCLA.edu', firstName: 'Pat', lastName: 'Lee', fullName: 'Pat Lee' }],
    });

    const [o] = await findOccurrences(rule, { client, now });
    expect(resolveAudience).toHaveBeenCalledTimes(1);
    expect(o.values).toMatchObject({ firstName: 'Pat', cycleName: 'Fall 2026' });
    // Keyed on the identity, so the g.ucla.edu and ucla.edu spellings are one person.
    expect(o.subjectKey).toContain('pat@ucla.edu');
  });

  it('sends nothing if the audience was deleted', async () => {
    client.recruitingCycle.findMany.mockResolvedValue([{ id: 'c1', name: 'F', applicationDeadline: hoursAhead(71) }]);
    client.savedAudience.findUnique.mockResolvedValue(null);
    expect(await findOccurrences(rule, { client, now })).toEqual([]);
  });
});

it('finds nothing for an email that has never been turned on', async () => {
  const out = await findOccurrences({ id: 'r', trigger: 'RECORD_CREATED', triggerConfig: { record: 'ACCOUNT' }, enabledAt: null }, { client, now });
  expect(out).toEqual([]);
  expect(client.user.findMany).not.toHaveBeenCalled();
});
