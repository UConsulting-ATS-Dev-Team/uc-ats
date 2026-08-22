import React, { useState, useEffect } from 'react';
import apiClient from '../utils/api';
import ImageCache from '../utils/imageCache';

const AuthenticatedImage = ({ src, alt, style, onError, ...props }) => {
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

  if (loading) {
    return (
      <div
        style={{
          ...style,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#f5f5f5',
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
          backgroundColor: '#f5f5f5',
          color: '#666',
          border: '2px dashed #ccc',
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
