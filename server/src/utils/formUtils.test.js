import { describe, it, expect } from 'vitest';
import { applicantFormLink, syncableFormId } from './formUtils.js';

describe('syncableFormId', () => {
  it('reads the id from an editor, responder or bare form link', () => {
    expect(syncableFormId('https://docs.google.com/forms/d/abc_12-3/edit')).toBe('abc_12-3');
    expect(syncableFormId('https://docs.google.com/forms/d/abc123/viewform?usp=sf_link')).toBe('abc123');
    expect(syncableFormId('  https://docs.google.com/forms/d/abc123/  ')).toBe('abc123');
  });

  it('refuses links the Forms API cannot read', () => {
    // A shortlink has no id, and a published id is not the one the API takes.
    expect(syncableFormId('https://forms.gle/AbC123xyz')).toBeNull();
    expect(syncableFormId('https://docs.google.com/forms/d/e/1FAIpQLSd-pub/viewform')).toBeNull();
  });

  it('refuses anything that is not a Google Form', () => {
    expect(syncableFormId(null)).toBeNull();
    expect(syncableFormId('')).toBeNull();
    expect(syncableFormId('not a url')).toBeNull();
    expect(syncableFormId('https://example.com/apply')).toBeNull();
    expect(syncableFormId('javascript:alert(1)')).toBeNull();
    expect(syncableFormId('https://docs.google.com/spreadsheets/d/abc/edit')).toBeNull();
  });

  it('refuses a Google-looking path on another host', () => {
    expect(syncableFormId('https://example.com/forms/d/abc/edit')).toBeNull();
    expect(syncableFormId('https://docs.google.com.evil.test/forms/d/abc/edit')).toBeNull();
    expect(syncableFormId('https://example.com/?next=docs.google.com/forms/d/abc')).toBeNull();
  });
});

describe('applicantFormLink', () => {
  it('turns the editor link admins paste into the responder link', () => {
    expect(applicantFormLink('https://docs.google.com/forms/d/abc_12-3/edit')).toBe(
      'https://docs.google.com/forms/d/abc_12-3/viewform'
    );
  });

  it('offers no link to a form whose responses would never sync', () => {
    expect(applicantFormLink('https://forms.gle/AbC123xyz')).toBeNull();
    expect(applicantFormLink('https://docs.google.com/forms/d/e/1FAIpQLSd-pub/viewform')).toBeNull();
    expect(applicantFormLink('https://example.com/forms/d/abc/edit')).toBeNull();
  });
});
