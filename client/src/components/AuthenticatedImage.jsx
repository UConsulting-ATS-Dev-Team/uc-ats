import React, { useState, useEffect } from 'react';
import apiClient from '../utils/api';
import ImageCache from '../utils/imageCache';

// `fallback`, when given, replaces the "Photo unavailable" box for a missing or
// broken image, and is shown while loading too, so a row never flashes the box.
const AuthenticatedImage = ({ src, alt, style, onError, fallback, ...props }) => {
  const [imageUrl, setImageUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    setImageUrl(null);
    setLoading(true);
    setError(false);

    if (!ImageCache.isValidImageUrl(src)) {
      setLoading(false);
      setError(true);
      if (onError) onError(new Error('Invalid image source'));
      return;
    }

    let isMounted = true;

    const loadImage = async () => {
      try {
        const blobUrl = await ImageCache.loadImage(src, apiClient.token);
        if (!isMounted) return;
        setImageUrl(blobUrl);
        setLoading(false);
        setError(false);
      } catch (err) {
        if (!isMounted) return;
        setError(true);
        setLoading(false);
        if (onError) onError(err);
      }
    };

    loadImage();

    return () => {
      isMounted = false;
    };
  }, [src, onError]);

  if (fallback && (loading || error || !imageUrl)) {
    return fallback;
  }

  if (loading) {
    return (
      <div
        style={{
          ...style,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--bg-gray-lighter)',
        }}
        {...props}
      />
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
          backgroundColor: 'var(--bg-gray-lighter)',
          color: 'var(--text-tertiary)',
          border: '2px dashed var(--border-medium)',
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
    if (onError) onError(new Error('Image failed to render'));
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
