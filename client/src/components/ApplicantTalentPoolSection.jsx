import React, { useState } from 'react';
import apiClient from '../utils/api';

// The Talent Partner Network answer for someone who applied.
//
// Applicants gave this answer once, on the application form, and until now had
// no way to change it — the one group of the four (applicants, members, talent
// portal, onboarded candidates) with a consent decision they could not revisit.
//
// Its own control and its own save, rather than a field on the details form:
// everything there is a fact being corrected, while this is a permission, and
// turning it off reaches past the row to withdraw the resume from companies
// that already have it.

export default function ApplicantTalentPoolSection({ optedIn, onChanged }) {
  const [shared, setShared] = useState(optedIn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const setSharing = async (next) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await apiClient.patch('/applicant-info/talent-pool', {
        talentPoolOptIn: next,
      });
      setShared(next);
      setMessage(result.message || 'Your preference has been updated.');
      if (onChanged) onChanged(next);
    } catch (e) {
      setError(e.message || 'Failed to update your sharing preference');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="applicant-section">
      <h2 className="applicant-section-title">Talent Partner Network</h2>
      <p className="applicant-note">
        UConsulting shares resumes with partner organizations hiring interns and early-career
        candidates. This is separate from your application and has no bearing on it. You can change
        this at any time — saying no withdraws your resume from every company that already has it.
      </p>

      <div className="applicant-grid">
        <div className="applicant-field">
          <span className="applicant-label">Current answer</span>
          <span className="applicant-readonly">
            {shared === true ? 'Shared with partners' : shared === false ? 'Not shared' : 'Not answered'}
          </span>
        </div>
      </div>

      <div className="applicant-actions">
        <button
          type="button"
          className="applicant-save"
          disabled={busy || shared === true}
          onClick={() => setSharing(true)}
        >
          Yes, share it
        </button>
        <button
          type="button"
          className="applicant-save"
          disabled={busy || shared === false}
          onClick={() => setSharing(false)}
        >
          No, do not share
        </button>
      </div>

      {error && <p className="applicant-error">{error}</p>}
      {message && <p className="applicant-success">{message}</p>}
    </section>
  );
}
