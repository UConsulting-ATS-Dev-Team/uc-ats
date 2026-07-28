import React, { useEffect, useState } from 'react';
import {
  XMarkIcon,
  DocumentDuplicateIcon,
  UsersIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
} from '@heroicons/react/24/outline';
import apiClient from '../utils/api';

export default function CandidateGroupCopyModal({
  interview,
  applicationGroups,
  onClose,
  onCopy,
}) {
  const [candidateGroups, setCandidateGroups] = useState([]);
  const [sourceGroupId, setSourceGroupId] = useState('');
  const [destinationGroupId, setDestinationGroupId] = useState('');
  const [createNewGroup, setCreateNewGroup] = useState(true);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const groups = await apiClient.get('/review-teams');
        if (!cancelled) setCandidateGroups(Array.isArray(groups) ? groups : []);
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load candidate groups');
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setPreview(null);
    setError('');
  }, [sourceGroupId, destinationGroupId, createNewGroup]);

  const canPreview = sourceGroupId && (createNewGroup || destinationGroupId);

  const handlePreview = async () => {
    if (!canPreview) return;
    setPreviewLoading(true);
    setError('');
    setPreview(null);
    try {
      const body = {
        sourceGroupId,
        destinationGroupId: createNewGroup ? undefined : destinationGroupId,
      };
      const data = await apiClient.post(
        `/admin/interviews/${interview.id}/copy-candidate-group-preview`,
        body
      );
      setPreview(data);
    } catch (e) {
      setError(e.message || 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleCommit = async () => {
    if (!canPreview) return;
    setLoading(true);
    setError('');
    try {
      const body = {
        sourceGroupId,
        destinationGroupId: createNewGroup ? undefined : destinationGroupId,
      };
      const data = await apiClient.post(
        `/admin/interviews/${interview.id}/copy-candidate-group`,
        body
      );
      onCopy(data);
    } catch (e) {
      setError(e.message || 'Copy failed');
    } finally {
      setLoading(false);
    }
  };

  const selectedGroup = candidateGroups.find((g) => g.id === sourceGroupId);

  return (
    <div className="modal-overlay">
      <div className="modal-content group-copy-modal">
        <div className="modal-header">
          <h3><DocumentDuplicateIcon className="btn-icon" /> Copy Candidate Group</h3>
          <button className="icon-btn" onClick={onClose}>
            <XMarkIcon className="btn-icon" />
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-description">
            Copy candidates from a source candidate group into <strong>{interview.title}</strong>.
            Existing members of the destination group are preserved (add-only).
          </p>

          {error && (
            <div className="alert alert-error">
              <ExclamationTriangleIcon className="btn-icon" />
              {error}
            </div>
          )}

          <div className="form-row">
            <label htmlFor="source-group-select">Source Candidate Group</label>
            <select
              id="source-group-select"
              value={sourceGroupId}
              onChange={(e) => setSourceGroupId(e.target.value)}
            >
              <option value="">Select a candidate group</option>
              {candidateGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name || `Group ${group.id.slice(-4)}`} ({group.applications?.length || 0} candidates)
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <label htmlFor="destination-group-select">Destination Application Group</label>
            <select
              id="destination-group-select"
              value={createNewGroup ? 'new' : destinationGroupId}
              onChange={(e) => {
                const value = e.target.value;
                if (value === 'new') {
                  setCreateNewGroup(true);
                  setDestinationGroupId('');
                } else {
                  setCreateNewGroup(false);
                  setDestinationGroupId(value);
                }
              }}
            >
              <option value="new">Create new application group</option>
              {applicationGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name || `Group ${group.id.slice(-4)}`} ({group.applicationIds?.length || 0} candidates)
                </option>
              ))}
            </select>
          </div>

          <div className="modal-actions">
            <button
              className="btn-secondary"
              onClick={handlePreview}
              disabled={!canPreview || previewLoading}
            >
              {previewLoading ? 'Previewing...' : 'Preview'}
            </button>
          </div>

          {preview && (
            <div className="copy-preview">
              <h4>Preview</h4>

              <div className="preview-summary">
                <div className="preview-stat success">
                  <CheckCircleIcon className="btn-icon" />
                  <span>{preview.additionCount} addition(s)</span>
                </div>
                <div className="preview-stat warning">
                  <DocumentDuplicateIcon className="btn-icon" />
                  <span>{preview.duplicateCount} duplicate(s)</span>
                </div>
                <div className="preview-stat error">
                  <ExclamationTriangleIcon className="btn-icon" />
                  <span>{preview.skippedCount} skipped / ineligible</span>
                </div>
              </div>

              {preview.additions.length > 0 && (
                <div className="preview-section">
                  <h5>Additions</h5>
                  <ul className="preview-list">
                    {preview.additions.map((a) => (
                      <li key={a.applicationId}>{a.name} ({a.email})</li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.duplicates.length > 0 && (
                <div className="preview-section">
                  <h5>Duplicates (already in destination)</h5>
                  <ul className="preview-list">
                    {preview.duplicates.map((a) => (
                      <li key={a.applicationId}>{a.name} ({a.email})</li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.skipped.length > 0 && (
                <div className="preview-section">
                  <h5>Skipped / Ineligible</h5>
                  <ul className="preview-list">
                    {preview.skipped.map((s) => (
                      <li key={s.candidateId}>
                        {s.name} — {s.reason.replace(/_/g, ' ')}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={handleCommit}
            disabled={!canPreview || !preview || loading}
          >
            {loading ? 'Copying...' : 'Copy Candidates'}
          </button>
        </div>
      </div>
    </div>
  );
}
