// Where profile images live.
//
// They used to be written to server/uploads/profile-images on the instance's
// own disk. Render's filesystem is ephemeral, so an image uploaded through the
// app was served until the next deploy and then 404'd, while the row still
// pointed at it. The only images that survived were the ones committed to git.
// Resumes had the same bug; see resumeStorage.js.
//
// Supabase Storage instead, in a public bucket: an avatar is shown to everyone
// who can see the member, and a plain URL is what every <img> in the app
// already renders. Object keys carry a random suffix, so a URL cannot be
// guessed from a user id.
//
// Local disk remains the fallback for development and previews without
// Supabase credentials, and is refused in production for the same reason as
// resumes: there it is not a degraded mode, it is the original bug.
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import supabase, { isSupabaseAvailable } from '../supabaseClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Served by the /api/uploads static mount in index.js.
export const LOCAL_UPLOAD_DIR = path.join(__dirname, '../../uploads/profile-images');
const LOCAL_URL_PREFIX = '/api/uploads/profile-images/';

export const BUCKET = 'profile-images';

// Avatars render at 120px at most. 512 leaves room for high-density screens
// and turns a 3MB phone photo into roughly 50KB.
const MAX_DIMENSION = 512;

let bucketReady = false;

const ensureBucket = async () => {
  if (bucketReady) return;
  const { data } = await supabase.storage.getBucket(BUCKET);
  if (!data) {
    const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
    // A concurrent first upload may have created it between the two calls.
    if (error && !/already exists/i.test(error.message)) {
      throw new Error(`Failed to create ${BUCKET} bucket: ${error.message}`);
    }
  } else if (!data.public) {
    // The URLs saved on user rows are public URLs, which a private bucket
    // answers with 400. Flip it rather than store images nobody can load.
    const { error } = await supabase.storage.updateBucket(BUCKET, { public: true });
    if (error) throw new Error(`Failed to make ${BUCKET} bucket public: ${error.message}`);
  }
  bucketReady = true;
};

const tagged = (message, code) => Object.assign(new Error(message), { code });

/**
 * Decode, apply EXIF rotation, shrink and re-encode as JPEG.
 *
 * An animated GIF keeps only its first frame, which is why the profile page
 * no longer offers GIF.
 *
 * Decoding is also the real format check: a file that sharp cannot read is
 * refused here rather than stored and shown broken. That includes iPhone HEIC,
 * which sharp's prebuilt binaries cannot decode.
 */
export const normalizeProfileImage = async (buffer) => {
  try {
    return await sharp(buffer)
      .rotate()
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
  } catch {
    throw tagged(
      "We couldn't read that image. Please upload a JPG, PNG or WebP. " +
        'iPhone HEIC photos need to be exported as JPG first.',
      'IMAGE_UNREADABLE'
    );
  }
};

/**
 * Store a user's new profile image and return the URL to save on the row.
 *
 * @param {string} userId
 * @param {Buffer} buffer the uploaded file, any format sharp can decode
 * @returns {Promise<string>}
 */
export const storeProfileImage = async (userId, buffer) => {
  const jpeg = await normalizeProfileImage(buffer);
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`;

  if (isSupabaseAvailable()) {
    await ensureBucket();
    const key = `${userId}/${name}`;
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(key, jpeg, { contentType: 'image/jpeg', cacheControl: '31536000' });
    if (error) throw new Error(`Failed to store profile image: ${error.message}`);
    return supabase.storage.from(BUCKET).getPublicUrl(key).data.publicUrl;
  }

  if (process.env.NODE_ENV === 'production') {
    console.error(
      '[profileImageStorage] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. ' +
        'Profile images cannot be stored durably and are being refused.'
    );
    throw tagged(
      'File storage is not configured. Please contact the recruitment team.',
      'STORAGE_NOT_CONFIGURED'
    );
  }

  await fsPromises.mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
  await fsPromises.writeFile(path.join(LOCAL_UPLOAD_DIR, `profile-${name}`), jpeg);
  return `${LOCAL_URL_PREFIX}profile-${name}`;
};

/**
 * The bucket key behind a URL this module returned, or null for any other URL
 * (a local path, a committed team photo, something external).
 */
export const bucketKeyFromUrl = (url) => {
  if (typeof url !== 'string') return null;
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const at = url.indexOf(marker);
  return at === -1 ? null : decodeURIComponent(url.slice(at + marker.length));
};

/**
 * Delete a replaced image. Best-effort: the new image is already saved, and a
 * leftover object costs a few kilobytes. Only objects in our bucket are
 * touched; local files are left alone because committed team photos live there.
 */
export const removeProfileImage = async (url) => {
  const key = bucketKeyFromUrl(url);
  if (!key || !isSupabaseAvailable()) return;
  try {
    const { error } = await supabase.storage.from(BUCKET).remove([key]);
    if (error) console.warn('[profileImageStorage] remove:', error.message);
  } catch (error) {
    console.warn('[profileImageStorage] remove:', error.message);
  }
};
