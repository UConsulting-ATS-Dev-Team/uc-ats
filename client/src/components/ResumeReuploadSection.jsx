import React, { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../utils/api';

const formatDateTime = (value) =>
  new Date(value).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

const formatDeadline = (isoDeadline, label) => {
  if (isoDeadline) {
    return new Date(isoDeadline).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }
  // Older cycles store the deadline as free text ("Oct 4th, Morning"); show it
  // as written rather than pretending it is a date.
  return label;
};

const formatSize = (bytes) => {
  if (!bytes) return null;
  const mb = bytes / (1024 * 1024);
  return mb >= 0.1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

/**
 * Lets an applicant swap in a new resume PDF for an application they already
 * submitted, and shows every version that has been on the application so they
 * can see exactly what reviewers are looking at.
 *
 * `onReplaced` is called with the new resume URL so the surrounding view can
 * repoint its own "View Resume" link.
 */
export default function ResumeReuploadSection({ applicationId, onPreview, onReplaced }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const fileInputRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError('');
      setState(await apiClient.get(`/resume-uploads/applications/${applicationId}`));
    } catch (e) {
      setLoadError(e.message || 'Failed to load your resume history');
    } finally {
      setLoading(false);
    }
  }, [applicationId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSelect = (event) => {
    const selected = event.target.files?.[0] || null;
    setUploadError('');
    setConfirmation('');

    if (selected && selected.type !== 'application/pdf') {
      setFile(null);
      setUploadError('Your resume must be a PDF.');
      return;
    }
    if (selected && state?.maxBytes && selected.size > state.maxBytes) {
      setFile(null);
      setUploadError(`That file is larger than ${Math.round(state.maxBytes / (1024 * 1024))}MB.`);
      return;
    }
    setFile(selected);
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setUploadError('');
    setConfirmation('');

    try {
      const body = new FormData();
      body.append('resume', file);
      const result = await apiClient.post(`/resume-uploads/applications/${applicationId}`, body);

      setState((previous) => ({
        ...previous,
        currentResumeUrl: result.currentResumeUrl,
        versions: result.versions,
      }));
      setConfirmation(result.message || 'Your resume has been updated.');
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      onReplaced?.(result.currentResumeUrl);
    } catch (e) {
      setUploadError(e.message || 'Failed to upload your resume');
    } finally {
      setUploading(false);
    }
  };

  if (loading) return <div className="resume-reupload"><p className="resume-reupload-note">Loading resume history…</p></div>;
  if (loadError) return <div className="resume-reupload"><p className="resume-reupload-error">{loadError}</p></div>;
  if (!state) return null;

  const deadline = formatDeadline(state.deadline, state.deadlineLabel);
  const versions = [...(state.versions || [])].reverse();

  return (
    <div className="resume-reupload">
      <h5 className="resume-reupload-title">Replace your resume</h5>

      {state.canReplace ? (
        <>
          <p className="resume-reupload-note">
            Uploading a new PDF replaces the resume reviewers see. Your previous versions are kept below.
            {deadline ? ` You can make changes until ${deadline}.` : ''}
          </p>

          <div className="resume-reupload-controls">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              onChange={handleSelect}
              disabled={uploading}
              aria-label="Choose a new resume PDF"
            />
            <button
              type="button"
              className="document-link"
              onClick={handleUpload}
              disabled={!file || uploading}
            >
              {uploading ? 'Uploading…' : 'Upload new resume'}
            </button>
          </div>
        </>
      ) : (
        <p className="resume-reupload-note">{state.reason}</p>
      )}

      {uploadError && <p className="resume-reupload-error">{uploadError}</p>}
      {confirmation && <p className="resume-reupload-success">{confirmation}</p>}

      {versions.length > 0 && (
        <ul className="resume-version-list">
          {versions.map((version) => (
            <li key={version.id || 'original'} className="resume-version">
              <div className="resume-version-meta">
                <span className="resume-version-label">
                  {version.originalName || (version.replacedByCandidate ? 'Uploaded resume' : 'Submitted with your application')}
                  {version.isCurrent && <span className="resume-version-current">Current</span>}
                </span>
                <span className="resume-version-date">
                  {formatDateTime(version.uploadedAt)}
                  {formatSize(version.sizeBytes) ? ` · ${formatSize(version.sizeBytes)}` : ''}
                </span>
              </div>
              <button
                type="button"
                className="document-link"
                onClick={() => onPreview?.(version.url, version.isCurrent ? 'Resume (current)' : 'Resume (previous version)')}
              >
                View
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
