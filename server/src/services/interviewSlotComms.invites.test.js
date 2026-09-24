// Which scheduling notifications carry a calendar invite, and whether a later one
// moves the entry a person already has or adds a second.

import { describe, it, expect, beforeAll } from 'vitest';
import { inviteFor } from './interviewSlotComms.js';

beforeAll(() => {
  process.env.EMAIL_FROM = 'no-reply@uconsultingats.com';
});

const slot = {
  id: 'slot-1',
  interviewId: 'interview-1',
  label: 'Morning Block',
  startTime: new Date('2026-10-06T16:00:00.000Z'),
  endTime: new Date('2026-10-06T16:30:00.000Z'),
  location: 'Covel Commons',
  interview: { title: 'First Round Interview', location: 'UCLA', interviewType: 'ROUND_ONE' },
};

function notification(overrides = {}) {
  return {
    id: 'n-1',
    type: 'CONFIRMATION',
    recipient: 'candidate@ucla.edu',
    subject: "You're confirmed",
    queuedAt: new Date('2026-09-14T10:00:00.000Z'),
    slotId: slot.id,
    interviewId: 'interview-1',
    signupId: 'signup-1',
    slot,
    signup: { application: { firstName: 'Ada', lastName: 'Lovelace', email: 'candidate@ucla.edu' } },
    ...overrides,
  };
}

function lines(invite) {
  return invite.content.replace(/\r\n /g, '').split('\r\n');
}

