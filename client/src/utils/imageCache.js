// Global image cache to store loaded images
const imageCache = new Map();
const loadingPromises = new Map();

// Cache for blob URLs to prevent memory leaks
const blobUrlCache = new Map();

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

    // Return cached image if available
    if (imageCache.has(src)) {
      return imageCache.get(src);
    }

    // Return existing loading promise if already loading
    if (loadingPromises.has(src)) {
      return loadingPromises.get(src);
    }

    // Create new loading promise
    const loadingPromise = this.fetchImage(src, token);
    loadingPromises.set(src, loadingPromise);

    try {
      const blobUrl = await loadingPromise;
      imageCache.set(src, blobUrl);
      return blobUrl;
    } finally {
      loadingPromises.delete(src);
    }
  }

  static async fetchImage(src, token) {
    if (!this.isValidImageUrl(src)) {
      throw new Error('Invalid image source');
    }

    const headers = {};
    // Only send the auth token to our own API; never forward it to external hosts.
    if (token && this.isInternalImageUrl(src)) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(src, {
      headers,
      credentials: 'include', // Include cookies for session-based auth if needed
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

    const blobUrl = URL.createObjectURL(blob);

    // Store blob URL for cleanup
    blobUrlCache.set(src, blobUrl);
    imageCache.set(src, blobUrl);

    return blobUrl;
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
  }

  static preloadImages(imageUrls, token) {
    // Preload multiple images in parallel
    const promises = imageUrls.map((src) => this.loadImage(src, token));
    return Promise.allSettled(promises);
  }
}

export default ImageCache;
