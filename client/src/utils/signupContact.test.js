import { describe, it, expect } from 'vitest';
import { buildGmailComposeUrl, draftSignupMessage } from './signupContact';

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
    expect(text).toMatch(/^Hi Jordan, Sam and Lee! This is Avery from UConsulting\./);
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

describe('buildGmailComposeUrl', () => {
  const parse = (url) => new URL(url);

  it('opens a Gmail compose window addressed to everyone once', () => {
    const url = parse(buildGmailComposeUrl(['a@ucla.edu', 'b+x@ucla.edu', 'a@ucla.edu'], 'Get to Know UC', 'Hi & see you\nsoon'));
    expect(url.origin + url.pathname).toBe('https://mail.google.com/mail/');
    expect(url.searchParams.get('view')).toBe('cm');
    expect(url.searchParams.get('to')).toBe('a@ucla.edu,b+x@ucla.edu');
    expect(url.searchParams.get('su')).toBe('Get to Know UC');
    expect(url.searchParams.get('body')).toBe('Hi & see you\nsoon');
  });

  it('leaves out subject and body when there is nothing to prefill', () => {
    const url = parse(buildGmailComposeUrl(['a@ucla.edu']));
    expect(url.searchParams.has('su')).toBe(false);
    expect(url.searchParams.has('body')).toBe(false);
  });
});
