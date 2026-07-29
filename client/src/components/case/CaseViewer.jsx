import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import apiClient from '../../utils/api';
import { setPreviewActive as setGlobalPreview } from '../../utils/previewMode';
import CasePageImage from './CasePageImage';
import './CaseViewer.css';

// Arc injects `--arc-*` CSS custom properties on the root. Arc handles
// programmatic fullscreen inconsistently (spurious fullscreenchange events), so
// we skip the native Fullscreen API there and rely on the CSS overlay, which
// already covers the whole screen.
function isArcBrowser() {
  try {
    const s = getComputedStyle(document.documentElement);
    return ['--arc-palette-title', '--arc-background-simple-color', '--arc-palette-background'].some(
      (p) => s.getPropertyValue(p).trim() !== ''
    );
  } catch {
    return false;
  }
}

// Nearest visible page (by page number) to a given page number — used to snap off
// an interviewer-only page when entering candidate preview.
function nearestVisibleId(visible, fromPageNumber) {
  if (!visible.length) return null;
  let best = visible[0];
  let bestDist = Infinity;
  for (const p of visible) {
    const d = Math.abs(p.pageNumber - fromPageNumber);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best.id;
}

// Live case viewer for the interviewer screen. Renders the assigned case's pages
// large with prev/next + keyboard nav, a thumbnail strip, an exhibit quick-jump
// bar, a case override control (lead/admin), and a full-screen candidate preview
// mode. If no case is assigned, shows an inline picker instead of a dead-end.
export default function CaseViewer({
  interviewId,
  applicationId,
  assignment, // { id, caseId, caseTitle, overriddenAt } | null
  canManage = false,
  activeCases = [],
  onAssignmentChange,
}) {
  const [caseData, setCaseData] = useState(null);
  const [pages, setPages] = useState([]);
  const [currentPageId, setCurrentPageId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const [pickerValue, setPickerValue] = useState('');
  const [confirmSwitch, setConfirmSwitch] = useState(null);
  const [previewActive, setPreviewActive] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const containerRef = useRef(null);
  const overlayRef = useRef(null);
  const preEnterPageIdRef = useRef(null);
  const hideTimerRef = useRef(null);
  const enteredFullscreenRef = useRef(false);
  const enterTimeRef = useRef(0);

  const caseId = assignment?.caseId || null;

  const loadCase = useCallback(async (id) => {
    if (!id) {
      setCaseData(null);
      setPages([]);
      setCurrentPageId(null);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await apiClient.get(`/cases/${id}`);
      setCaseData(data);
      setPages(data.pages || []);
      setCurrentPageId(data.pages?.[0]?.id || null);
    } catch (e) {
      setError(e.message || 'Failed to load case');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCase(caseId);
  }, [caseId, loadCase]);

  // In candidate preview, interviewer-only pages are a HARD boundary — excluded
  // from the page list so their image URLs are never referenced or requested.
  const visiblePages = previewActive
    ? pages.filter((p) => p.pageType !== 'INTERVIEWER_ONLY')
    : pages;

  // Keep currentPageId valid for the active page list (snap off restricted pages).
  useEffect(() => {
    if (!pages.length) return;
    if (visiblePages.some((p) => p.id === currentPageId)) return;
    const fromNum = pages.find((p) => p.id === currentPageId)?.pageNumber ?? 1;
    setCurrentPageId(nearestVisibleId(visiblePages, fromNum));
  }, [previewActive, pages, currentPageId, visiblePages]);

  const currentIndex = Math.max(0, visiblePages.findIndex((p) => p.id === currentPageId));
  const currentPage = visiblePages[currentIndex] || null;

  const goToIndex = (i) => {
    const clamped = Math.max(0, Math.min(visiblePages.length - 1, i));
    setCurrentPageId(visiblePages[clamped]?.id || null);
  };
  const next = () => goToIndex(currentIndex + 1);
  const prev = () => goToIndex(currentIndex - 1);
  const jumpToPage = (pageId) => setCurrentPageId(pageId);

  // --- Fullscreen + preview toggle ------------------------------------------
  const enterPreview = () => {
    preEnterPageIdRef.current = currentPageId;
    const visible = pages.filter((p) => p.pageType !== 'INTERVIEWER_ONLY');
    if (!visible.some((p) => p.id === currentPageId)) {
      const fromNum = pages.find((p) => p.id === currentPageId)?.pageNumber ?? 1;
      setCurrentPageId(nearestVisibleId(visible, fromNum));
    }
    setPreviewActive(true);
    setGlobalPreview(true);
    showControls();
    // Native fullscreen is an ENHANCEMENT — the CSS fixed overlay already fully
    // covers the screen on its own. Request it on the document root (not the fixed
    // overlay, which renders blank as a fullscreen element) and synchronously
    // within this click gesture (browsers block requestFullscreen otherwise).
    // Skip it entirely on Arc, whose fullscreen handling is unreliable.
    enteredFullscreenRef.current = false;
    enterTimeRef.current = Date.now();
    if (!isArcBrowser()) {
      try {
        const el = document.documentElement;
        if (el.requestFullscreen) {
          el.requestFullscreen()
            .then(() => {
              enteredFullscreenRef.current = true;
            })
            .catch(() => {});
        }
      } catch {
        /* fullscreen unavailable — CSS overlay is the fallback */
      }
    }
  };

  const exitPreview = useCallback(() => {
    setPreviewActive(false);
    setGlobalPreview(false);
    enteredFullscreenRef.current = false;
    if (preEnterPageIdRef.current) setCurrentPageId(preEnterPageIdRef.current);
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  const togglePreview = () => (previewActive ? exitPreview() : enterPreview());

  // Focus the overlay once mounted (fullscreen itself is requested in the click
  // gesture inside enterPreview).
  useEffect(() => {
    if (previewActive) overlayRef.current?.focus?.();
  }, [previewActive]);

  // If the user leaves a fullscreen WE entered (native Esc), also exit preview.
  // Guarded so spurious fullscreenchange events (Arc) or the enter/exit bounce
  // never auto-close the overlay — preview is otherwise closed only by the user.
  useEffect(() => {
    const onFsChange = () => {
      if (document.fullscreenElement) return; // just entered fullscreen
      if (!previewActive || !enteredFullscreenRef.current) return;
      if (Date.now() - enterTimeRef.current < 600) return; // ignore enter/exit bounce
      enteredFullscreenRef.current = false;
      exitPreview();
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [previewActive, exitPreview]);

  // Hotkeys: Cmd/Ctrl+Shift+P toggles (enter only when this viewer is focused, so
  // stacked viewers don't all fire); Esc + arrows while in preview.
  useEffect(() => {
    const onKey = (e) => {
      const toggle = (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'P' || e.key === 'p');
      if (toggle) {
        if (previewActive) {
          e.preventDefault();
          exitPreview();
        } else if (containerRef.current?.contains(document.activeElement)) {
          e.preventDefault();
          enterPreview();
        }
        return;
      }
      if (!previewActive) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        exitPreview();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        next();
        showControls();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
        showControls();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const showControls = () => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 2500);
  };
  useEffect(() => () => hideTimerRef.current && clearTimeout(hideTimerRef.current), []);

  // --- Case switch/override --------------------------------------------------
  const doSwitch = async (newCaseId) => {
    setSwitching(true);
    setError('');
    try {
      let result;
      if (assignment?.id) {
        result = await apiClient.patch(`/cases/assignments/${assignment.id}/override`, {
          caseId: newCaseId,
        });
      } else {
        result = await apiClient.post('/cases/assignments/self', {
          interviewId,
          applicationId,
          caseId: newCaseId,
        });
      }
      onAssignmentChange?.(applicationId, {
        id: result.id,
        caseId: result.caseId,
        caseTitle: result.caseTitle,
        overriddenAt: result.overriddenAt || null,
      });
      setPickerValue('');
      setConfirmSwitch(null);
    } catch (e) {
      setError(e.message || 'Failed to switch case');
    } finally {
      setSwitching(false);
    }
  };

  const exhibits = pages.filter((p) => p.pageType === 'EXHIBIT');
  const guides = pages.filter((p) => p.pageType === 'INTERVIEWER_ONLY');

  // --- No case assigned: inline picker --------------------------------------
  if (!caseId) {
    return (
      <div className="case-viewer case-viewer--empty">
        <p className="case-viewer__empty-title">No case assigned</p>
        {canManage ? (
          <>
            <p className="case-viewer__empty-sub">Pick a case to run for this candidate.</p>
            <div className="case-viewer__picker">
              <select value={pickerValue} onChange={(e) => setPickerValue(e.target.value)} disabled={switching}>
                <option value="">Select a case…</option>
                {activeCases.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
              <button
                className="case-viewer__btn case-viewer__btn--primary"
                disabled={!pickerValue || switching}
                onClick={() => doSwitch(pickerValue)}
              >
                Load case
              </button>
            </div>
          </>
        ) : (
          <p className="case-viewer__empty-sub">
            No case has been assigned yet. Ask the lead interviewer or an admin to assign one.
          </p>
        )}
        {error && <p className="case-viewer__error">{error}</p>}
      </div>
    );
  }

  // --- Candidate preview overlay (portal) -----------------------------------
  const previewOverlay = previewActive
    ? createPortal(
        <div
          className="case-preview-overlay"
          ref={overlayRef}
          tabIndex={-1}
          onMouseMove={showControls}
        >
          <div className="case-preview-overlay__stage">
            {currentPage ? (
              <CasePageImage
                key={currentPage.id}
                src={`/api/cases/${caseId}/pages/${currentPage.id}/image`}
                alt={`Page ${currentPage.pageNumber}`}
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
              />
            ) : (
              <div style={{ color: '#fff' }}>No page to display.</div>
            )}
          </div>

          <div className={`case-preview-overlay__chrome ${controlsVisible ? 'is-visible' : ''}`}>
            {/* Exhibit-only quick jump (no interviewer-only jumps in preview) */}
            {exhibits.length > 0 && (
              <div className="case-preview-overlay__jumpbar">
                {exhibits.map((p) => (
                  <button
                    key={p.id}
                    className={`case-preview-overlay__jump ${currentPage?.id === p.id ? 'is-active' : ''}`}
                    onClick={() => jumpToPage(p.id)}
                  >
                    {p.exhibitLabel || `Exhibit (p.${p.pageNumber})`}
                  </button>
                ))}
              </div>
            )}

            {visiblePages.length > 1 && (
              <>
                <button
                  className="case-preview-overlay__nav case-preview-overlay__nav--prev"
                  onClick={prev}
                  disabled={currentIndex === 0}
                  aria-label="Previous"
                >
                  ‹
                </button>
                <button
                  className="case-preview-overlay__nav case-preview-overlay__nav--next"
                  onClick={next}
                  disabled={currentIndex === visiblePages.length - 1}
                  aria-label="Next"
                >
                  ›
                </button>
              </>
            )}

            {/* Discreet exit control */}
            <button className="case-preview-overlay__exit" onClick={exitPreview} title="Exit candidate view (Esc)">
              Exit candidate view
            </button>
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <div className="case-viewer" ref={containerRef} tabIndex={0}>
      {/* Header: case title + candidate-view toggle + override control */}
      <div className="case-viewer__header">
        <div className="case-viewer__title">
          {caseData?.title || 'Case'}
          {assignment?.overriddenAt && <span className="case-viewer__badge-overridden">overridden</span>}
        </div>
        <div className="case-viewer__header-actions">
          <button
            className="case-viewer__btn case-viewer__btn--primary case-viewer__preview-btn"
            onClick={togglePreview}
            title="Full-screen candidate-safe view (Cmd/Ctrl+Shift+P)"
          >
            Candidate View
          </button>
          {canManage && (
            <select
              className="case-viewer__switch-select"
              value=""
              disabled={switching}
              onChange={(e) => {
                if (e.target.value) setConfirmSwitch(e.target.value);
              }}
            >
              <option value="">Change case…</option>
              {activeCases
                .filter((c) => c.id !== caseId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
            </select>
          )}
        </div>
      </div>

      {error && <p className="case-viewer__error">{error}</p>}

      {/* When preview is active the inline viewer renders NO case images so no
          interviewer-only page image can be present in the DOM. */}
      {previewActive ? (
        <div className="case-viewer__preview-placeholder">
          <span>Candidate view is active on this screen.</span>
          <button className="case-viewer__btn" onClick={exitPreview}>
            Exit candidate view
          </button>
        </div>
      ) : (
        <>
          {/* Exhibit / guide quick-jump bar */}
          {(exhibits.length > 0 || guides.length > 0) && (
            <div className="case-viewer__jumpbar">
              {exhibits.map((p) => (
                <button
                  key={p.id}
                  className={`case-viewer__jump ${currentPage?.id === p.id ? 'is-active' : ''}`}
                  onClick={() => jumpToPage(p.id)}
                >
                  {p.exhibitLabel || `Exhibit (p.${p.pageNumber})`}
                </button>
              ))}
              {guides.map((p) => (
                <button
                  key={p.id}
                  className={`case-viewer__jump case-viewer__jump--guide ${
                    currentPage?.id === p.id ? 'is-active' : ''
                  }`}
                  onClick={() => jumpToPage(p.id)}
                >
                  {p.exhibitLabel || `Guide (p.${p.pageNumber})`}
                </button>
              ))}
            </div>
          )}

          {/* Main page */}
          <div
            className={`case-viewer__stage ${
              currentPage?.pageType === 'INTERVIEWER_ONLY' ? 'is-interviewer-only' : ''
            }`}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') {
                e.preventDefault();
                next();
              } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                prev();
              }
            }}
          >
            {loading ? (
              <div className="case-viewer__loading">Loading case…</div>
            ) : currentPage ? (
              <>
                {currentPage.pageType === 'INTERVIEWER_ONLY' && (
                  <div className="case-viewer__io-badge">Interviewer only — hidden from candidate view</div>
                )}
                <CasePageImage
                  key={currentPage.id}
                  src={`/api/cases/${caseId}/pages/${currentPage.id}/image`}
                  alt={`Page ${currentPage.pageNumber}`}
                  className="case-viewer__img"
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                />
              </>
            ) : (
              <div className="case-viewer__loading">No pages to display.</div>
            )}

            {visiblePages.length > 1 && (
              <>
                <button
                  className="case-viewer__nav case-viewer__nav--prev"
                  onClick={prev}
                  disabled={currentIndex === 0}
                  aria-label="Previous page"
                >
                  ‹
                </button>
                <button
                  className="case-viewer__nav case-viewer__nav--next"
                  onClick={next}
                  disabled={currentIndex === visiblePages.length - 1}
                  aria-label="Next page"
                >
                  ›
                </button>
              </>
            )}
          </div>

          {/* Page indicator + thumbnails */}
          <div className="case-viewer__footer">
            <span className="case-viewer__indicator">
              Page {currentPage ? currentIndex + 1 : 0} / {visiblePages.length}
            </span>
            <div className="case-viewer__thumbs">
              {visiblePages.map((p, i) => (
                <button
                  key={p.id}
                  className={`case-viewer__thumb ${p.id === currentPageId ? 'is-active' : ''} ${
                    p.pageType === 'INTERVIEWER_ONLY' ? 'is-io' : ''
                  }`}
                  onClick={() => setCurrentPageId(p.id)}
                  title={p.exhibitLabel || `Page ${p.pageNumber}`}
                >
                  <CasePageImage
                    src={`/api/cases/${caseId}/pages/${p.id}/image`}
                    alt={`Thumb ${p.pageNumber}`}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Confirm switch dialog */}
      {confirmSwitch && (
        <div className="case-viewer__confirm-backdrop" onClick={() => setConfirmSwitch(null)}>
          <div className="case-viewer__confirm" onClick={(e) => e.stopPropagation()}>
            <p className="case-viewer__confirm-title">Switch case?</p>
            <p className="case-viewer__confirm-text">
              Notes already entered will be kept — only the displayed case changes.
            </p>
            <div className="case-viewer__confirm-actions">
              <button className="case-viewer__btn" onClick={() => setConfirmSwitch(null)} disabled={switching}>
                Cancel
              </button>
              <button
                className="case-viewer__btn case-viewer__btn--primary"
                onClick={() => doSwitch(confirmSwitch)}
                disabled={switching}
              >
                {switching ? 'Switching…' : 'Switch case'}
              </button>
            </div>
          </div>
        </div>
      )}

      {previewOverlay}
    </div>
  );
}
