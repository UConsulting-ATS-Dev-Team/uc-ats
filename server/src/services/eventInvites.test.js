import { describe, it, expect, beforeAll } from 'vitest';
import { eventInviteFor, DEFAULT_EVENT_MINUTES } from './eventInvites.js';

beforeAll(() => {
  process.env.EMAIL_FROM = 'no-reply@uconsultingats.com';
});

const event = {
  id: 'event-1',
  eventName: 'Fall Info Session',
  eventStartDate: new Date('2026-10-01T01:00:00.000Z'),
  eventEndDate: new Date('2026-10-01T02:00:00.000Z'),
  eventLocation: 'Covel Commons',
};

const recipient = { recipientEmail: 'candidate@ucla.edu', recipientName: 'Ada Lovelace' };

function prop(invite, name) {
  return (
    invite.content
      .replace(/\r\n /g, '')
      .split('\r\n')
      .find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`)) ?? null
  );
}

describe('eventInviteFor', () => {
  it('builds a REQUEST for the event time and place', () => {
    const invite = eventInviteFor({ event, ...recipient });

    expect(invite.contentType).toContain('method=REQUEST');
    expect(invite.content).toContain('DTSTART:20261001T010000Z');
    expect(invite.content).toContain('DTEND:20261001T020000Z');
    expect(prop(invite, 'SUMMARY')).toBe('SUMMARY:Fall Info Session');
    expect(prop(invite, 'LOCATION')).toBe('LOCATION:Covel Commons');
  });

  it('amends the entry on a resend rather than adding a second', () => {
    // The admin resend button and a sync that sees a response twice both land here.
    const first = eventInviteFor({ event, ...recipient });
    const resent = eventInviteFor({ event, ...recipient });
    expect(prop(first, 'UID')).toBe(prop(resent, 'UID'));
  });

  it('gives two attendees at the same event separate entries', () => {
    const a = eventInviteFor({ event, recipientEmail: 'one@ucla.edu' });
    const b = eventInviteFor({ event, recipientEmail: 'two@ucla.edu' });
    expect(prop(a, 'UID')).not.toBe(prop(b, 'UID'));
  });

  it('matches a recipient address case-insensitively', () => {
    const lower = eventInviteFor({ event, recipientEmail: 'one@ucla.edu' });
    const upper = eventInviteFor({ event, recipientEmail: 'One@UCLA.edu' });
    expect(prop(lower, 'UID')).toBe(prop(upper, 'UID'));
  });

  it('invites only the one recipient', () => {
    const attendees = eventInviteFor({ event, ...recipient })
      .content.replace(/\r\n /g, '')
      .split('\r\n')
      .filter((l) => l.startsWith('ATTENDEE'));

    expect(attendees).toHaveLength(1);
    expect(attendees[0]).toContain('mailto:candidate@ucla.edu');
    expect(attendees[0]).toContain('CN=Ada Lovelace');
  });

  it('works for a member recipient, ready for the integrated member RSVP form', () => {
    // Nothing emails members about an event yet. When that lands it calls this with a
    // member's address and needs no change here, so pin that now.
    const invite = eventInviteFor({ event, recipientEmail: 'member@ucla.edu', recipientName: 'Grace Hopper' });

    expect(invite.contentType).toContain('method=REQUEST');
    expect(invite.content).toContain('DTSTART:20261001T010000Z');
    expect(invite.content).toContain('CN=Grace Hopper');
  });

  it('keeps a member and a candidate on one event on separate entries', () => {
    const candidate = eventInviteFor({ event, recipientEmail: 'candidate@ucla.edu' });
    const member = eventInviteFor({ event, recipientEmail: 'member@ucla.edu' });
    expect(prop(candidate, 'UID')).not.toBe(prop(member, 'UID'));
  });

  it('gives an event with no end date an hour', () => {
    const invite = eventInviteFor({ event: { ...event, eventEndDate: null }, ...recipient });
    expect(invite.content).toContain('DTEND:20261001T020000Z');
    expect(DEFAULT_EVENT_MINUTES).toBe(60);
  });

  it('ignores an end date that precedes its start', () => {
    const invite = eventInviteFor({
      event: { ...event, eventEndDate: new Date('2026-09-30T23:00:00.000Z') },
      ...recipient,
    });
    expect(invite.content).toContain('DTEND:20261001T020000Z');
  });

  it('carries no location when the event has none', () => {
    const invite = eventInviteFor({ event: { ...event, eventLocation: null }, ...recipient });
    expect(prop(invite, 'LOCATION')).toBeNull();
  });

  it('returns null rather than throwing when there is nothing to describe', () => {
    expect(eventInviteFor({ event: null, ...recipient })).toBeNull();
    expect(eventInviteFor({ event: { ...event, eventStartDate: null }, ...recipient })).toBeNull();
    expect(eventInviteFor({ event: { ...event, id: null }, ...recipient })).toBeNull();
    expect(eventInviteFor({ event, recipientEmail: null })).toBeNull();
    expect(eventInviteFor({ event: { ...event, eventStartDate: new Date('nonsense') }, ...recipient })).toBeNull();
  });

  it('returns null when no from-address is configured', () => {
    const saved = process.env.EMAIL_FROM;
    process.env.EMAIL_FROM = '';
    try {
      expect(eventInviteFor({ event, ...recipient })).toBeNull();
    } finally {
      process.env.EMAIL_FROM = saved;
    }
  });

  it('names the reply-to inbox as organizer, so RSVP replies do not bounce', () => {
    // Calendars send Yes/No replies to ORGANIZER. no-reply@uconsultingats.com has
    // no mail server, so naming it bounced every RSVP back to the person.
    const saved = process.env.EMAIL_REPLY_TO;
    process.env.EMAIL_REPLY_TO = 'uconsultingla@gmail.com';
    try {
      const organizer = eventInviteFor({ event, ...recipient })
        .content.replace(/\r\n /g, '')
        .split('\r\n')
        .find((l) => l.startsWith('ORGANIZER'));
      expect(organizer).toBe('ORGANIZER;CN=UConsulting:mailto:uconsultingla@gmail.com');
    } finally {
      if (saved === undefined) delete process.env.EMAIL_REPLY_TO;
      else process.env.EMAIL_REPLY_TO = saved;
    }
  });
});
