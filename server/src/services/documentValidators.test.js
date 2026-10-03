import { describe, it, expect } from 'vitest';
import { documentValidators, etagMatches } from './documentValidators.js';

describe('documentValidators', () => {
  it("quotes Drive's md5Checksum as a strong ETag", () => {
    expect(documentValidators({ md5Checksum: 'ABCdef0123' }).etag).toBe('"ABCdef0123"');
  });

  it('turns modifiedTime into an HTTP date', () => {
    expect(documentValidators({ modifiedTime: '2026-09-20T18:04:11.123Z' }).lastModified)
      .toBe('Sun, 20 Sep 2026 18:04:11 GMT');
  });

  it('gives nothing for metadata without them', () => {
    expect(documentValidators(null)).toEqual({ etag: null, lastModified: null });
    expect(documentValidators({ md5Checksum: 'not hex"', modifiedTime: 'yesterday' }))
      .toEqual({ etag: null, lastModified: null });
  });
});

describe('etagMatches', () => {
  it('matches the same tag, weakly, in a list, or *', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"x", "abc"', '"abc"')).toBe(true);
    expect(etagMatches('*', '"abc"')).toBe(true);
  });

  it('does not match another tag, no header, or no ETag', () => {
    expect(etagMatches('"abd"', '"abc"')).toBe(false);
    expect(etagMatches(undefined, '"abc"')).toBe(false);
    expect(etagMatches('*', null)).toBe(false);
  });
});
