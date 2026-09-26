import { describe, it, expect } from 'vitest';
import { buildMailtoUrl, draftSignupMessage } from './signupContact';

describe('draftSignupMessage', () => {
  const base = {
    hostName: 'Avery Chen',
    startTime: '2026-10-14T18:30:00.000Z',
    location: 'Ackerman Union',
  };

  it('greets everyone by first name and signs as the host', () => {
    const text = draftSignupMessage({
      ...base,
      contacts: [{ fullName: 'Jordan Rivera' }, { fullName: 'Sam Patel' }, { fullName: 'Lee Kim' }],
    });
    expect(text).toMatch(/^Hi Jordan, Sam and Lee! This is Avery from UC Consulting\./);
  });

  it('gives the time in Pacific, where the meetings happen', () => {
    const text = draftSignupMessage({ ...base, contacts: [{ fullName: 'Jordan Rivera' }] });
    expect(text).toContain('Wednesday, October 14 at 11:30 AM');
  });

  it('leaves the exact spot and how to find the host for them to fill in', () => {
    const text = draftSignupMessage({ ...base, contacts: [{ fullName: 'Jordan Rivera' }] });
    expect(text).toContain('Where to meet: Ackerman Union, [exact spot');
    expect(text).toContain('How to find me: [');
  });
});

describe('buildMailtoUrl', () => {
  it('addresses everyone once, with subject and body encoded', () => {
    expect(buildMailtoUrl(['a@ucla.edu', 'b+x@ucla.edu', 'a@ucla.edu'], 'Get to Know UC', 'Hi & see you\nsoon'))
      .toBe('mailto:a@ucla.edu,b%2Bx@ucla.edu?subject=Get%20to%20Know%20UC&body=Hi%20%26%20see%20you%0Asoon');
  });

  it('omits the query when there is nothing to prefill', () => {
    expect(buildMailtoUrl(['a@ucla.edu'])).toBe('mailto:a@ucla.edu');
  });
});
