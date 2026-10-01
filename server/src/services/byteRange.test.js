import { describe, it, expect } from 'vitest';
import { MAX_RANGE_BYTES, parseByteRange } from './byteRange.js';

const MB = 1024 * 1024;

describe('parseByteRange', () => {
  it('answers no range when the request asks for none, or the size is unknown', () => {
    expect(parseByteRange(undefined, 100)).toBeNull();
    expect(parseByteRange('', 100)).toBeNull();
    expect(parseByteRange('bytes=0-', undefined)).toBeNull();
    expect(parseByteRange('bytes=0-', NaN)).toBeNull();
  });

  it('serves a closed range as asked', () => {
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
  });

  it('caps an open-ended range, so no one response is the whole of a large video', () => {
    // A <video> asks for "bytes=0-" and keeps asking from where each answer ends.
    expect(parseByteRange('bytes=0-', 500 * MB)).toEqual({ start: 0, end: MAX_RANGE_BYTES - 1 });
    expect(parseByteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
  });

  it('caps a closed range that is too large, and clamps one past the end', () => {
    expect(parseByteRange(`bytes=0-${400 * MB}`, 500 * MB)).toEqual({ start: 0, end: MAX_RANGE_BYTES - 1 });
    expect(parseByteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
  });

  it('serves a suffix range: the last N bytes', () => {
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-1000', 100)).toEqual({ start: 0, end: 99 });
  });

  it('refuses a range that starts past the end, or a zero-length suffix', () => {
    expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable');
  });

  it('ignores what it does not handle, and serves the whole file instead', () => {
    // RFC 9110 lets a server ignore Range; these fall back to a plain 200.
    expect(parseByteRange('bytes=0-1,5-9', 100)).toBeNull();
    expect(parseByteRange('items=0-1', 100)).toBeNull();
    expect(parseByteRange('bytes=9-1', 100)).toBeNull();
    expect(parseByteRange('bytes=abc', 100)).toBeNull();
  });
});
