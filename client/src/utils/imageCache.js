// Global image cache to store loaded images
const imageCache = new Map();
const loadingPromises = new Map();

// Cache for blob URLs to prevent memory leaks
const blobUrlCache = new Map();

// The sign-in the cached images were fetched with. An image is only as visible
// as the account that loaded it, so a different token starts from empty; and a
// fetch still in the air when that happens must not put its answer back.
let cacheToken = null;
let generation = 0;

class ImageCache {
  static isValidImageUrl(url) {
    if (typeof url !== 'string' || !url.trim()) {
      return false;
    }
    const trimmed = url.trim();
    // Only accept same-origin relative API paths or explicit http(s) URLs.
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
      return true;
    }
    return /^https?:\/\//i.test(trimmed);
  }

  static isInternalImageUrl(url) {
    if (typeof url !== 'string') {
      return false;
    }
    if (url.startsWith('/')) {
      return true;
    }
    if (typeof window === 'undefined') {
      return false;
    }
    try {
      const parsed = new URL(url, window.location.href);
      return parsed.origin === window.location.origin;
    } catch {
      return false;
    }
  }

  static async loadImage(src, token) {
    if (!this.isValidImageUrl(src)) {
      throw new Error('Invalid image source');
    }

    if ((token || null) !== cacheToken) {
      this.clearCache();
      cacheToken = token || null;
    }
    const startedIn = generation;

    // Return cached image if available
    if (imageCache.has(src)) {
      return imageCache.get(src);
    }

    // Return existing loading promise if already loading
    if (loadingPromises.has(src)) {
      return loadingPromises.get(src);
    }

    // One promise for everyone waiting on this image, so each of them gets the
    // same answer, including "the sign-in changed".
    const loadingPromise = (async () => {
      const blobUrl = await this.fetchImage(src, token);
      // The cache was emptied while this was in the air: the sign-in that asked
      // is gone, so the image is neither kept nor shown, and its blob is freed
      // here because nothing else holds it to free later.
      if (startedIn !== generation) {
        URL.revokeObjectURL(blobUrl);
        throw new Error('Image request outlived its sign-in');
      }
      blobUrlCache.set(src, blobUrl);
      imageCache.set(src, blobUrl);
      return blobUrl;
    })();
    loadingPromises.set(src, loadingPromise);

    try {
      return await loadingPromise;
    } finally {
      if (loadingPromises.get(src) === loadingPromise) loadingPromises.delete(src);
    }
  }

  static async fetchImage(src, token) {
    if (!this.isValidImageUrl(src)) {
      throw new Error('Invalid image source');
    }

    const headers = {};
    const internal = this.isInternalImageUrl(src);
    // Only send the auth token to our own API; never forward it to external hosts.
    if (token && internal) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(src, {
      headers,
      // Credentialed only for our own API. Public storage (Supabase profile
      // images) answers `Access-Control-Allow-Origin: *`, which the browser
      // rejects on a credentialed request, so the image would never load.
      credentials: internal ? 'include' : 'omit',
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to load image: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType && !contentType.trim().toLowerCase().startsWith('image/')) {
      throw new Error(`Non-image content type: ${contentType}`);
    }

    const blob = await response.blob();
    if (blob.type && !blob.type.toLowerCase().startsWith('image/')) {
      throw new Error(`Non-image blob type: ${blob.type}`);
    }

    return URL.createObjectURL(blob);
  }

  static getCachedImage(src) {
    return imageCache.get(src);
  }

  static isImageCached(src) {
    return imageCache.has(src);
  }

  static isImageLoading(src) {
    return loadingPromises.has(src);
  }

  static clearCache() {
    // Revoke all blob URLs to prevent memory leaks
    blobUrlCache.forEach((blobUrl) => {
      URL.revokeObjectURL(blobUrl);
    });

    imageCache.clear();
    loadingPromises.clear();
    blobUrlCache.clear();
    cacheToken = null;
    generation += 1;
  }

  static preloadImages(imageUrls, token) {
    // Preload multiple images in parallel
    const promises = imageUrls.map((src) => this.loadImage(src, token));
    return Promise.allSettled(promises);
  }
}

export default ImageCache;
