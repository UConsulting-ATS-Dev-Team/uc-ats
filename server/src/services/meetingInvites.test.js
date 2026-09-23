import { describe, it, expect, beforeAll, vi } from 'vitest';
import prisma from '../prismaClient.js';
import { candidateMeetingInvite, hostMeetingInvite, bookedNames } from './meetingInvites.js';

vi.mock('../prismaClient.js', () => ({
  default: { meetingSignup: { findMany: vi.fn() } },
}));

beforeAll(() => {
  process.env.EMAIL_FROM = 'no-reply@uconsultingats.com';
});

const slot = {
  id: 'slot-1',
  location: 'Kerckhoff Coffee House',
  startTime: new Date('2026-10-01T18:00:00.000Z'),
  endTime: new Date('2026-10-01T18:30:00.000Z'),
};

const candidate = { candidateEmail: 'ada@ucla.edu', candidateName: 'Ada Lovelace', hostName: 'Grace Hopper' };
const host = { hostEmail: 'grace@ucla.edu', hostName: 'Grace Hopper' };

function prop(invite, name) {
  return (
    invite.content
      .replace(/\r\n /g, '')
      .split('\r\n')
      .find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`)) ?? null
  );
}

describe('candidateMeetingInvite', () => {
  it('books the slot time and place, naming the host', () => {
    const invite = candidateMeetingInvite({ slot, ...candidate });

    expect(invite.contentType).toContain('method=REQUEST');
    expect(invite.content).toContain('DTSTART:20261001T180000Z');
    expect(invite.content).toContain('DTEND:20261001T183000Z');
    expect(prop(invite, 'SUMMARY')).toBe('SUMMARY:Get to Know UC with Grace Hopper');
    expect(prop(invite, 'LOCATION')).toBe('LOCATION:Kerckhoff Coffee House');
    expect(prop(invite, 'ATTENDEE')).toContain('mailto:ada@ucla.edu');
  });

  it('cancels the same entry it booked, whatever case the address arrives in', () => {
    const booked = candidateMeetingInvite({ slot, ...candidate });
    const cancelled = candidateMeetingInvite({
      slot,
      ...candidate,
      candidateEmail: 'Ada@UCLA.edu',
      method: 'CANCEL',
    });

    expect(prop(cancelled, 'UID')).toBe(prop(booked, 'UID'));
    expect(cancelled.contentType).toContain('method=CANCEL');
    expect(prop(cancelled, 'STATUS')).toBe('STATUS:CANCELLED');
  });

  it('moves the entry on a reschedule instead of adding a second', () => {
    const moved = { ...slot, startTime: new Date('2026-10-02T18:00:00.000Z'), endTime: null };
    const before = candidateMeetingInvite({ slot, ...candidate });
    const after = candidateMeetingInvite({ slot: moved, ...candidate });

    expect(prop(after, 'UID')).toBe(prop(before, 'UID'));
    expect(after.content).toContain('DTSTART:20261002T180000Z');
    // No end time on the slot falls back to the default half hour.
    expect(after.content).toContain('DTEND:20261002T183000Z');
  });

  it('keeps two candidates in one slot on separate entries', () => {
    const a = candidateMeetingInvite({ slot, ...candidate });
    const b = candidateMeetingInvite({ slot, ...candidate, candidateEmail: 'alan@ucla.edu' });
    expect(prop(a, 'UID')).not.toBe(prop(b, 'UID'));
  });

  it('returns null rather than throwing when there is nothing to schedule', () => {
    expect(candidateMeetingInvite({ slot: { ...slot, startTime: null }, ...candidate })).toBeNull();
    expect(candidateMeetingInvite({ slot, ...candidate, candidateEmail: '' })).toBeNull();
    expect(candidateMeetingInvite({ slot: null, ...candidate })).toBeNull();
  });
});

describe('hostMeetingInvite', () => {
  it('holds one entry per slot and lists everyone booked', () => {
    const first = hostMeetingInvite({ slot, ...host, attendeeNames: ['Ada Lovelace'] });
    const second = hostMeetingInvite({ slot, ...host, attendeeNames: ['Ada Lovelace', 'Alan Turing'] });

    expect(prop(second, 'UID')).toBe(prop(first, 'UID'));
    expect(second.contentType).toContain('method=REQUEST');
    expect(prop(second, 'SUMMARY')).toBe('SUMMARY:Get to Know UC: Ada Lovelace\\, Alan Turing');
    expect(prop(second, 'ATTENDEE')).toContain('mailto:grace@ucla.edu');
  });

  it('keeps the entry when one of two candidates cancels', () => {
    const invite = hostMeetingInvite({ slot, ...host, attendeeNames: ['Alan Turing'] });
    expect(invite.contentType).toContain('method=REQUEST');
    expect(prop(invite, 'STATUS')).toBe('STATUS:CONFIRMED');
  });

  it('keeps an empty slot on the calendar as an open slot', () => {
    // The host set this time aside when they opened the slot. The last candidate
    // leaving frees it for someone else; it does not take it off their calendar.
    const invite = hostMeetingInvite({ slot, ...host, attendeeNames: [] });
    expect(invite.contentType).toContain('method=REQUEST');
    expect(prop(invite, 'STATUS')).toBe('STATUS:CONFIRMED');
    expect(prop(invite, 'SUMMARY')).toBe('SUMMARY:Get to Know UC (open slot)');
  });

  it('is the same entry from the moment the slot opens', () => {
    const opened = hostMeetingInvite({ slot, ...host, attendeeNames: [] });
    const booked = hostMeetingInvite({ slot, ...host, attendeeNames: ['Ada Lovelace'] });
    expect(prop(booked, 'UID')).toBe(prop(opened, 'UID'));
  });

  it('cancels when the slot itself is deleted, even with people still booked', () => {
    const invite = hostMeetingInvite({ slot, ...host, attendeeNames: ['Ada Lovelace'], method: 'CANCEL' });
    expect(invite.contentType).toContain('method=CANCEL');
  });

  it('never shares an entry with a candidate', () => {
    const hostInvite = hostMeetingInvite({ slot, ...host, attendeeNames: ['Ada Lovelace'] });
    const candidateInvite = candidateMeetingInvite({ slot, ...candidate, candidateEmail: host.hostEmail });
    expect(prop(hostInvite, 'UID')).not.toBe(prop(candidateInvite, 'UID'));
  });
});

describe('sequence', () => {
  it('increases for every invite, even inside one second', () => {
    // A second candidate booking the same slot a moment after the first updates the
    // host's entry; an equal SEQUENCE would let a calendar ignore the update.
    const seqs = Array.from({ length: 5 }, () =>
      Number(prop(hostMeetingInvite({ slot, ...host, attendeeNames: ['Ada Lovelace'] }), 'SEQUENCE').split(':')[1])
    );
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    // Still a 32-bit INTEGER, as RFC 5545 requires.
    expect(seqs.at(-1)).toBeLessThan(2 ** 31);
  });
});

describe('bookedNames', () => {
  it('reads the committed roster, leaving out a signup being cancelled', async () => {
    prisma.meetingSignup.findMany.mockResolvedValueOnce([{ fullName: 'Alan Turing' }]);

    expect(await bookedNames('slot-1', { excludingSignupId: 'signup-9' })).toEqual(['Alan Turing']);
    expect(prisma.meetingSignup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slotId: 'slot-1', id: { not: 'signup-9' } } })
    );
  });

  it('sends no host invite when the roster cannot be read, rather than a CANCEL', async () => {
    prisma.meetingSignup.findMany.mockRejectedValueOnce(new Error('connection reset'));

    const names = await bookedNames('slot-1');
    expect(names).toBeNull();
    expect(hostMeetingInvite({ slot, ...host, attendeeNames: names })).toBeNull();
  });
});
