import React, { useRef } from 'react';
import { Modal } from '@mui/material';
import { useAuth } from '../context/AuthContext';
import { useIsMobile } from '../hooks/useResponsive';
import useDocumentPreview from '../hooks/useDocumentPreview';

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
  // Theme tokens, not fixed colours: the text inherits the theme's colour, so a
  // fixed white background left dark mode's near-white text unreadable.
  backgroundColor: 'var(--bg-primary)',
  color: 'var(--text-primary)',
  borderRadius: isMobile ? 0 : '8px',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
});

const headerStyle = {
  padding: '8px 12px',
  borderBottom: '1px solid var(--border-light)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const contentStyle = {
  flex: 1,
  backgroundColor: 'var(--bg-gray-light)',
};

// kind 'text' shows `text` as written (an application's short answer) and
// fetches nothing. A video streams from a signed link, in ranges, the same way
// the grading modal's does; it used to be downloaded whole before it could
// start, and again on every open. A PDF or image still loads as a blob.
export default function DocumentPreviewModal({ src, kind, title, text, onClose }) {
  const videoRef = useRef(null);
  const { token } = useAuth();
  const isMobile = useIsMobile();
  const preview = useDocumentPreview({ url: src, kind, enabled: kind !== 'text', token });
  const { previewUrl, onVideoError, onVideoLoaded } = preview;
  const error = preview.error || (!src ? 'There is no document to preview.' : null);

  // An MUI Modal, which renders on <body> and takes part in MUI's stack of modals.
  // <body>: the overlay is position: fixed, and fixed positions against the nearest
  // transformed ancestor rather than the window. Rendered in place, a card with a
  // hover transform (My Interviews' .interview-card:hover) became that ancestor the
  // moment someone clicked Resume, and the preview opened shifted up under the top
  // bar. The stack: opened from an MUI Dialog (Staging), this is the top modal, so it
  // holds keyboard focus and Escape closes it alone, not the dialog underneath too.
  return (
    // 1500, as the overlay always was: above MUI dialogs (1300) and snackbars (1400).
    <Modal open onClose={onClose} hideBackdrop sx={{ zIndex: 1500 }}>
      <div style={overlayStyle} onClick={onClose}>
        <div style={getModalStyle(isMobile)} onClick={(e) => e.stopPropagation()}>
          <div style={headerStyle}>
            <div style={{ fontWeight: 600 }}>{title || 'Preview'}</div>
            <button onClick={onClose} style={{ padding: '6px 10px' }}>Close</button>
          </div>
          <div style={contentStyle}>
            {kind === 'text' && (
              <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)' }}>
                <p style={{ maxWidth: 720, margin: '0 auto', padding: isMobile ? 16 : 32, whiteSpace: 'pre-wrap', lineHeight: 1.7, fontSize: 16 }}>
                  {text}
                </p>
              </div>
            )}
            {kind !== 'text' && error && (
              <div style={{ padding: 16, color: 'red' }}>Error: {error}</div>
            )}
            {kind !== 'text' && !error && !previewUrl && (
              <div style={{ padding: 16 }}>Loading preview…</div>
            )}
            {kind !== 'text' && !error && previewUrl && (
              kind === 'pdf' ? (
                <iframe
                  title={title || 'Document preview'}
                  src={`${previewUrl}#toolbar=0&navpanes=0&scrollbar=0`}
                  style={{ width: '100%', height: '100%', border: 'none' }}
                />
              ) : kind === 'video' ? (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000' }}>
                  <video
                    ref={videoRef}
                    src={previewUrl}
                    controls
                    preload="auto"
                    style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto' }}
                    onLoadedData={(event) => {
                      onVideoLoaded(event);
                      // Opened on purpose, so start playing; a browser that
                      // blocks autoplay leaves the controls to the viewer.
                      videoRef.current?.play().catch(() => {});
                    }}
                    onError={onVideoError}
                  >
                    Your browser does not support the video tag.
                  </video>
                </div>
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff' }}>
                  <img src={previewUrl} alt={title || 'Image preview'} style={{ maxWidth: '100%', maxHeight: '100%' }} />
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
