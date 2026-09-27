import { track } from '../analytics/tracker';
import { normalizePath } from '../analytics/normalizePath';

// A call slower than this is reported to Site Analytics. Mirrors SLOW_API_MS on the server.
export const SLOW_API_MS = 2000;

class ApiClient {
  constructor() {
    this.baseURL = '/api';
  }

  setToken(token) {
    this.token = token;
  }

  // Short-lived executive unlock for sealed recruiting records. Managed by
  // ExecUnlockContext; sent alongside the session token, never instead of it.
  setExecUnlockToken(token) {
    this.execUnlockToken = token;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`;

    const config = {
      headers: {
        ...options.headers,
      },
      ...options,
    };

    // Only set Content-Type to application/json if not already set and not FormData
    if (!config.headers['Content-Type'] && !(options.body instanceof FormData)) {
      config.headers['Content-Type'] = 'application/json';
    }

    // Add authorization header if token is available
    if (this.token) {
      config.headers.Authorization = `Bearer ${this.token}`;
    }

    if (this.execUnlockToken) {
      config.headers['X-Exec-Unlock'] = this.execUnlockToken;
    }

    const method = (config.method || 'GET').toUpperCase();
    const startedAt = performance.now();
    let response;
    try {
      response = await fetch(url, config);
    } catch (networkError) {
      // Offline, DNS, CORS, or the server dropped the connection: the request
      // never got an answer. Previously nothing saw these at all.
      track('api_error', { path: normalizePath(endpoint), name: '0', meta: { method, network: true } });
      throw networkError;
    }

    const elapsed = performance.now() - startedAt;
    if (elapsed > SLOW_API_MS) {
      track('api_slow', { path: normalizePath(endpoint), value: Math.round(elapsed), meta: { method } });
    }

    if (!response.ok) {
      let error;
      try {
        error = await response.json();
      } catch (parseError) {
        // If JSON parsing fails, try to get text response
        try {
          const textResponse = await response.text();
          error = { error: `Server Error (${response.status}): ${textResponse || response.statusText}` };
        } catch (textError) {
          error = { error: `Server Error (${response.status}): ${response.statusText}` };
        }
      }

      // An expired session answering 401 on its way to the login page is
      // expected, not a failure worth a row.
      if (!(response.status === 401 && endpoint.startsWith('/auth/'))) {
        track('api_error', {
          path: normalizePath(endpoint),
          name: String(response.status),
          meta: { method, code: error?.code || null },
        });
      }

      console.error('API Error Response:', {
        status: response.status,
        statusText: response.statusText,
        error: error,
        url: url
      });

      // Include more details in the error message
      const errorMessage = error.error || error.message || 'Request failed';
      const detailedError = `${errorMessage} (Status: ${response.status})`;
      const err = new Error(detailedError);
      // Machine-readable pieces, so callers can branch on a sealed record
      // (423, RECORD_LOCKED) without parsing the message.
      err.status = response.status;
      err.code = error.code;
      err.serverMessage = errorMessage;
      // The whole parsed body, for endpoints that explain a refusal in more than
      // a message (a live vote launch lists the candidates it rejected).
      err.body = error;
      if (error.contactEmail) {
        err.contactEmail = error.contactEmail;
      }
      throw err;
    }

    return response.json();
  }

  // Convenience methods
  get(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'GET' });
  }

  post(endpoint, data, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'POST',
      body: data instanceof FormData ? data : JSON.stringify(data),
    });
  }

  put(endpoint, data, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'PUT',
      // Same FormData check post() has. Without it an upload sent over PUT or
      // PATCH is stringified to "[object FormData]" and the file never arrives.
      body: data instanceof FormData ? data : JSON.stringify(data),
    });
  }

  patch(endpoint, data, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'PATCH',
      // Same FormData check post() has. Without it an upload sent over PUT or
      // PATCH is stringified to "[object FormData]" and the file never arrives.
      body: data instanceof FormData ? data : JSON.stringify(data),
    });
  }

  delete(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'DELETE' });
  }
}

// Create a singleton instance
const apiClient = new ApiClient();

export default apiClient;