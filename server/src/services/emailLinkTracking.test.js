// Links that are themselves credentials must never go through SES's click
// tracking redirect. Everything else should.
import { describe, it, expect } from 'vitest';

import { carriesCredential, markUntrackedLinks, sesTagValue } from './emailLinkTracking.js';

describe('carriesCredential', () => {
  it.each([
    'https://ats.test/reset-password?token=abc123',
    'https://ats.test/verify-email?token=abc',
    'https://ats.test/member-signup?invite=xyz',
    'https://ats.test/unsubscribe?t=signed.value',
    'https://api.ats.test/api/unsubscribe/one-click?t=signed',
    'https://ats.test/x?cycle=1&amp;token=abc',
  ])('keeps %s out of tracking', (href) => expect(carriesCredential(href)).toBe(true));

  it.each(['https://ats.test/interview-signup', 'https://ats.test/applications?tab=mine', 'mailto:recruiting@ats.test', ''])(
    'lets %s be tracked',
    (href) => expect(carriesCredential(href)).toBe(false)
  );
});

describe('markUntrackedLinks', () => {
  it('adds ses:no-track to credential links only', () => {
    const html =
      '<a href="https://ats.test/reset-password?token=abc" style="x">Reset</a> ' +
      '<a style="y" href="https://ats.test/interview-signup">Book</a> ' +
      "<a href='https://ats.test/unsubscribe?t=1'>Unsubscribe</a>";
    const out = markUntrackedLinks(html);
    expect(out).toContain('<a ses:no-track href="https://ats.test/reset-password?token=abc" style="x">');
    expect(out).toContain('<a style="y" href="https://ats.test/interview-signup">');
    expect(out).toContain("<a ses:no-track href='https://ats.test/unsubscribe?t=1'>");
  });

  it('leaves an anchor already marked alone', () => {
    const html = '<a ses:no-track href="https://ats.test/reset-password?token=abc">x</a>';
    expect(markUntrackedLinks(html)).toBe(html);
  });

  it('passes through anything without links', () => {
    expect(markUntrackedLinks('<p>hi</p>')).toBe('<p>hi</p>');
    expect(markUntrackedLinks(null)).toBeNull();
  });

  it('does not touch <abbr> or other tags starting with a', () => {
    const html = '<abbr title="x">ATS</abbr>';
    expect(markUntrackedLinks(html)).toBe(html);
  });
});

describe('sesTagValue', () => {
  it('keeps only characters SES accepts', () => {
    expect(sesTagValue('INTERVIEW_SLOT')).toBe('INTERVIEW_SLOT');
    expect(sesTagValue('a b/c')).toBe('a_b_c');
    expect(sesTagValue(undefined)).toBe('OTHER');
    expect(sesTagValue('x'.repeat(300))).toHaveLength(256);
  });
});
