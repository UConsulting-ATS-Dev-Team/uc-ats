import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ImageCache from './imageCache';

describe('ImageCache', () => {
  beforeEach(() => {
    ImageCache.clearCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Map([['content-type', 'image/png']]),
          text: () => Promise.resolve(''),
          blob: () => Promise.resolve(new Blob(['image-data'], { type: 'image/png' })),
        })
      )
    );
    global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    global.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete global.URL.createObjectURL;
    delete global.URL.revokeObjectURL;
  });

  it('loads an image successfully', async () => {
    const result = await ImageCache.loadImage('/api/files/abc123/image', 'test-token');
    expect(result).toBe('blob:mock-url');
    expect(ImageCache.isImageCached('/api/files/abc123/image')).toBe(true);
  });

  it('rejects a missing or blank URL', async () => {
    await expect(ImageCache.loadImage('', 'test-token')).rejects.toThrow('Invalid image source');
    await expect(ImageCache.loadImage('   ', 'test-token')).rejects.toThrow('Invalid image source');
    await expect(ImageCache.loadImage(null, 'test-token')).rejects.toThrow('Invalid image source');
  });

  it('rejects a rejected/404 URL', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Map(),
      text: () => Promise.resolve('not found'),
    });

    await expect(ImageCache.loadImage('/api/files/missing/image', 'test-token')).rejects.toThrow(
      'Failed to load image: 404 Not Found'
    );
  });

  it('rejects a non-image content type', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map([['content-type', 'text/html']]),
      text: () => Promise.resolve('<html></html>'),
      blob: () => Promise.resolve(new Blob(['<html></html>'], { type: 'text/html' })),
    });

    await expect(ImageCache.loadImage('/api/files/nasty/image', 'test-token')).rejects.toThrow(
      'Non-image content type'
    );
  });

  it('sends the Authorization header for internal API URLs', async () => {
    await ImageCache.loadImage('/api/files/abc123/image', 'test-token');

    expect(fetch).toHaveBeenCalledWith(
      '/api/files/abc123/image',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
        credentials: 'include',
      })
    );
  });

  it('does not send the Authorization header to external hosts', async () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost:3001/', origin: 'http://localhost:3001' } });

    await ImageCache.loadImage('https://example.com/headshot.png', 'test-token');

    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/headshot.png',
      expect.objectContaining({
        headers: {},
        credentials: 'include',
      })
    );
  });

  it('does not retry or spam requests when the URL is invalid', async () => {
    await expect(ImageCache.loadImage('not-a-url', 'test-token')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
