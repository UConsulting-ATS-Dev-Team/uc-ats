import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../utils/api';
import { signedDocumentTarget, toSameOriginDocumentUrl } from '../utils/documentUrl';

// Showing one application document in the page: a PDF as a blob URL for an
// <iframe>, a video as a signed link a <video> streams from.
//
// A video never arrives whole. /api goes through Vercel's proxy, which cuts a
// long response off part way ("The download stopped before the file
// finished"); <video> asks for the file in ranges, each one a short response,
// through a 15-minute link from POST /files/:id/link.
//
// Used by the grading modal and the review team deliberation card.

export default function useDocumentPreview({ url, kind, enabled = true, token }) {
  const [previewUrl, setPreviewUrl] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [openTabError, setOpenTabError] = useState(null);
  const videoRetriesRef = useRef(0);
  // Bumped each time a document loads, so a link renewal still in flight for an
  // earlier one cannot touch the preview shown now.
  const generationRef = useRef(0);

  useEffect(() => {
    let localUrl;
    let cancelled = false;
    videoRetriesRef.current = 0;
    generationRef.current += 1;
    setError(null);
    setPreviewUrl(null);
    setLoading(false);
    setOpenTabError(null);
    if (!enabled || !url) return undefined;

    const load = async () => {
      setLoading(true);
      const signed = kind === 'video' ? signedDocumentTarget(url) : null;
      if (signed) {
        try {
          const { access } = await apiClient.post(signed.linkEndpoint);
          if (!cancelled) setPreviewUrl(signed.open(access));
        } catch (e) {
          console.error('Failed to sign video preview link:', e);
          if (!cancelled) setError(`Could not open the video: ${e.serverMessage || e.message}`);
        } finally {
          if (!cancelled) setLoading(false);
        }
        return;
      }

      try {
        const resp = await fetch(toSameOriginDocumentUrl(url), {
          headers: {
            Authorization: `Bearer ${token || apiClient.token || localStorage.getItem('token')}`
          }
        });
        if (!resp.ok) {
          const txt = await resp.text();
          let reason = resp.statusText;
          try { reason = JSON.parse(txt).error || reason; } catch { /* not JSON */ }
          throw new Error(`The server answered ${resp.status}: ${reason}`);
        }
        let blob;
        try {
          blob = await resp.blob();
        } catch (e) {
          // Headers arrived, the body did not: the connection dropped part way
          // through a large file.
          throw new Error(`The download stopped before the file finished (${e.message})`);
        }
        if (cancelled) return;
        localUrl = URL.createObjectURL(blob);
        setPreviewUrl(localUrl);
      } catch (e) {
        console.error(`Failed to load ${kind} preview:`, e);
        if (!cancelled) {
          setError(e instanceof TypeError ? `Could not reach the server (${e.message})` : e.message || `Failed to load ${kind} preview`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
      if (localUrl) URL.revokeObjectURL(localUrl);
    };
  }, [url, kind, enabled, token]);

  // A streamed video re-requests its link with every range, and the link lasts
  // 15 minutes, so a video left open can stop. The first error re-signs and
  // resumes where it was; a second one is reported.
  const onVideoError = useCallback(async (event) => {
    const video = event.currentTarget;
    const target = signedDocumentTarget(url);
    if (!target || videoRetriesRef.current >= 1) {
      setPreviewUrl(null);
      setError('The video could not be played here. The browser may not support its format; try opening it in a new tab.');
      return;
    }
    videoRetriesRef.current += 1;
    const resumeAt = video.currentTime;
    const generation = generationRef.current;
    try {
      const { access } = await apiClient.post(target.linkEndpoint);
      if (generation !== generationRef.current) return;
      video.src = target.open(access);
      video.currentTime = resumeAt;
    } catch (e) {
      if (generation !== generationRef.current) return;
      setPreviewUrl(null);
      setError(`Could not open the video: ${e.serverMessage || e.message}`);
    }
  }, [url]);

  const onVideoLoaded = useCallback(() => { videoRetriesRef.current = 0; }, []);

  const openInNewTab = useCallback(async () => {
    const target = signedDocumentTarget(url);
    if (!target) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    setOpenTabError(null);
    // Opened inside the click, before the await, or a popup blocker eats it.
    const tab = window.open('', '_blank');
    try {
      const { access } = await apiClient.post(target.linkEndpoint);
      if (!tab) {
        setOpenTabError('Your browser blocked the new tab. Allow pop-ups for this site and try again.');
        return;
      }
      tab.opener = null;
      tab.location.href = target.open(access);
    } catch (e) {
      tab?.close();
      setOpenTabError(e.serverMessage || e.message || `Could not open the ${kind}.`);
    }
  }, [url, kind]);

  return { previewUrl, loading, error, openTabError, onVideoError, onVideoLoaded, openInNewTab };
}