function prop(invite, name) {
  return lines(invite).find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`)) ?? null;
}

describe('inviteFor - which types carry an invite', () => {
  it.each(['CONFIRMATION', 'WAITLIST_ADDED', 'PROMOTED', 'MOVED_BY_ADMIN', 'INTERVIEWER_ASSIGNED', 'INTERVIEWER_MOVED'])(
    '%s books a seat, so it sends a REQUEST',
    (type) => {
      const invite = inviteFor(notification({ type }));
      expect(invite.contentType).toContain('method=PUBLISH');
      expect(invite.content).toContain('STATUS:CONFIRMED');
    }
  );

  it.each(['CANCELLATION', 'FALLBACK_RELEASED', 'INTERVIEWER_REMOVED'])(
    '%s gives a seat up, so it sends a CANCEL',
    (type) => {
      const invite = inviteFor(notification({ type }));
      expect(invite.contentType).toContain('method=CANCEL');
      expect(invite.content).toContain('STATUS:CANCELLED');
    }
  );

  it('sends a CANCEL that still names the time, though the email body hides it', () => {
    // renderInterviewSlotEmail strips the details card for these two types; the .ics
    // reads notification.slot directly, so it can still cancel the right event.
    const invite = inviteFor(notification({ type: 'CANCELLATION' }));
    expect(invite.content).toContain('DTSTART:20261006T160000Z');
  });

  it.each(['ADMIN_OVERFLOW_ALERT', 'AVAILABILITY_REQUEST'])(
    '%s has no time to send, so it carries no invite',
    (type) => {
      expect(inviteFor(notification({ type }))).toBeNull();
    }
  );

  it('carries no invite when the notification is about an interview with no session', () => {
    // slotId is nullable by design - AVAILABILITY_REQUEST is sent before slots exist.
    expect(inviteFor(notification({ slot: null, slotId: null }))).toBeNull();
  });
});

describe('inviteFor - identity that decides move vs duplicate', () => {
  it('keys a candidate on the signup, so a move follows the seat', () => {
    // A move updates slotId on the same signup row, so the UID must not mention the slot.
    const booked = inviteFor(notification());
    const moved = inviteFor(
      notification({
        type: 'MOVED_BY_ADMIN',
        queuedAt: new Date('2026-09-14T11:00:00.000Z'),
        slot: { ...slot, id: 'slot-2', startTime: new Date('2026-10-06T18:00:00.000Z'), endTime: new Date('2026-10-06T18:30:00.000Z') },
      })
    );

    expect(prop(booked, 'UID')).toBe(prop(moved, 'UID'));
    expect(moved.content).toContain('DTSTART:20261006T180000Z');
  });

  it('keys an interviewer on the interview and their address', () => {
    const assigned = inviteFor(
      notification({ type: 'INTERVIEWER_ASSIGNED', signupId: null, signup: null, recipient: 'member@ucla.edu' })
    );
    expect(prop(assigned, 'UID')).toBe('UID:interviewer-interview-1-member@ucla.edu@uconsultingats.com');
  });

  it('moves an interviewer in place, since a move cannot cross interviews', () => {
    const base = { type: 'INTERVIEWER_ASSIGNED', signupId: null, signup: null, recipient: 'member@ucla.edu' };
    const assigned = inviteFor(notification(base));
    const moved = inviteFor(
      notification({
        ...base,
        type: 'INTERVIEWER_MOVED',
        queuedAt: new Date('2026-09-14T11:00:00.000Z'),
        slot: { ...slot, id: 'slot-2', startTime: new Date('2026-10-06T18:00:00.000Z') },
      })
    );

    expect(prop(assigned, 'UID')).toBe(prop(moved, 'UID'));
    expect(moved.content).toContain('DTSTART:20261006T180000Z');
  });

  it('matches an interviewer address case-insensitively', () => {
    const lower = inviteFor(notification({ signupId: null, signup: null, recipient: 'member@ucla.edu', type: 'INTERVIEWER_ASSIGNED' }));
    const upper = inviteFor(notification({ signupId: null, signup: null, recipient: 'Member@UCLA.edu', type: 'INTERVIEWER_ASSIGNED' }));
    expect(prop(lower, 'UID')).toBe(prop(upper, 'UID'));
  });

  it('takes SEQUENCE from queuedAt, which rises per notification', () => {
    const first = inviteFor(notification());
    const second = inviteFor(notification({ queuedAt: new Date('2026-09-14T11:00:00.000Z') }));

    const seq = (i) => Number(prop(i, 'SEQUENCE').split(':')[1]);
    expect(seq(second)).toBeGreaterThan(seq(first));
  });
});

describe('inviteFor - staffing a session leaves the candidates alone', () => {
  // Assigning an interviewer must not disturb any candidate's calendar entry. The
  // routes already guarantee it - notifyInterviewer queues one notification, to the
  // interviewer, with no signupId, and the assign/remove/claim paths touch no signup
  // rows - but an invite addressed to the wrong UID would undo that silently.
  const candidate = notification();
  const interviewer = notification({
    type: 'INTERVIEWER_ASSIGNED',
    recipient: 'member@ucla.edu',
    signupId: null,
    signup: null,
  });

  it('gives the interviewer a UID disjoint from the candidate on the same session', () => {
    expect(prop(inviteFor(interviewer), 'UID')).not.toBe(prop(inviteFor(candidate), 'UID'));
  });

  it('names nobody on a booking - no attendee to RSVP as, and no one else exposed', () => {
    expect(lines(inviteFor(interviewer)).filter((l) => l.startsWith('ATTENDEE'))).toHaveLength(0);
    expect(lines(inviteFor(candidate)).filter((l) => l.startsWith('ATTENDEE'))).toHaveLength(0);
    expect(lines(inviteFor(candidate)).join('\n')).not.toContain('member@ucla.edu');
  });
});

describe('inviteFor - content', () => {
  it('prefers the slot location over the interview default', () => {
    expect(prop(inviteFor(notification()), 'LOCATION')).toBe('LOCATION:Covel Commons');
  });

  it('falls back to the interview location when the slot inherits it', () => {
    const invite = inviteFor(notification({ slot: { ...slot, location: null } }));
    expect(prop(invite, 'LOCATION')).toBe('LOCATION:UCLA');
  });

  it('titles the entry with the interview', () => {
    const invite = inviteFor(notification());
    expect(prop(invite, 'SUMMARY')).toBe('SUMMARY:First Round Interview');
  });
});

describe('inviteFor - who the interviewer is seeing', () => {
  // The whole point of the invite for an interviewer: they walk in knowing who is
  // in front of them. Before this, the entry carried the time and the room and
  // left the roster in the app.
  const roster = [
    { groupLabel: null, application: { firstName: 'Ada', lastName: 'Lovelace' } },
    { groupLabel: null, application: { firstName: 'Grace', lastName: 'Hopper' } },
  ];
  const interviewer = (overrides = {}) =>
    notification({
      type: 'INTERVIEWER_ASSIGNED',
      recipient: 'member@ucla.edu',
      signupId: null,
      signup: null,
      candidateRoster: roster,
      ...overrides,
    });

  it('names the candidates in the description', () => {
    // The separating comma arrives escaped, as RFC 5545 requires inside a text
    // value - a raw one would end the property and truncate the roster.
    expect(prop(inviteFor(interviewer()), 'DESCRIPTION')).toContain(
      'Candidates: Ada Lovelace\\, Grace Hopper'
    );
  });

  it('keeps the time and place it already carried', () => {
    const description = prop(inviteFor(interviewer()), 'DESCRIPTION');
    expect(description).toContain('Session: Morning Block');
    expect(description).toContain('Where: Covel Commons');
  });

  it('carries the roster on a move too, because the session changed and the people did not', () => {
    expect(prop(inviteFor(interviewer({ type: 'INTERVIEWER_MOVED' })), 'DESCRIPTION')).toContain('Ada Lovelace');
  });

  it('names nobody on the way out', () => {
    // A CANCEL exists to remove an entry. Listing the candidates on it tells
    // somebody who is no longer running the session who was going to be in it.
    const removed = prop(inviteFor(interviewer({ type: 'INTERVIEWER_REMOVED' })), 'DESCRIPTION');
    expect(removed).not.toContain('Ada Lovelace');
  });

  it('never names candidates on a candidate\'s own invite', () => {
    // The guard that matters: a candidate must not learn who else is in the round.
    // Belt and braces - loadCandidateRoster already refuses to populate this for a
    // candidate notification, and inviteFor refuses to read it if it somehow is.
    const candidateInvite = inviteFor(notification({ candidateRoster: roster }));
    expect(prop(candidateInvite, 'DESCRIPTION')).not.toContain('Grace Hopper');
  });

  it('omits the line for a session nobody has booked yet', () => {
    const empty = prop(inviteFor(interviewer({ candidateRoster: [] })), 'DESCRIPTION');
    expect(empty).not.toContain('Candidates:');
    expect(empty).toContain('Session: Morning Block');
  });

  it('still builds when no roster was loaded at all', () => {
    expect(inviteFor(interviewer({ candidateRoster: undefined }))).not.toBeNull();
  });
});

describe('inviteFor - never breaks a send', () => {
  it('returns null rather than throwing on a malformed notification', () => {
    expect(inviteFor({})).toBeNull();
    expect(inviteFor(notification({ slot: { ...slot, startTime: null } }))).toBeNull();
  });

  it('returns null when no from-address is configured', () => {
    const saved = process.env.EMAIL_FROM;
    process.env.EMAIL_FROM = '';
    try {
      expect(inviteFor(notification())).toBeNull();
    } finally {
      process.env.EMAIL_FROM = saved;
    }
  });
});
