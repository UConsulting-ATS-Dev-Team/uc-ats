import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeftIcon,
  CheckIcon,
  UserIcon,
  DocumentTextIcon
} from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import InterviewChatWidget from '../components/chat/InterviewChatWidget';
import '../styles/InterviewInterface.css';

export default function InterviewInterface() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const interviewId = searchParams.get('interviewId');
  const groupIds = searchParams.get('groupIds')?.split(',') || [];
  
  const [interview, setInterview] = useState(null);
  const [applications, setApplications] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [evaluations, setEvaluations] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [autoSaveTimeouts, setAutoSaveTimeouts] = useState({});
  const [saveStatus, setSaveStatus] = useState({});
  const [groupSelectionOpen, setGroupSelectionOpen] = useState(false);
  const [groupSearchTerm, setGroupSearchTerm] = useState('');
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [interviewData, setInterviewData] = useState({});
  const [allEvaluationsSaved, setAllEvaluationsSaved] = useState(false);
  const [showNextActionModal, setShowNextActionModal] = useState(false);


  const decisionOptions = [
    { value: 'YES', label: 'Yes', color: 'green' },
    { value: 'MAYBE_YES', label: 'Maybe-Yes', color: 'light-green' },
    { value: 'MAYBE_NO', label: 'Maybe-No', color: 'orange' },
    { value: 'NO', label: 'No', color: 'red' }
  ];

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true);
        console.log('Loading interview data for:', { interviewId, groupIds });
        console.log('URL search params:', searchParams.toString());
        console.log('Parsed groupIds:', groupIds);
        
        // Check if we have required parameters
        if (!interviewId) {
          throw new Error('No interview ID provided');
        }
        if (!groupIds || groupIds.length === 0) {
          console.warn('No group IDs provided, will show empty applications list');
          setApplications([]);
          setLoading(false);
          return;
        }
        
        // Load current user first to check authentication
        console.log('Loading current user...');
        const userRes = await apiClient.get('/admin/profile');
        console.log('Current user:', userRes);
        setCurrentUser(userRes);
        
        // Load interview details
        console.log('Loading interview details...');
        const interviewRes = await apiClient.get(`/admin/interviews/${interviewId}`);
        console.log('Interview data loaded:', interviewRes);
        console.log('Interview type from API:', interviewRes.interviewType);
        console.log('Is this supposed to be ROUND_ONE?', interviewRes.interviewType === 'ROUND_ONE');
        console.log('=== THIS IS THE ADMIN INTERVIEW INTERFACE ===');
        setInterview(interviewRes);
        
        // Parse interview description to get application groups
        let parsedDescription = {};
        try {
          parsedDescription = typeof interviewRes.description === 'string' 
            ? JSON.parse(interviewRes.description) 
            : interviewRes.description || {};
        } catch (e) {
          console.warn('Failed to parse interview description:', e);
        }
        
        console.log('Parsed interview description:', parsedDescription);
        console.log('Application groups:', parsedDescription.applicationGroups);
        
        // Load applications for selected groups
        console.log('Loading applications for groups:', groupIds);
        console.log('API URL:', `/admin/interviews/${interviewId}/applications?groupIds=${groupIds.join(',')}`);
        try {
          const applicationsRes = await apiClient.get(`/admin/interviews/${interviewId}/applications?groupIds=${groupIds.join(',')}`);
          console.log('Applications loaded:', applicationsRes);
          console.log('Applications count:', applicationsRes?.length || 0);
          setApplications(applicationsRes);
        } catch (appError) {
          console.error('Failed to load applications:', appError);
          console.error('Applications error details:', appError.response?.data || appError.message);
          setApplications([]);
        }
        
        // Load existing evaluations for the current user across all applications in this interview
        console.log('Loading existing evaluations...');
        const evaluationsRes = await apiClient.get(`/admin/interviews/${interviewId}/evaluations`);
        console.log('Evaluations loaded:', evaluationsRes);
        const evaluationsMap = {};
        evaluationsRes.forEach(evaluation => {
          evaluationsMap[`${evaluation.applicationId}_${evaluation.evaluatorId}`] = evaluation;
        });
        setEvaluations(evaluationsMap);

        // Set interview data with parsed description for group selection
        console.log('Setting interview data with parsed description...');
        const interviewDataWithGroups = {
          ...interviewRes,
          applicationGroups: parsedDescription.applicationGroups || []
        };
        setInterviewData(interviewDataWithGroups);
        
      } catch (error) {
        console.error('Failed to load interview data:', error);
        console.error('Error details:', error.response?.data || error.message);
        console.error('Full error object:', error);
        
        let errorMessage = 'Failed to load interview data';
        if (error.response?.data?.error) {
          errorMessage = error.response.data.error;
        } else if (error.message) {
          errorMessage = error.message;
        }
        
        alert(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    if (interviewId && groupIds.length > 0) {
      loadData();
    } else {
      console.log('Missing required parameters:', { interviewId, groupIds });
      setLoading(false);
    }
  }, [interviewId, groupIds.join(',')]);

  const getEvaluation = (applicationId) => {
    const key = `${applicationId}_${currentUser?.id}`;
    return evaluations[key] || {
      notes: '',
      decision: null
    };
  };

  const updateEvaluation = (applicationId, updates) => {
    const key = `${applicationId}_${currentUser?.id}`;
    setEvaluations(prev => ({
      ...prev,
      [key]: {
        ...getEvaluation(applicationId),
        ...updates
      }
    }));
  };

  const updateNotes = (applicationId, notes) => {
    updateEvaluation(applicationId, { notes });
    scheduleAutoSave(applicationId);
  };

  const updateDecision = (applicationId, decision) => {
    updateEvaluation(applicationId, { decision });
    scheduleAutoSave(applicationId);
  };

  const scheduleAutoSave = (applicationId) => {
    // Clear existing timeout for this application
    if (autoSaveTimeouts[applicationId]) {
      clearTimeout(autoSaveTimeouts[applicationId]);
    }

    // Set new timeout for auto-save (2 seconds after last change)
    const timeoutId = setTimeout(() => {
      autoSaveEvaluation(applicationId);
    }, 2000);

    setAutoSaveTimeouts(prev => ({
      ...prev,
      [applicationId]: timeoutId
    }));
  };

  const autoSaveEvaluation = async (applicationId) => {
    try {
      const evaluation = getEvaluation(applicationId);
      const { rubricScores, ...evaluationData } = evaluation;
      
      await apiClient.post(`/admin/interviews/${interviewId}/evaluations`, {
        applicationId,
        ...evaluationData
      });
      
      // Auto-save completed successfully - no visual feedback needed
    } catch (error) {
      console.error('Auto-save failed:', error);
      setSaveStatus(prev => ({
        ...prev,
        [applicationId]: { type: 'error', message: 'Auto-save failed', timestamp: Date.now() }
      }));
    }
  };


  const saveEvaluation = async (applicationId) => {
    try {
      setSaving(true);
      const evaluation = getEvaluation(applicationId);
      // Remove rubricScores from the evaluation data since we're not using them anymore
      const { rubricScores, ...evaluationData } = evaluation;
      
      await apiClient.post(`/admin/interviews/${interviewId}/evaluations`, {
        applicationId,
        ...evaluationData
      });
      
      alert('Evaluation saved successfully');
    } catch (error) {
      console.error('Failed to save evaluation:', error);
      alert('Failed to save evaluation');
    } finally {
      setSaving(false);
    }
  };

  const saveAllEvaluations = async () => {
    try {
      setSaving(true);
      const promises = applications.map(app => {
        const evaluation = getEvaluation(app.id);
        // Remove rubricScores from the evaluation data since we're not using them anymore
        const { rubricScores, ...evaluationData } = evaluation;
        return apiClient.post(`/admin/interviews/${interviewId}/evaluations`, {
          applicationId: app.id,
          ...evaluationData
        });
      });
      
      await Promise.all(promises);
      setAllEvaluationsSaved(true);
      setShowNextActionModal(true);
    } catch (error) {
      console.error('Failed to save evaluations:', error);
      alert('Failed to save evaluations');
    } finally {
      setSaving(false);
    }
  };

  const handleInterviewNextGroup = () => {
    setGroupSelectionOpen(true);
    setSelectedGroups([]);
    setGroupSearchTerm('');
  };

  const handleGroupToggle = (groupId) => {
    setSelectedGroups(prev => {
      if (prev.includes(groupId)) {
        return prev.filter(id => id !== groupId);
      } else if (prev.length < 3) {
        return [...prev, groupId];
      }
      return prev;
    });
  };

  const handleStartWithSelectedGroups = () => {
    if (selectedGroups.length === 0) return;
    
    const newGroupIds = selectedGroups.join(',');
    navigate(`/admin/interview-interface?interviewId=${interviewId}&groupIds=${newGroupIds}`);
  };

  const handleCloseGroupSelection = () => {
    setGroupSelectionOpen(false);
    setSelectedGroups([]);
    setGroupSearchTerm('');
  };

  const handleInterviewAnotherGroup = () => {
    setShowNextActionModal(false);
    setGroupSelectionOpen(true);
    setSelectedGroups([]);
    setGroupSearchTerm('');
  };

  const handleBackToDashboard = () => {
    navigate('/admin/assigned-interviews');
  };

  const handleCloseNextActionModal = () => {
    setShowNextActionModal(false);
  };

  const hasGroupBeenEvaluated = (groupId) => {
    // Check if any evaluations exist for applications in this group by looking at the evaluations data
    const group = interviewData?.applicationGroups?.find(g => g.id === groupId);
    if (!group || !group.applicationIds) {
      console.log(`Group ${groupId} not found or has no applications`);
      return false;
    }
    
    // Check if any applications in this group have evaluations from the current user
    const hasEvaluations = group.applicationIds.some(appId => {
      const key = `${appId}_${currentUser?.id}`;
      const hasEval = evaluations[key] && (evaluations[key].notes || evaluations[key].decision);
      if (hasEval) {
        console.log(`Found evaluation for application ${appId} in group ${groupId}`);
      }
      return hasEval;
    });
    
    console.log(`Group ${groupId} (${group.name}) evaluation status:`, hasEvaluations);
    return hasEvaluations;
  };

  if (loading) {
    return (
      <div className="interview-interface-container">
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>Loading interview data...</p>
        </div>
      </div>
    );
  }

  if (!interview || applications.length === 0) {
    return (
      <div className="interview-interface-container">
        <div className="error-state">
          <h2>No interview data found</h2>
          <p>Please check your interview selection and try again.</p>
          <button className="btn-primary" onClick={() => navigate('/admin/assigned-interviews')}>
            Back to Interviews
          </button>
        </div>
      </div>
    );
  }

  return (
    <AccessControl allowedRoles={['ADMIN']}>
      <div className="interview-interface-container">
      {/* Header */}
      <div className="interview-header">
        <button 
          className="back-button"
          onClick={() => navigate('/admin/assigned-interviews')}
        >
          <ArrowLeftIcon className="back-icon" />
          Back to Interviews
        </button>
        
        <div className="interview-info">
          <h1>{interview.title}</h1>
          <p className="interview-meta">
            {interview.interviewType?.replace(/_/g, ' ')} • {applications.length} applications
          </p>
        </div>
        
        <div className="header-actions">
          {!allEvaluationsSaved && (
            <button 
              className="btn-secondary"
              onClick={handleInterviewNextGroup}
            >
              Select Groups
            </button>
          )}
          <button 
            className="btn-primary"
            onClick={saveAllEvaluations}
            disabled={saving}
          >
            <CheckIcon className="btn-icon" />
            {saving ? 'Saving...' : 'Save All'}
          </button>
        </div>
      </div>

      {/* Applications Grid */}
      <div className="applications-grid">
        {applications.map(application => {
          const evaluation = getEvaluation(application.id);
          
          return (
            <div key={application.id} className="application-card">
              {/* Application Header */}
              <div className="application-header">
                <div className="applicant-info">
                  <div className="applicant-avatar">
                    {application.headshotUrl ? (
                      <img
                        src={application.headshotUrl}
                        alt={application.name}
                        className="avatar-image"
                        style={{
                          width: '100%',
                          height: '100%',
                          borderRadius: '50%',
                          objectFit: 'cover'
                        }}
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                          e.currentTarget.nextSibling.style.display = 'flex';
                        }}
                      />
                    ) : null}
                    <UserIcon 
                      className="avatar-icon" 
                      style={{ display: application.headshotUrl ? 'none' : 'flex' }}
                    />
                  </div>
                  <div className="applicant-details">
                    <h3>{application.name}</h3>
                    <p className="applicant-meta">
                      {application.major} • {application.year}
                    </p>
                  </div>
                </div>
                {/* Test For Note (Admin) */}
                {application.testFor && (
                  <div style={{ 
                    width: '100%',
                    marginBottom: '16px',
                    padding: '12px',
                    backgroundColor: 'var(--status-info-bg)',
                    borderLeft: '4px solid var(--status-info-border)',
                    borderRadius: '4px'
                  }}>
                    <p style={{ 
                      color: 'var(--status-info-text)',
                      fontWeight: '600',
                      marginBottom: '6px',
                      fontSize: '0.875rem',
                      margin: '0 0 6px 0'
                    }}>
                      Test For (Admin Note):
                    </p>
                    <p style={{
                      color: 'var(--status-info-text)',
                      margin: 0,
                      fontSize: '0.875rem',
                      lineHeight: '1.5',
                      whiteSpace: 'pre-wrap'
                    }}>
                      {application.testFor}
                    </p>
                  </div>
                )}
                <div className="save-section">
                  {saveStatus[application.id] && saveStatus[application.id].type === 'error' && (
                    <div className={`save-status ${saveStatus[application.id].type}`}>
                      {saveStatus[application.id].message}
                    </div>
                  )}
                  <button 
                    className="save-btn"
                    onClick={() => saveEvaluation(application.id)}
                    disabled={saving}
                  >
                    <CheckIcon className="btn-icon" />
                    Save
                  </button>
                </div>
              </div>

              {/* Notes Section */}
              <div className="evaluation-section">
                <h4 className="section-title">
                  <DocumentTextIcon className="section-icon" />
                  Notes
                </h4>
                <textarea
                  className="notes-textarea"
                  value={evaluation.notes || ''}
                  onChange={(e) => updateNotes(application.id, e.target.value)}
                  placeholder="Add your interview notes here..."
                  rows={4}
                />
              </div>


              {/* Decision Section */}
              <div className="evaluation-section">
                <h4 className="section-title">Initial Decision</h4>
                <div className="decision-options">
                  {decisionOptions.map(option => (
                    <label key={option.value} className="decision-option">
                      <input
                        type="radio"
                        name={`decision-${application.id}`}
                        value={option.value}
                        checked={evaluation.decision === option.value}
                        onChange={() => updateDecision(application.id, option.value)}
                      />
                      <span className={`decision-label ${option.color}`}>
                        {option.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Group Selection Modal */}
      {groupSelectionOpen && (
        <div className="modal-overlay">
          <div className="modal-content group-selection-modal">
            <div className="modal-header">
              <h3>Select Application Groups</h3>
              <div className="selection-info">
                {selectedGroups.length}/3 groups selected
              </div>
              <button className="icon-btn" onClick={handleCloseGroupSelection}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="search-section">
                <input
                  type="text"
                  placeholder="Search application groups..."
                  value={groupSearchTerm}
                  onChange={(e) => setGroupSearchTerm(e.target.value)}
                  className="group-search-input"
                />
              </div>
              
              <div className="groups-selection-list">
                {(() => {
                  const data = interviewData || { applicationGroups: [] };
                  const applicationGroups = data.applicationGroups || [];
                  console.log('Available groups for selection:', applicationGroups);
                  const filteredGroups = applicationGroups.filter(group =>
                    group.name.toLowerCase().includes(groupSearchTerm.toLowerCase())
                  );
                  console.log('Filtered groups:', filteredGroups);
                  
                  return filteredGroups.length === 0 ? (
                    <div className="no-groups-message">
                      {groupSearchTerm ? 'No groups match your search' : 'No application groups available'}
                    </div>
                  ) : (
                    filteredGroups.map(group => {
                      const isSelected = selectedGroups.includes(group.id);
                      const isDisabled = !isSelected && selectedGroups.length >= 3;
                      const isEvaluated = hasGroupBeenEvaluated(group.id);
                      
                      return (
                        <div 
                          key={group.id} 
                          className={`group-selection-item ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''} ${isEvaluated ? 'evaluated' : ''}`}
                          onClick={() => !isDisabled && handleGroupToggle(group.id)}
                        >
                          <div className="group-checkbox">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => !isDisabled && handleGroupToggle(group.id)}
                              disabled={isDisabled}
                            />
                            <span className="checkmark"></span>
                          </div>
                          <div className="group-info">
                            <div className="group-header">
                              <h4 className="group-name">{group.name}</h4>
                              {isEvaluated && (
                                <span className="evaluation-badge">Evaluated</span>
                              )}
                            </div>
                            <p className="group-count">
                              {group.applicationIds?.length || 0} applications
                            </p>
                          </div>
                        </div>
                      );
                    })
                  );
                })()}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={handleCloseGroupSelection}>
                Cancel
              </button>
              <button 
                className="btn-primary" 
                onClick={handleStartWithSelectedGroups}
                disabled={selectedGroups.length === 0}
              >
                {selectedGroups.length === 0 ? 'Select Groups' : `Review Groups (${selectedGroups.length})`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Next Action Modal */}
      {showNextActionModal && (
        <div className="modal-overlay">
          <div className="modal-content next-action-modal">
            <div className="modal-header">
              <h3>All Evaluations Saved Successfully!</h3>
              <button className="icon-btn" onClick={handleCloseNextActionModal}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <p>What would you like to do next?</p>
            </div>
            <div className="modal-footer">
              <button 
                className="btn-secondary" 
                onClick={handleInterviewAnotherGroup}
              >
                Interview Another Group
              </button>
              <button 
                className="btn-primary" 
                onClick={handleBackToDashboard}
              >
                Back to Dashboard
              </button>
            </div>
          </div>
        </div>
      )}
      <InterviewChatWidget interviewId={interviewId} interviewTitle={interview?.title} />
    </div>
    </AccessControl>
  );
}
