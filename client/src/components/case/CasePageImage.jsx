import React, { useState, useEffect } from 'react';
import apiClient from '../../utils/api';
import ImageCache from '../../utils/imageCache';

// Authenticated <img> for case page images. Unlike AuthenticatedImage, it always
// fetches with the Bearer token (never an anonymous public attempt) — the case
// image endpoint is auth-gated. Only requests the given `src`, so the caller
// controls exactly which page URLs enter the DOM (important for candidate
// preview mode, where interviewer-only pages must never be requested).
// `errorLabel` replaces the default "Page unavailable" for any failure, and
// `missingLabel` for the server saying the file is gone (404), which is the one
// failure re-uploading fixes. A thumbnail has room for a word, the main stage
// for a sentence.
const CasePageImage = ({
  src,
  alt,
  style,
  className,
  onLoaded,
  errorLabel = 'Page unavailable',
  missingLabel = errorLabel,
}) => {
  const [imageUrl, setImageUrl] = useState(() => ImageCache.getCachedImage(src) || null);
  const [status, setStatus] = useState(src ? 'loading' : 'error');
  const [missing, setMissing] = useState(false);

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
    setMissing(false);
    ImageCache.loadImage(src, apiClient.token)
      .then((url) => {
        if (!mounted) return;
        setImageUrl(url);
        setStatus('ready');
        onLoaded?.();
      })
      .catch((error) => {
        if (!mounted) return;
        setMissing(error?.status === 404);
        setStatus('error');
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
          background: 'var(--bg-secondary)',
          color: 'var(--text-secondary)',
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
          background: 'var(--bg-secondary)',
          color: 'var(--text-secondary)',
          fontSize: '0.85rem',
          border: '1px dashed var(--border-light)',
          textAlign: 'center',
          padding: '4px',
        }}
      >
        {missing ? missingLabel : errorLabel}
      </div>
    );
  }

  return <img src={imageUrl} alt={alt} style={style} className={className} />;
};

export default CasePageImage;
