class ApiClient {
  constructor() {
    this.baseURL = '/api';
  }

  setToken(token) {
    this.token = token;
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
      body: JSON.stringify(data),
    });
  }

  patch(endpoint, data, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  delete(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'DELETE' });
  }
}

// Create a singleton instance
const apiClient = new ApiClient();

export default apiClient; 