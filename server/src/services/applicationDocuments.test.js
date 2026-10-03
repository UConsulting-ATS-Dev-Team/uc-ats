import { describe, it, expect } from 'vitest';
import {
  createVideoUpload,
  documentUrl,
  parseDocumentId,
  videoExtension,
  MAX_VIDEO_BYTES,
} from './applicationDocuments.js';

const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

describe('parseDocumentId', () => {
  it('reads the content type from the extension', () => {
    expect(parseDocumentId(`${UUID}.pdf`)).toEqual({
      id: `${UUID}.pdf`,
      contentType: 'application/pdf',
      isVideo: false,
      key: `application-documents/${UUID}.pdf`,
    });
    expect(parseDocumentId(`${UUID}.mov`)).toMatchObject({ contentType: 'video/quicktime', isVideo: true });
  });

  it.each([
    ['a path', `../resumes/${UUID}.pdf`],
    ['an unknown extension', `${UUID}.exe`],
    ['no extension', UUID],
    ['an uppercase id', `${UUID.toUpperCase()}.pdf`],
    ['a non-string', 42],
    ['nothing', undefined],
  ])('refuses %s', (_, id) => {
    expect(parseDocumentId(id)).toBeNull();
  });
});

describe('documentUrl', () => {
  it('is the path the document is served at', () => {
    expect(documentUrl(`${UUID}.mp4`)).toBe(`/api/application-documents/${UUID}.mp4/file`);
  });
});

describe('videoExtension', () => {
  it('accepts the video types a browser can be handed, in any case', () => {
    expect(videoExtension('IMG_1234.MOV')).toBe('mov');
    expect(videoExtension('pitch.final.mp4')).toBe('mp4');
  });

  it('refuses anything else', () => {
    expect(videoExtension('resume.pdf')).toBeNull();
    expect(videoExtension('video')).toBeNull();
    expect(videoExtension(undefined)).toBeNull();
  });
});

describe('createVideoUpload', () => {
  it('refuses a file that is not a video before asking storage for anything', async () => {
    await expect(createVideoUpload({ fileName: 'notes.pdf', sizeBytes: 10 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_VIDEO',
    });
  });

  it.each([0, -1, NaN, MAX_VIDEO_BYTES + 1])('refuses a size of %s', async (sizeBytes) => {
    await expect(createVideoUpload({ fileName: 'a.mp4', sizeBytes })).rejects.toMatchObject({
      code: 'VIDEO_TOO_LARGE',
    });
  });
});
