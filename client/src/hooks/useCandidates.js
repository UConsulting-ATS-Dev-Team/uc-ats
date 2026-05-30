import { useState, useEffect, useCallback, useRef } from 'react';
import apiClient from '../utils/api';

// Simple in-memory cache
const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes

function getCacheKey(endpoint, page, limit, search) {
  return `${endpoint}:${page}:${limit}:${search}`;
}

function getFromCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setToCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

export function invalidateCandidatesCache() {
  for (const key of cache.keys()) {
    cache.delete(key);
  }
}

/**
 * Hook for fetching candidates data with pagination, search, and caching
 */
export function useCandidates(options = {}) {
  const {
    page = 1,
    limit = 10,
    search = '',
    enabled = true,
    endpoint = '/admin/candidates',
    eventAttendanceEventId = '',
    eventRsvpEventId = '',
  } = options;

  const [data, setData] = useState({ candidates: [], pagination: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const isMounted = useRef(true);

  const fetchCandidates = useCallback(async (skipCache = false) => {
    if (!enabled) return;

    const cacheKey = getCacheKey(endpoint, page, limit, search);

    // Check cache first
    if (!skipCache) {
      const cached = getFromCache(cacheKey);
      if (cached) {
        setData(cached);
        return;
      }
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.append('page', page.toString());
      params.append('limit', limit.toString());
      if (search) params.append('search', search);
      if (eventAttendanceEventId) params.append('eventAttendanceEventId', eventAttendanceEventId);
      if (eventRsvpEventId) params.append('eventRsvpEventId', eventRsvpEventId);

      const response = await apiClient.get(`${endpoint}?${params.toString()}`);

      let result;
      if (response.pagination) {
        result = {
          candidates: response.data || [],
          pagination: response.pagination,
        };
      } else {
        const items = Array.isArray(response) ? response : [];
        result = {
          candidates: items,
          pagination: {
            page: 1,
            limit: items.length,
            total: items.length,
            totalPages: 1,
            hasNextPage: false,
            hasPrevPage: false,
          },
        };
      }

      setToCache(cacheKey, result);
      if (isMounted.current) {
        setData(result);
      }
    } catch (err) {
      if (isMounted.current) {
        setError(err.message || 'Failed to fetch candidates');
        setData({ candidates: [], pagination: null });
      }
    } finally {
      if (isMounted.current) {
        setLoading(false);
      }
    }
  }, [page, limit, search, enabled, endpoint, eventAttendanceEventId, eventRsvpEventId]);

  useEffect(() => {
    isMounted.current = true;
    fetchCandidates();
    return () => {
      isMounted.current = false;
    };
  }, [fetchCandidates]);

  const refetch = useCallback(() => {
    return fetchCandidates(true);
  }, [fetchCandidates]);

  return {
    candidates: data.candidates,
    pagination: data.pagination,
    loading,
    error,
    refetch,
  };
}

export default useCandidates;
