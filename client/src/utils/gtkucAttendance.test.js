import { describe, expect, it } from 'vitest';
import { attendanceReminders, attendanceState, canFinishAttendance, timeAgo } from './gtkucAttendance';

const NOW = new Date('2026-10-01T18:00:00Z');

const slot = (overrides = {}) => ({
  startTime: '2026-10-01T15:00:00Z',
  endTime: '2026-10-01T15:30:00Z',
  attendanceMarkedAt: null,
  signups: [{ attended: true }, { attended: false }],
  ...overrides
});

describe('attendanceState', () => {
  it('is outstanding once a slot ends with someone unchecked', () => {
    expect(attendanceState(slot(), NOW)).toBe('outstanding');
  });

  it('is done when marked done, even with a no-show left unchecked', () => {
    expect(attendanceState(slot({ attendanceMarkedAt: '2026-10-01T16:00:00Z' }), NOW)).toBe('done');
  });

  it('is done when everyone is checked', () => {
    expect(attendanceState(slot({ signups: [{ attended: true }] }), NOW)).toBe('done');
  });

  it('has no attendance before the slot ends or without signups', () => {
    expect(attendanceState(slot({ endTime: '2026-10-01T18:30:00Z' }), NOW)).toBe('none');
    expect(attendanceState(slot({ signups: [] }), NOW)).toBe('none');
  });

  it('treats a slot without an end time as an hour long', () => {
    expect(attendanceState(slot({ startTime: '2026-10-01T17:30:00Z', endTime: null }), NOW)).toBe('none');
    expect(attendanceState(slot({ startTime: '2026-10-01T16:30:00Z', endTime: null }), NOW)).toBe('outstanding');
  });
});

describe('canFinishAttendance', () => {
  it('allows it once the slot has started and has signups', () => {
    expect(canFinishAttendance(slot(), NOW)).toBe(true);
    expect(canFinishAttendance(slot({ startTime: '2026-10-02T15:00:00Z' }), NOW)).toBe(false);
    expect(canFinishAttendance(slot({ signups: [] }), NOW)).toBe(false);
  });
});

describe('attendanceReminders', () => {
  it('lists only sent attendance reminders, newest first', () => {
    const s = slot({
      communications: [
        { type: 'ATTENDANCE_REMINDER', status: 'SENT', sentAt: '2026-09-28T00:00:00Z' },
        { type: 'ATTENDANCE_REMINDER', status: 'FAILED', sentAt: '2026-09-30T00:00:00Z' },
        { type: 'REMINDER', status: 'SENT', sentAt: '2026-09-29T00:00:00Z' },
        { type: 'ATTENDANCE_REMINDER', status: 'SENT', sentAt: '2026-09-29T12:00:00Z' }
      ]
    });
    expect(attendanceReminders(s).map((c) => c.sentAt)).toEqual(['2026-09-29T12:00:00Z', '2026-09-28T00:00:00Z']);
  });
});

describe('timeAgo', () => {
  it('rounds down to the largest whole unit', () => {
    expect(timeAgo('2026-10-01T17:59:40Z', NOW)).toBe('just now');
    expect(timeAgo('2026-10-01T17:15:00Z', NOW)).toBe('45m ago');
    expect(timeAgo('2026-10-01T13:00:00Z', NOW)).toBe('5h ago');
    expect(timeAgo('2026-09-28T17:00:00Z', NOW)).toBe('3d ago');
  });
});
