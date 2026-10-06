// Images placed inside emails: the logo and photo on a GM recap.
//
// An email client fetches an image from the open internet with no session, so
// these go in a public Supabase bucket, the profileImageStorage.js pattern.
// There is no local-disk fallback: a localhost URL inside a sent email is
// broken for every reader, so without Supabase the upload is refused.
import crypto from 'node:crypto';
import sharp from 'sharp';
import supabase, { isSupabaseAvailable } from '../supabaseClient.js';

export const BUCKET = 'email-images';

// Email bodies are about 600px wide; 1200 stays sharp on high-density screens
// and keeps a phone photo to a few hundred kilobytes.
const MAX_WIDTH = 1200;

let bucketReady = false;

const ensureBucket = async () => {
  if (bucketReady) return;
  const { data } = await supabase.storage.getBucket(BUCKET);
  if (!data) {
    const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
    if (error && !/already exists/i.test(error.message)) {
      throw new Error(`Failed to create ${BUCKET} bucket: ${error.message}`);
    }
  } else if (!data.public) {
    const { error } = await supabase.storage.updateBucket(BUCKET, { public: true });
    if (error) throw new Error(`Failed to make ${BUCKET} bucket public: ${error.message}`);
  }
  bucketReady = true;
};

const tagged = (message, code, status) => Object.assign(new Error(message), { code, status });

/**
 * Shrink and re-encode. A logo with transparency stays PNG so it sits on any
 * background; everything else becomes JPEG. Decoding is also the format check.
 */
export const normalizeEmailImage = async (buffer) => {
  try {
    const image = sharp(buffer).rotate();
    const { hasAlpha } = await image.metadata();
    const resized = image.resize({ width: MAX_WIDTH, withoutEnlargement: true });
    return hasAlpha
      ? { data: await resized.png({ compressionLevel: 9 }).toBuffer(), extension: 'png', contentType: 'image/png' }
      : {
          data: await resized.flatten({ background: '#ffffff' }).jpeg({ quality: 85, mozjpeg: true }).toBuffer(),
          extension: 'jpg',
          contentType: 'image/jpeg',
        };
  } catch {
    throw tagged(
      "We couldn't read that image. Please upload a JPG, PNG or WebP. " +
        'iPhone HEIC photos need to be exported as JPG first.',
      'IMAGE_UNREADABLE',
      400
    );
  }
};

/** Store an image for an email and return its public URL. */
export const storeEmailImage = async (buffer) => {
  if (!isSupabaseAvailable()) {
    throw tagged(
      'Image storage is not configured, so images cannot be uploaded.',
      'STORAGE_NOT_CONFIGURED',
      503
    );
  }
  const { data, extension, contentType } = await normalizeEmailImage(buffer);
  await ensureBucket();
  const key = `gm-recaps/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${extension}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(key, data, { contentType, cacheControl: '31536000' });
  if (error) throw new Error(`Failed to store image: ${error.message}`);
  return supabase.storage.from(BUCKET).getPublicUrl(key).data.publicUrl;
};
