// Documents an admin uploads while adding an application by hand: the blind
// resume and the video.
//
// A form application's documents are Drive files, served by routes/files.js and
// authorized by "some application's URL column names this file". These work the
// same way, with the file in the private resumes bucket instead of Drive: no
// table of their own, and `Application.blindResumeUrl` / `videoUrl` naming the
// document is what makes it readable. A document nothing points at is served to
// nobody.
//
// The regular resume is not one of these. It is a ResumeUpload, so replacing it
// later keeps its version history (routes/resumeUploads.js).
//
// A document's id is `<uuid>.<extension>` (utils/applicationDocumentIds.js), and
// a fresh uuid per upload means a document's bytes never change: its size can be
// remembered for good.
//
// A video is far too large to pass through this server (/api goes through
// Vercel's proxy, and an upload held in memory would not fit on the instance), so
// the browser sends it straight to storage with a signed upload URL and reads it
// back in ranges, like a Drive video (services/byteRange.js).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import supabase, { isSupabaseAvailable } from '../supabaseClient.js';
import { putResume, removeResume, LOCAL_STORAGE_ROOT, RESUME_BUCKET } from './resumeStorage.js';
import {
  parseDocumentId,
  documentUrl,
  videoExtension,
  VIDEO_EXTENSIONS,
} from '../utils/applicationDocumentIds.js';

export { parseDocumentId, documentUrl, videoExtension, VIDEO_EXTENSIONS };

export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

const notConfigured = () => {
  const error = new Error('File storage is not configured. Please contact the recruitment team.');
  error.code = 'STORAGE_NOT_CONFIGURED';
  return error;
};

/** Store a PDF and answer with its new document id. */
export async function storePdfDocument(buffer) {
  const document = parseDocumentId(`${crypto.randomUUID()}.pdf`);
  await putResume(document.key, buffer, document.contentType);
  return document.id;
}

/**
 * Where the browser should send a video, and the id it will have once it is
 * there. Nothing is stored yet: the id only counts once an application names it.
 */
export async function createVideoUpload({ fileName, sizeBytes }) {
  const ext = videoExtension(fileName);
  if (!ext) {
    const error = new Error(`The video must be one of: ${VIDEO_EXTENSIONS.map((e) => `.${e}`).join(', ')}`);
    error.code = 'UNSUPPORTED_VIDEO';
    throw error;
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_VIDEO_BYTES) {
    const error = new Error(`The video must be smaller than ${Math.round(MAX_VIDEO_BYTES / (1024 * 1024))}MB`);
    error.code = 'VIDEO_TOO_LARGE';
    throw error;
  }
  // No local-disk fallback: the upload goes from the browser to storage, and
  // there is no storage for it to go to.
  if (!isSupabaseAvailable()) throw notConfigured();

  const document = parseDocumentId(`${crypto.randomUUID()}.${ext}`);
  const { data, error } = await supabase.storage.from(RESUME_BUCKET).createSignedUploadUrl(document.key);
  if (error) throw new Error(`Failed to prepare the video upload: ${error.message}`);
  return { documentId: document.id, uploadUrl: data.signedUrl, contentType: document.contentType };
}

const objectUrl = (key) =>
  `${process.env.SUPABASE_URL}/storage/v1/object/authenticated/${RESUME_BUCKET}/${key}`;

const storageHeaders = () => ({
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
});

const localPath = (key) => path.join(LOCAL_STORAGE_ROOT, key);

const sizes = new Map();
const MAX_REMEMBERED_SIZES = 500;

/**
 * A stored document's size in bytes, or null when there is no such document.
 * Remembered once found, because a document's bytes never change.
 */
export async function documentSize(id) {
  const document = parseDocumentId(id);
  if (!document) return null;
  if (sizes.has(id)) return sizes.get(id);

  let size = null;
  if (isSupabaseAvailable()) {
    // One byte, for the total in Content-Range.
    const response = await fetch(objectUrl(document.key), {
      headers: { ...storageHeaders(), Range: 'bytes=0-0' },
    });
    await response.body?.cancel();
    const total = /\/(\d+)$/.exec(response.headers.get('content-range') || '');
    if (response.ok && total) size = Number(total[1]);
  }
  if (size === null) {
    const stat = await fs.promises.stat(localPath(document.key)).catch(() => null);
    if (stat?.isFile()) size = stat.size;
  }

  if (size !== null) {
    if (sizes.size >= MAX_REMEMBERED_SIZES) sizes.delete(sizes.keys().next().value);
    sizes.set(id, size);
  }
  return size;
}

/**
 * A readable stream of the document, or of `range` ({ start, end }, inclusive)
 * within it. Null when it is not in storage.
 */
export async function openDocument(id, range) {
  const document = parseDocumentId(id);
  if (!document) return null;

  if (isSupabaseAvailable()) {
    const response = await fetch(objectUrl(document.key), {
      headers: {
        ...storageHeaders(),
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      },
    });
    if (response.ok && response.body) return Readable.fromWeb(response.body);
    await response.body?.cancel();
  }

  const absolute = localPath(document.key);
  if (!fs.existsSync(absolute)) return null;
  return fs.createReadStream(absolute, range ? { start: range.start, end: range.end } : {});
}

/** Best-effort removal, for an upload no application ended up naming. */
export async function removeDocument(id) {
  const document = parseDocumentId(id);
  if (!document) return;
  sizes.delete(id);
  await removeResume(document.key);
}
