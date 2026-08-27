import { describe, it, expect } from 'vitest';
import { toSameOriginDocumentUrl } from './documentUrl';

describe('toSameOriginDocumentUrl', () => {
  it('strips the production origin from a stored document URL', () => {
    expect(
      toSameOriginDocumentUrl('https://uconsultingats.com/api/files/1nQ5mdh/pdf')
    ).toBe('/api/files/1nQ5mdh/pdf');
  });

  it('strips a www production origin', () => {
    expect(
      toSameOriginDocumentUrl('https://www.uconsultingats.com/api/files/abc/image')
    ).toBe('/api/files/abc/image');
  });

  it('strips a localhost API origin', () => {
    expect(
      toSameOriginDocumentUrl('http://localhost:3001/api/resume-uploads/xyz/file')
    ).toBe('/api/resume-uploads/xyz/file');
  });

  // The hostname list this replaced would have missed these entirely.
  it('strips an origin it has never seen before', () => {
    expect(
      toSameOriginDocumentUrl('https://uc-ats-pr-123.onrender.com/api/files/abc/pdf')
    ).toBe('/api/files/abc/pdf');
  });

  it('leaves an already-relative API path alone', () => {
    expect(toSameOriginDocumentUrl('/api/files/abc/pdf')).toBe('/api/files/abc/pdf');
  });

  it('preserves the query string and hash', () => {
    expect(
      toSameOriginDocumentUrl('https://uconsultingats.com/api/files/abc/pdf?v=2#page=3')
    ).toBe('/api/files/abc/pdf?v=2#page=3');
  });

  it('leaves a third-party URL absolute', () => {
    const drive = 'https://drive.google.com/file/d/1nQ5mdh/view';
    expect(toSameOriginDocumentUrl(drive)).toBe(drive);
  });

  it('does not treat a path that merely starts with "api" as ours', () => {
    const other = 'https://example.com/apiary/files/abc';
    expect(toSameOriginDocumentUrl(other)).toBe(other);
  });

  it('passes through empty and non-string values untouched', () => {
    expect(toSameOriginDocumentUrl('')).toBe('');
    expect(toSameOriginDocumentUrl(null)).toBe(null);
    expect(toSameOriginDocumentUrl(undefined)).toBe(undefined);
  });
});
