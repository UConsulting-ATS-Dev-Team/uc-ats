import React, { useState, useEffect, useRef } from 'react';
import apiClient from '../utils/api';
import ImageCache from '../utils/imageCache';

const AuthenticatedImage = ({ src, alt, style, onError, ...props }) => {
  const [imageUrl, setImageUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const retryCountRef = useRef(0);
  const maxRetries = 3;

  // Check if URL is a public URL that doesn't need authentication
  const isPublicUrl = (url) => {
    if (!url) return false;
    // If it's a full URL (http/https) and not a Supabase storage URL, it might be public
    if (url.startsWith('http://') || url.startsWith('https://')) {
      // Check if it's a Supabase storage URL (contains supabase.co or storage paths)
      const isSupabaseUrl = url.includes('supabase.co') || 
                           url.includes('/storage/') ||
                           url.includes('/files/');
      // Also check if it's pointing to our own server's uploads endpoint
      const isServerUploadUrl = url.includes('/api/uploads/') || url.includes('/uploads/');
      return !isSupabaseUrl && !isServerUploadUrl;
    }
    // Relative URLs starting with /api/uploads/ need authentication
    if (url.startsWith('/api/uploads/')) {
      return false; // These need auth
    }
    // Other relative URLs might be public
    if (url.startsWith('/api/')) {
      return true;
    }
    return false;
  };

  useEffect(() => {
    if (typeof src !== 'string' || !src.trim()) {
      setLoading(false);
      setError(true);
      if (onError) onError(new Error('Invalid image source'));
      return;
    }

    let isMounted = true;
    let currentBlobUrl = null;
    retryCountRef.current = 0;

    const loadImage = async (retry = false) => {
      try {
        if (!retry) {
          console.log('AuthenticatedImage: Loading image:', src);
          console.log('AuthenticatedImage: Token available:', !!apiClient.token);
        }
        
        // Check if image is already cached
        const cachedImage = ImageCache.getCachedImage(src);
        if (cachedImage) {
          console.log('AuthenticatedImage: Using cached image');
          if (isMounted) {
            setImageUrl(cachedImage);
            setLoading(false);
          }
          return;
        }

        // Try public URL first if it appears to be public
        if (isPublicUrl(src)) {
          try {
            console.log('AuthenticatedImage: Attempting to load as public URL');
            const response = await fetch(src);
            if (response.ok) {
              const blob = await response.blob();
              const blobUrl = URL.createObjectURL(blob);
              currentBlobUrl = blobUrl;
              if (isMounted) {
                setImageUrl(blobUrl);
                setLoading(false);
                setError(false);
              }
              return;
            }
          } catch (publicError) {
            console.log('AuthenticatedImage: Public URL load failed, trying authenticated:', publicError);
            // Fall through to authenticated load
          }
        }

        // Load image using cache with authentication
        if (!apiClient.token && retryCountRef.current < maxRetries) {
          // Wait a bit for token to become available
          console.log('AuthenticatedImage: No token available, waiting...');
          await new Promise(resolve => setTimeout(resolve, 500));
          retryCountRef.current++;
          if (isMounted && apiClient.token) {
            return loadImage(true);
          }
        }

        console.log('AuthenticatedImage: Fetching new image');
        const blobUrl = await ImageCache.loadImage(src, apiClient.token);
        currentBlobUrl = blobUrl;
        console.log('AuthenticatedImage: Image loaded successfully');
        if (isMounted) {
          setImageUrl(blobUrl);
          setLoading(false);
          setError(false);
        }
      } catch (err) {
        console.error('AuthenticatedImage: Error loading image:', err);
        
        // Retry if we haven't exceeded max retries and token might be available now
        if (retryCountRef.current < maxRetries && !apiClient.token) {
          retryCountRef.current++;
          console.log(`AuthenticatedImage: Retrying (${retryCountRef.current}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (isMounted && apiClient.token) {
            return loadImage(true);
          }
        }
        
        if (isMounted) {
          setError(true);
          setLoading(false);
          if (onError) onError(err);
        }
      }
    };

    loadImage();

    return () => {
      isMounted = false;
      // Clean up blob URL if it was created for a public URL
      if (currentBlobUrl && isPublicUrl(src)) {
        URL.revokeObjectURL(currentBlobUrl);
      }
    };
  }, [src]);

  if (loading) {
    return (
      <div 
        style={{
          ...style,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#f5f5f5',
          color: '#666'
        }}
        {...props}
      >
        Loading...
      </div>
    );
  }

  if (error || !imageUrl) {
    return (
      <div
        style={{
          ...style,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#f5f5f5',
          color: '#666',
          border: '2px dashed #ccc'
        }}
        {...props}
      >
        Photo unavailable
      </div>
    );
  }

  const handleImageError = () => {
    setError(true);
    setLoading(false);
    if (onError) onError(new Error('Image failed to load'));
  };

  return (
    <img
      src={imageUrl}
      alt={alt}
      style={style}
      onError={handleImageError}
      {...props}
    />
  );
};

export default AuthenticatedImage; 