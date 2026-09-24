import { describe, it, expect, afterEach } from 'vitest';
import {
  buildInvite,
  sequenceFrom,
  inviteUid,
  describeWhen,
  inviteOrganizerEmail,
  DEFAULT_DURATION_MINUTES,
} from './calendarInvite.js';

describe('inviteOrganizerEmail', () => {
  const saved = process.env.EMAIL_FROM;
  afterEach(() => {
    if (saved === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = saved;
  });

  it('is the sending address, quotes stripped as .env writes them', () => {
    process.env.EMAIL_FROM = "'no-reply@uconsultingats.com'";
    expect(inviteOrganizerEmail()).toBe('no-reply@uconsultingats.com');
  });
});

const base = {
  uid: 'slot-signup-abc@uconsultingats.com',
  start: new Date('2026-10-06T16:00:00.000Z'),
  end: new Date('2026-10-06T16:30:00.000Z'),
  summary: 'First Round Interview',
  organizerEmail: 'recruitment@uconsultingats.com',
  attendeeEmail: 'candidate@ucla.edu',
};

/** Unfold a rendered invite so assertions can look at logical properties. */
function unfold(ics) {
  return ics.replace(/\r\n /g, '');
}

function propertyOf(ics, name) {
  const line = unfold(ics)
    .split('\r\n')
    .find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
  return line ?? null;
}

describe('buildInvite', () => {
  it('renders a booking as PUBLISH with UTC timestamps and CRLF line endings', () => {
    const { content, contentType, filename } = buildInvite(base);

    expect(filename).toBe('invite.ics');
    expect(contentType).toBe('text/calendar; charset=utf-8; method=PUBLISH');
    expect(content).toContain('METHOD:PUBLISH');
    expect(content).toContain('DTSTART:20261006T160000Z');
    expect(content).toContain('DTEND:20261006T163000Z');
    expect(content).toContain('STATUS:CONFIRMED');
    expect(content.endsWith('\r\n')).toBe(true);
    // Every break is a CRLF - a bare LF makes Outlook reject the file.
    expect(content.split('\n').every((l, i, all) => i === all.length - 1 || l.endsWith('\r'))).toBe(true);
  });

  it('moves an existing entry rather than duplicating it: same UID, higher SEQUENCE', () => {
    const first = buildInvite({ ...base, sequence: 100 });
    const moved = buildInvite({
      ...base,
      sequence: 200,
      start: new Date('2026-10-06T18:00:00.000Z'),
      end: new Date('2026-10-06T18:30:00.000Z'),
    });

    expect(propertyOf(first.content, 'UID')).toBe(propertyOf(moved.content, 'UID'));
    expect(first.content).toContain('SEQUENCE:100');
    expect(moved.content).toContain('SEQUENCE:200');
    expect(moved.content).toContain('DTSTART:20261006T180000Z');
  });

  it('publishes a booking with nobody to reply as, so no RSVP is ever sent', () => {
    // A REQUEST names the recipient as an attendee and Gmail offers Yes / No, each of
    // which mails the organizer. The no-reply domain bounced those back to the
    // person; a real inbox would fill with "Accepted:". PUBLISH has no attendee.
    const { content } = buildInvite(base);
    expect(propertyOf(content, 'ATTENDEE')).toBeNull();
    expect(content).not.toContain('RSVP=TRUE');
    expect(content).not.toContain('METHOD:REQUEST');
  });

  it('marks a CANCEL as cancelled and asks for no reply', () => {
    const { content, contentType } = buildInvite({ ...base, method: 'CANCEL', sequence: 300 });

    expect(contentType).toBe('text/calendar; charset=utf-8; method=CANCEL');
    expect(content).toContain('METHOD:CANCEL');
    expect(content).toContain('STATUS:CANCELLED');
    expect(propertyOf(content, 'ATTENDEE')).toContain('RSVP=FALSE');
  });

  it('falls back to a default duration when the slot carries no end time', () => {
    // MeetingSlot.endTime is nullable, so this is a real shape, not a defensive case.
    const { content } = buildInvite({ ...base, end: null });
    expect(content).toContain(`DTSTART:20261006T160000Z`);
    expect(content).toContain('DTEND:20261006T163000Z');
    expect(DEFAULT_DURATION_MINUTES).toBe(30);
  });

  it('ignores an end that precedes its start rather than emitting a negative event', () => {
    const { content } = buildInvite({ ...base, end: new Date('2026-10-06T15:00:00.000Z') });
    expect(content).toContain('DTEND:20261006T163000Z');
  });

  it('escapes separators in text values, leaving colons alone for URL locations', () => {
    const { content } = buildInvite({
      ...base,
      summary: 'Round 1; Panel A, Room 2',
      location: 'https://zoom.us/j/123?pwd=x',
      description: 'Line one\nLine two',
    });
    const unfolded = unfold(content);

    expect(unfolded).toContain('SUMMARY:Round 1\\; Panel A\\, Room 2');
    expect(unfolded).toContain('DESCRIPTION:Line one\\nLine two');
    // A colon-escaped LOCATION breaks Outlook's parser.
    expect(unfolded).toContain('LOCATION:https://zoom.us/j/123?pwd=x');
  });

  it('escapes backslashes before the separators, not after', () => {
    const { content } = buildInvite({ ...base, location: 'C:\\rooms;2' });
    expect(unfold(content)).toContain('LOCATION:C:\\\\rooms\\;2');
  });

  it('folds long lines at 75 octets and unfolds back to the original value', () => {
    const summary = 'A'.repeat(200);
    const { content } = buildInvite({ ...base, summary });

    for (const line of content.split('\r\n')) {
      expect(Buffer.from(line, 'utf8').length).toBeLessThanOrEqual(75);
    }
    expect(unfold(content)).toContain(`SUMMARY:${summary}`);
  });

  it('never splits a multi-byte character across a fold', () => {
    const { content } = buildInvite({ ...base, summary: '→'.repeat(100) });

    for (const line of content.split('\r\n')) {
      expect(Buffer.from(line, 'utf8').length).toBeLessThanOrEqual(75);
      // A continuation that began mid-character would surface as U+FFFD here.
      expect(line).not.toContain('\uFFFD');
    }
    expect(unfold(content)).toContain(`SUMMARY:${'→'.repeat(100)}`);
  });

  it('returns null instead of throwing when there is nothing to describe', () => {
    expect(buildInvite({ ...base, start: null })).toBeNull();
    expect(buildInvite({ ...base, uid: null })).toBeNull();
    expect(buildInvite({ ...base, attendeeEmail: null })).toBeNull();
    expect(buildInvite({ ...base, organizerEmail: null })).toBeNull();
    expect(buildInvite({ ...base, start: new Date('nonsense') })).toBeNull();
  });
});

describe('sequenceFrom', () => {
  it('increases with updatedAt so a later write always wins', () => {
    const earlier = sequenceFrom(new Date('2026-09-14T10:00:00.000Z'));
    const later = sequenceFrom(new Date('2026-09-14T10:00:05.000Z'));
    expect(later).toBeGreaterThan(earlier);
  });

  it('degrades to 0 on a missing or unparseable timestamp', () => {
    expect(sequenceFrom(null)).toBe(0);
    expect(sequenceFrom(undefined)).toBe(0);
    expect(sequenceFrom(new Date('nonsense'))).toBe(0);
  });
});

describe('inviteUid', () => {
  it('is stable for the same entity and distinct across kinds', () => {
    expect(inviteUid('slot-signup', 'abc')).toBe(inviteUid('slot-signup', 'abc'));
    expect(inviteUid('slot-signup', 'abc')).not.toBe(inviteUid('meeting-signup', 'abc'));
  });
});

describe('describeWhen', () => {
  it('renders a range in Los Angeles time', () => {
    // 16:00Z on 6 October is 09:00 PDT.
    const when = describeWhen(base.start, base.end);
    expect(when).toBe('Tuesday, October 6, 2026, 9:00 AM - 9:30 AM');
  });

  it('renders a lone start when there is no end', () => {
    expect(describeWhen(base.start, null)).toBe('Tuesday, October 6, 2026, 9:00 AM');
  });

  it('is empty when there is no start', () => {
    expect(describeWhen(null, null)).toBe('');
  });
});
