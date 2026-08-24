import React, { useEffect, useMemo, useState } from 'react';
import { XMarkIcon, DocumentDuplicateIcon, UserGroupIcon } from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import './CopyCandidateGroupDialog.css';

export default function CopyCandidateGroupDialog({ interview, applicationGroups, onClose, onCommitted }) {
  const [candidateGroups, setCandidateGroups] = useState([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [selectedSourceGroupId, setSelectedSourceGroupId] = useState('');
  const [selectedTargetGroupId, setSelectedTargetGroupId] = useState('');
  const [mode, setMode] = useState('add');
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [commitLoading, setCommitLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingGroups(true);
    apiClient
      .get('/review-teams')
      .then((groups) => {
        if (!cancelled) setCandidateGroups(groups || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load candidate groups');
      })
      .finally(() => {
        if (!cancelled) setLoadingGroups(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedSourceGroup = useMemo(
    () => candidateGroups.find((g) => g.id === selectedSourceGroupId),
    [candidateGroups, selectedSourceGroupId]
  );

  const targetOptions = useMemo(
    () => [{ id: '', name: '+ Create new application group' }, ...(applicationGroups || [])],
    [applicationGroups]
  );

  const clearPreview = () => {
    setPreview(null);
    setError(null);
  };

  const buildBody = () => ({
    sourceGroupId: selectedSourceGroupId,
    targetGroupId: selectedTargetGroupId || undefined,
    mode,
  });

  const handlePreview = async () => {
    if (!selectedSourceGroupId) return;
    clearPreview();
    setPreviewLoading(true);
    try {
      const response = await apiClient.post(
        `/admin/interviews/${interview.id}/copy-candidate-groups/preview`,
        buildBody()
      );
      setPreview(response.preview || response);
    } catch (err) {
      setError(err.message || 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleCommit = async () => {
    if (!selectedSourceGroupId || !preview) return;
    setCommitLoading(true);
    setError(null);
    try {
      const result = await apiClient.post(
        `/admin/interviews/${interview.id}/copy-candidate-groups/commit`,
        buildBody()
      );
      onCommitted(interview.id, result);
    } catch (err) {
      setError(err.message || 'Commit failed');
    } finally {
      setCommitLoading(false);
    }
  };

  const renderPreviewList = (items, showMeta = false) => {
    if (!items || items.length === 0) {
      return <div className="empty">None</div>;
    }
    return items.map((item, index) => (
      <div key={index} className="copy-preview-item">
        <span>{item.firstName} {item.lastName}</span>
        {showMeta && item.studentId && (
          <span className="meta">{item.studentId}</span>
        )}
      </div>
    ));
  };

  const counts = preview
    ? {
        additions: preview.additions?.length ?? 0,
        duplicates: preview.duplicates?.length ?? 0,
        skipped: preview.skipped?.length ?? 0,
        removals: preview.removals?.length ?? 0,
      }
    : null;

  return (
    <div className="modal-overlay copy-candidate-group-dialog" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="dialog-title">
            <DocumentDuplicateIcon className="title-icon" />
            Copy Candidate Group
          </h3>
          <button className="icon-btn" onClick={onClose} title="Close">
            <XMarkIcon className="btn-icon" />
          </button>
        </div>

        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          <div className="form-row">
            <label htmlFor="source-group">Source Candidate Group</label>
            {loadingGroups ? (
              <div>Loading candidate groups...</div>
            ) : (
              <select
                id="source-group"
                value={selectedSourceGroupId}
                onChange={(e) => {
                  setSelectedSourceGroupId(e.target.value);
                  clearPreview();
                }}
              >
                <option value="">Select a candidate group</option>
                {candidateGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name} ({group.applications?.length || 0} candidates)
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="form-row">
            <label htmlFor="target-group">Destination Interview Group</label>
            <select
              id="target-group"
              value={selectedTargetGroupId}
              onChange={(e) => {
                setSelectedTargetGroupId(e.target.value);
                clearPreview();
              }}
            >
              {targetOptions.map((group) => (
                <option key={group.id || 'new'} value={group.id || ''}>
                  {group.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <label>Copy Mode</label>
            <div className="radio-row">
              <label>
                <input
                  type="radio"
                  name="copyMode"
                  value="add"
                  checked={mode === 'add'}
                  onChange={() => {
                    setMode('add');
                    clearPreview();
                  }}
                />
                Add to existing group
              </label>
              <label>
                <input
                  type="radio"
                  name="copyMode"
                  value="replace"
                  checked={mode === 'replace'}
                  onChange={() => {
                    setMode('replace');
                    clearPreview();
                  }}
                />
                Replace group contents
              </label>
            </div>
          </div>

          <div className="dialog-footer">
            <button className="btn-secondary small" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn-primary small"
              onClick={handlePreview}
              disabled={!selectedSourceGroupId || previewLoading}
            >
              {previewLoading ? 'Previewing...' : 'Preview'}
            </button>
          </div>

          {preview && (
            <div className="copy-preview">
              <h4>
                <UserGroupIcon className="title-icon" />
                Preview: {selectedSourceGroup?.name} → {preview.targetGroup?.name}
              </h4>

              <div className="copy-preview-counts">
                <div className="copy-preview-count">
                  <strong>{counts.additions}</strong>
                  <span>Additions</span>
                </div>
                <div className="copy-preview-count">
                  <strong>{counts.duplicates}</strong>
                  <span>Duplicates</span>
                </div>
                <div className="copy-preview-count">
                  <strong>{counts.skipped}</strong>
                  <span>Skipped</span>
                </div>
                {mode === 'replace' && (
                  <div className="copy-preview-count">
                    <strong>{counts.removals}</strong>
                    <span>Removed</span>
                  </div>
                )}
              </div>

              <div className="copy-preview-section">
                <h5>Additions ({counts.additions})</h5>
                <div className="copy-preview-list">
                  {renderPreviewList(preview.additions, true)}
                </div>
              </div>

              <div className="copy-preview-section">
                <h5>Already present (will remain) ({counts.duplicates})</h5>
                <div className="copy-preview-list">
                  {renderPreviewList(preview.duplicates, true)}
                </div>
              </div>

              {mode === 'replace' && (
                <div className="copy-preview-section">
                  <h5>Removed ({counts.removals})</h5>
                  <div className="copy-preview-list">
                    {preview.removals?.length > 0 ? (
                      preview.removals.map((item, index) => (
                        <div key={index} className="copy-preview-item">
                          <span>Application {item.applicationId.slice(-8)}</span>
                        </div>
                      ))
                    ) : (
                      <div className="empty">None</div>
                    )}
                  </div>
                </div>
              )}

              {counts.skipped > 0 && (
                <div className="copy-preview-section skipped">
                  <h5>Skipped / Ineligible ({counts.skipped})</h5>
                  <div className="copy-preview-list">
                    {preview.skipped.map((item, index) => (
                      <div key={index} className="copy-preview-item">
                        <span>
                          {item.firstName} {item.lastName}
                          {item.studentId && <span className="meta"> ({item.studentId})</span>}
                        </span>
                        <span className="meta">
                          {item.reason === 'no_application'
                            ? 'No application in this cycle'
                            : `Missing: ${item.missingFields?.join(', ')}`}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="dialog-footer">
                <button className="btn-secondary small" onClick={() => setPreview(null)}>
                  Clear
                </button>
                <button
                  className="btn-primary small"
                  onClick={handleCommit}
                  disabled={commitLoading}
                >
                  {commitLoading ? 'Committing...' : 'Commit'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
