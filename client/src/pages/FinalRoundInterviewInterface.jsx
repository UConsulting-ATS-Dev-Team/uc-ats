import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeftIcon,
  CheckIcon,
  UserIcon,
  DocumentTextIcon,
  ChatBubbleLeftRightIcon,
  ChartBarIcon,
  CalculatorIcon,
  LightBulbIcon,
  PresentationChartBarIcon,
  EyeIcon,
  DocumentDuplicateIcon,
  PlusIcon,
  PencilIcon
} from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import AuthenticatedImage from '../components/AuthenticatedImage';
import InterviewChatWidget from '../components/chat/InterviewChatWidget';
import { useCelebration } from '../context/CelebrationContext';
import '../styles/FinalRoundInterviewInterface.css';

export default function FinalRoundInterviewInterface() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const interviewId = searchParams.get('interviewId');
  const groupIds = searchParams.get('groupIds')?.split(',') || [];
  
  const { triggerCelebration } = useCelebration();
  
  const [interview, setInterview] = useState(null);
  const [applications, setApplications] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [evaluations, setEvaluations] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [autoSaveTimeouts, setAutoSaveTimeouts] = useState({});
  const [saveStatus, setSaveStatus] = useState({});
  const [currentPage, setCurrentPage] = useState(0); // 0 = behavioral, 1 = casing
  const [preview, setPreview] = useState({ open: false, src: '', kind: '', title: '' });

  const decisionOptions = [
    { value: 'YES', label: 'Yes', color: 'green' },
    { value: 'MAYBE_YES', label: 'Maybe-Yes', color: 'light-green' },
    { value: 'MAYBE_NO', label: 'Maybe-No', color: 'orange' },
    { value: 'NO', label: 'No', color: 'red' }
  ];

  // Behavioral questions will be loaded from interview configuration
  const [behavioralQuestions, setBehavioralQuestions] = useState([]);

  const casingSections = [
    { id: 'questions', title: 'Questions and prompt', icon: ChatBubbleLeftRightIcon },
    { id: 'framework', title: 'Framework', icon: ChartBarIcon },
    { id: 'quantitative', title: 'Quantitative', icon: CalculatorIcon },
    { id: 'qualitative', title: 'Qualitative', icon: LightBulbIcon },
    { id: 'conclusion', title: 'Conclusion', icon: PresentationChartBarIcon }
  ];

  const pageTitles = [
    { title: 'Behavioral Assessment', subtitle: 'Leadership, Problem Solving & Interest' },
    { title: 'Case Interview', subtitle: 'Analytical Thinking & Problem Solving' },
    { title: 'Confirm Candidate Details', subtitle: 'Logistical Information & Requirements' }
  ];

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true);
        console.log('Loading final round interview data for:', { interviewId, groupIds });
        
        if (!interviewId) {
          throw new Error('No interview ID provided');
        }
        if (!groupIds || groupIds.length === 0) {
          console.warn('No group IDs provided, will show empty applications list');
          setApplications([]);
          setLoading(false);
          return;
        }
        
        // Determine if this is an admin or member request based on the URL
        const isAdmin = window.location.pathname.includes('/admin/');
        const basePath = isAdmin ? '/admin' : '/member';
        
        // Load current user first to check authentication
        console.log('Loading current user...');
        const userRes = await apiClient.get(`${basePath}/profile`);
        console.log('Current user:', userRes);
        setCurrentUser(userRes);
        
        // Load interview details
        console.log('Loading interview details...');
        const interviewRes = await apiClient.get(`${basePath}/interviews/${interviewId}`);
        console.log('Interview data loaded:', interviewRes);
        setInterview(interviewRes);
        
        // Load interview configuration to get behavioral questions for selected groups
        try {
          const configRes = await apiClient.get(`${basePath}/interviews/${interviewId}/config?groupIds=${groupIds.join(',')}`);
          console.log('Interview config loaded:', configRes);
          const questionsByGroup = configRes.behavioralQuestions || {};
          
          // Flatten questions from all groups into a single array for display
          const allQuestions = [];
          Object.values(questionsByGroup).forEach(groupQuestions => {
            allQuestions.push(...groupQuestions);
          });
          
          // Sort by order
          allQuestions.sort((a, b) => a.order - b.order);
          
          console.log('Loaded behavioral questions from config:', allQuestions);
          setBehavioralQuestions(allQuestions);
        } catch (configError) {
          console.warn('Failed to load interview config:', configError);
          setBehavioralQuestions([]);
        }
        
        // Load applications for selected groups
        console.log('Loading applications for groups:', groupIds);
        try {
          const applicationsRes = await apiClient.get(`${basePath}/interviews/${interviewId}/applications?groupIds=${groupIds.join(',')}`);
          console.log('Applications loaded:', applicationsRes);
          setApplications(applicationsRes);
        } catch (appError) {
          console.error('Failed to load applications:', appError);
          setApplications([]);
        }
        
        // Load existing evaluations for the current user across all applications in this interview
        console.log('Loading existing evaluations...');
        const evaluationsRes = await apiClient.get(`${basePath}/evaluations?interviewId=${interviewId}`);
        console.log('Evaluations loaded:', evaluationsRes);
        const evaluationsMap = {};
        evaluationsRes.forEach(evaluation => {
          evaluationsMap[`${evaluation.applicationId}_${evaluation.evaluatorId}`] = evaluation;
        });
        setEvaluations(evaluationsMap);
        
      } catch (error) {
        console.error('Failed to load interview data:', error);
        alert('Failed to load interview data');
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
      behavioralNotes: '',
      casingNotes: {},
      finalDecision: null
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

  const updateBehavioralNotes = (applicationId, questionId, notes) => {
    const evaluation = getEvaluation(applicationId);
    const behavioralNotes = { ...evaluation.behavioralNotes };
    behavioralNotes[questionId] = notes;
    updateEvaluation(applicationId, { behavioralNotes });
    scheduleAutoSave(applicationId);
  };


  const updateCasingNotes = (applicationId, sectionId, notes) => {
    const evaluation = getEvaluation(applicationId);
    const casingNotes = { ...evaluation.casingNotes };
    casingNotes[sectionId] = notes;
    updateEvaluation(applicationId, { casingNotes });
    scheduleAutoSave(applicationId);
  };

  const updateFinalDecision = (applicationId, decision) => {
    updateEvaluation(applicationId, { finalDecision: decision });
    scheduleAutoSave(applicationId);
  };

  const updateCandidateDetails = (applicationId, detailKey, value) => {
    const evaluation = getEvaluation(applicationId);
    const candidateDetails = { ...evaluation.candidateDetails };
    candidateDetails[detailKey] = value;
    updateEvaluation(applicationId, { candidateDetails });
    scheduleAutoSave(applicationId);
  };

  const addBehavioralQuestion = async (groupId) => {
    try {
      const isAdmin = window.location.pathname.includes('/admin/');
      const basePath = isAdmin ? '/admin' : '/member';
      
      // Get current questions for the specific group
      const configRes = await apiClient.get(`${basePath}/interviews/${interviewId}/config?groupIds=${groupId}`);
      const questionsByGroup = configRes.behavioralQuestions || {};
      const currentQuestions = questionsByGroup[groupId] || [];
      
      // Add new empty question
      const newQuestions = [...currentQuestions.map(q => q.text || q), ''];
      
      // Update configuration for this specific group
      await apiClient.patch(`${basePath}/interviews/${interviewId}/config`, {
        type: 'behavioral_questions',
        config: {
          behavioralQuestions: true,
          groupId: groupId,
          questions: newQuestions
        }
      });
      
      // Reload questions for all groups
      const updatedConfigRes = await apiClient.get(`${basePath}/interviews/${interviewId}/config?groupIds=${groupIds.join(',')}`);
      const updatedQuestionsByGroup = updatedConfigRes.behavioralQuestions || {};
      const allQuestions = [];
      Object.values(updatedQuestionsByGroup).forEach(groupQuestions => {
        allQuestions.push(...groupQuestions);
      });
      allQuestions.sort((a, b) => a.order - b.order);
      setBehavioralQuestions(allQuestions);
      
      alert('Question added successfully!');
    } catch (error) {
      console.error('Failed to add question:', error);
      alert('Failed to add question');
    }
  };

  const updateBehavioralQuestion = async (questionId, newQuestion) => {
    try {
      const isAdmin = window.location.pathname.includes('/admin/');
      const basePath = isAdmin ? '/admin' : '/member';
      
      // Find which group this question belongs to
      const currentQuestion = behavioralQuestions.find(q => q.id === questionId);
      if (!currentQuestion) {
        alert('Question not found');
        return;
      }
      
      const groupId = currentQuestion.groupId;
      
      // Get current questions for the specific group
      const configRes = await apiClient.get(`${basePath}/interviews/${interviewId}/config?groupIds=${groupId}`);
      const questionsByGroup = configRes.behavioralQuestions || {};
      const currentQuestions = questionsByGroup[groupId] || [];
      
      // Update the specific question
      const updatedQuestions = currentQuestions.map(q => 
        q.id === questionId ? { ...q, text: newQuestion } : q
      );
      
      // Update configuration for this specific group
      await apiClient.patch(`${basePath}/interviews/${interviewId}/config`, {
        type: 'behavioral_questions',
        config: {
          behavioralQuestions: true,
          groupId: groupId,
          questions: updatedQuestions.map(q => q.text)
        }
      });
      
      // Reload questions for all groups
      const updatedConfigRes = await apiClient.get(`${basePath}/interviews/${interviewId}/config?groupIds=${groupIds.join(',')}`);
      const updatedQuestionsByGroup = updatedConfigRes.behavioralQuestions || {};
      const allQuestions = [];
      Object.values(updatedQuestionsByGroup).forEach(groupQuestions => {
        allQuestions.push(...groupQuestions);
      });
      allQuestions.sort((a, b) => a.order - b.order);
      setBehavioralQuestions(allQuestions);
      
    } catch (error) {
      console.error('Failed to update question:', error);
      alert('Failed to update question');
    }
  };

  const scheduleAutoSave = (applicationId) => {
    // Clear existing timeout for this application
    if (autoSaveTimeouts[applicationId]) {
      clearTimeout(autoSaveTimeouts[applicationId]);
    }

    // Set new timeout for auto-save (5 seconds after last change)
    const timeoutId = setTimeout(() => {
      autoSaveEvaluation(applicationId);
    }, 5000);

    setAutoSaveTimeouts(prev => ({
      ...prev,
      [applicationId]: timeoutId
    }));
  };

  const autoSaveEvaluation = async (applicationId) => {
    try {
      const isAdmin = window.location.pathname.includes('/admin/');
      const basePath = isAdmin ? '/admin' : '/member';
      const evaluation = getEvaluation(applicationId);
      
      if (isAdmin) {
        await apiClient.post(`${basePath}/interviews/${interviewId}/evaluations`, {
          applicationId,
          decision: evaluation.finalDecision,
          behavioralNotes: evaluation.behavioralNotes,
          casingNotes: evaluation.casingNotes,
          candidateDetails: evaluation.candidateDetails
        });
      } else {
        await apiClient.post(`${basePath}/evaluations`, {
          interviewId,
          applicationId,
          decision: evaluation.finalDecision,
          behavioralNotes: evaluation.behavioralNotes,
          casingNotes: evaluation.casingNotes,
          candidateDetails: evaluation.candidateDetails
        });
      }
      
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
      const isAdmin = window.location.pathname.includes('/admin/');
      const basePath = isAdmin ? '/admin' : '/member';
      setSaving(true);
      const evaluation = getEvaluation(applicationId);
      
      if (isAdmin) {
        await apiClient.post(`${basePath}/interviews/${interviewId}/evaluations`, {
          applicationId,
          decision: evaluation.finalDecision,
          behavioralNotes: evaluation.behavioralNotes,
          casingNotes: evaluation.casingNotes,
          candidateDetails: evaluation.candidateDetails
        });
      } else {
        await apiClient.post(`${basePath}/evaluations`, {
          interviewId,
          applicationId,
          decision: evaluation.finalDecision,
          behavioralNotes: evaluation.behavioralNotes,
          casingNotes: evaluation.casingNotes,
          candidateDetails: evaluation.candidateDetails
        });
      }
      
      alert('Evaluation saved successfully');
      triggerCelebration();
    } catch (error) {
      console.error('Failed to save evaluation:', error);
      alert('Failed to save evaluation');
    } finally {
      setSaving(false);
    }
  };

  const saveAllEvaluations = async () => {
    try {
      const isAdmin = window.location.pathname.includes('/admin/');
      const basePath = isAdmin ? '/admin' : '/member';
      setSaving(true);
      const promises = applications.map(app => {
        const evaluation = getEvaluation(app.id);
        if (isAdmin) {
          return apiClient.post(`${basePath}/interviews/${interviewId}/evaluations`, {
            applicationId: app.id,
            decision: evaluation.finalDecision,
            behavioralNotes: evaluation.behavioralNotes,
            casingNotes: evaluation.casingNotes,
            candidateDetails: evaluation.candidateDetails
          });
        } else {
          return apiClient.post(`${basePath}/evaluations`, {
            interviewId,
            applicationId: app.id,
            decision: evaluation.finalDecision,
            behavioralNotes: evaluation.behavioralNotes,
            casingNotes: evaluation.casingNotes,
            candidateDetails: evaluation.candidateDetails
          });
        }
      });
      
      await Promise.all(promises);
      triggerCelebration();
      alert('All evaluations saved successfully!');
    } catch (error) {
      console.error('Failed to save evaluations:', error);
      alert('Failed to save evaluations');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="final-round-interface-container">
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>Loading final round interview data...</p>
        </div>
      </div>
    );
  }

  if (!interview || applications.length === 0) {
    return (
      <div className="final-round-interface-container">
        <div className="error-state">
          <h2>No interview data found</h2>
          <p>Please check your interview selection and try again.</p>
          <button className="btn-primary" onClick={() => {
            const isAdmin = window.location.pathname.includes('/admin/');
            navigate(isAdmin ? '/admin/assigned-interviews' : '/assigned-interviews');
          }}>
            Back to Interviews
          </button>
        </div>
      </div>
    );
  }

  if (behavioralQuestions.length === 0 && currentPage === 0) {
    return (
      <div className="final-round-interface-container">
        <div className="error-state">
          <h2>No Behavioral Questions Configured</h2>
          <p>This interview doesn't have any behavioral questions configured. Please go back and configure the questions for this interview.</p>
          <button className="btn-primary" onClick={() => {
            const isAdmin = window.location.pathname.includes('/admin/');
            navigate(isAdmin ? '/admin/assigned-interviews' : '/assigned-interviews');
          }}>
            Back to Interviews
          </button>
        </div>
      </div>
    );
  }

  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <div className="final-round-interface-container">
        {/* Header */}
        <div className="interview-header">
          <button 
            className="back-button"
            onClick={() => {
              const isAdmin = window.location.pathname.includes('/admin/');
              navigate(isAdmin ? '/admin/assigned-interviews' : '/assigned-interviews');
            }}
          >
            <ArrowLeftIcon className="back-icon" />
            Back to Interviews
          </button>
          
          <div className="interview-info">
            <h1>{interview.title}</h1>
            <p className="interview-meta">
              Final Round Interview • {applications.length} applications
            </p>
          </div>
          
          <div className="header-actions">
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

        {/* Page Navigation */}
        <div className="page-navigation">
          <div className="nav-tabs">
            {pageTitles.map((page, index) => (
              <button
                key={index}
                className={`nav-tab ${currentPage === index ? 'active' : ''}`}
                onClick={() => setCurrentPage(index)}
              >
                <div className="tab-content">
                  <h3>{page.title}</h3>
                  <p>{page.subtitle}</p>
                </div>
              </button>
            ))}
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
                        <AuthenticatedImage
                          src={application.headshotUrl}
                          alt={application.name}
                          style={{
                            width: '100%',
                            height: '100%',
                            borderRadius: '50%',
                            objectFit: 'cover'
                          }}
                        />
                      ) : (
                        <UserIcon className="avatar-icon" />
                      )}
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
                      backgroundColor: '#eff6ff', 
                      borderLeft: '4px solid #2563eb',
                      borderRadius: '4px'
                    }}>
                      <p style={{ 
                        color: '#1e40af', 
                        fontWeight: '600',
                        marginBottom: '6px',
                        fontSize: '0.875rem',
                        margin: '0 0 6px 0'
                      }}>
                        Test For (Admin Note):
                      </p>
                      <p style={{ 
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

                {/* Document Links */}
                <div className="document-links">
                  <h4 className="section-title">
                    <DocumentTextIcon className="section-icon" />
                    Documents
                  </h4>
                  <div className="document-buttons">
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
                        <DocumentDuplicateIcon className="btn-icon" />
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
                        <DocumentDuplicateIcon className="btn-icon" />
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

                {/* Behavioral Section */}
                {currentPage === 0 && (
                  <div className="behavioral-section">
                    <div className="section-header">
                      <h4 className="section-title">
                        <UserIcon className="section-icon" />
                        Behavioral Assessment
                      </h4>
                      <button 
                        className="add-question-btn"
                        onClick={() => {
                          // For now, add to the first group. In a more advanced UI, we'd let user choose the group
                          if (groupIds.length > 0) {
                            addBehavioralQuestion(groupIds[0]);
                          } else {
                            alert('No groups selected');
                          }
                        }}
                        title="Add a new behavioral question"
                      >
                        <PlusIcon className="btn-icon" />
                        Add Question
                      </button>
                    </div>
                    
                    <div className="behavioral-questions">
                      {behavioralQuestions.map((question, questionIndex) => (
                        <div key={question.id || questionIndex} className="question-row">
                          <div className="question-cell">
                            <div className="question-header">
                              <h5 className="question-text">{question.text || question || `Question ${questionIndex + 1}`}</h5>
                              {question.createdBy && (
                                <span className="question-creator">
                                  Created by: {question.createdBy.fullName}
                                </span>
                              )}
                              <button 
                                className="edit-question-btn"
                                onClick={() => {
                                  const currentText = question.text || question;
                                  const newQuestion = prompt('Edit question:', currentText);
                                  if (newQuestion !== null && newQuestion !== currentText) {
                                    updateBehavioralQuestion(question.id, newQuestion);
                                  }
                                }}
                                title="Edit this question"
                              >
                                <PencilIcon className="btn-icon" />
                              </button>
                            </div>
                          </div>
                          <div className="interviewer-notes-cell">
                            <textarea
                              className="notes-textarea"
                              value={evaluation.behavioralNotes?.[question.id] || ''}
                              onChange={(e) => updateBehavioralNotes(application.id, question.id, e.target.value)}
                              placeholder="Your notes..."
                              rows={4}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Casing Section */}
                {currentPage === 1 && (
                  <div className="casing-section">
                    <h4 className="section-title">
                      <PresentationChartBarIcon className="section-icon" />
                      Case Interview
                    </h4>
                    
                    <div className="casing-sections">
                      {casingSections.map((section) => {
                        const IconComponent = section.icon;
                        return (
                          <div key={section.id} className="casing-section-row">
                            <div className="section-cell">
                              <h5 className="section-text">
                                <IconComponent className="section-icon-small" />
                                {section.title}
                              </h5>
                            </div>
                            <div className="interviewer-notes-cell">
                              <textarea
                                className="notes-textarea"
                                value={evaluation.casingNotes?.[section.id] || ''}
                                onChange={(e) => updateCasingNotes(application.id, section.id, e.target.value)}
                                placeholder="Your notes..."
                                rows={5}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Candidate Details Section */}
                {currentPage === 2 && (
                  <div className="candidate-details-section">
                    <h4 className="section-title">
                      <CheckIcon className="section-icon" />
                      Confirm Candidate Details
                    </h4>
                    <div className="logistical-info">
                      <div className="logistical-item">
                        <label className="logistical-label">
                          <input
                            type="checkbox"
                            checked={evaluation.candidateDetails?.phoneConfirmed || false}
                            onChange={(e) => updateCandidateDetails(application.id, 'phoneConfirmed', e.target.checked)}
                          />
                          Confirm phone number: {application.phoneNumber || 'No phone number on file'}
                        </label>
                      </div>
                      
                      <div className="logistical-item">
                        <label className="logistical-label">
                          <input
                            type="checkbox"
                            checked={evaluation.candidateDetails?.decisionCallTonight || false}
                            onChange={(e) => updateCandidateDetails(application.id, 'decisionCallTonight', e.target.checked)}
                          />
                          We will communicate a decision tonight.
                        </label>
                      </div>
                      
                      <div className="logistical-item">
                        <label className="logistical-label">
                          <input
                            type="checkbox"
                            checked={evaluation.candidateDetails?.weeklyMeetings || false}
                            onChange={(e) => updateCandidateDetails(application.id, 'weeklyMeetings', e.target.checked)}
                          />
                          Weekly mandatory meetings Tuesdays 6-7pm on the hill
                        </label>
                      </div>
                      
                      <div className="logistical-item">
                        <label className="logistical-label">
                          <input
                            type="checkbox"
                            checked={evaluation.candidateDetails?.accelerator || false}
                            onChange={(e) => updateCandidateDetails(application.id, 'accelerator', e.target.checked)}
                          />
                          Weekly Accelerator Mondays 6:00 - 7:00 during the rest of Winter Quarter
                        </label>
                      </div>
                      
                      <div className="logistical-item">
                        <label className="logistical-label">
                          <input
                            type="checkbox"
                            checked={evaluation.candidateDetails?.coffeeChats || false}
                            onChange={(e) => updateCandidateDetails(application.id, 'coffeeChats', e.target.checked)}
                          />
                          At least 3 coffee chats with members each week
                        </label>
                      </div>
                      
                      <div className="logistical-item">
                        <label className="logistical-label">
                          <input
                            type="checkbox"
                            checked={evaluation.candidateDetails?.dues || false}
                            onChange={(e) => updateCandidateDetails(application.id, 'dues', e.target.checked)}
                          />
                          One time membership fee of $230
                        </label>
                      </div>
                    </div>
                  </div>
                )}

              </div>
            );
          })}
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
        <InterviewChatWidget interviewId={interviewId} interviewTitle={interview?.title} />
      </div>
    </AccessControl>
  );
}
