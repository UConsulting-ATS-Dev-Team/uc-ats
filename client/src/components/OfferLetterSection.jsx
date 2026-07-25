import React, { useMemo, useState } from 'react';
import apiClient from '../utils/api';

const OFFER_SENT_PREFIX = '[OFFER_LETTER_SENT]';

function isFinalRoundAccepted(application) {
  return (
    application?.status === 'ACCEPTED' &&
    (application?.finalRoundDecision === 'yes' || application?.currentRound === '5')
  );
}

export default function OfferLetterSection({ application, comments = [], isAdmin, onSent }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    position: '',
    startDate: '',
    responseDeadline: '',
    additionalNotes: ''
  });
  const [force, setForce] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const sentComments = useMemo(
    () =>
      comments
        .filter((c) => c.content?.startsWith(OFFER_SENT_PREFIX))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    [comments]
  );
  const lastSent = sentComments[0];

  if (!isAdmin || !isFinalRoundAccepted(application)) {
    return null;
  }

  const handleChange = (field) => (e) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
    setError(null);
    setSuccess(null);
  };

  const openForm = (resend = false) => {
    setShowForm(true);
    setForce(resend);
    setError(null);
    setSuccess(null);
  };

  const closeForm = () => {
    setShowForm(false);
    setForm({ position: '', startDate: '', responseDeadline: '', additionalNotes: '' });
    setForce(false);
    setError(null);
    setSuccess(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!form.position.trim()) {
      setError('Position is required');
      return;
    }
    if (!form.responseDeadline.trim()) {
      setError('Response deadline is required');
      return;
    }

    setSending(true);
    try {
      const payload = {
        position: form.position.trim(),
        startDate: form.startDate.trim(),
        responseDeadline: form.responseDeadline.trim(),
        additionalNotes: form.additionalNotes.trim(),
        force
      };
      await apiClient.post(`/admin/applications/${application.id}/send-offer-letter`, payload);
      setSuccess(force ? 'Offer letter resent successfully.' : 'Offer letter sent successfully.');
      setForm({ position: '', startDate: '', responseDeadline: '', additionalNotes: '' });
      setForce(false);
      setTimeout(() => setShowForm(false), 1500);
      onSent?.();
    } catch (err) {
      setError(err.message || 'Failed to send offer letter');
    } finally {
      setSending(false);
    }
  };

  const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid #d1d5db',
    borderRadius: '8px',
    fontSize: '0.875rem',
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box'
  };

  const labelStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    fontSize: '0.875rem',
    fontWeight: '500',
    color: '#374151'
  };

  return (
    <div className="info-section" style={{ backgroundColor: '#f0fdf4', border: '1px solid #bbf7d0' }}>
      <h2 className="section-title">Offer Letter</h2>

      <div style={{ marginBottom: '1rem' }}>
        <div style={{ fontSize: '0.875rem', color: '#374151', marginBottom: '4px' }}>
          <strong>Candidate:</strong> {application.firstName} {application.lastName} ({application.email})
        </div>
        {lastSent ? (
          <div style={{ fontSize: '0.875rem', color: '#15803d' }}>
            Offer letter sent on {new Date(lastSent.createdAt).toLocaleString()}
            {lastSent.user?.fullName ? ` by ${lastSent.user.fullName}` : ''}.
          </div>
        ) : (
          <div style={{ fontSize: '0.875rem', color: '#6b7280' }}>
            No offer letter has been sent yet.
          </div>
        )}
      </div>

      {!showForm ? (
        <button
          onClick={() => openForm(Boolean(lastSent))}
          style={{
            padding: '10px 16px',
            backgroundColor: '#10b981',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            fontSize: '0.875rem',
            fontWeight: '500',
            cursor: 'pointer'
          }}
        >
          {lastSent ? 'Resend Offer Letter' : 'Send Offer Letter'}
        </button>
      ) : (
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '1rem' }}>
            <label style={labelStyle}>
              Position <span style={{ color: '#dc2626' }}>*</span>
              <input
                type="text"
                value={form.position}
                onChange={handleChange('position')}
                placeholder="e.g. Junior Consultant"
                style={inputStyle}
              />
            </label>

            <label style={labelStyle}>
              Start Date
              <input
                type="text"
                value={form.startDate}
                onChange={handleChange('startDate')}
                placeholder="e.g. January 15, 2027 or TBD"
                style={inputStyle}
              />
            </label>

            <label style={labelStyle}>
              Response Deadline <span style={{ color: '#dc2626' }}>*</span>
              <input
                type="text"
                value={form.responseDeadline}
                onChange={handleChange('responseDeadline')}
                placeholder="e.g. August 15, 2026"
                style={inputStyle}
              />
            </label>

            <label style={labelStyle}>
              Additional Notes
              <textarea
                value={form.additionalNotes}
                onChange={handleChange('additionalNotes')}
                placeholder="Any extra details to include in the offer letter..."
                style={{ ...inputStyle, minHeight: '80px', resize: 'vertical' }}
              />
            </label>

            {error && (
              <div
                style={{
                  color: '#dc2626',
                  fontSize: '0.875rem',
                  padding: '8px 12px',
                  backgroundColor: '#fef2f2',
                  border: '1px solid #fecaca',
                  borderRadius: '6px'
                }}
              >
                {error}
              </div>
            )}

            {success && (
              <div
                style={{
                  color: '#15803d',
                  fontSize: '0.875rem',
                  padding: '8px 12px',
                  backgroundColor: '#dcfce7',
                  border: '1px solid #bbf7d0',
                  borderRadius: '6px'
                }}
              >
                {success}
              </div>
            )}

            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              <button
                type="submit"
                disabled={sending}
                style={{
                  padding: '10px 16px',
                  backgroundColor: sending ? '#9ca3af' : '#10b981',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '0.875rem',
                  fontWeight: '500',
                  cursor: sending ? 'not-allowed' : 'pointer'
                }}
              >
                {sending ? 'Sending...' : force ? 'Resend Offer Letter' : 'Send Offer Letter'}
              </button>
              <button
                type="button"
                onClick={closeForm}
                style={{
                  padding: '10px 16px',
                  backgroundColor: 'white',
                  color: '#374151',
                  border: '1px solid #d1d5db',
                  borderRadius: '8px',
                  fontSize: '0.875rem',
                  fontWeight: '500',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
