// Profile images used to be written to the instance's disk, which Render wipes
// on every deploy: the row survived, the file did not, and the avatar 404'd.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import sharp from 'sharp';

const storage = {
  getBucket: vi.fn(),
  createBucket: vi.fn(),
  upload: vi.fn(),
  getPublicUrl: vi.fn(),
  remove: vi.fn(),
};
let available = true;

vi.mock('../supabaseClient.js', () => ({
  default: {
    storage: {
      getBucket: (...a) => storage.getBucket(...a),
      createBucket: (...a) => storage.createBucket(...a),
      from: () => ({
        upload: (...a) => storage.upload(...a),
        getPublicUrl: (...a) => storage.getPublicUrl(...a),
        remove: (...a) => storage.remove(...a),
      }),
    },
  },
  isSupabaseAvailable: () => available,
}));

const {
  normalizeProfileImage,
  storeProfileImage,
  removeProfileImage,
  bucketKeyFromUrl,
} = await import('./profileImageStorage.js');

const PUBLIC = 'https://proj.supabase.co/storage/v1/object/public/profile-images/';

const png = (width, height) =>
  sharp({ create: { width, height, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } })
    .png()
    .toBuffer();

beforeEach(() => {
  vi.clearAllMocks();
  available = true;
  storage.getBucket.mockResolvedValue({ data: { name: 'profile-images' } });
  storage.upload.mockResolvedValue({ error: null });
  storage.getPublicUrl.mockImplementation((key) => ({ data: { publicUrl: PUBLIC + key } }));
  storage.remove.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('normalizeProfileImage', () => {
  it('shrinks a large photo to fit 512px and re-encodes it as JPEG', async () => {
    const out = await normalizeProfileImage(await png(2000, 1000));
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(256);
  });

  it('does not enlarge a small image', async () => {
    const meta = await sharp(await normalizeProfileImage(await png(100, 80))).metadata();
    expect([meta.width, meta.height]).toEqual([100, 80]);
  });

  it('refuses bytes it cannot decode, such as an iPhone HEIC', async () => {
    await expect(normalizeProfileImage(Buffer.from('not an image'))).rejects.toMatchObject({
      code: 'IMAGE_UNREADABLE',
    });
  });
});

describe('storeProfileImage', () => {
  it('uploads to the public bucket under the user id and returns the public URL', async () => {
    const url = await storeProfileImage('user-1', await png(10, 10));

    const [key, body, opts] = storage.upload.mock.calls[0];
    expect(key).toMatch(/^user-1\/\d+-[0-9a-f]{12}\.jpg$/);
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(opts.contentType).toBe('image/jpeg');
    expect(url).toBe(PUBLIC + key);
  });

  it('creates the bucket as public when it does not exist yet', async () => {
    vi.resetModules();
    const fresh = await import('./profileImageStorage.js');
    storage.getBucket.mockResolvedValue({ data: null, error: { message: 'Bucket not found' } });
    storage.createBucket.mockResolvedValue({ error: null });

    await fresh.storeProfileImage('user-1', await png(10, 10));

    expect(storage.createBucket).toHaveBeenCalledWith('profile-images', { public: true });
  });

  it('refuses to fall back to the local disk in production', async () => {
    // The fallback there is the original bug: accepted, saved, gone at deploy.
    available = false;
    vi.stubEnv('NODE_ENV', 'production');

    await expect(storeProfileImage('user-1', await png(10, 10))).rejects.toMatchObject({
      code: 'STORAGE_NOT_CONFIGURED',
    });
  });

  it('surfaces a storage failure instead of returning a URL', async () => {
    storage.upload.mockResolvedValue({ error: { message: 'quota exceeded' } });
    await expect(storeProfileImage('user-1', await png(10, 10))).rejects.toThrow(/quota exceeded/);
  });
});

describe('removeProfileImage', () => {
  it('deletes an object this bucket holds', async () => {
    await removeProfileImage(`${PUBLIC}user-1/123-abc.jpg`);
    expect(storage.remove).toHaveBeenCalledWith(['user-1/123-abc.jpg']);
  });

  it('leaves local and external images alone', async () => {
    // Committed team-page photos live at local paths.
    await removeProfileImage('/api/uploads/profile-images/profile-1.png');
    await removeProfileImage('https://example.com/me.jpg');
    await removeProfileImage(null);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('does not throw when the delete fails', async () => {
    storage.remove.mockRejectedValue(new Error('network'));
    await expect(removeProfileImage(`${PUBLIC}user-1/a.jpg`)).resolves.toBeUndefined();
  });
});

describe('bucketKeyFromUrl', () => {
  it('returns null for anything outside the bucket', () => {
    expect(bucketKeyFromUrl('https://proj.supabase.co/storage/v1/object/public/resumes/x.pdf')).toBeNull();
  });
});
