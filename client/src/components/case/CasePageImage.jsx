import React, { useState, useEffect } from 'react';
import apiClient from '../../utils/api';
import ImageCache from '../../utils/imageCache';

// Authenticated <img> for case page images. Unlike AuthenticatedImage, it always
// fetches with the Bearer token (never an unauthenticated public attempt) — the case
// image endpoint is auth-gated. Only requests the given `src`, so the caller
// controls exactly which page URLs enter the DOM (important for candidate
// preview mode, where interviewer-only pages must never be requested).
const CasePageImage = ({ src, alt, style, className, onLoaded }) => {
  const [imageUrl, setImageUrl] = useState(() => ImageCache.getCachedImage(src) || null);
  const [status, setStatus] = useState(src ? 'loading' : 'error');

  useEffect(() => {
    if (!src) {
      setStatus('error');
      return;
    }
    let mounted = true;
    const cached = ImageCache.getCachedImage(src);
    if (cached) {
      setImageUrl(cached);
      setStatus('ready');
      onLoaded?.();
      return;
    }
    setStatus('loading');
    ImageCache.loadImage(src, apiClient.token)
      .then((url) => {
        if (!mounted) return;
        setImageUrl(url);
        setStatus('ready');
        onLoaded?.();
      })
      .catch(() => {
        if (mounted) setStatus('error');
      });
    return () => {
      mounted = false;
    };
  }, [src]);

  if (status === 'loading') {
    return (
      <div
        className={className}
        style={{
          ...style,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f8fafc',
          color: '#64748b',
          fontSize: '0.85rem',
        }}
      >
        Loading…
      </div>
    );
  }

  if (status === 'error' || !imageUrl) {
    return (
      <div
        className={className}
        style={{
          ...style,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f8fafc',
          color: '#64748b',
          fontSize: '0.85rem',
          border: '1px dashed #e5e7eb',
        }}
      >
        Page unavailable
      </div>
    );
  }

  return <img src={imageUrl} alt={alt} style={style} className={className} />;
};

export default CasePageImage;
