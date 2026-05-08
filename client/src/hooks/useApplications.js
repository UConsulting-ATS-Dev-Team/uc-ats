import { useState, useEffect, useCallback, useRef } from 'react';
import apiClient from '../utils/api';

// Simple in-memory cache
const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes

function getCacheKey(page, limit, search, status, year, gender, firstGen, transfer, returning) {
  return `applications:${page}:${limit}:${search}:${status}:${year}:${gender}:${firstGen}:${transfer}:${returning}`;
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

export function invalidateApplicationsCache() {
  for (const key of cache.keys()) {
    cache.delete(key);
  }
}

/**
 * Hook for fetching applications data with pagination, search, filters, and caching
 */
export function useApplications(options = {}) {
  const {
    page = 1,
    limit = 10,
    search = '',
    status = null,
    year = null,
    gender = null,
    firstGen = null,
    transfer = null,
    returning = null,
    enabled = true,
  } = options;

  const [data, setData] = useState({ applications: [], pagination: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const isMounted = useRef(true);

  const fetchApplications = useCallback(async (skipCache = false) => {
    if (!enabled) return;

    const cacheKey = getCacheKey(page, limit, search, status, year, gender, firstGen, transfer, returning);

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
      if (status) params.append('status', status);
      if (year) params.append('year', year);
      if (gender) params.append('gender', gender);
      if (firstGen) params.append('firstGen', firstGen);
      if (transfer) params.append('transfer', transfer);
      if (returning) params.append('returning', returning);

      const response = await apiClient.get(`/applications?${params.toString()}`);

      let result;
      if (response.pagination) {
        result = {
          applications: response.data || [],
          pagination: response.pagination,
        };
      } else {
        const items = Array.isArray(response) ? response : [];
        result = {
          applications: items,
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
        setError(err.message || 'Failed to fetch applications');
        setData({ applications: [], pagination: null });
      }
    } finally {
      if (isMounted.current) {
        setLoading(false);
      }
    }
  }, [page, limit, search, status, year, gender, firstGen, transfer, returning, enabled]);

  useEffect(() => {
    isMounted.current = true;
    fetchApplications();
    return () => {
      isMounted.current = false;
    };
  }, [fetchApplications]);

  const refetch = useCallback(() => {
    return fetchApplications(true);
  }, [fetchApplications]);

  return {
    applications: data.applications,
    pagination: data.pagination,
    loading,
    error,
    refetch,
  };
}

export default useApplications;
