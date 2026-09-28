import React from 'react';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import '../styles/ApplyHereButton.css';

// Opens the open cycle's application, which is a Google Form outside the ATS.
// The caption says so, since nothing in the ATS itself submits an application.
// Renders nothing without a link, so callers pass the result of applyLinkFor
// and never check it themselves.
export default function ApplyHereButton({ href }) {
  if (!href) return null;
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
