import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import {
  THUMBNAIL_SIZES,
  parseThumbnailSize,
  renderThumbnail,
  readStreamToBuffer,
  getHeadshotThumbnail,
  clearHeadshotThumbnailCache,
  renderSlotsForTest,
} from './headshotThumbnails.js';

// A portrait "phone photo": random pixels so the JPEG is realistically large.
const photo = async (width, height, { orientation } = {}) => {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 2654435761) >>> 24;
  let img = sharp(raw, { raw: { width, height, channels: 3 } });
  if (orientation) img = img.withMetadata({ orientation });
  return img.jpeg({ quality: 90 }).toBuffer();
};

beforeEach(() => clearHeadshotThumbnailCache());

describe('parseThumbnailSize', () => {
  it('reads the allowed sizes', () => {
    for (const size of THUMBNAIL_SIZES) expect(parseThumbnailSize(String(size))).toBe(size);
  });

  it('treats a missing size as the original', () => {
    expect(parseThumbnailSize(undefined)).toBeNull();
    expect(parseThumbnailSize('')).toBeNull();
  });

  it('refuses any other size, so a caller cannot fill the cache with sizes of their choosing', () => {
    for (const raw of ['255', '4000', 'abc', '-256', ['256', '640']]) {
      expect(parseThumbnailSize(raw)).toBe(false);
    }
  });
});

describe('renderThumbnail', () => {
  it('sizes the short edge, so a square crop of a portrait photo stays sharp', async () => {
    const out = await renderThumbnail(await photo(1200, 1600), 256);
    const meta = await sharp(out.body).metadata();
    expect(out.contentType).toBe('image/webp');
    expect(meta.format).toBe('webp');
    expect(Math.min(meta.width, meta.height)).toBe(256);
    expect(meta.height).toBeGreaterThan(meta.width);
  });

  it('is a small fraction of the original', async () => {
    const original = await photo(1200, 1600);
    const out = await renderThumbnail(original, 256);
    expect(out.body.length).toBeLessThan(original.length / 10);
  });

  it('applies EXIF rotation, since WebP carries no orientation flag', async () => {
    // Stored landscape with "rotate 90" set: a portrait photo from a phone.
    const out = await renderThumbnail(await photo(1600, 1200, { orientation: 6 }), 256);
    const meta = await sharp(out.body).metadata();
    expect(meta.height).toBeGreaterThan(meta.width);
  });

  it('never enlarges a small image', async () => {
    const out = await renderThumbnail(await photo(100, 120), 256);
    const meta = await sharp(out.body).metadata();
    expect(meta.width).toBe(100);
  });

  it('answers null for something that is not an image', async () => {
    expect(await renderThumbnail(Buffer.from('%PDF-1.4 not a photo'), 256)).toBeNull();
  });
});

describe('readStreamToBuffer', () => {
  it('reads the whole stream', async () => {
    const buf = await readStreamToBuffer(Readable.from([Buffer.from('ab'), Buffer.from('cd')]));
    expect(buf.toString()).toBe('abcd');
  });

  it('gives up past the limit instead of holding a huge file in memory', async () => {
    expect(await readStreamToBuffer(Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), 15)).toBeNull();
  });
});

describe('getHeadshotThumbnail', () => {
  it('downloads once and serves repeats from memory', async () => {
    const original = await photo(800, 1000);
    const download = vi.fn(async () => Readable.from([original]));

    const first = await getHeadshotThumbnail('file-1', 256, { download });
    const second = await getHeadshotThumbnail('file-1', 256, { download });

    expect(first.kind).toBe('thumbnail');
    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith('file-1');
    expect(second.body.equals(first.body)).toBe(true);
  });

  it('shares one download between requests that arrive together', async () => {
    const original = await photo(800, 1000);
    const download = vi.fn(async () => Readable.from([original]));

    await Promise.all([1, 2, 3].map(() => getHeadshotThumbnail('file-1', 256, { download })));
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('keeps each size separately', async () => {
    const original = await photo(800, 1000);
    const download = vi.fn(async () => Readable.from([original]));

    const small = await getHeadshotThumbnail('file-1', 256, { download });
    const large = await getHeadshotThumbnail('file-1', 640, { download });
    expect(download).toHaveBeenCalledTimes(2);
    expect(large.body.length).toBeGreaterThan(small.body.length);
  });

  it('hands back the original it downloaded when it cannot read it, and never downloads it again', async () => {
    const heic = Buffer.from('not an image');
    const download = vi.fn(async () => Readable.from([heic]));

    const first = await getHeadshotThumbnail('heic', 256, { download });
    expect(first.kind).toBe('original');
    expect(first.body.equals(heic)).toBe(true);
    // Later requests stream the original themselves; nothing is downloaded here.
    expect(await getHeadshotThumbnail('heic', 256, { download })).toBeNull();
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('runs at most the slot limit of renders at once, even as slots free up', async () => {
    const original = await photo(64, 80);
    const { max } = renderSlotsForTest();
    let active = 0;
    let peak = 0;
    const download = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return Readable.from([original]);
    });

    // Two waves: the second arrives while the first is releasing its slots.
    const first = Array.from({ length: max * 2 }, (_, i) => getHeadshotThumbnail(`a${i}`, 256, { download }));
    await new Promise((r) => setTimeout(r, 6));
    const second = Array.from({ length: max * 2 }, (_, i) => getHeadshotThumbnail(`b${i}`, 256, { download }));
    await Promise.all([...first, ...second]);

    expect(peak).toBeLessThanOrEqual(max);
    expect(download).toHaveBeenCalledTimes(max * 4);
    expect(renderSlotsForTest()).toMatchObject({ running: 0, waiting: 0 });
  });

  it('passes a Drive failure through and tries again next time', async () => {
    const original = await photo(400, 500);
    const download = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'FILE_NOT_FOUND' }))
      .mockResolvedValue(Readable.from([original]));

    await expect(getHeadshotThumbnail('file-1', 256, { download })).rejects.toThrow('gone');
    expect(await getHeadshotThumbnail('file-1', 256, { download })).not.toBeNull();
  });
});
