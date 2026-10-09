// Where case book files (page images and the original PDF) live.
//
// They used to be written to server/storage/cases/ on the instance's own disk.
// On Render that disk is wiped by every deploy and is not shared between
// instances, so a page row in Postgres could point at an image that only one
// instance ever had, or that no instance has any more. The viewer then showed
// "Page unavailable" for some pages and not others, depending on which instance
// answered. The same bug, for resumes, is written up in resumeStorage.js.
//
// A private Supabase bucket instead. Nothing in it is fetched by URL; every
// read goes through GET /api/cases/:id/pages/:pageId/image, which checks who
// may see the case first.
//
// Keys keep the shape the disk paths always had ("cases/<caseId>/..."), so a
// row written before this change still resolves against a disk that has it.
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import supabase, { isSupabaseAvailable } from '../supabaseClient.js';
import { LOCAL_STORAGE_ROOT } from './resumeStorage.js';

export const CASE_BUCKET = 'cases';

const CASES_ROOT = path.join(LOCAL_STORAGE_ROOT, 'cases');

const isProduction = () => process.env.NODE_ENV === 'production';

let bucketReady = false;

const ensureBucket = async () => {
  if (bucketReady || !isSupabaseAvailable()) return;
  try {
    const { data } = await supabase.storage.getBucket(CASE_BUCKET);
    if (!data) {
      await supabase.storage.createBucket(CASE_BUCKET, { public: false });
    }
    bucketReady = true;
  } catch (error) {
    // Left unset so the next call retries; a bucket that cannot be created is
    // reported by the upload itself.
    console.warn('[caseStorage] ensureBucket:', error.message);
  }
};

// A key read back out of the database, resolved against the disk. Null when it
// would land outside the cases tree.
const localPath = (key) => {
  const absolute = path.resolve(LOCAL_STORAGE_ROOT, key);
  return absolute.startsWith(CASES_ROOT + path.sep) ? absolute : null;
};

/**
 * Where a newly uploaded page image goes. Unique per upload rather than per
 * page number: deleting a page renumbers the ones after it without renaming
 * their files, so a "page-4" key can already belong to what is now page 3.
 */
export const casePageKey = (caseId, extension) =>
  path.posix.join('cases', caseId, 'pages', `${randomUUID()}${extension}`);

export const casePdfKey = (caseId) => path.posix.join('cases', caseId, 'original.pdf');

/**
 * Store a case file. Refused in production without Supabase, because a local
 * write there is the original bug: accepted now, gone at the next deploy.
 */
export const putCaseFile = async (key, buffer, contentType) => {
  if (!isSupabaseAvailable()) {
    if (isProduction()) {
      console.error(
        '[caseStorage] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. ' +
          'Case uploads cannot be stored durably and are being refused.'
      );
      const error = new Error('File storage is not configured. Case pages cannot be saved.');
      error.code = 'STORAGE_NOT_CONFIGURED';
      throw error;
    }
    const absolute = localPath(key);
    if (!absolute) throw new Error(`Invalid case storage key: ${key}`);
    await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
    await fsPromises.writeFile(absolute, buffer);
    return;
  }

  await ensureBucket();
  const { error } = await supabase.storage
    .from(CASE_BUCKET)
    .upload(key, buffer, { contentType, upsert: true });
  if (error) throw new Error(`Failed to store case file: ${error.message}`);
};

/**
 * Read a case file back. Falls through to the local disk, which is where every
 * file written before this change is (if it survived). Null when neither has it.
 *
 * @returns {Promise<Buffer|null>}
 */
export const getCaseFile = async (key) => {
  if (isSupabaseAvailable()) {
    const { data, error } = await supabase.storage.from(CASE_BUCKET).download(key);
    if (!error && data) return Buffer.from(await data.arrayBuffer());
  }

  const absolute = localPath(key);
  if (!absolute || !fs.existsSync(absolute)) return null;
  return fsPromises.readFile(absolute);
};

/**
 * Delete case files. Best-effort: the caller is about to drop or repoint the
 * rows that named them, and a file that is already gone is not an error.
 */
export const removeCaseFiles = async (keys) => {
  const list = keys.filter(Boolean);
  if (list.length === 0) return;

  if (isSupabaseAvailable()) {
    try {
      await supabase.storage.from(CASE_BUCKET).remove(list);
    } catch (error) {
      console.warn('[caseStorage] remove:', error.message);
    }
  }

  await Promise.all(
    list.map((key) => {
      const absolute = localPath(key);
      return absolute ? fsPromises.rm(absolute, { force: true }).catch(() => {}) : null;
    })
  );
};
