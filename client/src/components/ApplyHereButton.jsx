import React, { useEffect, useState } from 'react';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import '../styles/ApplyHereButton.css';

// setTimeout fires at once for any delay past this (about 24.8 days).
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// Opens the open cycle's application, which is a Google Form outside the ATS.
// The caption says so, since nothing in the ATS itself submits an application.
// Renders nothing without a link, so callers pass the result of applyLinkFor
// and never check it themselves.
//
// `closesAt` is the application deadline. applyLinkFor only looks at it when a
// page loads, so a page left open across the deadline would keep offering the
// form; the button hides itself when the deadline arrives.
export default function ApplyHereButton({ href, closesAt }) {
  const closesAtMs = closesAt ? new Date(closesAt).getTime() : NaN;
  const [closed, setClosed] = useState(() => closesAtMs <= Date.now());

  useEffect(() => {
    if (Number.isNaN(closesAtMs)) {
      setClosed(false);
      return undefined;
    }
    const remaining = closesAtMs - Date.now();
    setClosed(remaining <= 0);
    if (remaining <= 0 || remaining > MAX_TIMEOUT_MS) return undefined;
    const timer = setTimeout(() => setClosed(true), remaining);
    return () => clearTimeout(timer);
  }, [closesAtMs]);

  if (!href || closed) return null;
  return (
    <span className="apply-here">
      <a
        className="apply-here-button"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-describedby="apply-here-caption"
        data-track="apply-here"
      >
        Apply Here
        <ArrowTopRightOnSquareIcon className="apply-here-icon" aria-hidden="true" />
      </a>
      <span className="apply-here-caption" id="apply-here-caption">
        Opens the application Google Form in a new tab
      </span>
    </span>
  );
}
