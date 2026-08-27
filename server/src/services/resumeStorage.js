// Where uploaded resumes actually live.
//
// They used to be written to server/storage/ on the instance's own disk, which
// works locally and silently does not work on Render: the filesystem there is
// ephemeral, so every deploy replaced it. The database row survived in Postgres
// and the PDF did not, which is why a resume uploaded in production came back
// as 404 "No resume on file" - the row was found and the file was gone.
//
// Supabase Storage instead. Same account the app already uses for realtime and
// for offer letters, same credentials, and the object outlives the instance
// that wrote it.
//
// The local-disk path is kept as a fallback rather than deleted. Staging
// previews and local development can run without Supabase credentials, and a
// storage layer that throws on boot in those environments would be worse than
// one that writes to a disk nobody is relying on to persist.
//
// In production that fallback is refused outright. Writing to the local disk
// there is not a degraded mode, it is the original bug: the file is accepted,
// the row is written, and the PDF is gone at the next deploy with nothing to
// indicate it happened. Better to fail the upload and say why.
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import supabase, { isSupabaseAvailable } from '../supabaseClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The same root the local paths always used, so a `storagePath` written before
// this change still resolves when running against a disk.
export const LOCAL_STORAGE_ROOT = path.join(__dirname, '../../storage');

// One private bucket for every uploaded resume. Private is the whole point:
// nothing here may be fetched by URL, only streamed through a route that has
// already decided the caller is allowed to see it.
const BUCKET = 'resumes';

let bucketReady = false;

/**
 * Create the bucket on first use.
 *
 * Cached rather than checked per upload - it is a network round trip, and the
 * answer only changes once in the lifetime of the project.
 */
const ensureBucket = async () => {
  if (bucketReady || !isSupabaseAvailable()) return;
  try {
    const { data } = await supabase.storage.getBucket(BUCKET);
    if (!data) {
      await supabase.storage.createBucket(BUCKET, { public: false });
    }
    bucketReady = true;
  } catch (error) {
    // Left unset so the next call retries. A bucket that could not be created
    // is reported by the upload itself, where the caller can act on it.
    console.warn('[resumeStorage] ensureBucket:', error.message);
  }
};

/**
 * Store a resume.
 *
 * @param {string} key   relative path, e.g. "member-resumes/<id>/resume.pdf"
 * @param {Buffer} buffer
 * @param {string} contentType
 */
const isProduction = () => process.env.NODE_ENV === 'production';

export const putResume = async (key, buffer, contentType = 'application/pdf') => {
  if (!isSupabaseAvailable() && isProduction()) {
    // Loud on purpose. A silent local write here is indistinguishable from
    // success right up until the file is needed.
    console.error(
      '[resumeStorage] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. ' +
        'Uploads cannot be stored durably and are being refused.'
    );
    throw new Error('File storage is not configured. Please contact the recruitment team.');
  }

  if (isSupabaseAvailable()) {
    await ensureBucket();
    const { error } = await supabase.storage
      .from(BUCKET)
      // upsert so a re-upload to the same key replaces rather than 409s. Keys
      // are per-row ids, so this only ever overwrites a file's own revision.
      .upload(key, buffer, { contentType, upsert: true });
    if (error) throw new Error(`Failed to store resume: ${error.message}`);
    return;
  }

  const absolute = path.join(LOCAL_STORAGE_ROOT, key);
  await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
  await fsPromises.writeFile(absolute, buffer);
};

/**
 * Read a resume back.
 *
 * Falls through to the local disk when the object is not in Supabase, which is
 * what lets a file uploaded before this change still open on a host that kept
 * its disk. Returns null when neither has it, so callers can 404 honestly.
 *
 * @returns {Promise<Buffer|null>}
 */
export const getResume = async (key) => {
  if (isSupabaseAvailable()) {
    const { data, error } = await supabase.storage.from(BUCKET).download(key);
    if (!error && data) {
      return Buffer.from(await data.arrayBuffer());
    }
  }

  const absolute = path.join(LOCAL_STORAGE_ROOT, key);
  // Resolved before reading: `key` comes out of the database, and this is what
  // stops a malformed or tampered value reading its way out of the tree.
  if (!path.resolve(absolute).startsWith(path.resolve(LOCAL_STORAGE_ROOT))) return null;
  if (!fs.existsSync(absolute)) return null;
  return fsPromises.readFile(absolute);
};

/** True when the resume can actually be served. */
export const resumeExists = async (key) => (await getResume(key)) !== null;

/**
 * Delete a resume. Best-effort: a file that is already gone is not an error,
 * because the caller's next step is removing the row that pointed at it.
 */
export const removeResume = async (key) => {
  if (isSupabaseAvailable()) {
    try {
      await supabase.storage.from(BUCKET).remove([key]);
    } catch (error) {
      console.warn('[resumeStorage] remove:', error.message);
    }
  }

  const absolute = path.join(LOCAL_STORAGE_ROOT, key);
  await fsPromises.rm(absolute, { force: true }).catch(() => {});
};
