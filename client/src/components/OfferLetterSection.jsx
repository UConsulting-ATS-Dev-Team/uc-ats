import React, { useEffect, useMemo, useState } from 'react';
import apiClient from '../utils/api';

const OFFER_SENT_PREFIX = '[OFFER_LETTER_SENT]';

function isFinalRoundAccepted(application) {
  return (
    application?.status === 'ACCEPTED' &&
    (application?.finalRoundDecision === 'yes' || application?.currentRound === '5')
  );
}

function base64ToBlob(base64, contentType) {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: contentType });
}

export default function OfferLetterSection({ application, comments = [], isAdmin, onSent }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    position: '',
    startDate: '',
    responseDeadline: '',
    additionalNotes: ''
  });
  const [template, setTemplate] = useState(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [force, setForce] = useState(false);
  const [sending, setSending] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);
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

  useEffect(() => {
    if (!isAdmin || !isFinalRoundAccepted(application) || !application?.cycleId) return;
    let cancelled = false;
    setTemplateLoading(true);
    apiClient
      .get(`/admin/cycles/${application.cycleId}/offer-letter-template`)
      .then((data) => {
        if (!cancelled) {
          setTemplate(data);
          setForm((prev) => ({
            ...prev,
            responseDeadline: data.responseDeadline || prev.responseDeadline
          }));
        }
      })
      .catch((err) => {
        console.warn('Failed to load offer letter template:', err);
      })
      .finally(() => {
        if (!cancelled) setTemplateLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, application]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

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
    setForm({ position: '', startDate: '', responseDeadline: template?.responseDeadline || '', additionalNotes: '' });
    setForce(false);
    setError(null);
    setSuccess(null);
  };

  const validateRequired = () => {
    if (!form.position.trim()) return 'Position is required';
    if (!form.responseDeadline.trim()) return 'Response deadline is required';
    return null;
  };

  const buildPayload = () => ({
    position: form.position.trim(),
    startDate: form.startDate.trim(),
    responseDeadline: form.responseDeadline.trim(),
    additionalNotes: form.additionalNotes.trim(),
    force
  });

  const handlePreview = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const validationError = validateRequired();
    if (validationError) {
      setError(validationError);
      return;
    }

    setPreviewing(true);
    try {
      const { pdf } = await apiClient.post(
        `/admin/applications/${application.id}/offer-letter-preview`,
        buildPayload()
      );
      const blob = base64ToBlob(pdf, 'application/pdf');
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
      setPreviewOpen(true);
    } catch (err) {
      setError(err.message || 'Failed to generate offer letter preview');
    } finally {
      setPreviewing(false);
    }
  };

  const handleSend = async () => {
    setError(null);
    setSuccess(null);
    setSending(true);
    try {
      await apiClient.post(`/admin/applications/${application.id}/send-offer-letter`, buildPayload());
      setSuccess(force ? 'Offer letter resent successfully.' : 'Offer letter sent successfully.');
      setForm({ position: '', startDate: '', responseDeadline: template?.responseDeadline || '', additionalNotes: '' });
      setForce(false);
      setPreviewOpen(false);
      setTimeout(() => setShowForm(false), 1500);
      onSent?.();
    } catch (err) {
      setError(err.message || 'Failed to send offer letter');
    } finally {
      setSending(false);
    }
  };

  const closePreview = () => {
    setPreviewOpen(false);
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

  const templateReady = template && template.presidentName?.trim() && template.signaturePath;

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
        {templateLoading && (
          <div style={{ fontSize: '0.875rem', color: '#6b7280' }}>Loading template...</div>
        )}
        {!templateReady && !templateLoading && (
          <div style={{ fontSize: '0.875rem', color: '#92400e', marginTop: '4px' }}>
            Offer letter template is not ready. Configure the president name and signature in Cycle Management before sending.
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
        <>
          <form onSubmit={handlePreview}>
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
                  placeholder="e.g. Friday, January 23rd at 11:59 PM"
                  style={inputStyle}
                />
              </label>

              <label style={labelStyle}>
                Additional Notes
                <textarea
                  value={form.additionalNotes}
                  onChange={handleChange('additionalNotes')}
                  placeholder="Any extra details to include in the email body..."
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

              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  type="submit"
                  disabled={previewing}
                  style={{
                    padding: '10px 16px',
                    backgroundColor: previewing ? '#9ca3af' : '#3b82f6',
                    color: 'white',
                    border: 'none',
                    borderRadius: '8px',
                    fontSize: '0.875rem',
                    fontWeight: '500',
                    cursor: previewing ? 'not-allowed' : 'pointer'
                  }}
                >
                  {previewing ? 'Generating Preview...' : 'Preview Offer Letter'}
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

          {previewOpen && previewUrl && (
            <div
              style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.5)',
                zIndex: 1000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '20px'
              }}
            >
              <div
                style={{
                  backgroundColor: 'white',
                  borderRadius: '12px',
                  width: '100%',
                  maxWidth: '900px',
                  maxHeight: '90vh',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden'
                }}
              >
                <div
                  style={{
                    padding: '16px',
                    borderBottom: '1px solid #e5e7eb',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}
                >
                  <h3 style={{ margin: 0, fontSize: '1rem' }}>Offer Letter Preview</h3>
                  <button
                    type="button"
                    onClick={closePreview}
                    style={{
                      background: 'none',
                      border: 'none',
                      fontSize: '1.25rem',
                      cursor: 'pointer',
                      color: '#6b7280'
                    }}
                  >
                    &times;
                  </button>
                </div>
                <div style={{ flex: 1, overflow: 'auto', padding: '16px', minHeight: '400px' }}>
                  <iframe
                    src={previewUrl}
                    title="Offer Letter Preview"
                    style={{ width: '100%', height: '500px', border: '1px solid #e5e7eb', borderRadius: '8px' }}
                  />
                </div>
                <div
                  style={{
                    padding: '16px',
                    borderTop: '1px solid #e5e7eb',
                    display: 'flex',
                    gap: '12px',
                    justifyContent: 'flex-end'
                  }}
                >
                  <button
                    type="button"
                    onClick={closePreview}
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
                  <button
                    type="button"
                    onClick={handleSend}
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
                    {sending ? 'Sending...' : force ? 'Resend Offer Letter' : 'Approve & Send Offer Letter'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
