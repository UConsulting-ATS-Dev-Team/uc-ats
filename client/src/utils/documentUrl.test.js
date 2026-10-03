import { describe, it, expect } from 'vitest';
import { signedDocumentTarget, toSameOriginDocumentUrl } from './documentUrl';

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

// A new tab sends no Authorization header, so our documents open through a link
// the server signs for one file.
describe('signedDocumentTarget', () => {
  it('signs our Drive documents, however the URL was stored', () => {
    const target = signedDocumentTarget('https://uconsultingats.com/api/files/1_ww9Vj/pdf');
    expect(target.linkEndpoint).toBe('/files/1_ww9Vj/link');
    expect(target.open('a.b+c')).toBe('/api/files/1_ww9Vj/pdf?access=a.b%2Bc');
  });

  it('keeps the kind of document, image or pdf', () => {
    expect(signedDocumentTarget('/api/files/abc/image').open('t')).toBe('/api/files/abc/image?access=t');
  });

  it('signs a replacement resume', () => {
    const target = signedDocumentTarget('/api/resume-uploads/up-1/file');
    expect(target.linkEndpoint).toBe('/resume-uploads/up-1/link');
    expect(target.open('t')).toBe('/api/resume-uploads/up-1/file?access=t');
  });

  it('signs a blind resume or video uploaded with a manual application', () => {
    const target = signedDocumentTarget('/api/application-documents/doc-1.mp4/file');
    expect(target.linkEndpoint).toBe('/application-documents/doc-1.mp4/link');
    expect(target.open('t')).toBe('/api/application-documents/doc-1.mp4/file?access=t');
  });

  it('leaves anything else to a plain link', () => {
    expect(signedDocumentTarget('https://drive.google.com/file/d/abc/view')).toBeNull();
    expect(signedDocumentTarget('/api/applications/abc')).toBeNull();
    expect(signedDocumentTarget(null)).toBeNull();
  });
});
