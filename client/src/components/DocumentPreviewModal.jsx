import React, { useEffect, useState, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useIsMobile } from '../hooks/useResponsive';
import { toSameOriginDocumentUrl } from '../utils/documentUrl';

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1500,
};

const getModalStyle = (isMobile) => ({
  width: isMobile ? '100vw' : '90vw',
  height: isMobile ? '100vh' : '90vh',
  backgroundColor: '#fff',
  borderRadius: isMobile ? 0 : '8px',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
});

const headerStyle = {
  padding: '8px 12px',
  borderBottom: '1px solid #eee',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const contentStyle = {
  flex: 1,
  backgroundColor: '#f9fafb',
};

export default function DocumentPreviewModal({ src, kind, title, onClose }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [error, setError] = useState(null);
  const videoRef = useRef(null);
  const { token } = useAuth();
  const isMobile = useIsMobile();
  
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let localUrl;
    const load = async () => {
      try {
        const fetchUrl = toSameOriginDocumentUrl(src);
        const resp = await fetch(fetchUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        if (!resp.ok) {
          const txt = await resp.text();
          console.error('Fetch error:', txt);
          throw new Error(`${resp.status} ${resp.statusText} - ${txt}`);
        }
        const blob = await resp.blob();

        localUrl = URL.createObjectURL(blob);
        setBlobUrl(localUrl);
      } catch (e) {
        console.error('Document load error:', e);
        setError(e.message || 'Failed to load document');
      }
    };
    load();
    return () => {
      if (localUrl) URL.revokeObjectURL(localUrl);
    };
  }, [src, token, kind]);

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={getModalStyle(isMobile)} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <div style={{ fontWeight: 600 }}>{title || 'Preview'}</div>
          <button onClick={onClose} style={{ padding: '6px 10px' }}>Close</button>
        </div>
        <div style={contentStyle}>
          {error && (
            <div style={{ padding: 16, color: 'red' }}>Error: {error}</div>
          )}
          {!error && !blobUrl && (
            <div style={{ padding: 16 }}>Loading preview…</div>
          )}
          {!error && blobUrl && (
            kind === 'pdf' ? (
              <iframe
                title={title || 'Document preview'}
                src={`${blobUrl}#toolbar=0&navpanes=0&scrollbar=0`}
                style={{ width: '100%', height: '100%', border: 'none' }}
              />
            ) : kind === 'video' ? (
              <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000' }}>
                <video
                  ref={videoRef}
                  src={blobUrl}
                  controls
                  preload="auto"
                  style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto' }}
                  onLoadedData={() => {
                    console.log('Video loaded successfully');
                    // Try to play the video
                    if (videoRef.current) {
                      videoRef.current.play().catch(err => {
                        console.log('Autoplay prevented, user can click play:', err);
                      });
                    }
                  }}
                  onError={(e) => {
                    console.error('Video playback error:', e, videoRef.current?.error);
                    const error = videoRef.current?.error;
                    let errorMsg = 'Failed to play video.';
                    if (error) {
                      switch (error.code) {
                        case error.MEDIA_ERR_ABORTED:
                          errorMsg = 'Video playback was aborted.';
                          break;
                        case error.MEDIA_ERR_NETWORK:
                          errorMsg = 'Network error while loading video.';
                          break;
                        case error.MEDIA_ERR_DECODE:
                          errorMsg = 'Video format not supported or corrupted.';
                          break;
                        case error.MEDIA_ERR_SRC_NOT_SUPPORTED:
                          errorMsg = 'Video format not supported.';
                          break;
                      }
                    }
                    setError(errorMsg);
                  }}
                >
                  Your browser does not support the video tag.
                </video>
              </div>
            ) : (
              <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff' }}>
                <img src={blobUrl} alt={title || 'Image preview'} style={{ maxWidth: '100%', maxHeight: '100%' }} />
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}


