import { describe, it, expect } from 'vitest';
import { applicantFormLink } from './formUtils.js';

describe('applicantFormLink', () => {
  it('turns the editor link admins paste into the responder link', () => {
    expect(applicantFormLink('https://docs.google.com/forms/d/abc_12-3/edit')).toBe(
      'https://docs.google.com/forms/d/abc_12-3/viewform'
    );
  });

  it('normalizes a bare form link and one with a query string', () => {
    expect(applicantFormLink('https://docs.google.com/forms/d/abc123/')).toBe(
      'https://docs.google.com/forms/d/abc123/viewform'
    );
    expect(applicantFormLink('https://docs.google.com/forms/d/abc123/viewform?usp=sf_link')).toBe(
      'https://docs.google.com/forms/d/abc123/viewform'
    );
  });

  it('keeps a published link under /d/e/, where its id works', () => {
    expect(applicantFormLink('https://docs.google.com/forms/d/e/1FAIpQLSd-pub/viewform?usp=header')).toBe(
      'https://docs.google.com/forms/d/e/1FAIpQLSd-pub/viewform'
    );
  });

  it('returns null for anything that is not a Google Form', () => {
    expect(applicantFormLink(null)).toBeNull();
    expect(applicantFormLink('')).toBeNull();
    expect(applicantFormLink('https://example.com/apply')).toBeNull();
    expect(applicantFormLink('javascript:alert(1)')).toBeNull();
  });
});
