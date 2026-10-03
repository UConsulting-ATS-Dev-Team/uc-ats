// Naming an application document (services/applicationDocuments.js): its id, the
// storage key the id stands for, and the URL an application stores. Pure, so the
// partner portal's projection can read a stored URL without loading storage.
//
// A document's id is `<uuid>.<extension>`. The extension is the content type, so
// nothing has to remember it.

import path from 'node:path';

const CONTENT_TYPES = Object.freeze({
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
});

export const VIDEO_EXTENSIONS = Object.freeze(['mp4', 'mov', 'm4v', 'webm']);

const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.([a-z0-9]+)$/;
const DOCUMENT_URL = /^(?:https?:\/\/[^/]+)?\/api\/application-documents\/([^/?#]+)\/file$/;

/**
 * What a document id says about itself, or null when it is not one of ours.
 * Every id reaching storage goes through here, so a path can never be built
 * from anything but a uuid and a known extension.
 */
export function parseDocumentId(id) {
  const match = typeof id === 'string' ? DOCUMENT_ID.exec(id) : null;
  const contentType = match ? CONTENT_TYPES[match[1]] : null;
  if (!contentType) return null;
  return {
    id,
    contentType,
    isVideo: VIDEO_EXTENSIONS.includes(match[1]),
    key: `application-documents/${id}`,
  };
}

/** The URL stored on the application, and the one the document is served at. */
export const documentUrl = (id) => `/api/application-documents/${id}/file`;

/** The document a stored URL names, as parseDocumentId describes it, or null. */
export function documentFromUrl(url) {
  const match = typeof url === 'string' ? DOCUMENT_URL.exec(url.trim()) : null;
  return match ? parseDocumentId(match[1]) : null;
}

/** `Interview.MOV` -> `mov`; null for anything that is not a video we accept. */
export function videoExtension(fileName) {
  const ext = path.extname(String(fileName || '')).slice(1).toLowerCase();
  return VIDEO_EXTENSIONS.includes(ext) ? ext : null;
}
