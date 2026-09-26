import { describe, it, expect } from 'vitest';
import { parseLumaUrl, lumaUrlChanged } from './lumaUrl.js';

describe('parseLumaUrl', () => {
  it('takes a Luma event link on either of Luma\'s hosts', () => {
    expect(parseLumaUrl('https://lu.ma/f96xsz0q')).toEqual({ url: 'https://lu.ma/f96xsz0q' });
    expect(parseLumaUrl('https://luma.com/f96xsz0q')).toEqual({ url: 'https://luma.com/f96xsz0q' });
    expect(parseLumaUrl('https://www.lu.ma/f96xsz0q').error).toBeUndefined();
  });

  it('does not care what the path looks like', () => {
    expect(parseLumaUrl('https://lu.ma/uconsulting/info-session?tk=abc').error).toBeUndefined();
  });

  it('trims, so a pasted link with stray whitespace still works', () => {
    expect(parseLumaUrl('  https://lu.ma/f96xsz0q  ')).toEqual({ url: 'https://lu.ma/f96xsz0q' });
  });

  it('reads an empty field as "this is not a Luma event"', () => {
    expect(parseLumaUrl('')).toEqual({ url: null });
    expect(parseLumaUrl('   ')).toEqual({ url: null });
    expect(parseLumaUrl(undefined)).toEqual({ url: null });
    expect(parseLumaUrl(null)).toEqual({ url: null });
  });

  it('refuses a bare slug, since the routine resolves a URL and not a name', () => {
    expect(parseLumaUrl('f96xsz0q').error).toMatch(/full URL/);
  });

  it('refuses a link somewhere other than Luma', () => {
    expect(parseLumaUrl('https://forms.gle/abc').error).toMatch(/not a Luma link/);
    // The host has to end at a Luma domain, not merely contain one.
    expect(parseLumaUrl('https://lu.ma.evil.example/f96xsz0q').error).toMatch(/not a Luma link/);
  });

  it('refuses a scheme that is not http(s)', () => {
    expect(parseLumaUrl('javascript:alert(1)//lu.ma').error).toBeDefined();
  });
});

describe('lumaUrlChanged', () => {
  it('is false for the same link and for two ways of saying "none"', () => {
    expect(lumaUrlChanged('https://lu.ma/a', 'https://lu.ma/a')).toBe(false);
    expect(lumaUrlChanged(null, null)).toBe(false);
    expect(lumaUrlChanged(undefined, null)).toBe(false);
  });

  it('is true for a different link, and for linking or unlinking', () => {
    expect(lumaUrlChanged('https://lu.ma/a', 'https://lu.ma/b')).toBe(true);
    expect(lumaUrlChanged(null, 'https://lu.ma/a')).toBe(true);
    expect(lumaUrlChanged('https://lu.ma/a', null)).toBe(true);
  });

  it('counts a cosmetic difference as a change, erring towards re-resolving', () => {
    expect(lumaUrlChanged('https://lu.ma/a', 'https://luma.com/a')).toBe(true);
  });
});
