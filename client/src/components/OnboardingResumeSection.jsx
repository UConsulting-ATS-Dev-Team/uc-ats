import React, { useCallback, useEffect, useState } from 'react';
import apiClient from '../utils/api';

// The resume and sharing controls for a candidate who onboarded instead of
// applying.
//
// ResumeReuploadSection cannot serve them: it is keyed to an applicationId, and
// these people have no application - which is why this page used to show
// "Application not found" where their resume should be.
//
// The sharing question lives here rather than on the details form above because
// it is not a detail. Answering it moves a resume in or out of the partner
// network, and turning it off pulls the resume back from every company that
// already has it, so it gets its own control and its own save.

export default function OnboardingResumeSection({ record, onPreview, onReplaced }) {
  const [file, setFile] = useState(null);
  const [shared, setShared] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadSharing = useCallback(async () => {
    try {
      const data = await apiClient.get('/candidate/onboarding/status');
      setShared(Boolean(data.talentPool?.shared));
    } catch {
      // Leave it unanswered rather than guessing. Defaulting to "no" would look
      // like a withdrawal they never made; defaulting to "yes" would be worse.
    }
  }, []);

  useEffect(() => {
    loadSharing();
  }, [loadSharing]);

  const replace = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const body = new FormData();
      body.append('resume', file);
      const result = await apiClient.put('/candidate/onboarding/resume', body);
      setFile(null);
      setMessage(result.message || 'Your resume has been replaced.');
      if (onReplaced) onReplaced(result.onboarding);
    } catch (e) {
      setError(e.message || 'Failed to replace your resume');
    } finally {
      setBusy(false);
    }
  };

  const setSharing = async (next) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await apiClient.patch('/candidate/onboarding/talent-pool', {
        talentPoolOptIn: next,
      });
      setShared(Boolean(result.talentPool?.shared));
      setMessage(
        next
          ? 'Your resume is now shared with partner organizations.'
          : 'Sharing stopped, and your resume has been withdrawn from any company that had it.'
      );
    } catch (e) {
      setError(e.message || 'Failed to update your sharing preference');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="applicant-grid">
        <div className="applicant-field">
          <span className="applicant-label">Current resume</span>
          <span className="applicant-readonly">{record?.resumeOriginalName || 'None on file'}</span>
        </div>
      </div>

      <div className="applicant-actions">
        {record?.resumeOriginalName && (
          <button
            type="button"
            className="applicant-save"
            onClick={() => onPreview('/api/candidate/onboarding/resume', record.resumeOriginalName)}
          >
            Preview
          </button>
        )}
        <label className="applicant-save" style={{ cursor: 'pointer' }}>
          {file ? file.name : 'Choose a new PDF'}
          <input
            hidden
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
        <button type="button" className="applicant-save" disabled={!file || busy} onClick={replace}>
          {busy ? 'Saving…' : 'Replace resume'}
        </button>
      </div>

      <h2 className="applicant-section-title" style={{ marginTop: '1.5rem' }}>
        Talent Partner Network
      </h2>
      <p className="applicant-note">
        UConsulting shares resumes with partner organizations hiring interns and early-career
        candidates. You can change this at any time — saying no withdraws your resume from every
        company that already has it.
      </p>
      <div className="applicant-actions">
        <button
          type="button"
          className="applicant-save"
          disabled={busy || shared === true}
          onClick={() => setSharing(true)}
        >
          {shared === true ? 'Sharing — yes' : 'Yes, share it'}
        </button>
        <button
          type="button"
          className="applicant-save"
          disabled={busy || shared === false}
          onClick={() => setSharing(false)}
        >
          {shared === false ? 'Sharing — no' : 'No, do not share'}
        </button>
      </div>

      {error && <p className="applicant-error">{error}</p>}
      {message && <p className="applicant-success">{message}</p>}
    </>
  );
}
