import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeftIcon,
  CalendarIcon,
  ClockIcon,
  MapPinIcon,
  UserGroupIcon,
  PlayIcon,
  EyeIcon,
  PlusIcon,
  XMarkIcon,
  UsersIcon,
  DocumentTextIcon,
  PencilIcon,
  CheckIcon
} from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import AuthenticatedImage from '../components/AuthenticatedImage';
import '../styles/AdminAssignedInterviews.css';

// Application Group Card Component
const ApplicationGroupCard = ({ group, interviewId }) => {
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const loadApplications = async () => {
    if (applications.length > 0) return; // Already loaded
    
    setLoading(true);
    try {
      const apps = await apiClient.get(`/member/interviews/${interviewId}/applications?groupIds=${group.id}`);
      setApplications(apps);
    } catch (error) {
      console.error('Failed to load applications for group:', error);
      setApplications([]);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleExpanded = () => {
    if (!expanded) {
      loadApplications();
    }
    setExpanded(!expanded);
  };

  return (
    <div className="application-group-card">
      <div className="group-card-header" onClick={handleToggleExpanded}>
        <div className="group-info">
          <UserGroupIcon className="group-icon" />
          <div className="group-details">
            <h4 className="group-name">{group.name}</h4>
            <p className="group-meta">
              {group.applicationIds?.length || 0} candidates
            </p>
          </div>
        </div>
        <div className="group-actions">
          <span className="expand-indicator">
            {expanded ? '−' : '+'}
          </span>
        </div>
      </div>
      
      {expanded && (
        <div className="group-applications">
          {loading ? (
            <div className="loading-applications">
              <div className="loading-spinner"></div>
              <p>Loading candidates...</p>
            </div>
          ) : applications.length === 0 ? (
            <div className="no-applications">
              <p>No candidates found in this group</p>
            </div>
          ) : (
            <div className="applications-grid">
              {applications.map((application) => (
                <CandidateCard key={application.id} application={application} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Candidate Card Component
const CandidateCard = ({ application }) => {
  const [preview, setPreview] = useState({ open: false, src: '', kind: '', title: '' });

  return (
    <>
      <div className="candidate-card">
        <div className="candidate-header">
          <div className="candidate-avatar">
            {application.headshotUrl ? (
              <AuthenticatedImage
                src={application.headshotUrl}
                alt={application.name}
                style={{
                  width: '60px',
                  height: '60px',
                  borderRadius: '50%',
                  objectFit: 'cover'
                }}
              />
            ) : (
              <div className="avatar-fallback">
                {(application.name || '?').split(' ').map(n => n.charAt(0)).join('').slice(0,2).toUpperCase()}
              </div>
            )}
          </div>
          <div className="candidate-info">
            <h4 className="candidate-name">{application.name}</h4>
            <p className="candidate-meta">
              {application.major} • Class of {application.year}
            </p>
          </div>
        </div>
        
        <div className="candidate-documents">
          <h5>Documents</h5>
          <div className="document-links">
            {application.resumeUrl && (
              <button 
                className="document-btn"
                onClick={() => setPreview({ 
                  open: true, 
                  src: application.resumeUrl, 
                  kind: 'pdf', 
                  title: `${application.name} – Resume` 
                })}
              >
                <DocumentTextIcon className="btn-icon" />
                Resume
              </button>
            )}
            {application.coverLetterUrl && (
              <button 
                className="document-btn"
                onClick={() => setPreview({ 
                  open: true, 
                  src: application.coverLetterUrl, 
                  kind: 'pdf', 
                  title: `${application.name} – Cover Letter` 
                })}
              >
                <DocumentTextIcon className="btn-icon" />
                Cover Letter
              </button>
            )}
            {application.videoUrl && (
              <button 
                className="document-btn"
                onClick={() => setPreview({ 
                  open: true, 
                  src: application.videoUrl, 
                  kind: 'video', 
                  title: `${application.name} – Video` 
                })}
              >
                <EyeIcon className="btn-icon" />
                Video
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Document Preview Modal */}
      {preview.open && (
        <DocumentPreviewModal
          onClose={() => setPreview({ open: false, src: '', kind: '', title: '' })}
          src={preview.src}
          kind={preview.kind}
          title={preview.title}
        />
      )}
    </>
  );
};

export default function AssignedInterviews() {
  const navigate = useNavigate();
  const [interviews, setInterviews] = useState([]);
  const [selectedInterviewId, setSelectedInterviewId] = useState(null);
  const [expandedInterviewId, setExpandedInterviewId] = useState(null);
  const [interviewData, setInterviewData] = useState({});
  const [groupSelectionOpen, setGroupSelectionOpen] = useState(false);
  const [selectedInterviewForStart, setSelectedInterviewForStart] = useState(null);
  const [groupSearchTerm, setGroupSearchTerm] = useState('');
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [evaluations, setEvaluations] = useState({});
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingEvaluation, setEditingEvaluation] = useState(null);
  const [editFormData, setEditFormData] = useState({
    decision: '',
    notes: ''
  });
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState({ open: false, src: '', kind: '', title: '' });
  const [groupApplications, setGroupApplications] = useState({});
  const [behavioralQuestionsConfig, setBehavioralQuestionsConfig] = useState([]);
  const [showBehavioralQuestionsConfig, setShowBehavioralQuestionsConfig] = useState(false);

  const decisionOptions = [
    { value: 'YES', label: 'Yes', color: 'green' },
    { value: 'MAYBE_YES', label: 'Maybe-Yes', color: 'light-green' },
    { value: 'MAYBE_NO', label: 'Maybe-No', color: 'orange' },
    { value: 'NO', label: 'No', color: 'red' }
  ];

  // Load applications for a specific group
  const loadGroupApplications = async (interviewId, groupId) => {
    try {
      const applications = await apiClient.get(`/member/interviews/${interviewId}/applications?groupIds=${groupId}`);
      setGroupApplications(prev => ({
        ...prev,
        [groupId]: applications
      }));
    } catch (error) {
      console.error('Failed to load applications for group:', error);
      setGroupApplications(prev => ({
        ...prev,
        [groupId]: []
      }));
    }
  };

  // Get current user information
  useEffect(() => {
    const getCurrentUser = async () => {
      try {
        const response = await apiClient.get('/member/profile');
        console.log('Current user loaded:', response);
        setCurrentUser(response);
      } catch (error) {
        console.error('Failed to get current user:', error);
      }
    };
    getCurrentUser();
  }, []);

  // Fetch member's assigned interviews
  useEffect(() => {
    const loadMemberInterviews = async () => {
      try {
        const [ivsRes] = await Promise.allSettled([
          apiClient.get('/member/interviews')
        ]);

        const ivs = ivsRes.status === 'fulfilled' ? ivsRes.value : [];
        if (ivsRes.status === 'rejected') {
          console.warn('Interviews fetch failed, continuing without them');
        }

        setInterviews(ivs);

        console.log('Loaded interviews:', ivs);
        console.log('Interview types:', ivs.map(i => ({ id: i.id, title: i.title, type: i.interviewType })));

        // Auto-expand the first interview card by default
        if (ivs.length > 0) {
          setExpandedInterviewId(ivs[0].id);
          setSelectedInterviewId(ivs[0].id);
        }

        // Initialize interview-specific data for each interview
        const initialData = {};
        ivs.forEach(interview => {
          const desc = interview.description;
          let parsed;
          try {
            parsed = typeof desc === 'string' ? JSON.parse(desc) : desc;
          } catch {
            parsed = {};
          }
          
          console.log('Interview description for', interview.id, ':', parsed);
          initialData[interview.id] = {
            memberGroups: parsed?.memberGroups || [],
            applicationGroups: parsed?.applicationGroups || [],
            groupAssignments: parsed?.groupAssignments || {}
          };
        });
        setInterviewData(initialData);

        // Load evaluations for each interview
        const evaluationsData = {};
        for (const interview of ivs) {
          try {
            const evaluationsRes = await apiClient.get(`/member/evaluations?interviewId=${interview.id}`);
            evaluationsData[interview.id] = evaluationsRes;
          } catch (error) {
            console.warn(`Failed to load evaluations for interview ${interview.id}:`, error);
            evaluationsData[interview.id] = [];
          }
        }
        setEvaluations(evaluationsData);
      } catch (e) {
        console.error('Failed to load interview data', e);
      }
    };
    loadMemberInterviews();
  }, []);


  const handleStartInterview = async (interviewId) => {
    setSelectedInterviewForStart(interviewId);
    setGroupSelectionOpen(true);
    setGroupSearchTerm('');
    setSelectedGroups([]);
    setShowBehavioralQuestionsConfig(false);
    
    // Don't load questions here - we'll load them when groups are selected
    setBehavioralQuestionsConfig([]);
  };

  const handleGroupToggle = (groupId) => {
    setSelectedGroups(prev => {
      // Check if this is a final round interview
      const interview = interviews.find(i => i.id === selectedInterviewForStart);
      const isFinalRound = interview?.interviewType === 'FINAL_ROUND' || interview?.interviewType === 'ROUND_TWO';
      const isRoundOne = interview?.interviewType === 'ROUND_ONE';
      const maxGroups = isFinalRound ? 1 : (isRoundOne ? 3 : 3);
      
      let newGroups;
      if (prev.includes(groupId)) {
        newGroups = prev.filter(id => id !== groupId);
      } else if (isFinalRound) {
        // For final round, replace the current selection
        newGroups = [groupId];
      } else if (prev.length < maxGroups) {
        newGroups = [...prev, groupId];
      } else {
        return prev;
      }
      
      // Load behavioral questions for the selected groups
      loadBehavioralQuestionsForGroups(newGroups);
      
      return newGroups;
    });
  };

  const loadBehavioralQuestionsForGroups = async (groupIds) => {
    if (groupIds.length === 0) {
      setBehavioralQuestionsConfig([]);
      return;
    }

    try {
      const configRes = await apiClient.get(`/member/interviews/${selectedInterviewForStart}/config?groupIds=${groupIds.join(',')}`);
      const questionsByGroup = configRes.behavioralQuestions || {};
      
      // Flatten questions from all groups
      const allQuestions = [];
      Object.values(questionsByGroup).forEach(groupQuestions => {
        allQuestions.push(...groupQuestions.map(q => q.text || q));
      });
      
      setBehavioralQuestionsConfig(allQuestions);
    } catch (error) {
      console.warn('Failed to load behavioral questions for groups:', error);
      setBehavioralQuestionsConfig([]);
    }
  };

  const handleStartWithSelectedGroups = async () => {
    console.log('handleStartWithSelectedGroups called!');
    console.log('selectedGroups:', selectedGroups);
    console.log('selectedInterviewForStart:', selectedInterviewForStart);
    
    if (selectedGroups.length === 0) return;
    
    const interview = interviews.find(i => i.id === selectedInterviewForStart);
    
    // Check if this is a round that needs behavioral questions configuration
    if ((interview?.interviewType === 'ROUND_TWO' || interview?.interviewType === 'FINAL_ROUND' || interview?.interviewType === 'ROUND_ONE') && !showBehavioralQuestionsConfig) {
      setShowBehavioralQuestionsConfig(true);
      return;
    }
    
    const groupIdsParam = selectedGroups.join(',');
    
    console.log('Interview found:', interview);
    console.log('Interview type:', interview?.interviewType);
    console.log('Is ROUND_ONE?', interview?.interviewType === 'ROUND_ONE');
    console.log('All interviews for debugging:', interviews.map(i => ({ id: i.id, title: i.title, type: i.interviewType })));
    
    // Save behavioral questions configuration if provided
    if (showBehavioralQuestionsConfig && behavioralQuestionsConfig.length > 0) {
      try {
        await saveBehavioralQuestionsConfiguration();
        console.log('Behavioral questions saved successfully');
      } catch (error) {
        console.error('Failed to save behavioral questions:', error);
        alert('Failed to save behavioral questions. Please try again.');
        return; // Don't navigate if save failed
      }
    }
    
    // Route to appropriate interface based on interview type
    if (interview?.interviewType === 'ROUND_ONE') {
      console.log('Routing to first round interview interface');
      const url = `/member/first-round-interview?interviewId=${selectedInterviewForStart}&groupIds=${groupIdsParam}`;
      console.log('Navigating to:', url);
      navigate(url);
    } else if (interview?.interviewType === 'ROUND_TWO' || interview?.interviewType === 'FINAL_ROUND') {
      console.log('Routing to final round interview interface');
      const url = `/member/final-round-interview?interviewId=${selectedInterviewForStart}&groupIds=${groupIdsParam}`;
      console.log('Navigating to:', url);
      navigate(url);
    } else {
      console.log('Routing to regular interview interface');
      const url = `/member/interview-interface?interviewId=${selectedInterviewForStart}&groupIds=${groupIdsParam}`;
      console.log('Navigating to:', url);
      navigate(url);
    }
    
    setGroupSelectionOpen(false);
    setSelectedInterviewForStart(null);
    setSelectedGroups([]);
    setBehavioralQuestionsConfig([]);
    setShowBehavioralQuestionsConfig(false);
  };

  const saveBehavioralQuestionsConfiguration = async () => {
    try {
      // Save questions to each selected group individually
      const questionsToSave = behavioralQuestionsConfig.filter(q => q.trim() !== '');
      
      console.log('Saving behavioral questions:', {
        selectedGroups,
        questionsToSave,
        interviewId: selectedInterviewForStart
      });
      
      for (const groupId of selectedGroups) {
        console.log(`Saving questions for group ${groupId}:`, questionsToSave);
        const response = await apiClient.patch(`/member/interviews/${selectedInterviewForStart}/config`, {
          type: 'behavioral_questions',
          config: {
            behavioralQuestions: true,
            groupId: groupId,
            questions: questionsToSave
          }
        });
        console.log(`Save response for group ${groupId}:`, response);
      }
      
      console.log('Behavioral questions saved successfully for groups:', selectedGroups);
      
    } catch (error) {
      console.error('Failed to save behavioral questions configuration:', error);
      alert('Failed to save behavioral questions configuration');
      throw error; // Re-throw so the calling function can handle it
    }
  };

  const handleCloseGroupSelection = () => {
    setGroupSelectionOpen(false);
    setSelectedInterviewForStart(null);
    setGroupSearchTerm('');
    setSelectedGroups([]);
    setBehavioralQuestionsConfig([]);
    setShowBehavioralQuestionsConfig(false);
  };

  const addBehavioralQuestion = () => {
    setBehavioralQuestionsConfig(prev => [...prev, '']);
  };

  const updateBehavioralQuestion = (index, value) => {
    setBehavioralQuestionsConfig(prev => prev.map((q, i) => i === index ? value : q));
  };

  const removeBehavioralQuestion = (index) => {
    setBehavioralQuestionsConfig(prev => prev.filter((_, i) => i !== index));
  };

  const handleSelectInterview = (id) => {
    setSelectedInterviewId(id);
  };

  const toggleExpandInterview = (id) => {
    setExpandedInterviewId(expandedInterviewId === id ? null : id);
  };


  const getDecisionColor = (decision) => {
    switch (decision) {
      case 'YES': return 'decision-yes';
      case 'MAYBE_YES': return 'decision-maybe-yes';
      case 'MAYBE_NO': return 'decision-maybe-no';
      case 'NO': return 'decision-no';
      default: return 'decision-none';
    }
  };

  const getDecisionLabel = (decision) => {
    switch (decision) {
      case 'YES': return 'Yes';
      case 'MAYBE_YES': return 'Maybe-Yes';
      case 'MAYBE_NO': return 'Maybe-No';
      case 'NO': return 'No';
      default: return 'Not evaluated';
    }
  };

  const handleEditEvaluation = (evaluation) => {
    setEditingEvaluation(evaluation);
    setEditFormData({
      decision: evaluation.decision || '',
      notes: evaluation.notes || ''
    });
    setEditModalOpen(true);
  };

  const handleCloseEditModal = () => {
    setEditModalOpen(false);
    setEditingEvaluation(null);
    setEditFormData({ decision: '', notes: '' });
  };

  const handleSaveEvaluation = async () => {
    if (!editingEvaluation) return;
    
    try {
      setSaving(true);
      await apiClient.post('/member/evaluations', {
        interviewId: editingEvaluation.interviewId,
        applicationId: editingEvaluation.applicationId,
        decision: editFormData.decision,
        notes: editFormData.notes
      });
      
      // Update the evaluations state
      setEvaluations(prev => ({
        ...prev,
        [editingEvaluation.interviewId]: prev[editingEvaluation.interviewId].map(evaluation => 
          evaluation.id === editingEvaluation.id 
            ? { ...evaluation, decision: editFormData.decision, notes: editFormData.notes, updatedAt: new Date().toISOString() }
            : evaluation
        )
      }));
      
      handleCloseEditModal();
    } catch (error) {
      console.error('Failed to save evaluation:', error);
      alert('Failed to save evaluation');
    } finally {
      setSaving(false);
    }
  };

  // Find which member group the current user belongs to for a given interview
  const getUserMemberGroup = (interviewId) => {
    if (!currentUser) {
      console.log('No current user found');
      return null;
    }
    
    const data = interviewData[interviewId];
    if (!data?.memberGroups) {
      console.log('No member groups found for interview:', interviewId, data);
      return null;
    }
    
    console.log('Looking for user in member groups:', {
      userId: currentUser.id,
      userIdType: typeof currentUser.id,
      memberGroups: data.memberGroups
    });
    
    // Log each member group's IDs for debugging
    data.memberGroups.forEach((group, index) => {
      console.log(`Member Group ${index + 1} (${group.name}):`, {
        memberIds: group.memberIds,
        memberIdTypes: group.memberIds?.map(id => typeof id)
      });
    });
    
    const userId = String(currentUser.id);
    const userGroup = data.memberGroups.find(group => {
      if (!group.memberIds || !Array.isArray(group.memberIds)) {
        return false;
      }
      // Check both string and number comparisons
      const isInGroup = group.memberIds.some(id => 
        String(id) === userId || id === currentUser.id
      );
      console.log(`Checking group "${group.name}":`, {
        groupMemberIds: group.memberIds,
        currentUserId: currentUser.id,
        userIdString: userId,
        isInGroup: isInGroup
      });
      return isInGroup;
    });
    
    console.log('Found user group:', userGroup);
    return userGroup;
  };

  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <div className="admin-assigned-interviews-container">
      {/* Group Selection Modal */}
      {groupSelectionOpen && selectedInterviewForStart && (
        <div className="modal-overlay">
          <div className="modal-content group-selection-modal">
            <div className="modal-header">
              <h3>
                {showBehavioralQuestionsConfig 
                  ? 'Configure Behavioral Questions' 
                  : 'Select Application Groups to Evaluate'
                }
              </h3>
              {!showBehavioralQuestionsConfig && (() => {
                const interview = interviews.find(i => i.id === selectedInterviewForStart);
                const isFinalRound = interview?.interviewType === 'FINAL_ROUND' || interview?.interviewType === 'ROUND_TWO';
                const maxGroups = isFinalRound ? 1 : 3;
                return (
                  <div className="selection-info">
                    {selectedGroups.length}/{maxGroups} group{maxGroups === 1 ? '' : 's'} selected
                  </div>
                );
              })()}
              <button className="icon-btn" onClick={handleCloseGroupSelection}>
                <XMarkIcon className="btn-icon" />
              </button>
            </div>
            <div className="modal-body">
              {showBehavioralQuestionsConfig ? (
                <div className="behavioral-questions-config">
                  <div className="config-instruction">
                    <p>Configure the behavioral questions for this interview. These questions will be used for all candidates in the selected groups.</p>
                    {behavioralQuestionsConfig.length > 0 && (
                      <p className="existing-questions-note">
                        <strong>Existing questions:</strong> {behavioralQuestionsConfig.length} question(s) already configured. You can edit them below or add new ones.
                      </p>
                    )}
                  </div>
                  
                  <div className="questions-list">
                    {behavioralQuestionsConfig.length === 0 ? (
                      <div className="no-questions-message">
                        <p>No behavioral questions configured yet. Add your first question below.</p>
                      </div>
                    ) : (
                      behavioralQuestionsConfig.map((question, index) => (
                        <div key={index} className="question-config-row">
                          <input
                            type="text"
                            placeholder={`Behavioral Question ${index + 1}`}
                            value={question}
                            onChange={(e) => updateBehavioralQuestion(index, e.target.value)}
                            className="question-input"
                          />
                          <button
                            type="button"
                            onClick={() => removeBehavioralQuestion(index)}
                            className="remove-question-btn"
                            disabled={behavioralQuestionsConfig.length === 1}
                          >
                            <XMarkIcon className="btn-icon" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                  
                  <button
                    type="button"
                    onClick={addBehavioralQuestion}
                    className="add-question-btn"
                  >
                    <PlusIcon className="btn-icon" />
                    {behavioralQuestionsConfig.length === 0 ? 'Add First Question' : 'Add Another Question'}
                  </button>
                </div>
              ) : (
                (() => {
                  const interview = interviews.find(i => i.id === selectedInterviewForStart);
                  const data = interviewData[selectedInterviewForStart] || { applicationGroups: [] };
                  
                  // Filter to only show groups assigned to member groups that include the current user
                  const userAssignedGroups = currentUser ? 
                    data.applicationGroups.filter(group => {
                      const groupAssignments = data.groupAssignments || {};
                      
                      // Find all member groups that include the current user
                      const userId = String(currentUser.id);
                      const userMemberGroups = data.memberGroups?.filter(memberGroup => {
                        if (!memberGroup.memberIds || !Array.isArray(memberGroup.memberIds)) {
                          return false;
                        }
                        return memberGroup.memberIds.some(id => 
                          String(id) === userId || id === currentUser.id
                        );
                      }) || [];
                      
                      // Check if this application group is assigned to any of the user's member groups
                      return userMemberGroups.some(memberGroup => 
                        groupAssignments[memberGroup.id]?.includes(group.id)
                      );
                    }) : [];
                  
                  const filteredGroups = userAssignedGroups.filter(group =>
                    group.name.toLowerCase().includes(groupSearchTerm.toLowerCase())
                  );
                  
                  return (
                    <>
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
                        {filteredGroups.length === 0 ? (
                          <div className="no-groups-message">
                            {groupSearchTerm ? 'No groups match your search' : 'No application groups available'}
                          </div>
                        ) : (
                          filteredGroups.map(group => {
                            const isSelected = selectedGroups.includes(group.id);
                            const isFinalRound = interview?.interviewType === 'FINAL_ROUND' || interview?.interviewType === 'ROUND_TWO';
                            const isRoundOne = interview?.interviewType === 'ROUND_ONE';
                            const maxGroups = isFinalRound ? 1 : (isRoundOne ? 3 : 3);
                            const isDisabled = !isSelected && selectedGroups.length >= maxGroups;
                            
                            return (
                              <div 
                                key={group.id} 
                                className={`group-selection-item ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''}`}
                                onClick={() => !isDisabled && handleGroupToggle(group.id)}
                              >
                                <div className="group-checkbox">
                                  <input
                                    type={isFinalRound ? "radio" : "checkbox"}
                                    checked={isSelected}
                                    onChange={() => !isDisabled && handleGroupToggle(group.id)}
                                    disabled={isDisabled}
                                  />
                                  <span className="checkmark"></span>
                                </div>
                                <div className="group-info">
                                  <h4 className="group-name">{group.name}</h4>
                                  <p className="group-count">
                                    {group.applicationIds?.length || 0} applications
                                  </p>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </>
                  );
                })()
              )}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={handleCloseGroupSelection}>
                Cancel
              </button>
              <button 
                className="btn-primary" 
                onClick={handleStartWithSelectedGroups}
                disabled={showBehavioralQuestionsConfig ? behavioralQuestionsConfig.length === 0 : selectedGroups.length === 0}
              >
                {showBehavioralQuestionsConfig 
                  ? 'Configure Questions' 
                  : `Start Interview (${selectedGroups.length} group${selectedGroups.length !== 1 ? 's' : ''})`
                }
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header Section */}
      <div className="interview-header">
        <button 
          className="back-button"
          onClick={() => navigate(-1)}
        >
          <ArrowLeftIcon className="back-icon" />
          Back
        </button>
      </div>

      {/* Main Content - Interview Cards Grid */}
      <div className="interviews-grid">
        {(() => {
          // Filter interviews to only show those where the user is assigned to a member group
          const assignedInterviews = currentUser ? interviews.filter(interview => {
            const data = interviewData[interview.id] || {};
            const memberGroups = data.memberGroups || [];
            
            // Check if the current user is in any member group for this interview
            // Handle both string and number ID types
            const userId = String(currentUser.id);
            const userInGroup = memberGroups.some(memberGroup => {
              if (!memberGroup.memberIds || !Array.isArray(memberGroup.memberIds)) {
                return false;
              }
              // Check both string and number comparisons
              return memberGroup.memberIds.some(id => 
                String(id) === userId || id === currentUser.id
              );
            });
            
            if (!userInGroup) {
              console.log(`User ${currentUser.id} not found in any member group for interview ${interview.id}`);
            }
            
            return userInGroup;
          }) : [];
          
          return assignedInterviews.length === 0 ? (
            <div className="no-interviews-card">
              <div className="no-interviews-icon">
                <CalendarIcon className="empty-icon" />
              </div>
              <h2>No Interviews Assigned</h2>
              <p>You don't have any interviews assigned at this time</p>
            </div>
          ) : (
            assignedInterviews.map((interview) => {
            const startDate = new Date(interview.startDate);
            const endDate = new Date(interview.endDate);
            const isSelected = interview.id === selectedInterviewId;
            const isExpanded = expandedInterviewId === interview.id;
            const data = interviewData[interview.id] || {};
            
            return (
              <div 
                key={interview.id} 
                className={`interview-card ${isSelected ? 'selected' : ''} ${isExpanded ? 'expanded' : ''}`}
              >
                {/* Card Header */}
                <div className="interview-card-header" onClick={() => handleSelectInterview(interview.id)}>
                  <div className="interview-type-badge">
                    {interview.interviewType?.replace(/_/g, ' ')}
                  </div>
                  <div className="interview-card-actions">
                    <button 
                      className={`icon-btn expand ${isExpanded ? 'expanded' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpandInterview(interview.id);
                      }}
                      title={isExpanded ? "Collapse" : "Expand"}
                    >
                      {isExpanded ? <XMarkIcon className="btn-icon" /> : <PlusIcon className="btn-icon" />}
                    </button>
                  </div>
                </div>

                {/* Card Body */}
                <div className="interview-card-body">
                  {/* Date Section */}
                  <div className="interview-date-section">
                    <div className="interview-date-badge">
                      <div className="date-day">{startDate.toLocaleDateString('en-US', { weekday: 'short' })}</div>
                      <div className="date-number">{startDate.getDate()}</div>
                      <div className="date-month">{startDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</div>
                    </div>
                    
                    <div className="interview-info">
                      <h3 className="interview-card-title">{interview.title}</h3>
                      
                      <div className="interview-details">
                        <div className="detail-item">
                          <ClockIcon className="detail-icon" />
                          <span>
                            {startDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} - 
                            {endDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        
                        <div className="detail-item">
                          <MapPinIcon className="detail-icon" />
                          <span>{interview.location || 'No location set'}</span>
                        </div>
                        
                        <div className="detail-item">
                          <UserGroupIcon className="detail-icon" />
                          <span>{interview.dresscode || 'No dress code specified'}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Member Group Assignment - Show when not expanded */}
                  {!isExpanded && isSelected && currentUser && (() => {
                    const userGroup = getUserMemberGroup(interview.id);
                    return (
                      <div className="interview-groups-summary">
                        <div className="groups-header">
                          <span className="groups-label">Your Assignment:</span>
                        </div>
                        <div className="groups-preview">
                          {userGroup ? (
                            <div className="preview-section">
                              <UsersIcon className="group-type-icon" />
                              <span className="preview-label">Member Group: </span>
                              <span className="preview-value">{userGroup.name}</span>
                            </div>
                          ) : (
                            <div className="preview-section">
                              <UsersIcon className="group-type-icon" />
                              <span className="preview-label">Member Group: </span>
                              <span className="preview-value" style={{color: 'var(--status-warning-text)'}}>
                                Not assigned to any group
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div className="interview-expanded-content">
                      {/* Member Assignment Section */}
                      {currentUser && (() => {
                        const userGroup = getUserMemberGroup(interview.id);
                        return (
                          <div className="expanded-section">
                            <h3 className="expanded-section-title">Your Assignment</h3>
                            <div className="assignment-details">
                              {userGroup ? (
                                <>
                                  <div className="assignment-item">
                                    <UsersIcon className="assignment-icon" />
                                    <div className="assignment-info">
                                      <span className="assignment-label">Member Group:</span>
                                      <span className="assignment-value">{userGroup.name}</span>
                                    </div>
                                  </div>
                                  {userGroup.notes && (
                                    <div className="assignment-notes">
                                      <span className="notes-label">Notes:</span>
                                      <span className="notes-value">{userGroup.notes}</span>
                                    </div>
                                  )}
                                </>
                              ) : (
                                <div className="assignment-item">
                                  <UsersIcon className="assignment-icon" />
                                  <div className="assignment-info">
                                    <span className="assignment-label">Member Group:</span>
                                    <span className="assignment-value" style={{color: 'var(--status-warning-text)'}}>
                                      Not assigned to any group
                                    </span>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()}


                      {/* My Evaluations Section */}
                      <div className="expanded-section">
                        <h3 className="expanded-section-title">My Evaluations</h3>
                        {(() => {
                          const interviewEvaluations = evaluations[interview.id] || [];
                          return interviewEvaluations.length === 0 ? (
                            <div className="no-evaluations">
                              <DocumentTextIcon className="no-evaluations-icon" />
                              <p>No evaluations completed yet</p>
                            </div>
                          ) : (
                            <div className="evaluations-list">
                              {interviewEvaluations.map((evaluation) => {
                                const application = evaluation.application;
                                return (
                                  <div key={evaluation.id} className="evaluation-item">
                                    <div className="evaluation-header">
                                      <div className="evaluation-candidate">
                                        <div className="candidate-photo">
                                          {application.headshotUrl ? (
                                            <AuthenticatedImage
                                              src={application.headshotUrl}
                                              alt={`${application.firstName} ${application.lastName}`}
                                              className="candidate-headshot"
                                              style={{
                                                width: '48px',
                                                height: '48px',
                                                borderRadius: '50%',
                                                objectFit: 'cover'
                                              }}
                                            />
                                          ) : null}
                                          <div 
                                            className="candidate-headshot-fallback"
                                            style={{ display: application.headshotUrl ? 'none' : 'flex' }}
                                          >
                                            {(application.firstName?.[0] || '') + (application.lastName?.[0] || '')}
                                          </div>
                                        </div>
                                        <div className="candidate-info">
                                          <h4 className="candidate-name">
                                            {application.firstName} {application.lastName}
                                          </h4>
                                          <p className="candidate-details">
                                            {application.major1} • Class of {application.graduationYear}
                                          </p>
                                        </div>
                                      </div>
                                      <div className="evaluation-actions">
                                        <div className={`evaluation-decision ${getDecisionColor(evaluation.decision)}`}>
                                          {getDecisionLabel(evaluation.decision)}
                                        </div>
                                        <button 
                                          className="edit-evaluation-btn"
                                          onClick={() => handleEditEvaluation(evaluation)}
                                          title="Edit evaluation"
                                        >
                                          <PencilIcon className="edit-icon" />
                                        </button>
                                      </div>
                                    </div>
                                    {/* Test For Note (Admin) */}
                                    {application.testFor && (
                                      <div className="evaluation-notes" style={{ 
                                        backgroundColor: '#eff6ff', 
                                        borderLeft: '4px solid #2563eb',
                                        padding: '12px',
                                        marginBottom: '12px',
                                        borderRadius: '4px'
                                      }}>
                                        <p className="notes-label" style={{ 
                                          color: '#1e40af', 
                                          fontWeight: '600',
                                          marginBottom: '6px',
                                          fontSize: '0.875rem'
                                        }}>
                                          Test For (Admin Note):
                                        </p>
                                        <p className="notes-content" style={{ 
                                          color: '#1e40af',
                                          margin: 0,
                                          fontSize: '0.875rem',
                                          lineHeight: '1.5',
                                          whiteSpace: 'pre-wrap'
                                        }}>
                                          {application.testFor}
                                        </p>
                                      </div>
                                    )}
                                    {/* Basic Notes */}
                                    {evaluation.notes && (
                                      <div className="evaluation-notes">
                                        <p className="notes-label">General Notes:</p>
                                        <p className="notes-content">{evaluation.notes}</p>
                                      </div>
                                    )}

                                    {/* Behavioral Notes */}
                                    {evaluation.behavioralNotes && Object.keys(evaluation.behavioralNotes).length > 0 && (
                                      <div className="evaluation-notes">
                                        <p className="notes-label">Behavioral Assessment Notes:</p>
                                        {Object.entries(evaluation.behavioralNotes).map(([questionId, notes]) => (
                                          notes && (
                                            <div key={questionId} className="behavioral-question-notes">
                                              <p className="question-label">Question {Object.keys(evaluation.behavioralNotes).indexOf(questionId) + 1}:</p>
                                              <p className="notes-content">{notes}</p>
                                            </div>
                                          )
                                        ))}
                                      </div>
                                    )}

                                    {/* Casing Notes */}
                                    {evaluation.casingNotes && Object.keys(evaluation.casingNotes).length > 0 && (
                                      <div className="evaluation-notes">
                                        <p className="notes-label">Case Interview Notes:</p>
                                        {Object.entries(evaluation.casingNotes).map(([section, notes]) => (
                                          notes && (
                                            <div key={section} className="casing-section-notes">
                                              <p className="section-label">{section.replace(/([A-Z])/g, ' $1').trim()}:</p>
                                              <p className="notes-content">{notes}</p>
                                            </div>
                                          )
                                        ))}
                                      </div>
                                    )}

                                    {/* Candidate Details */}
                                    {evaluation.candidateDetails && Object.keys(evaluation.candidateDetails).length > 0 && (
                                      <div className="evaluation-notes">
                                        <p className="notes-label">Candidate Details Confirmation:</p>
                                        <div className="candidate-details-grid">
                                          {Object.entries(evaluation.candidateDetails).map(([field, value]) => (
                                            <div key={field} className="detail-item">
                                              <span className="detail-label">{field.replace(/([A-Z])/g, ' $1').trim()}:</span>
                                              <span className="detail-value">{value ? 'Yes' : 'No'}</span>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                    <div className="evaluation-meta">
                                      <span className="evaluation-date">
                                        {new Date(evaluation.updatedAt).toLocaleDateString()} at{' '}
                                        {new Date(evaluation.updatedAt).toLocaleTimeString()}
                                      </span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>

                      {/* Assigned Application Groups Section */}
                      <div className="expanded-section">
                        <h3 className="expanded-section-title">Assigned Application Groups</h3>
                        {(() => {
                          const currentInterviewData = interviewData[interview.id];
                          const allApplicationGroups = currentInterviewData?.applicationGroups || [];
                          const userMemberGroup = getUserMemberGroup(interview.id);
                          
                          // Filter application groups based on user's member group assignments
                          const assignedApplicationGroups = currentUser ? 
                            allApplicationGroups.filter(group => {
                              const groupAssignments = currentInterviewData?.groupAssignments || {};
                              
                              // Find all member groups that include the current user
                              const userId = String(currentUser.id);
                              const userMemberGroups = currentInterviewData?.memberGroups?.filter(memberGroup => {
                                if (!memberGroup.memberIds || !Array.isArray(memberGroup.memberIds)) {
                                  return false;
                                }
                                return memberGroup.memberIds.some(id => 
                                  String(id) === userId || id === currentUser.id
                                );
                              }) || [];
                              
                              // Check if this application group is assigned to any of the user's member groups
                              return userMemberGroups.some(memberGroup => 
                                groupAssignments[memberGroup.id]?.includes(group.id)
                              );
                            }) : [];
                          
                          return assignedApplicationGroups.length === 0 ? (
                            <div className="no-groups">
                              <UserGroupIcon className="no-groups-icon" />
                              <p>No application groups assigned to this interview</p>
                            </div>
                          ) : (
                            <div className="application-groups-list">
                              {assignedApplicationGroups.map((group) => (
                                <ApplicationGroupCard 
                                  key={group.id} 
                                  group={group} 
                                  interviewId={interview.id}
                                />
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  )}
                </div>

                {/* Card Footer */}
                <div className="interview-card-footer">
                  <button 
                    className="btn-primary interview-action-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedInterviewId(interview.id);
                      handleStartInterview(interview.id);
                    }}
                  >
                    <PlayIcon className="btn-icon" />
                    Start Interview
                  </button>
                </div>
              </div>
            );
          })
          );
        })()}
      </div>

      {/* Edit Evaluation Modal */}
      {editModalOpen && editingEvaluation && (
        <div className="modal-overlay">
          <div className="modal-content edit-evaluation-modal">
            <div className="modal-header">
              <h3>Edit Evaluation</h3>
              <div className="candidate-info-modal">
                {editingEvaluation.application.headshotUrl && (
                  <AuthenticatedImage
                    src={editingEvaluation.application.headshotUrl}
                    alt={`${editingEvaluation.application.firstName} ${editingEvaluation.application.lastName}`}
                    className="modal-candidate-photo"
                    style={{
                      width: '40px',
                      height: '40px',
                      borderRadius: '50%',
                      objectFit: 'cover'
                    }}
                  />
                )}
                <span className="modal-candidate-name">
                  {editingEvaluation.application.firstName} {editingEvaluation.application.lastName}
                </span>
              </div>
              <button className="icon-btn" onClick={handleCloseEditModal}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">Decision</label>
                <div className="decision-options">
                  {decisionOptions.map(option => (
                    <label key={option.value} className="decision-option">
                      <input
                        type="radio"
                        name="decision"
                        value={option.value}
                        checked={editFormData.decision === option.value}
                        onChange={(e) => setEditFormData(prev => ({ ...prev, decision: e.target.value }))}
                      />
                      <span className={`decision-label ${option.color}`}>
                        {option.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Notes</label>
                <textarea
                  className="form-textarea"
                  value={editFormData.notes}
                  onChange={(e) => setEditFormData(prev => ({ ...prev, notes: e.target.value }))}
                  placeholder="Add your evaluation notes here..."
                  rows={4}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button 
                className="btn-secondary" 
                onClick={handleCloseEditModal}
                disabled={saving}
              >
                Cancel
              </button>
              <button 
                className="btn-primary" 
                onClick={handleSaveEvaluation}
                disabled={saving}
              >
                <CheckIcon className="btn-icon" />
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </AccessControl>
  );
}
