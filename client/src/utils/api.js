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

    const response = await fetch(url, config);

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