// First-paint cache for the Staging console's snapshot. It lives in its own module so
// that anything holding it (the page, tests) can reset it explicitly instead of
// depending on module-load order.
const stagingCache = {
  data: null,
  timestamp: null,
  TTL: 2 * 60 * 1000, // 2 minutes

  isValid() {
    return this.data && this.timestamp && (Date.now() - this.timestamp < this.TTL);
  },

  set(data) {
    this.data = data;
    this.timestamp = Date.now();
  },

  get() {
    return this.isValid() ? this.data : null;
  },

  invalidate() {
    this.data = null;
    this.timestamp = null;
  }
};

export default stagingCache;
