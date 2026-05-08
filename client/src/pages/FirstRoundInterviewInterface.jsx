import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeftIcon,
  CheckIcon,
  UserIcon,
  DocumentTextIcon,
  EyeIcon,
  ClockIcon,
  PlusIcon,
  PencilIcon,
  ChevronLeftIcon,
  ChevronRightIcon
} from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import AuthenticatedImage from '../components/AuthenticatedImage';
import InterviewChatWidget from '../components/chat/InterviewChatWidget';
import '../styles/FirstRoundInterviewInterface.css';

export default function FirstRoundInterviewInterface() {
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
  const [currentRotation, setCurrentRotation] = useState(0); // 0 = behaviorals, 1 = market sizing, 2 = post grading
  const [preview, setPreview] = useState({ open: false, src: '', kind: '', title: '' });
  const [behavioralQuestions, setBehavioralQuestions] = useState([]);
  const [timeRemaining, setTimeRemaining] = useState({ minutes: 30, seconds: 0 });
  const [interviewStartTime, setInterviewStartTime] = useState(null);

  const decisionOptions = [
    { value: 'YES', label: 'Yes', color: 'green' },
    { value: 'MAYBE_YES', label: 'Maybe-Yes', color: 'light-green' },
    { value: 'MAYBE_NO', label: 'Maybe-No', color: 'orange' },
    { value: 'NO', label: 'No', color: 'red' }
  ];

  const rotations = [
    { id: 'behaviorals', title: 'Behaviorals', icon: CheckIcon },
    { id: 'market_sizing', title: 'Market Sizing', icon: ClockIcon },
    { id: 'post_grading', title: 'Post Grading', icon: ClockIcon }
  ];

  // Calculate suggested itinerary based on when user clicked "Start Interview"
  const getSuggestedItinerary = () => {
    // Use the actual start time when user clicked the button, not the scheduled time
    const startTime = interviewStartTime;
    
    if (!startTime) {
      return [
        { time: '--:--', title: 'Intros', icon: ClockIcon },
        { time: '--:--', title: 'Behaviorals', icon: ClockIcon, active: currentRotation === 0 },
        { time: '--:--', title: 'Market Size', icon: ClockIcon, active: currentRotation === 1 },
        { time: '--:--', title: 'Present', icon: ClockIcon },
        { time: '--:--', title: 'Questions', icon: ClockIcon }
      ];
    }

    const formatTime = (date) => {
      // Use 12-hour format with AM/PM
      return date.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      });
    };

    const addMinutes = (date, minutes) => {
      const result = new Date(date);
      result.setMinutes(result.getMinutes() + minutes);
      return result;
    };

    // Itinerary timing:
    // Intros: 0-5 minutes (5 mins)
    // Behaviorals: 5-35 minutes (30 mins) 
    // Market Size: 35-50 minutes (15 mins)
    // Present: 50-52 minutes (2 mins)
    // Questions: 52-60 minutes (8 mins)

    return [
      { 
        time: `${formatTime(startTime)}-${formatTime(addMinutes(startTime, 5))}`, 
        title: 'Intros', 
        icon: ClockIcon 
      },
      { 
        time: `${formatTime(addMinutes(startTime, 5))}-${formatTime(addMinutes(startTime, 35))}`, 
        title: 'Behaviorals', 
        icon: ClockIcon, 
        active: currentRotation === 0 
      },
      { 
        time: `${formatTime(addMinutes(startTime, 35))}-${formatTime(addMinutes(startTime, 50))}`, 
        title: 'Market Size', 
        icon: ClockIcon, 
        active: currentRotation === 1,
        showTimeRemaining: currentRotation === 1
      },
      { 
        time: `${formatTime(addMinutes(startTime, 50))}-${formatTime(addMinutes(startTime, 52))}`, 
        title: 'Present', 
        icon: ClockIcon 
      },
      { 
        time: `${formatTime(addMinutes(startTime, 52))}-${formatTime(addMinutes(startTime, 60))}`, 
        title: 'Questions', 
        icon: ClockIcon 
      }
    ];
  };

  // Recalculate itinerary when interview start time or rotation changes
  const suggestedItinerary = useMemo(() => getSuggestedItinerary(), [interviewStartTime, currentRotation]);

  // Set interview start time when component first loads (when user clicks "Start Interview")
  useEffect(() => {
    if (!interviewStartTime && interviewId) {
      setInterviewStartTime(new Date());
      console.log('Interview started at:', new Date());
    }
  }, [interviewId]);

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true);
        console.log('=== FIRST ROUND INTERVIEW INTERFACE LOADING ===');
        console.log('Loading first round interview data for:', { interviewId, groupIds });
        
        if (!interviewId) {
          throw new Error('No interview ID provided');
        }
        if (!groupIds || groupIds.length === 0) {
          console.warn('No group IDs provided, will show empty applications list');
          setApplications([]);
          setLoading(false);
          return;
        }
        
        // Load current user (try both admin and member endpoints)
        console.log('Loading current user...');
        let userRes;
        let isAdmin = false;
        try {
          userRes = await apiClient.get('/admin/profile');
          isAdmin = true;
          console.log('Current user (admin):', userRes);
        } catch (adminError) {
          try {
            userRes = await apiClient.get('/member/profile');
            isAdmin = false;
            console.log('Current user (member):', userRes);
          } catch (memberError) {
            throw new Error('Failed to load user profile');
          }
        }
        setCurrentUser(userRes);
        
        // Load interview details
        console.log('Loading interview details...');
        const interviewRes = isAdmin 
          ? await apiClient.get(`/admin/interviews/${interviewId}`)
          : await apiClient.get(`/member/interviews/${interviewId}`);
        console.log('Interview data loaded:', interviewRes);
        setInterview(interviewRes);
        
        // Load interview configuration to get behavioral questions for selected groups
        try {
          const configRes = await apiClient.get(`${isAdmin ? '/admin' : '/member'}/interviews/${interviewId}/config?groupIds=${groupIds.join(',')}`);
          console.log('Interview config loaded:', configRes);
          const questionsByGroup = configRes.behavioralQuestions || {};
          
          // Flatten questions from all groups into a single array for display
          const allQuestions = [];
          Object.values(questionsByGroup).forEach(groupQuestions => {
            allQuestions.push(...groupQuestions);
          });
          
          // Sort by order
          allQuestions.sort((a, b) => (a.order || 0) - (b.order || 0));
          
          // Normalize questions to ensure consistent structure
          const normalizedQuestions = allQuestions.map((q, idx) => {
            if (typeof q === 'string') {
              return { id: `temp-${idx}`, text: q, order: idx };
            }
            return {
              id: q.id || `temp-${idx}`,
              text: q.text || q.questionText || q,
              order: q.order !== undefined ? q.order : idx,
              groupId: q.groupId
            };
          });
          
          console.log('Loaded behavioral questions from config:', normalizedQuestions);
          setBehavioralQuestions(normalizedQuestions);
        } catch (configError) {
          console.warn('Failed to load interview config:', configError);
          setBehavioralQuestions([]);
        }
        
        // Load applications for selected groups
        console.log('Loading applications for groups:', groupIds);
        try {
          const applicationsRes = isAdmin
            ? await apiClient.get(`/admin/interviews/${interviewId}/applications?groupIds=${groupIds.join(',')}`)
            : await apiClient.get(`/member/interviews/${interviewId}/applications?groupIds=${groupIds.join(',')}`);
          console.log('Applications loaded:', applicationsRes);
          setApplications(applicationsRes);
        } catch (appError) {
          console.error('Failed to load applications:', appError);
          setApplications([]);
        }
        
        // Load existing evaluations
        console.log('Loading existing evaluations...');
        try {
          const evaluationsRes = isAdmin
            ? await apiClient.get(`/admin/evaluations?interviewId=${interviewId}`)
            : await apiClient.get(`/member/evaluations?interviewId=${interviewId}`);
          console.log('Evaluations loaded:', evaluationsRes);
          
          const evaluationsObj = {};
          evaluationsRes.forEach(evaluation => {
            evaluationsObj[evaluation.applicationId] = evaluation;
          });
          setEvaluations(evaluationsObj);
        } catch (evaluationError) {
          console.error('Failed to load evaluations:', evaluationError);
          setEvaluations({});
        }
        
      } catch (error) {
        console.error('Failed to load interview data:', error);
        alert('Failed to load interview data: ' + error.message);
        navigate('/assigned-interviews');
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
  }, [interviewId, groupIds.join(','), navigate]);

  // Timer effect for time remaining - calculate based on when user clicked "Start Interview"
  useEffect(() => {
    if (interviewStartTime) {
      const calculateTimeRemaining = () => {
        let sectionStart, sectionEnd;
        
        if (currentRotation === 0) {
          // Behaviorals: 5-35 minutes from start
          sectionStart = new Date(interviewStartTime);
          sectionStart.setMinutes(sectionStart.getMinutes() + 5);
          sectionEnd = new Date(interviewStartTime);
          sectionEnd.setMinutes(sectionEnd.getMinutes() + 35);
        } else if (currentRotation === 1) {
          // Market Sizing: 35-50 minutes from start
          sectionStart = new Date(interviewStartTime);
          sectionStart.setMinutes(sectionStart.getMinutes() + 35);
          sectionEnd = new Date(interviewStartTime);
          sectionEnd.setMinutes(sectionEnd.getMinutes() + 50);
        } else {
          return { minutes: 0, seconds: 0 };
        }
        
        const now = new Date();
        const remainingMs = sectionEnd.getTime() - now.getTime();
        
        if (remainingMs <= 0) {
          return { minutes: 0, seconds: 0 };
        }
        
        const minutes = Math.floor(remainingMs / 60000);
        const seconds = Math.floor((remainingMs % 60000) / 1000);
        
        return { minutes, seconds };
      };

      // Calculate immediately
      setTimeRemaining(calculateTimeRemaining());

      // Update every second
      const interval = setInterval(() => {
        setTimeRemaining(calculateTimeRemaining());
      }, 1000);
      
      return () => clearInterval(interval);
    } else {
      // Fallback if no interview start time
      if (currentRotation === 0) {
        setTimeRemaining({ minutes: 30, seconds: 0 });
      } else if (currentRotation === 1) {
        setTimeRemaining({ minutes: 15, seconds: 0 });
      }
    }
  }, [currentRotation, interviewStartTime]);

  const getEvaluation = (applicationId) => {
    const evaluation = evaluations[applicationId] || {};
    
    return {
      notes: evaluation.notes || '',
      decision: evaluation.decision || null,
      behavioralNotes: evaluation.behavioralNotes || {},
      marketSizingNotes: evaluation.marketSizingNotes || '',
      behavioralLeadership: evaluation.behavioralLeadership || null,
      behavioralProblemSolving: evaluation.behavioralProblemSolving || null,
      behavioralInterest: evaluation.behavioralInterest || null,
      behavioralTotal: evaluation.behavioralTotal || null,
      marketSizingTeamwork: evaluation.marketSizingTeamwork || null,
      marketSizingLogic: evaluation.marketSizingLogic || null,
      marketSizingCreativity: evaluation.marketSizingCreativity || null,
      marketSizingTotal: evaluation.marketSizingTotal || null
    };
  };

  const updateEvaluation = (applicationId, updates) => {
    setEvaluations(prev => ({
      ...prev,
      [applicationId]: {
        ...getEvaluation(applicationId),
        ...updates
      }
    }));
    scheduleAutoSave(applicationId);
  };

  const updateBehavioralNotes = (applicationId, questionId, notes) => {
    const evaluation = getEvaluation(applicationId);
    const behavioralNotes = { ...evaluation.behavioralNotes };
    behavioralNotes[questionId] = notes;
    updateEvaluation(applicationId, { behavioralNotes });
    scheduleAutoSave(applicationId);
  };

  const updateBehavioralScore = (applicationId, field, value) => {
    const evaluation = getEvaluation(applicationId);
    const newScores = {
      ...evaluation,
      [field]: value ? parseInt(value) : null
    };
    
    // Calculate behavioral total
    const leadership = newScores.behavioralLeadership || 0;
    const problemSolving = newScores.behavioralProblemSolving || 0;
    const interest = newScores.behavioralInterest || 0;
    newScores.behavioralTotal = leadership + problemSolving + interest;
    
    updateEvaluation(applicationId, newScores);
    scheduleAutoSave(applicationId);
  };

  const updateMarketSizingScore = (applicationId, field, value) => {
    const evaluation = getEvaluation(applicationId);
    const newScores = {
      ...evaluation,
      [field]: value ? parseInt(value) : null
    };
    
    // Calculate market sizing total
    const teamwork = newScores.marketSizingTeamwork || 0;
    const logic = newScores.marketSizingLogic || 0;
    const creativity = newScores.marketSizingCreativity || 0;
    newScores.marketSizingTotal = teamwork + logic + creativity;
    
    updateEvaluation(applicationId, newScores);
    scheduleAutoSave(applicationId);
  };

  const scheduleAutoSave = (applicationId) => {
    if (autoSaveTimeouts[applicationId]) {
      clearTimeout(autoSaveTimeouts[applicationId]);
    }

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
      const isAdmin = currentUser?.role === 'ADMIN';
      const endpoint = isAdmin ? `/admin/interviews/${interviewId}/evaluations` : '/member/evaluations';
      
      await apiClient.post(endpoint, {
        interviewId,
        applicationId,
        decision: evaluation.decision,
        notes: evaluation.notes,
        behavioralNotes: evaluation.behavioralNotes,
        marketSizingNotes: evaluation.marketSizingNotes,
        behavioralLeadership: evaluation.behavioralLeadership,
        behavioralProblemSolving: evaluation.behavioralProblemSolving,
        behavioralInterest: evaluation.behavioralInterest,
        behavioralTotal: evaluation.behavioralTotal,
        marketSizingTeamwork: evaluation.marketSizingTeamwork,
        marketSizingLogic: evaluation.marketSizingLogic,
        marketSizingCreativity: evaluation.marketSizingCreativity,
        marketSizingTotal: evaluation.marketSizingTotal
      });
      
    } catch (error) {
      console.error('Auto-save failed:', error);
      console.error('Error details:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status
      });
      setSaveStatus(prev => ({
        ...prev,
        [applicationId]: { type: 'error', message: 'Auto-save failed', timestamp: Date.now() }
      }));
    }
  };

  const saveEvaluation = async (applicationId, showAlert = true) => {
    try {
      setSaving(true);
      const evaluation = getEvaluation(applicationId);
      const isAdmin = window.location.pathname.includes('/admin/');
      const endpoint = isAdmin ? `/admin/interviews/${interviewId}/evaluations` : '/member/evaluations';
      
      await apiClient.post(endpoint, {
        interviewId,
        applicationId,
        decision: evaluation.decision,
        notes: evaluation.notes,
        behavioralNotes: evaluation.behavioralNotes,
        marketSizingNotes: evaluation.marketSizingNotes,
        behavioralLeadership: evaluation.behavioralLeadership,
        behavioralProblemSolving: evaluation.behavioralProblemSolving,
        behavioralInterest: evaluation.behavioralInterest,
        behavioralTotal: evaluation.behavioralTotal,
        marketSizingTeamwork: evaluation.marketSizingTeamwork,
        marketSizingLogic: evaluation.marketSizingLogic,
        marketSizingCreativity: evaluation.marketSizingCreativity,
        marketSizingTotal: evaluation.marketSizingTotal
      });
      
      if (showAlert) {
        alert('Evaluation saved successfully');
      }
    } catch (error) {
      console.error('Failed to save evaluation:', error);
      console.error('Error details:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status,
        requestData: {
          interviewId,
          applicationId,
          behavioralNotes: evaluation.behavioralNotes,
          behavioralLeadership: evaluation.behavioralLeadership
        }
      });
      if (showAlert) {
        alert(`Failed to save evaluation: ${error.response?.data?.error || error.message}`);
      }
      throw error; // Re-throw so saveAllEvaluations can catch it
    } finally {
      setSaving(false);
    }
  };

  const saveAllEvaluations = async () => {
    try {
      setSaving(true);
      const isAdmin = window.location.pathname.includes('/admin/');
      const endpoint = isAdmin ? `/admin/interviews/${interviewId}/evaluations` : '/member/evaluations';
      
      const promises = applications.map(app => {
        const evaluation = getEvaluation(app.id);
        return apiClient.post(endpoint, {
          interviewId,
          applicationId: app.id,
          decision: evaluation.decision,
          notes: evaluation.notes,
          behavioralNotes: evaluation.behavioralNotes,
          marketSizingNotes: evaluation.marketSizingNotes,
          behavioralLeadership: evaluation.behavioralLeadership,
          behavioralProblemSolving: evaluation.behavioralProblemSolving,
          behavioralInterest: evaluation.behavioralInterest,
          behavioralTotal: evaluation.behavioralTotal,
          marketSizingTeamwork: evaluation.marketSizingTeamwork,
          marketSizingLogic: evaluation.marketSizingLogic,
          marketSizingCreativity: evaluation.marketSizingCreativity,
          marketSizingTotal: evaluation.marketSizingTotal
        });
      });
      
      await Promise.all(promises);
      alert(`All ${applications.length} evaluation(s) saved successfully`);
    } catch (error) {
      console.error('Failed to save evaluations:', error);
      alert(`Failed to save evaluations: ${error.response?.data?.error || error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const addBehavioralQuestion = async (groupId) => {
    try {
      console.log('Adding behavioral question for group:', groupId);
      const isAdmin = window.location.pathname.includes('/admin/');
      const basePath = isAdmin ? '/admin' : '/member';
      
      // Get current questions for the specific group
      const configRes = await apiClient.get(`${basePath}/interviews/${interviewId}/config?groupIds=${groupId}`);
      console.log('Current config response:', configRes);
      const questionsByGroup = configRes.behavioralQuestions || {};
      const currentQuestions = questionsByGroup[groupId] || [];
      console.log('Current questions for group:', currentQuestions);
      
      // Add new question with placeholder text (server filters out empty strings)
      // Handle both object format (with .text property) and string format
      const questionTexts = currentQuestions.length > 0 
        ? currentQuestions.map(q => (typeof q === 'string' ? q : (q.text || q)))
        : [];
      // Use a placeholder text so the server will create the question
      const newQuestionNumber = questionTexts.length + 1;
      const newQuestions = [...questionTexts, `Question ${newQuestionNumber}`];
      console.log('New questions array:', newQuestions);
      
      // Update configuration for this specific group
      const updateResponse = await apiClient.patch(`${basePath}/interviews/${interviewId}/config`, {
        type: 'behavioral_questions',
        config: {
          behavioralQuestions: true,
          groupId: groupId,
          questions: newQuestions
        }
      });
      console.log('Update response:', updateResponse);
      
      // Reload questions for all groups - add a small delay to ensure server has processed
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const updatedConfigRes = await apiClient.get(`${basePath}/interviews/${interviewId}/config?groupIds=${groupIds.join(',')}`);
      console.log('Updated config response:', updatedConfigRes);
      const updatedQuestionsByGroup = updatedConfigRes.behavioralQuestions || {};
      const allQuestions = [];
      Object.values(updatedQuestionsByGroup).forEach(groupQuestions => {
        allQuestions.push(...groupQuestions);
      });
      allQuestions.sort((a, b) => (a.order || 0) - (b.order || 0));
      console.log('Setting behavioral questions to:', allQuestions);
      
      // Ensure all questions have proper structure
      const normalizedQuestions = allQuestions.map((q, idx) => {
        if (typeof q === 'string') {
          return { id: `temp-${idx}`, text: q, order: idx };
        }
        return {
          id: q.id || `temp-${idx}`,
          text: q.text || q.questionText || q,
          order: q.order !== undefined ? q.order : idx,
          groupId: q.groupId
        };
      });
      
      setBehavioralQuestions(normalizedQuestions);
      
      alert('Question added successfully!');
    } catch (error) {
      console.error('Failed to add question:', error);
      console.error('Error details:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status
      });
      alert(`Failed to add question: ${error.message || 'Unknown error'}`);
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

  if (loading) {
    return (
      <div className="first-round-interview-container">
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>Loading interview data...</p>
        </div>
      </div>
    );
  }

  if (!interview) {
    return (
      <div className="first-round-interview-container">
        <div className="error-state">
          <h2>Interview not found</h2>
          <p>The interview you're looking for doesn't exist or you don't have access to it.</p>
          <button 
            className="btn-primary"
            onClick={() => navigate('/assigned-interviews')}
          >
            <ArrowLeftIcon className="btn-icon" />
            Back to Assigned Interviews
          </button>
        </div>
      </div>
    );
  }

  if (behavioralQuestions.length === 0 && currentRotation === 0) {
    return (
      <div className="first-round-interview-container">
        <div className="error-state">
          <h2>No Behavioral Questions Configured</h2>
          <p>This interview doesn't have any behavioral questions configured. Please go back and configure the questions for this interview.</p>
          <button className="btn-primary" onClick={() => navigate('/assigned-interviews')}>
            Back to Interviews
          </button>
        </div>
      </div>
    );
  }

  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <div className="first-round-interview-container">
        {/* Header */}
        <div className="interview-header">
          <button 
            className="back-button"
            onClick={() => navigate('/assigned-interviews')}
          >
            <ArrowLeftIcon className="back-icon" />
            Back to Interviews
          </button>
          
          <div className="interview-info">
            <h1>{interview.title}</h1>
            <p className="interview-meta">
              First Round Interview • {applications.length} candidates
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

        {/* Interview Progress Tracker */}
        <div className="progress-tracker">
          <button 
            className="rotation-nav-btn"
            onClick={() => setCurrentRotation(Math.max(0, currentRotation - 1))}
            disabled={currentRotation === 0}
          >
            <ChevronLeftIcon className="nav-icon" />
            Previous Rotation
          </button>
          
          {rotations.map((rotation, index) => {
            const IconComponent = rotation.icon;
            const isActive = currentRotation === index;
            const isCompleted = currentRotation > index;
            
            return (
              <div key={rotation.id} className={`progress-step ${isActive ? 'active' : ''} ${isCompleted ? 'completed' : ''}`}>
                <div className="step-icon">
                  {isCompleted ? (
                    <CheckIcon className="icon" />
                  ) : (
                    <IconComponent className="icon" />
                  )}
                </div>
                <span className="step-title">{rotation.title}</span>
              </div>
            );
          })}
          
          <button 
            className="rotation-nav-btn"
            onClick={() => setCurrentRotation(Math.min(rotations.length - 1, currentRotation + 1))}
            disabled={currentRotation === rotations.length - 1}
          >
            Next Rotation
            <ChevronRightIcon className="nav-icon" />
          </button>
        </div>

        {/* Suggested Itinerary */}
        <div className="suggested-itinerary">
          <h3 className="itinerary-title">Suggested Itinerary</h3>
          <div className="itinerary-slots">
            {suggestedItinerary.map((slot, index) => {
              const IconComponent = slot.icon;
              return (
                <div key={index} className={`itinerary-slot ${slot.active ? 'active' : ''}`}>
                  <IconComponent className="slot-icon" />
                  <div className="slot-content">
                    <span className="slot-time">{slot.time}</span>
                    <span className="slot-title">{slot.title}</span>
                  </div>
                  {((slot.active && currentRotation === 0) || (slot.showTimeRemaining && currentRotation === 1)) && (
                    <div className="time-remaining">
                      Time Remaining in Section: {String(timeRemaining.minutes).padStart(2, '0')}:{String(timeRemaining.seconds).padStart(2, '0')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Applications Grid - Interviewees in rows, Questions in columns */}
        <div className="applications-grid-container">
          <div 
            className="grid-header"
            style={{
              gridTemplateColumns: currentRotation === 0 
                ? `200px repeat(${behavioralQuestions.length}, minmax(300px, 1fr)) 120px 120px 120px 100px`
                : currentRotation === 1
                ? '200px 1fr 120px 120px 120px 100px'
                : '200px 1fr'
            }}
          >
            <div className="header-cell interviewee-header">Interviewee</div>
            {currentRotation === 0 && behavioralQuestions.map((question, index) => {
              const questionId = question.id || `temp-${index}`;
              const questionText = question.text || question || `Question ${index + 1}`;
              
              return (
                <div key={questionId} className="header-cell question-header">
                  <div className="question-header-content">
                    <span className="question-number">Question {index + 1}</span>
                    <button 
                      className="edit-question-btn-small"
                      onClick={() => {
                        const newQuestion = prompt('Edit question:', questionText);
                        if (newQuestion !== null && newQuestion !== questionText && question.id) {
                          updateBehavioralQuestion(question.id, newQuestion);
                        } else if (newQuestion !== null && newQuestion !== questionText && !question.id) {
                          alert('Please save this question first before editing. Questions need to be saved to the server before they can be edited.');
                        }
                      }}
                      title="Edit this question"
                    >
                      <PencilIcon className="btn-icon-small" />
                    </button>
                  </div>
                </div>
              );
            })}
            {currentRotation === 0 && (
              <>
                <div className="header-cell scoring-header">Leadership</div>
                <div className="header-cell scoring-header">Problem Solving</div>
                <div className="header-cell scoring-header">Interest</div>
                <div className="header-cell scoring-header">Total</div>
              </>
            )}
            {currentRotation === 1 && (
              <>
                <div className="header-cell question-header">
                  <span>Market Sizing Notes</span>
                </div>
                <div className="header-cell scoring-header">Teamwork</div>
                <div className="header-cell scoring-header">Logic</div>
                <div className="header-cell scoring-header">Creativity</div>
                <div className="header-cell scoring-header">Total</div>
              </>
            )}
            {currentRotation === 2 && (
              <>
                <div className="header-cell question-header">
                  <span>Initial Decision</span>
                </div>
                <div className="header-cell question-header">
                  <span>Post Grading Notes</span>
                </div>
              </>
            )}
          </div>

          <div className="grid-body">
            {applications.map((application, appIndex) => {
              const evaluation = getEvaluation(application.id);
              const colorClass = appIndex % 2 === 0 ? 'pink' : 'blue';
              
              return (
                <div 
                  key={application.id} 
                  className={`grid-row ${colorClass}`}
                  style={{
                    gridTemplateColumns: currentRotation === 0 
                      ? `200px repeat(${behavioralQuestions.length}, minmax(300px, 1fr)) 120px 120px 120px 100px`
                      : currentRotation === 1
                      ? '200px 1fr 120px 120px 120px 100px'
                      : '200px 200px 1fr'
                  }}
                >
                  {/* Interviewee Column */}
                  <div className={`grid-cell interviewee-cell ${colorClass}`}>
                    <div className="interviewee-card">
                      <div className="interviewee-avatar">
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
                      <div className="interviewee-name">{application.name}</div>
                      <div className="interviewee-actions">
                        {application.resumeUrl && (
                          <button 
                            className="action-btn"
                            onClick={() => setPreview({ 
                              open: true, 
                              src: application.resumeUrl, 
                              kind: 'pdf', 
                              title: `${application.name} – Resume` 
                            })}
                            title="Resume"
                          >
                            <DocumentTextIcon className="action-icon" />
                          </button>
                        )}
                        {application.coverLetterUrl && (
                          <button 
                            className="action-btn"
                            onClick={() => setPreview({ 
                              open: true, 
                              src: application.coverLetterUrl, 
                              kind: 'pdf', 
                              title: `${application.name} – Cover Letter` 
                            })}
                            title="Cover Letter"
                          >
                            <DocumentTextIcon className="action-icon" />
                          </button>
                        )}
                        {application.videoUrl && (
                          <button 
                            className="action-btn"
                            onClick={() => setPreview({ 
                              open: true, 
                              src: application.videoUrl, 
                              kind: 'video', 
                              title: `${application.name} – Video` 
                            })}
                            title="Video"
                          >
                            <EyeIcon className="action-icon" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Question Columns */}
                  {currentRotation === 0 && behavioralQuestions.map((question, questionIndex) => {
                    // Use a consistent identifier for the question
                    const questionId = question.id || `temp-${questionIndex}`;
                    const questionText = question.text || question || `Question ${questionIndex + 1}`;
                    
                    return (
                      <div key={questionId} className={`grid-cell question-cell ${colorClass}`}>
                        <div className="question-card">
                          <div className="question-text-display">
                            {questionText}
                          </div>
                          <textarea
                            className="comments-textarea"
                            value={evaluation.behavioralNotes?.[questionId] || evaluation.behavioralNotes?.[question.id] || ''}
                            onChange={(e) => {
                              // Use the question ID if available, otherwise use the temp ID
                              const idToUse = question.id || questionId;
                              updateBehavioralNotes(application.id, idToUse, e.target.value);
                            }}
                            placeholder="Comments"
                            rows={8}
                          />
                        </div>
                      </div>
                    );
                  })}
                  
                  {/* Behavioral Scoring Columns */}
                  {currentRotation === 0 && (
                    <>
                      <div className={`grid-cell scoring-cell ${colorClass}`}>
                        <select
                          className="score-select"
                          value={evaluation.behavioralLeadership || ''}
                          onChange={(e) => updateBehavioralScore(application.id, 'behavioralLeadership', e.target.value)}
                        >
                          <option value="">-</option>
                          <option value="1">1</option>
                          <option value="2">2</option>
                          <option value="3">3</option>
                          <option value="4">4</option>
                          <option value="5">5</option>
                        </select>
                      </div>
                      <div className={`grid-cell scoring-cell ${colorClass}`}>
                        <select
                          className="score-select"
                          value={evaluation.behavioralProblemSolving || ''}
                          onChange={(e) => updateBehavioralScore(application.id, 'behavioralProblemSolving', e.target.value)}
                        >
                          <option value="">-</option>
                          <option value="1">1</option>
                          <option value="2">2</option>
                          <option value="3">3</option>
                          <option value="4">4</option>
                          <option value="5">5</option>
                        </select>
                      </div>
                      <div className={`grid-cell scoring-cell ${colorClass}`}>
                        <select
                          className="score-select"
                          value={evaluation.behavioralInterest || ''}
                          onChange={(e) => updateBehavioralScore(application.id, 'behavioralInterest', e.target.value)}
                        >
                          <option value="">-</option>
                          <option value="1">1</option>
                          <option value="2">2</option>
                          <option value="3">3</option>
                          <option value="4">4</option>
                          <option value="5">5</option>
                        </select>
                      </div>
                      <div className={`grid-cell scoring-cell total-cell ${colorClass}`}>
                        <div className="score-total">{evaluation.behavioralTotal || 0}</div>
                      </div>
                    </>
                  )}
                  
                  {currentRotation === 1 && (
                    <>
                      <div className={`grid-cell question-cell ${colorClass}`}>
                        <div className="question-card">
                          <textarea
                            className="comments-textarea"
                            value={evaluation.marketSizingNotes || ''}
                            onChange={(e) => updateEvaluation(application.id, { marketSizingNotes: e.target.value })}
                            placeholder="Market Sizing Notes"
                            rows={8}
                          />
                        </div>
                      </div>
                      <div className={`grid-cell scoring-cell ${colorClass}`}>
                        <select
                          className="score-select"
                          value={evaluation.marketSizingTeamwork || ''}
                          onChange={(e) => updateMarketSizingScore(application.id, 'marketSizingTeamwork', e.target.value)}
                        >
                          <option value="">-</option>
                          <option value="1">1</option>
                          <option value="2">2</option>
                          <option value="3">3</option>
                          <option value="4">4</option>
                          <option value="5">5</option>
                        </select>
                      </div>
                      <div className={`grid-cell scoring-cell ${colorClass}`}>
                        <select
                          className="score-select"
                          value={evaluation.marketSizingLogic || ''}
                          onChange={(e) => updateMarketSizingScore(application.id, 'marketSizingLogic', e.target.value)}
                        >
                          <option value="">-</option>
                          <option value="1">1</option>
                          <option value="2">2</option>
                          <option value="3">3</option>
                          <option value="4">4</option>
                          <option value="5">5</option>
                        </select>
                      </div>
                      <div className={`grid-cell scoring-cell ${colorClass}`}>
                        <select
                          className="score-select"
                          value={evaluation.marketSizingCreativity || ''}
                          onChange={(e) => updateMarketSizingScore(application.id, 'marketSizingCreativity', e.target.value)}
                        >
                          <option value="">-</option>
                          <option value="1">1</option>
                          <option value="2">2</option>
                          <option value="3">3</option>
                          <option value="4">4</option>
                          <option value="5">5</option>
                        </select>
                      </div>
                      <div className={`grid-cell scoring-cell total-cell ${colorClass}`}>
                        <div className="score-total">{evaluation.marketSizingTotal || 0}</div>
                      </div>
                    </>
                  )}
                  
                  {currentRotation === 2 && (
                    <>
                      <div className={`grid-cell question-cell ${colorClass}`}>
                        <div className="question-card">
                          <div className="decision-options">
                            {decisionOptions.map(option => (
                              <label key={option.value} className="decision-option">
                                <input
                                  type="radio"
                                  name={`decision-${application.id}`}
                                  value={option.value}
                                  checked={evaluation.decision === option.value}
                                  onChange={() => updateEvaluation(application.id, { decision: option.value })}
                                />
                                <span className={`decision-label ${option.color}`}>
                                  {option.label}
                                </span>
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className={`grid-cell question-cell ${colorClass}`}>
                        <div className="question-card">
                          <textarea
                            className="comments-textarea"
                            value={evaluation.notes || ''}
                            onChange={(e) => updateEvaluation(application.id, { notes: e.target.value })}
                            placeholder="Post Grading Notes"
                            rows={8}
                          />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Add Question Button (only for behaviorals) */}
        {currentRotation === 0 && (
          <div className="add-question-section">
            <button 
              className="add-question-btn"
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('Add Question button clicked');
                console.log('groupIds:', groupIds);
                console.log('currentUser:', currentUser);
                console.log('interviewId:', interviewId);
                
                if (!groupIds || groupIds.length === 0) {
                  alert('No groups selected');
                  return;
                }
                
                if (!interviewId) {
                  alert('No interview ID available');
                  return;
                }
                
                try {
                  await addBehavioralQuestion(groupIds[0]);
                } catch (error) {
                  console.error('Error in onClick handler:', error);
                }
              }}
            >
              <PlusIcon className="btn-icon" />
              Add Question
            </button>
          </div>
        )}

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
