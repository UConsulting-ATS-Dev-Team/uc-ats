import { describe, it, expect } from 'vitest';
import { isFormReady, resolveFormStatus } from './eventFormStatus.js';

describe('isFormReady', () => {
  it('needs both the RSVP and attendance form', () => {
    expect(isFormReady({ rsvpForm: 'https://forms.gle/a', attendanceForm: 'https://forms.gle/b' })).toBe(true);
    expect(isFormReady({ rsvpForm: 'https://forms.gle/a', attendanceForm: null })).toBe(false);
    expect(isFormReady({ rsvpForm: null, attendanceForm: 'https://forms.gle/b' })).toBe(false);
    expect(isFormReady({ rsvpForm: '   ', attendanceForm: 'https://forms.gle/b' })).toBe(false);
  });
});

describe('resolveFormStatus', () => {
  const links = { rsvpForm: 'https://forms.gle/a', attendanceForm: 'https://forms.gle/b' };

  it('moves a pending generated event to CONNECTED once both links exist', () => {
    expect(resolveFormStatus({ currentStatus: 'PENDING_FORM', ...links })).toBe('CONNECTED');
  });

  it('moves back to PENDING_FORM when a link is cleared', () => {
    expect(resolveFormStatus({ currentStatus: 'CONNECTED', ...links, attendanceForm: null })).toBe(
      'PENDING_FORM'
    );
    expect(resolveFormStatus({ currentStatus: 'CONNECTED', rsvpForm: '', attendanceForm: '' })).toBe(
      'PENDING_FORM'
    );
  });

  it('leaves the status alone when it already matches', () => {
    expect(resolveFormStatus({ currentStatus: 'CONNECTED', ...links })).toBeUndefined();
    expect(
      resolveFormStatus({ currentStatus: 'PENDING_FORM', rsvpForm: null, attendanceForm: null })
    ).toBeUndefined();
  });

  it('never labels a manual or legacy event', () => {
    expect(resolveFormStatus({ currentStatus: null, ...links })).toBeUndefined();
    expect(resolveFormStatus({ currentStatus: undefined, ...links })).toBeUndefined();
  });
});
