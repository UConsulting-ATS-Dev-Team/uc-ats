import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeftIcon, DocumentIcon, ChatBubbleLeftRightIcon, ChevronDownIcon, ChevronUpIcon, PencilIcon } from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import AuthenticatedImage from '../components/AuthenticatedImage';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import AccessControl from '../components/AccessControl';
import OfferLetterSection from '../components/OfferLetterSection';
import { useAuth } from '../context/AuthContext';
import '../styles/ApplicationDetail.css';

export default function ApplicationDetail({ applicationId: propApplicationId, embedded = false }) {
  const { id: paramId } = useParams();
  const id = propApplicationId || paramId;
  const navigate = useNavigate();
  const [application, setApplication] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [currentUserId, setCurrentUserId] = useState(null); // Store current user ID
  const [averageGrades, setAverageGrades] = useState({
    resume: 0,
    video: 0,
    cover_letter: 0,
    total: 0,
    count: 0
  }); // Store average grades

  // Document scores
  const [resumeScores, setResumeScores] = useState([]);
  const [coverLetterScores, setCoverLetterScores] = useState([]);
  const [videoScores, setVideoScores] = useState([]);
  const [selectedScore, setSelectedScore] = useState(null);
  const [scoreModalOpen, setScoreModalOpen] = useState(false);
  
  // Admin edit score state
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [editScoreModalOpen, setEditScoreModalOpen] = useState(false);
  const [editingScore, setEditingScore] = useState(null);
  const [editingScoreType, setEditingScoreType] = useState(null); // 'resume', 'coverLetter', 'video'
  const [editScoreForm, setEditScoreForm] = useState({
    overallScore: '',
    scoreOne: '',
    scoreTwo: '',
    scoreThree: '',
    notes: '',
    adminScore: '',
    adminNotes: ''
  });
  const [savingScore, setSavingScore] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Comments
  const [comments, setComments] = useState([]);
  const [newComment, setNewComment] = useState('');
  const [commentError, setCommentError] = useState('');
  const [preview, setPreview] = useState({ open: false, src: '', kind: 'pdf', title: '' });
  const [isCommentsMinimized, setIsCommentsMinimized] = useState(false);
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const commentsEndRef = useRef(null);

  // Referral state
  const [referral, setReferral] = useState(null);
  const [isReferralModalOpen, setIsReferralModalOpen] = useState(false);
  const [referralForm, setReferralForm] = useState({ referrerName: '', relationship: '' });
  const [isSubmittingReferral, setIsSubmittingReferral] = useState(false);

  // Event attendance
  const [eventData, setEventData] = useState({ events: [], totalPoints: 0 });
  const [eventLoading, setEventLoading] = useState(true);

  // Interview evaluations
  const [interviewEvaluations, setInterviewEvaluations] = useState([]);
  const [evaluationsLoading, setEvaluationsLoading] = useState(false);
  
  // Test For note (admin only)
  const [testForNote, setTestForNote] = useState('');
  const [isEditingTestFor, setIsEditingTestFor] = useState(false);
  const [savingTestFor, setSavingTestFor] = useState(false);

  // Past applications modal
  const [pastApplicationModalOpen, setPastApplicationModalOpen] = useState(false);
  const [selectedPastApplication, setSelectedPastApplication] = useState(null);


  // Function to fetch and store average grades for the current application
  const logAverageGrades = async () => {
    try {
      const averages = await apiClient.get(`/applications/${id}/grades/average`);
      
      // Store the averages in state
      setAverageGrades({
        resume: averages.resume,
        video: averages.video,
        cover_letter: averages.cover_letter,
        total: averages.total,
        count: averages.count
      });
    } catch (error) {
      console.error('Error fetching average grades:', error);
    }
  };

  const fetchComments = async () => {
    try {
      const list = await apiClient.get(`/applications/${id}/comments`);
      setComments(list);
      // Scroll to bottom after comments are loaded
      setTimeout(() => {
        if (commentsEndRef.current) {
          commentsEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
      }, 100);
    } catch (e) {
      console.error('Error fetching comments:', e);
    }
  };

  const scrollToBottom = () => {
    if (commentsEndRef.current) {
      commentsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  };

  // Referral functions
  const fetchReferral = async () => {
    try {
      const referralData = await apiClient.get(`/applications/${id}/referral`);
      setReferral(referralData);
    } catch (e) {
      if (e.response?.status !== 404) {
        console.error('Error fetching referral:', e);
      }
      setReferral(null);
    }
  };

  const addReferral = async () => {
    if (!referralForm.referrerName.trim() || !referralForm.relationship.trim()) {
      return;
    }

    setIsSubmittingReferral(true);
    try {
      const newReferral = await apiClient.post(`/applications/${id}/referral`, referralForm);
      setReferral(newReferral);
      setIsReferralModalOpen(false);
      setReferralForm({ referrerName: '', relationship: '' });
      // Refresh average grades to show the bonus
      await logAverageGrades();
    } catch (e) {
      console.error('Error adding referral:', e);
      alert(e.response?.data?.error || 'Failed to add referral');
    } finally {
      setIsSubmittingReferral(false);
    }
  };

  const removeReferral = async () => {
    if (!confirm('Are you sure you want to remove this referral?')) {
      return;
    }

    try {
      await apiClient.delete(`/applications/${id}/referral`);
      setReferral(null);
      // Refresh average grades to remove the bonus
      await logAverageGrades();
    } catch (e) {
      console.error('Error removing referral:', e);
      alert(e.response?.data?.error || 'Failed to remove referral');
    }
  };

  // Calculate average scores from the actual score arrays
  // Uses adminScore override if available, otherwise uses overallScore
  const calculateAverageScore = (scores) => {
    if (!scores || scores.length === 0) return 0;
    const validScores = scores.map(score => {
      // Use adminScore if it exists, otherwise use overallScore
      const scoreValue = score.adminScore !== null && score.adminScore !== undefined 
        ? parseFloat(score.adminScore) 
        : parseFloat(score.overallScore);
      return scoreValue;
    }).filter(score => !isNaN(score));
    if (validScores.length === 0) return 0;
    const total = validScores.reduce((sum, score) => sum + score, 0);
    return total / validScores.length;
  };

  // Get calculated averages for display
  const getCalculatedAverages = () => {
    const resumeAvg = calculateAverageScore(resumeScores);
    const videoAvg = calculateAverageScore(videoScores);
    const coverLetterAvg = calculateAverageScore(coverLetterScores);
    
    // Calculate overall total by summing all document scores (not averaging)
    let overallTotal = 0;
    if (resumeScores.length > 0) overallTotal += resumeAvg;
    if (videoScores.length > 0) overallTotal += videoAvg;
    if (coverLetterScores.length > 0) overallTotal += coverLetterAvg;
    
    // Add event points directly (raw points, not scaled), capped at 3
    const rawEventPoints = eventData.totalPoints || 0;
    const eventPointsContribution = Math.min(rawEventPoints, 3);
    overallTotal += eventPointsContribution;
    
    const result = {
      resume: resumeAvg,
      video: videoAvg,
      cover_letter: coverLetterAvg,
      total: overallTotal,
      count: resumeScores.length + videoScores.length + coverLetterScores.length,
      referralBonus: 0, // Referrals no longer contribute to overall score
      eventPointsContribution: eventPointsContribution
    };
    
    return result;
  };

  const fetchResumeScores = async (candidateId, cycleId) => {
    try {
      if (!candidateId) {
        return;
      }
      const url = cycleId 
        ? `/review-teams/resume-scores/${candidateId}?cycleId=${cycleId}`
        : `/review-teams/resume-scores/${candidateId}`;
      const scores = await apiClient.get(url);
      setResumeScores(scores);
    } catch (e) {
      console.error('Error fetching resume scores:', e);
    }
  };

  const fetchCoverLetterScores = async (candidateId, cycleId) => {
    try {
      if (!candidateId) {
        return;
      }
      const url = cycleId 
        ? `/review-teams/cover-letter-scores/${candidateId}?cycleId=${cycleId}`
        : `/review-teams/cover-letter-scores/${candidateId}`;
      const scores = await apiClient.get(url);
      setCoverLetterScores(scores);
    } catch (e) {
      console.error('Error fetching cover letter scores:', e);
    }
  };

  const fetchVideoScores = async (candidateId, cycleId) => {
    try {
      if (!candidateId) {
        return;
      }
      const url = cycleId 
        ? `/review-teams/video-scores/${candidateId}?cycleId=${cycleId}`
        : `/review-teams/video-scores/${candidateId}`;
      const scores = await apiClient.get(url);
      setVideoScores(scores);
    } catch (e) {
      console.error('Error fetching video scores:', e);
    }
  };

  // Handle opening edit score modal
  const handleEditScore = (score, scoreType) => {
    setEditingScore(score);
    setEditingScoreType(scoreType);
    setEditScoreForm({
      overallScore: score.overallScore?.toString() || '',
      scoreOne: score.scoreOne?.toString() || '',
      scoreTwo: score.scoreTwo?.toString() || '',
      scoreThree: score.scoreThree?.toString() || '',
      notes: score.notes || score.notesOne || '',
      adminScore: score.adminScore?.toString() || '',
      adminNotes: score.adminNotes || ''
    });
    setEditScoreModalOpen(true);
    setSaveError(null);
  };

  // Handle saving edited score
  const handleSaveScore = async () => {
    try {
      setSavingScore(true);
      setSaveError(null);
      
      const endpointMap = {
        resume: '/admin/resume-scores',
        coverLetter: '/admin/cover-letter-scores',
        video: '/admin/video-scores'
      };
      
      const endpoint = `${endpointMap[editingScoreType]}/${editingScore.id}`;
      
      const updateData = {
        overallScore: editScoreForm.overallScore ? parseFloat(editScoreForm.overallScore) : undefined,
        scoreOne: editScoreForm.scoreOne ? parseInt(editScoreForm.scoreOne) : undefined,
        scoreTwo: editScoreForm.scoreTwo ? parseInt(editScoreForm.scoreTwo) : undefined,
        scoreThree: editScoreForm.scoreThree ? parseInt(editScoreForm.scoreThree) : undefined,
        adminScore: editScoreForm.adminScore ? parseFloat(editScoreForm.adminScore) : undefined,
        adminNotes: editScoreForm.adminNotes || undefined
      };
      
      // For resume, use 'notes', for cover letter and video use 'notesOne'
      if (editingScoreType === 'resume') {
        updateData.notes = editScoreForm.notes || undefined;
      } else {
        updateData.notesOne = editScoreForm.notes || undefined;
      }
      
      await apiClient.patch(endpoint, updateData);
      
      // Refresh the scores
      if (application?.candidateId) {
        await Promise.all([
          fetchResumeScores(application.candidateId),
          fetchCoverLetterScores(application.candidateId),
          fetchVideoScores(application.candidateId)
        ]);
      }
      
      setEditScoreModalOpen(false);
      setSaveError(null);
    } catch (error) {
      console.error('Error updating score:', error);
      setSaveError(error.message || 'Failed to update score');
    } finally {
      setSavingScore(false);
    }
  };

  const fetchEventData = async () => {
    try {
      const data = await apiClient.get(`/applications/${id}/events`);
      setEventData(data);
    } catch (e) {
      console.error('Error fetching event data:', e);
    } finally {
      setEventLoading(false);
    }
  };

  const fetchInterviewEvaluations = async () => {
    try {
      setEvaluationsLoading(true);
      const evaluations = await apiClient.get(`/admin/applications/${id}/interview-evaluations`);
      setInterviewEvaluations(evaluations);
    } catch (e) {
      console.error('Error fetching interview evaluations:', e);
      setInterviewEvaluations([]);
    } finally {
      setEvaluationsLoading(false);
    }
  };

  // Handle saving testFor note
  const handleSaveTestFor = async () => {
    try {
      setSavingTestFor(true);
      await apiClient.patch(`/admin/applications/${id}/test-for`, { testFor: testForNote });
      setApplication(prev => prev ? { ...prev, testFor: testForNote } : null);
      setIsEditingTestFor(false);
    } catch (error) {
      console.error('Error saving testFor note:', error);
      alert('Failed to save testFor note');
    } finally {
      setSavingTestFor(false);
    }
  };



  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        
        // Fetch application data
        const [appData, userData] = await Promise.all([
          apiClient.get(`/applications/${id}`),
          apiClient.get('/applications/current-user/id')
        ]);
        
        console.log('Application data received:', appData);
        console.log('Document URLs:', {
          resumeUrl: appData.resumeUrl,
          blindResumeUrl: appData.blindResumeUrl,
          coverLetterUrl: appData.coverLetterUrl,
          videoUrl: appData.videoUrl
        });
        setApplication(appData);
        setCurrentUserId(userData.userId);
        setTestForNote(appData.testFor || '');

        // Load all secondary data concurrently
        await Promise.all([
          logAverageGrades(),
          fetchComments(),
          fetchResumeScores(appData.candidateId, appData.cycleId),
          fetchCoverLetterScores(appData.candidateId, appData.cycleId),
          fetchVideoScores(appData.candidateId, appData.cycleId),
          fetchEventData(),
          fetchInterviewEvaluations(),
          fetchReferral()
        ]);
        
      } catch (err) {
        console.error('Error loading data:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [id]);

  // Auto-scroll to bottom when comments change
  useEffect(() => {
    if (comments.length > 0 && !isCommentsMinimized) {
      setTimeout(scrollToBottom, 100);
    }
  }, [comments, isCommentsMinimized]);

  if (loading) {
    return (
      <div className="application-detail">
        <div style={{ padding: '2rem', textAlign: 'center' }}>
          Loading application details...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="application-detail">
        <div style={{ color: 'red', marginBottom: '1rem' }}>Error: {error}</div>
        {!embedded && (
          <Link to="/application-list" className="back-link">
            <ArrowLeftIcon className="back-icon" />
            Back to Applications
          </Link>
        )}
      </div>
    );
  }

  if (!application) {
    return (
      <div className="application-detail">
        <div style={{ marginBottom: '1rem' }}>Application not found</div>
        {!embedded && (
          <Link to="/application-list" className="back-link">
            <ArrowLeftIcon className="back-icon" />
            Back to Applications
          </Link>
        )}
      </div>
    );
  }

  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <div className="application-detail">
      {/* Header with back button and status */}
      <div className="detail-header">
        <div className="header-left">
          {!embedded && (
            <Link to="/application-list" className="back-link">
              <ArrowLeftIcon className="back-icon" />
              Back to Applications
            </Link>
          )}
          <div className="name-and-status">
            <div>
              <div className="candidate-header">
                <h1 className="candidate-name">
                  {application.firstName} {application.lastName}
                </h1>
                <span className="applicant-id">ID: {application.id}</span>
              </div>
              
              <div className="average-grades-container">
                {(() => {
                  const calculatedAverages = getCalculatedAverages();
                  return (
                    <>
                      <div className="average-grade">
                        <span className="average-grade-label">Resume</span>
                        <div>
                          <span className="average-grade-value">{calculatedAverages.resume.toFixed(1)}</span>
                          <span className="average-grade-total">/ 13</span>
                        </div>
                        {resumeScores.length > 0 && (
                          <div className="average-grade-count">
                            from {resumeScores.length} {resumeScores.length === 1 ? 'review' : 'reviews'}
                          </div>
                        )}
                      </div>
                      
                      <div className="average-grade">
                        <span className="average-grade-label">Video</span>
                        <div>
                          <span className="average-grade-value">{calculatedAverages.video.toFixed(1)}</span>
                          <span className="average-grade-total">/ 2</span>
                        </div>
                        {videoScores.length > 0 && (
                          <div className="average-grade-count">
                            from {videoScores.length} {videoScores.length === 1 ? 'review' : 'reviews'}
                          </div>
                        )}
                      </div>
                      
                      <div className="average-grade">
                        <span className="average-grade-label">Cover Letter</span>
                        <div>
                          <span className="average-grade-value">{calculatedAverages.cover_letter.toFixed(1)}</span>
                          <span className="average-grade-total">/ 3</span>
                        </div>
                        {coverLetterScores.length > 0 && (
                          <div className="average-grade-count">
                            from {coverLetterScores.length} {coverLetterScores.length === 1 ? 'review' : 'reviews'}
                          </div>
                        )}
                      </div>
                      
                      <div className="average-grade">
                        <span className="average-grade-label">Event Points</span>
                        <div>
                          <span className="average-grade-value">{Math.min(eventData.totalPoints, 3)}</span>
                          <span className="average-grade-total">/ 3</span>
                        </div>
                        <div className="average-grade-count">
                          {eventData.events.filter(e => e.rsvpStatus === 'RSVPed' || e.attendanceStatus === 'Attended').filter(e => e.attendanceStatus === 'Attended').length} attended of {eventData.events.filter(e => e.rsvpStatus === 'RSVPed' || e.attendanceStatus === 'Attended').length} relevant
                        </div>
                        {eventData.totalPoints > 3 && (
                          <div className="average-grade-count" style={{ color: '#9ca3af', fontSize: '0.7rem' }}>
                            ({eventData.totalPoints} raw, capped)
                          </div>
                        )}
                      </div>
                      
                      <div className="average-grade" style={{ backgroundColor: '#f0f9ff', borderColor: '#bae6fd' }}>
                        <span className="average-grade-label">Overall</span>
                        <div>
                          <span className="average-grade-value" style={{ color: '#0369a1' }}>{calculatedAverages.total.toFixed(1)}</span>
                          <span className="average-grade-total">/ 21</span>
                        </div>
                        {calculatedAverages.count > 0 && (
                          <div className="average-grade-count">
                            from {calculatedAverages.count} {calculatedAverages.count === 1 ? 'review' : 'reviews'}
                          </div>
                        )}
                        {calculatedAverages.eventPointsContribution > 0 && (
                          <div className="average-grade-count" style={{ color: '#059669', fontWeight: '600' }}>
                            +{Math.floor(calculatedAverages.eventPointsContribution)} events
                          </div>
                        )}
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
            
            <div className={`status-badge ${application.status.toLowerCase()}`}>
              {application.status.replace('_', ' ')}
            </div>
          </div>
        </div>
      </div>

      {/* Main content area */}
      <div className="detail-content">
        {/* Left column - Application details */}
        <div className="detail-main">
          {/* Basic Information */}
          <div className="info-section">
            <h2 className="section-title">Basic Information</h2>
            <div className="info-grid">
              <div className="info-item">
                <span className="info-label">Email</span>
                <span className="info-value">
                  <a href={`mailto:${application.email}`}>{application.email}</a>
                </span>
              </div>
              <div className="info-item">
                <span className="info-label">Phone</span>
                <span className="info-value">{application.phoneNumber}</span>
              </div>
              <div className="info-item">
                <span className="info-label">Student ID</span>
                <span className="info-value">{application.studentId}</span>
              </div>
              <div className="info-item">
                <span className="info-label">Submitted</span>
                <span className="info-value">
                  {new Date(application.submittedAt).toLocaleDateString()}
                </span>
              </div>
            </div>
          </div>

          {/* Offer Letter - admin only, only for Final Round accepted candidates */}
          <OfferLetterSection
            application={application}
            comments={comments}
            isAdmin={isAdmin}
            onSent={fetchComments}
          />

          {/* Past Applications Section - only show if there are past applications */}
          {application.pastApplications && application.pastApplications.length > 0 && (
            <div className="info-section" style={{
              backgroundColor: '#eff6ff',
              border: '1px solid #bfdbfe',
              borderRadius: '8px',
              padding: '1rem'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '0.75rem' }}>
                <span style={{
                  backgroundColor: '#1e40af',
                  color: 'white',
                  padding: '2px 8px',
                  borderRadius: '9999px',
                  fontSize: '0.75rem',
                  fontWeight: '600'
                }}>
                  Returning Applicant
                </span>
                <h2 className="section-title" style={{ margin: 0 }}>Past Applications</h2>
              </div>
              <p style={{ color: '#1e40af', fontSize: '0.875rem', marginBottom: '0.75rem' }}>
                This applicant has applied {application.pastApplications.length} time{application.pastApplications.length > 1 ? 's' : ''} before.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {application.pastApplications.map((pastApp) => (
                  <div
                    key={pastApp.id}
                    onClick={() => {
                      setSelectedPastApplication(pastApp);
                      setPastApplicationModalOpen(true);
                    }}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '12px',
                      backgroundColor: 'white',
                      border: '1px solid #93c5fd',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = '#f0f9ff';
                      e.currentTarget.style.transform = 'translateX(4px)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'white';
                      e.currentTarget.style.transform = 'translateX(0)';
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: '600', color: '#1e40af' }}>
                        {pastApp.cycle?.name || 'Unknown Cycle'}
                      </div>
                      <div style={{ fontSize: '0.875rem', color: '#6b7280' }}>
                        Submitted: {new Date(pastApp.submittedAt).toLocaleDateString()}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <span style={{
                        padding: '4px 10px',
                        borderRadius: '9999px',
                        fontSize: '0.75rem',
                        fontWeight: '500',
                        backgroundColor:
                          pastApp.status === 'ACCEPTED' ? '#dcfce7' :
                          pastApp.status === 'REJECTED' ? '#fee2e2' :
                          pastApp.status === 'WAITLISTED' ? '#fef3c7' :
                          '#e0e7ff',
                        color:
                          pastApp.status === 'ACCEPTED' ? '#166534' :
                          pastApp.status === 'REJECTED' ? '#991b1b' :
                          pastApp.status === 'WAITLISTED' ? '#92400e' :
                          '#3730a3'
                      }}>
                        {pastApp.status.replace('_', ' ')}
                      </span>
                      <span style={{ color: '#3b82f6', fontSize: '1.25rem' }}>→</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Academic Information */}
          <div className="info-section">
            <h2 className="section-title">Academic Information</h2>
            <div className="info-grid">
              <div className="info-item">
                <span className="info-label">Graduation Year</span>
                <span className="info-value">{application.graduationYear}</span>
              </div>
              <div className="info-item">
                <span className="info-label">Transfer Student</span>
                <span className="info-value">
                  {application.isTransferStudent ? 'Yes' : 'No'}
                </span>
              </div>
              <div className="info-item">
                <span className="info-label">Cumulative GPA</span>
                <span className="info-value">{application.cumulativeGpa}</span>
              </div>
              <div className="info-item">
                <span className="info-label">Major GPA</span>
                <span className="info-value">{application.majorGpa || 'Not provided'}</span>
              </div>
              <div className="info-item">
                <span className="info-label">Primary Major</span>
                <span className="info-value">{application.major1}</span>
              </div>
              {application.major2 && (
                <div className="info-item">
                  <span className="info-label">Secondary Major</span>
                  <span className="info-value">{application.major2}</span>
                </div>
              )}
              {application.priorCollegeYears && (
                <div className="info-item">
                  <span className="info-label">Prior College Years</span>
                  <span className="info-value">{application.priorCollegeYears}</span>
                </div>
              )}
            </div>
          </div>

          {/* Demographic Information */}
          {(application.gender || application.isFirstGeneration !== null) && (
            <div className="info-section">
              <h2 className="section-title">Demographic Information</h2>
              <div className="info-grid">
                {application.gender && (
                  <div className="info-item">
                    <span className="info-label">Gender</span>
                    <span className="info-value">{application.gender}</span>
                  </div>
                )}
                {application.isFirstGeneration !== null && (
                  <div className="info-item">
                    <span className="info-label">First Generation</span>
                    <span className="info-value">
                      {application.isFirstGeneration ? 'Yes' : 'No'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Documents */}
          <div className="info-section">
            <h2 className="section-title">Documents</h2>
            <div className="documents-gallery">
              {application.resumeUrl && (
                <div 
                  className="document-card"
                  onClick={(e) => {
                    e.preventDefault();
                    setPreview({ open: true, src: application.resumeUrl, kind: 'pdf', title: `${application.firstName} ${application.lastName} – Resume` });
                  }}
                >
                  <div className="document-preview pdf-preview">
                    <div className="document-preview-content">
                      <DocumentIcon className="document-preview-icon" />
                      <div className="document-preview-lines">
                        <div className="preview-line"></div>
                        <div className="preview-line"></div>
                        <div className="preview-line short"></div>
                        <div className="preview-line"></div>
                        <div className="preview-line short"></div>
                      </div>
                    </div>
                    <div className="document-overlay">
                      <DocumentIcon className="document-overlay-icon" />
                      <span>View Resume</span>
                    </div>
                  </div>
                  <div className="document-info">
                    <h3 className="document-title">Resume</h3>
                    <p className="document-type">PDF Document</p>
                  </div>
                </div>
              )}
              {application.blindResumeUrl && (
                <div 
                  className="document-card"
                  onClick={(e) => {
                    e.preventDefault();
                    setPreview({ open: true, src: application.blindResumeUrl, kind: 'pdf', title: `${application.firstName} ${application.lastName} – Blind Resume` });
                  }}
                >
                  <div className="document-preview pdf-preview">
                    <div className="document-preview-content">
                      <DocumentIcon className="document-preview-icon" />
                      <div className="document-preview-lines">
                        <div className="preview-line"></div>
                        <div className="preview-line"></div>
                        <div className="preview-line short"></div>
                        <div className="preview-line"></div>
                        <div className="preview-line short"></div>
                      </div>
                    </div>
                    <div className="document-overlay">
                      <DocumentIcon className="document-overlay-icon" />
                      <span>View Blind Resume</span>
                    </div>
                  </div>
                  <div className="document-info">
                    <h3 className="document-title">Blind Resume</h3>
                    <p className="document-type">PDF Document</p>
                  </div>
                </div>
              )}
              {application.coverLetterUrl && (
                <div 
                  className="document-card"
                  onClick={(e) => {
                    e.preventDefault();
                    setPreview({ open: true, src: application.coverLetterUrl, kind: 'pdf', title: `${application.firstName} ${application.lastName} – Cover Letter` });
                  }}
                >
                  <div className="document-preview pdf-preview">
                    <div className="document-preview-content">
                      <DocumentIcon className="document-preview-icon" />
                      <div className="document-preview-lines">
                        <div className="preview-line"></div>
                        <div className="preview-line"></div>
                        <div className="preview-line short"></div>
                        <div className="preview-line"></div>
                        <div className="preview-line short"></div>
                      </div>
                    </div>
                    <div className="document-overlay">
                      <DocumentIcon className="document-overlay-icon" />
                      <span>View Cover Letter</span>
                    </div>
                  </div>
                  <div className="document-info">
                    <h3 className="document-title">Cover Letter</h3>
                    <p className="document-type">PDF Document</p>
                  </div>
                </div>
              )}
              {application.videoUrl && (
                <div 
                  className="document-card"
                  onClick={(e) => {
                    e.preventDefault();
                    setPreview({ open: true, src: application.videoUrl, kind: 'video', title: `${application.firstName} ${application.lastName} – Video` });
                  }}
                >
                  <div className="document-preview video-preview">
                    <div className="document-preview-content">
                      <div className="play-button-large">
                        <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <circle cx="32" cy="32" r="32" fill="rgba(59, 130, 246, 0.9)"/>
                          <path d="M26 20L44 32L26 44V20Z" fill="white"/>
                        </svg>
                      </div>
                      <div className="video-preview-lines">
                        <div className="preview-line"></div>
                        <div className="preview-line short"></div>
                        <div className="preview-line"></div>
                      </div>
                    </div>
                    <div className="document-overlay">
                      <div className="play-button">
                        <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <circle cx="24" cy="24" r="24" fill="rgba(0,0,0,0.6)"/>
                          <path d="M18 14L34 24L18 34V14Z" fill="white"/>
                        </svg>
                      </div>
                      <span>View Video</span>
                    </div>
                  </div>
                  <div className="document-info">
                    <h3 className="document-title">Video</h3>
                    <p className="document-type">Video Recording</p>
                  </div>
                </div>
              )}
              {!application.resumeUrl && !application.blindResumeUrl && !application.coverLetterUrl && !application.videoUrl && (
                <div className="empty-state">No documents available for this application.</div>
              )}
            </div>
          </div>

          {/* Event Attendance */}
          <div className="info-section">
            <h2 className="section-title">Event Attendance</h2>
            <div style={{
              backgroundColor: '#f0f9ff',
              border: '1px solid #bae6fd',
              borderRadius: '6px',
              padding: '12px',
              marginBottom: '16px',
              fontSize: '0.875rem',
              color: '#0369a1'
            }}>
              <strong>Note:</strong> Students can earn a maximum of 3 points total from events and GTKUC (Get To Know UC) meetings combined. Points beyond 3 are tracked but do not contribute to the overall score.
            </div>
            {eventLoading ? (
              <div className="empty-state">Loading event data...</div>
            ) : eventData.events.length === 0 ? (
              <div className="empty-state">No events found for this cycle.</div>
            ) : (
              <div>
                <div className="event-summary">
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}>
                    <span style={{ fontWeight: '600', color: '#0369a1' }}>
                      Total Event Points: {Math.min(eventData.totalPoints, 3)} / 3
                      {eventData.totalPoints > 3 && (
                        <span style={{ fontWeight: '400', color: '#6b7280', marginLeft: '8px' }}>
                          ({eventData.totalPoints} earned, capped at 3)
                        </span>
                      )}
                    </span>
                    <span style={{ fontSize: '0.875rem', color: '#0369a1' }}>
                      {eventData.events.filter(e => e.rsvpStatus === 'RSVPed' || e.attendanceStatus === 'Attended').filter(e => e.attendanceStatus === 'Attended').length} attended of {eventData.events.filter(e => e.rsvpStatus === 'RSVPed' || e.attendanceStatus === 'Attended').length} relevant events
                    </span>
                  </div>
                </div>
                
                <div className="events-list">
                  {eventData.events
                    .filter(event => event.rsvpStatus === 'RSVPed' || event.attendanceStatus === 'Attended')
                    .map((event) => (
                    <div 
                      key={event.id} 
                      className="event-item"
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                        <div style={{ flex: 1 }}>
                          <div className="event-name">
                            {event.eventName}
                            {event.isMeeting && event.memberName && (
                              <span style={{ 
                                fontSize: '0.875rem', 
                                fontWeight: '500', 
                                color: '#0369a1',
                                marginLeft: '8px'
                              }}>
                                with {event.memberName}
                              </span>
                            )}
                          </div>
                          <div className="event-details">
                            {new Date(event.eventStartDate).toLocaleDateString()} • {event.eventLocation || 'Location TBD'}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', marginLeft: '16px' }}>
                          <div className={`event-points ${event.points === 0 ? 'no-points' : ''}`}>
                            {event.points} pts
                          </div>
                        </div>
                      </div>
                      
                      <div className="event-status-badges">
                        <div className={`status-badge ${event.rsvpStatus === 'RSVPed' ? 'rsvped' : 'not-rsvped'}`}>
                          {event.rsvpStatus}
                        </div>
                        <div className={`status-badge ${event.attendanceStatus === 'Attended' ? 'attended' : 'not-attended'}`}>
                          {event.attendanceStatus}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right column - Photo */}
        <div className="detail-sidebar">
          <div className="candidate-photo">
            <h3 className="photo-title">Photo</h3>
            {application.headshotUrl ? (
              <AuthenticatedImage
                src={application.headshotUrl}
                alt={`${application.firstName} ${application.lastName}`}
                className="photo-image"
              />
            ) : (
              <div className="photo-placeholder">
                No photo available
              </div>
            )}
          </div>
          

          {/* Comments Chatbox */}
          <div className="info-section" style={{ 
            border: '1px solid #e5e7eb', 
            borderRadius: '12px', 
            overflow: 'hidden',
            backgroundColor: '#fafafa'
          }}>
            {/* Chatbox Header */}
            <div 
              style={{ 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'space-between',
                padding: '16px 20px',
                backgroundColor: '#f8fafc',
                borderBottom: '1px solid #e5e7eb',
                cursor: 'pointer'
              }}
              onClick={() => setIsCommentsMinimized(!isCommentsMinimized)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ChatBubbleLeftRightIcon style={{ width: '20px', height: '20px', color: '#6b7280' }} />
                <h2 style={{ 
                  margin: 0, 
                  fontSize: '1.125rem', 
                  fontWeight: '600', 
                  color: '#374151' 
                }}>
                  Comments ({comments.length})
                </h2>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {comments.length > 0 && (
                  <span style={{ 
                    fontSize: '0.75rem', 
                    color: '#6b7280',
                    backgroundColor: '#e5e7eb',
                    padding: '2px 8px',
                    borderRadius: '12px'
                  }}>
                    {comments.length} message{comments.length !== 1 ? 's' : ''}
                  </span>
                )}
                {isCommentsMinimized ? (
                  <ChevronDownIcon style={{ width: '20px', height: '20px', color: '#6b7280' }} />
                ) : (
                  <ChevronUpIcon style={{ width: '20px', height: '20px', color: '#6b7280' }} />
                )}
              </div>
            </div>

            {/* Chatbox Content */}
            {!isCommentsMinimized && (
              <div style={{ display: 'flex', flexDirection: 'column', height: '400px' }}>
                {/* Messages Area */}
                <div style={{ 
                  flex: 1, 
                  overflowY: 'auto', 
                  padding: '16px 20px',
                  backgroundColor: '#ffffff'
                }}>
                  {comments.length === 0 ? (
                    <div style={{ 
                      textAlign: 'center', 
                      color: '#6b7280', 
                      padding: '40px 20px',
                      fontStyle: 'italic'
                    }}>
                      No comments yet. Start the conversation!
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      {comments.map((c) => (
                        <div 
                          key={c.id} 
                          style={{ 
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'flex-start',
                            padding: '12px 16px',
                            backgroundColor: '#f8fafc',
                            borderRadius: '12px',
                            border: '1px solid #e5e7eb',
                            maxWidth: '80%',
                            alignSelf: 'flex-start'
                          }}
                        >
                          <div style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: '8px',
                            marginBottom: '6px'
                          }}>
                            <div style={{ 
                              width: '8px', 
                              height: '8px', 
                              borderRadius: '50%', 
                              backgroundColor: '#10b981' 
                            }} />
                            <span style={{ 
                              fontSize: '0.875rem', 
                              fontWeight: '600',
                              color: '#374151' 
                            }}>
                              {c.user?.fullName || c.user?.email || 'Unknown'}
                            </span>
                            <span style={{ 
                              fontSize: '0.75rem', 
                              color: '#6b7280' 
                            }}>
                              {new Date(c.createdAt).toLocaleString()}
                            </span>
                          </div>
                          <div style={{ 
                            whiteSpace: 'pre-wrap', 
                            fontSize: '0.875rem',
                            color: '#374151',
                            lineHeight: '1.5'
                          }}>
                            {c.content}
                          </div>
                        </div>
                      ))}
                      <div ref={commentsEndRef} />
                    </div>
                  )}
                </div>

                {/* Input Area */}
                <div style={{ 
                  padding: '16px 20px', 
                  borderTop: '1px solid #e5e7eb',
                  backgroundColor: '#f8fafc'
                }}>
                  {commentError && (
                    <div style={{ 
                      color: '#dc2626', 
                      fontSize: '0.875rem',
                      marginBottom: '8px',
                      padding: '8px 12px',
                      backgroundColor: '#fef2f2',
                      border: '1px solid #fecaca',
                      borderRadius: '6px'
                    }}>
                      {commentError}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
                    <textarea
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      placeholder="Type your comment here..."
                      style={{ 
                        flex: 1,
                        minHeight: '40px',
                        maxHeight: '120px',
                        padding: '10px 12px',
                        border: '1px solid #d1d5db',
                        borderRadius: '8px',
                        fontSize: '0.875rem',
                        resize: 'vertical',
                        fontFamily: 'inherit',
                        outline: 'none',
                        transition: 'border-color 0.2s'
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault();
                          if (newComment.trim() && !isSubmittingComment) {
                            // Trigger submit
                            const submitEvent = new Event('click');
                            e.target.nextElementSibling.dispatchEvent(submitEvent);
                          }
                        }
                      }}
                    />
                    <button
                      onClick={async () => {
                        setCommentError('');
                        const content = newComment.trim();
                        if (!content) {
                          setCommentError('Please enter a comment');
                          return;
                        }
                        setIsSubmittingComment(true);
                        try {
                          await apiClient.post(`/applications/${id}/comments`, { content });
                          setNewComment('');
                          await fetchComments();
                          // Auto-scroll to bottom after new comment
                          setTimeout(scrollToBottom, 200);
                        } catch (e) {
                          console.error('Failed to post comment', e);
                          setCommentError('Failed to post comment');
                        } finally {
                          setIsSubmittingComment(false);
                        }
                      }}
                      disabled={isSubmittingComment || !newComment.trim()}
                      style={{ 
                        padding: '10px 16px',
                        backgroundColor: isSubmittingComment || !newComment.trim() ? '#9ca3af' : '#3b82f6',
                        color: 'white',
                        border: 'none',
                        borderRadius: '8px',
                        fontSize: '0.875rem',
                        fontWeight: '500',
                        cursor: isSubmittingComment || !newComment.trim() ? 'not-allowed' : 'pointer',
                        transition: 'background-color 0.2s',
                        minWidth: '80px'
                      }}
                    >
                      {isSubmittingComment ? 'Posting...' : 'Send'}
                    </button>
                  </div>
                  <div style={{ 
                    fontSize: '0.75rem', 
                    color: '#6b7280', 
                    marginTop: '6px',
                    textAlign: 'center'
                  }}>
                    Press Ctrl+Enter to send
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Referral Section */}
      <div className="info-section" style={{ marginTop: '2rem' }}>
        <h2 className="section-title">Referral</h2>
        <div style={{ 
          padding: '1rem', 
          backgroundColor: '#f0fdf4', 
          borderRadius: '8px', 
          border: '1px solid #bbf7d0' 
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: '600', color: '#374151' }}>
              Referral Information
            </h3>
            {!referral && (
              <button
                onClick={() => setIsReferralModalOpen(true)}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#3b82f6',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '0.875rem',
                  fontWeight: '500',
                  cursor: 'pointer'
                }}
              >
                Add Referral
              </button>
            )}
          </div>
          
          {referral ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
                  {referral.referrerName}
                </div>
                <div style={{ fontSize: '0.875rem', color: '#6b7280', marginBottom: '4px' }}>
                  {referral.relationship}
                </div>
                <div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
                  Added {new Date(referral.createdAt).toLocaleDateString()}
                </div>
              </div>
              <button
                onClick={removeReferral}
                style={{
                  padding: '6px 12px',
                  backgroundColor: '#dc2626',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '0.875rem',
                  cursor: 'pointer'
                }}
              >
                Remove
              </button>
            </div>
          ) : (
            <div style={{ color: '#6b7280', fontSize: '0.875rem', fontStyle: 'italic' }}>
              No referral added yet.
            </div>
          )}
        </div>
      </div>

      {/* Document Scores Section */}
      <div className="info-section" style={{ marginTop: '2rem' }}>
        <h2 className="section-title">Document Scores</h2>
        
        {/* Resume Scores */}
        <div style={{ marginBottom: '2rem' }}>
          <h3 style={{ fontSize: '1.125rem', fontWeight: '600', color: '#374151', marginBottom: '1rem' }}>
            Resume Scores ({resumeScores.length})
          </h3>
          {resumeScores.length === 0 ? (
            <div className="empty-state">No resume scores yet.</div>
          ) : (
            <div className="resume-scores-list">
              {resumeScores.map((score) => (
                <div 
                  key={score.id} 
                  className="resume-score-item"
                  style={{
                    padding: '12px',
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                    marginBottom: '8px',
                    cursor: 'pointer',
                    backgroundColor: '#f9fafb',
                    transition: 'background-color 0.2s',
                    position: 'relative'
                  }}
                  onMouseEnter={(e) => e.target.style.backgroundColor = '#f3f4f6'}
                  onMouseLeave={(e) => e.target.style.backgroundColor = '#f9fafb'}
                  onClick={() => {
                    setSelectedScore({...score, documentType: 'Resume'});
                    setScoreModalOpen(true);
                  }}
                >
                  {isAdmin && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEditScore(score, 'resume');
                      }}
                      style={{
                        position: 'absolute',
                        top: '8px',
                        right: '8px',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '4px',
                        color: '#6b7280'
                      }}
                      onMouseEnter={(e) => {
                        e.target.style.backgroundColor = '#e5e7eb';
                        e.target.style.color = '#374151';
                      }}
                      onMouseLeave={(e) => {
                        e.target.style.backgroundColor = 'transparent';
                        e.target.style.color = '#6b7280';
                      }}
                      title="Edit score (Admin)"
                    >
                      <PencilIcon style={{ width: '16px', height: '16px' }} />
                    </button>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: '600', color: '#374151' }}>
                        {score.evaluator?.fullName || score.evaluator?.email || 'Unknown Evaluator'}
                      </div>
                      <div style={{ fontSize: '0.875rem', color: '#6b7280', marginTop: '2px' }}>
                        {new Date(score.createdAt).toLocaleDateString()} at {new Date(score.createdAt).toLocaleTimeString()}
                      </div>
                      {score.notes && (
                        <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '4px', fontStyle: 'italic' }}>
                          {score.notes}
                        </div>
                      )}
                      {score.adminNotes && (
                        <div style={{ fontSize: '0.75rem', color: '#2563eb', marginTop: '4px', fontWeight: '600' }}>
                          Admin Notes: {score.adminNotes}
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '1.125rem', fontWeight: '600', color: '#059669' }}>
                        {score.adminScore !== null && score.adminScore !== undefined 
                          ? `${score.adminScore}/13 (Admin Override)`
                          : `${score.overallScore}/13`}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                        Overall Score
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cover Letter Scores */}
        <div style={{ marginBottom: '2rem' }}>
          <h3 style={{ fontSize: '1.125rem', fontWeight: '600', color: '#374151', marginBottom: '1rem' }}>
            Cover Letter Scores ({coverLetterScores.length})
          </h3>
          {coverLetterScores.length === 0 ? (
            <div className="empty-state">No cover letter scores yet.</div>
          ) : (
            <div className="resume-scores-list">
              {coverLetterScores.map((score) => (
                <div 
                  key={score.id} 
                  className="resume-score-item"
                  style={{
                    padding: '12px',
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                    marginBottom: '8px',
                    cursor: 'pointer',
                    backgroundColor: '#f9fafb',
                    transition: 'background-color 0.2s',
                    position: 'relative'
                  }}
                  onMouseEnter={(e) => e.target.style.backgroundColor = '#f3f4f6'}
                  onMouseLeave={(e) => e.target.style.backgroundColor = '#f9fafb'}
                  onClick={() => {
                    setSelectedScore({...score, documentType: 'Cover Letter'});
                    setScoreModalOpen(true);
                  }}
                >
                  {isAdmin && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEditScore(score, 'coverLetter');
                      }}
                      style={{
                        position: 'absolute',
                        top: '8px',
                        right: '8px',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '4px',
                        color: '#6b7280'
                      }}
                      onMouseEnter={(e) => {
                        e.target.style.backgroundColor = '#e5e7eb';
                        e.target.style.color = '#374151';
                      }}
                      onMouseLeave={(e) => {
                        e.target.style.backgroundColor = 'transparent';
                        e.target.style.color = '#6b7280';
                      }}
                      title="Edit score (Admin)"
                    >
                      <PencilIcon style={{ width: '16px', height: '16px' }} />
                    </button>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: '600', color: '#374151' }}>
                        {score.evaluator?.fullName || score.evaluator?.email || 'Unknown Evaluator'}
                      </div>
                      <div style={{ fontSize: '0.875rem', color: '#6b7280', marginTop: '2px' }}>
                        {new Date(score.createdAt).toLocaleDateString()} at {new Date(score.createdAt).toLocaleTimeString()}
                      </div>
                      {(score.notes || score.notesOne) && (
                        <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '4px', fontStyle: 'italic' }}>
                          {score.notes || score.notesOne}
                        </div>
                      )}
                      {score.adminNotes && (
                        <div style={{ fontSize: '0.75rem', color: '#2563eb', marginTop: '4px', fontWeight: '600' }}>
                          Admin Notes: {score.adminNotes}
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '1.125rem', fontWeight: '600', color: '#059669' }}>
                        {score.adminScore !== null && score.adminScore !== undefined 
                          ? `${score.adminScore}/3 (Admin Override)`
                          : `${score.overallScore}/3`}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                        Overall Score
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Video Scores */}
        <div style={{ marginBottom: '2rem' }}>
          <h3 style={{ fontSize: '1.125rem', fontWeight: '600', color: '#374151', marginBottom: '1rem' }}>
            Video Scores ({videoScores.length})
          </h3>
          {videoScores.length === 0 ? (
            <div className="empty-state">No video scores yet.</div>
          ) : (
            <div className="resume-scores-list">
              {videoScores.map((score) => (
                <div 
                  key={score.id} 
                  className="resume-score-item"
                  style={{
                    padding: '12px',
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                    marginBottom: '8px',
                    cursor: 'pointer',
                    backgroundColor: '#f9fafb',
                    transition: 'background-color 0.2s',
                    position: 'relative'
                  }}
                  onMouseEnter={(e) => e.target.style.backgroundColor = '#f3f4f6'}
                  onMouseLeave={(e) => e.target.style.backgroundColor = '#f9fafb'}
                  onClick={() => {
                    setSelectedScore({...score, documentType: 'Video'});
                    setScoreModalOpen(true);
                  }}
                >
                  {isAdmin && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEditScore(score, 'video');
                      }}
                      style={{
                        position: 'absolute',
                        top: '8px',
                        right: '8px',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '4px',
                        color: '#6b7280'
                      }}
                      onMouseEnter={(e) => {
                        e.target.style.backgroundColor = '#e5e7eb';
                        e.target.style.color = '#374151';
                      }}
                      onMouseLeave={(e) => {
                        e.target.style.backgroundColor = 'transparent';
                        e.target.style.color = '#6b7280';
                      }}
                      title="Edit score (Admin)"
                    >
                      <PencilIcon style={{ width: '16px', height: '16px' }} />
                    </button>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: '600', color: '#374151' }}>
                        {score.evaluator?.fullName || score.evaluator?.email || 'Unknown Evaluator'}
                      </div>
                      <div style={{ fontSize: '0.875rem', color: '#6b7280', marginTop: '2px' }}>
                        {new Date(score.createdAt).toLocaleDateString()} at {new Date(score.createdAt).toLocaleTimeString()}
                      </div>
                      {(score.notes || score.notesOne) && (
                        <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '4px', fontStyle: 'italic' }}>
                          {score.notes || score.notesOne}
                        </div>
                      )}
                      {score.adminNotes && (
                        <div style={{ fontSize: '0.75rem', color: '#2563eb', marginTop: '4px', fontWeight: '600' }}>
                          Admin Notes: {score.adminNotes}
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '1.125rem', fontWeight: '600', color: '#059669' }}>
                        {score.adminScore !== null && score.adminScore !== undefined 
                          ? `${score.adminScore}/2 (Admin Override)`
                          : `${score.overallScore}/2`}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                        Overall Score
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Test For Note Section (Admin Only) */}
      {isAdmin && (
        <div className="info-section" style={{ marginTop: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 className="section-title">Test For Note (Admin)</h2>
            {!isEditingTestFor && (
              <button
                onClick={() => setIsEditingTestFor(true)}
                style={{
                  padding: '6px 12px',
                  backgroundColor: '#2563eb',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                  fontWeight: '500',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <PencilIcon style={{ width: '16px', height: '16px' }} />
                {testForNote ? 'Edit' : 'Add Note'}
              </button>
            )}
          </div>
          
          {isEditingTestFor ? (
            <div style={{ 
              padding: '16px', 
              backgroundColor: '#f9fafb', 
              borderRadius: '8px',
              border: '1px solid #e5e7eb'
            }}>
              <textarea
                value={testForNote}
                onChange={(e) => setTestForNote(e.target.value)}
                placeholder="Enter what to test for in interviews (e.g., 'Test for leadership skills and problem-solving ability')"
                rows={4}
                style={{
                  width: '100%',
                  padding: '12px',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  fontSize: '0.875rem',
                  fontFamily: 'inherit',
                  resize: 'vertical',
                  marginBottom: '12px'
                }}
              />
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => {
                    setIsEditingTestFor(false);
                    setTestForNote(application?.testFor || '');
                  }}
                  disabled={savingTestFor}
                  style={{
                    padding: '8px 16px',
                    backgroundColor: '#fff',
                    color: '#374151',
                    border: '1px solid #d1d5db',
                    borderRadius: '6px',
                    cursor: savingTestFor ? 'not-allowed' : 'pointer',
                    fontSize: '0.875rem',
                    fontWeight: '500'
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveTestFor}
                  disabled={savingTestFor}
                  style={{
                    padding: '8px 16px',
                    backgroundColor: savingTestFor ? '#9ca3af' : '#2563eb',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: savingTestFor ? 'not-allowed' : 'pointer',
                    fontSize: '0.875rem',
                    fontWeight: '500'
                  }}
                >
                  {savingTestFor ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ 
              padding: '16px', 
              backgroundColor: testForNote ? '#eff6ff' : '#f9fafb', 
              borderRadius: '8px',
              border: `1px solid ${testForNote ? '#bfdbfe' : '#e5e7eb'}`,
              minHeight: '60px'
            }}>
              {testForNote ? (
                <p style={{ 
                  margin: 0, 
                  color: '#1e40af',
                  fontSize: '0.875rem',
                  lineHeight: '1.5',
                  whiteSpace: 'pre-wrap'
                }}>
                  {testForNote}
                </p>
              ) : (
                <p style={{ 
                  margin: 0, 
                  color: '#6b7280',
                  fontSize: '0.875rem',
                  fontStyle: 'italic'
                }}>
                  No test for note set. Click "Add Note" to add one.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Interview Evaluations Section */}
      <div className="info-section" style={{ marginTop: '2rem' }}>
        <h2 className="section-title">Interview Evaluations</h2>
        {evaluationsLoading ? (
          <div className="empty-state">Loading interview evaluations...</div>
        ) : interviewEvaluations.length > 0 ? (
          <div className="interview-evaluations-list">
            {interviewEvaluations.map((evaluation) => (
              <div 
                key={evaluation.id} 
                className="interview-evaluation-item"
                style={{
                  padding: '16px',
                  border: '1px solid #e5e7eb',
                  borderRadius: '8px',
                  marginBottom: '12px',
                  backgroundColor: '#f9fafb'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: '600', color: '#374151', fontSize: '1.1rem' }}>
                      {evaluation.interview.title}
                    </div>
                    <div style={{ fontSize: '0.875rem', color: '#6b7280', marginTop: '2px' }}>
                      {evaluation.interview.interviewType.replace(/_/g, ' ')} • 
                      Evaluated by {evaluation.evaluator.fullName}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: '2px' }}>
                      {new Date(evaluation.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  {(evaluation.decision || evaluation.finalDecision) && (
                    <div 
                      style={{
                        padding: '4px 8px',
                        borderRadius: '4px',
                        fontSize: '0.75rem',
                        fontWeight: '600',
                        backgroundColor: 
                          (evaluation.decision || evaluation.finalDecision) === 'YES' ? '#dcfce7' :
                          (evaluation.decision || evaluation.finalDecision) === 'MAYBE_YES' ? '#dcfce7' :
                          (evaluation.decision || evaluation.finalDecision) === 'UNSURE' ? '#fef3c7' :
                          (evaluation.decision || evaluation.finalDecision) === 'MAYBE_NO' ? '#fee2e2' :
                          '#fee2e2',
                        color: 
                          (evaluation.decision || evaluation.finalDecision) === 'YES' ? '#166534' :
                          (evaluation.decision || evaluation.finalDecision) === 'MAYBE_YES' ? '#166534' :
                          (evaluation.decision || evaluation.finalDecision) === 'UNSURE' ? '#92400e' :
                          (evaluation.decision || evaluation.finalDecision) === 'MAYBE_NO' ? '#991b1b' :
                          '#991b1b',
                        border: '1px solid',
                        borderColor: 
                          (evaluation.decision || evaluation.finalDecision) === 'YES' ? '#bbf7d0' :
                          (evaluation.decision || evaluation.finalDecision) === 'MAYBE_YES' ? '#bbf7d0' :
                          (evaluation.decision || evaluation.finalDecision) === 'UNSURE' ? '#fde68a' :
                          (evaluation.decision || evaluation.finalDecision) === 'MAYBE_NO' ? '#fecaca' :
                          '#fecaca'
                      }}
                    >
                      {(evaluation.decision || evaluation.finalDecision).replace(/_/g, ' ')}
                    </div>
                  )}
                </div>
                
                {/* Test For Note (Admin) */}
                {application?.testFor && (
                  <div style={{ 
                    marginBottom: '12px',
                    padding: '12px',
                    backgroundColor: '#eff6ff', 
                    borderLeft: '4px solid #2563eb',
                    borderRadius: '4px'
                  }}>
                    <div style={{ 
                      fontWeight: '600', 
                      color: '#1e40af', 
                      marginBottom: '4px', 
                      fontSize: '0.875rem'
                    }}>
                      Test For (Admin Note):
                    </div>
                    <div style={{ 
                      color: '#1e40af',
                      fontSize: '0.875rem',
                      lineHeight: '1.5',
                      whiteSpace: 'pre-wrap'
                    }}>
                      {application.testFor}
                    </div>
                  </div>
                )}
                
                {/* First Round Interview Scores */}
                {evaluation.interview.interviewType === 'ROUND_ONE' && (evaluation.behavioralTotal !== undefined || evaluation.marketSizingTotal !== undefined) && (
                  <div style={{ marginBottom: '12px' }}>
                    <div style={{ fontWeight: '600', color: '#374151', marginBottom: '8px', fontSize: '0.875rem' }}>
                      First Round Scores:
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                      {/* Behavioral Section */}
                      <div style={{
                        backgroundColor: '#f3f4f6',
                        padding: '12px',
                        borderRadius: '4px'
                      }}>
                        <div style={{ fontWeight: '600', color: '#374151', marginBottom: '8px', fontSize: '0.875rem' }}>
                          Behavioral
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.8rem', color: '#6b7280' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>Leadership:</span>
                            <span style={{ fontWeight: '500' }}>{evaluation.behavioralLeadership ?? 'N/A'}/5</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>Problem Solving:</span>
                            <span style={{ fontWeight: '500' }}>{evaluation.behavioralProblemSolving ?? 'N/A'}/5</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>Interest:</span>
                            <span style={{ fontWeight: '500' }}>{evaluation.behavioralInterest ?? 'N/A'}/5</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #d1d5db', paddingTop: '4px', marginTop: '4px' }}>
                            <span style={{ fontWeight: '600' }}>Total:</span>
                            <span style={{ fontWeight: '600', color: '#374151' }}>{evaluation.behavioralTotal ?? 'N/A'}/15</span>
                          </div>
                        </div>
                      </div>
                      {/* Market Sizing Section */}
                      <div style={{
                        backgroundColor: '#f3f4f6',
                        padding: '12px',
                        borderRadius: '4px'
                      }}>
                        <div style={{ fontWeight: '600', color: '#374151', marginBottom: '8px', fontSize: '0.875rem' }}>
                          Market Sizing
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.8rem', color: '#6b7280' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>Teamwork:</span>
                            <span style={{ fontWeight: '500' }}>{evaluation.marketSizingTeamwork ?? 'N/A'}/5</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>Logic:</span>
                            <span style={{ fontWeight: '500' }}>{evaluation.marketSizingLogic ?? 'N/A'}/5</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>Creativity:</span>
                            <span style={{ fontWeight: '500' }}>{evaluation.marketSizingCreativity ?? 'N/A'}/5</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #d1d5db', paddingTop: '4px', marginTop: '4px' }}>
                            <span style={{ fontWeight: '600' }}>Total:</span>
                            <span style={{ fontWeight: '600', color: '#374151' }}>{evaluation.marketSizingTotal ?? 'N/A'}/15</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* First Round Interview Notes */}
                {evaluation.interview.interviewType === 'ROUND_ONE' && (
                  <>
                    {evaluation.behavioralNotes && typeof evaluation.behavioralNotes === 'object' && Object.keys(evaluation.behavioralNotes).length > 0 && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontWeight: '600', color: '#374151', marginBottom: '8px', fontSize: '0.875rem' }}>
                          Behavioral Notes:
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {Object.entries(evaluation.behavioralNotes).map(([questionId, notes], index) => {
                            const questionText = evaluation.behavioralQuestionMap?.[questionId] || `Question ${index + 1}`;
                            return (
                              <div key={questionId} style={{
                                backgroundColor: '#f3f4f6',
                                padding: '12px',
                                borderRadius: '4px',
                                borderLeft: '3px solid #6366f1'
                              }}>
                                <div style={{
                                  fontWeight: '500',
                                  color: '#4f46e5',
                                  fontSize: '0.8rem',
                                  marginBottom: '6px'
                                }}>
                                  {questionText}
                                </div>
                                <div style={{
                                  whiteSpace: 'pre-wrap',
                                  fontSize: '0.875rem',
                                  color: '#374151',
                                  lineHeight: '1.5'
                                }}>
                                  {notes || 'No notes'}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {evaluation.behavioralNotes && typeof evaluation.behavioralNotes === 'string' && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontWeight: '600', color: '#374151', marginBottom: '4px', fontSize: '0.875rem' }}>
                          Behavioral Notes:
                        </div>
                        <div style={{
                          backgroundColor: '#f3f4f6',
                          padding: '8px',
                          borderRadius: '4px',
                          whiteSpace: 'pre-wrap',
                          fontSize: '0.875rem',
                          color: '#374151'
                        }}>
                          {evaluation.behavioralNotes}
                        </div>
                      </div>
                    )}
                    {evaluation.marketSizingNotes && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontWeight: '600', color: '#374151', marginBottom: '4px', fontSize: '0.875rem' }}>
                          Market Sizing Notes:
                        </div>
                        <div style={{
                          backgroundColor: '#f3f4f6',
                          padding: '8px',
                          borderRadius: '4px',
                          whiteSpace: 'pre-wrap',
                          fontSize: '0.875rem',
                          color: '#374151'
                        }}>
                          {typeof evaluation.marketSizingNotes === 'object' ? JSON.stringify(evaluation.marketSizingNotes, null, 2) : evaluation.marketSizingNotes}
                        </div>
                      </div>
                    )}
                    {evaluation.additionalNotes && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontWeight: '600', color: '#374151', marginBottom: '4px', fontSize: '0.875rem' }}>
                          Additional Notes:
                        </div>
                        <div style={{
                          backgroundColor: '#f3f4f6',
                          padding: '8px',
                          borderRadius: '4px',
                          whiteSpace: 'pre-wrap',
                          fontSize: '0.875rem',
                          color: '#374151'
                        }}>
                          {typeof evaluation.additionalNotes === 'object' ? JSON.stringify(evaluation.additionalNotes, null, 2) : evaluation.additionalNotes}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* Final Round Interview Evaluations (FINAL_ROUND and ROUND_TWO) */}
                {(evaluation.interview.interviewType === 'FINAL_ROUND' || evaluation.interview.interviewType === 'ROUND_TWO') && (
                  <>
                    {/* Behavioral Notes for Final Round */}
                    {evaluation.behavioralNotes && typeof evaluation.behavioralNotes === 'object' && Object.keys(evaluation.behavioralNotes).length > 0 && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontWeight: '600', color: '#374151', marginBottom: '8px', fontSize: '0.875rem' }}>
                          Behavioral Notes:
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {Object.entries(evaluation.behavioralNotes).map(([questionId, notes], index) => (
                            <div key={questionId} style={{
                              backgroundColor: '#f3f4f6',
                              padding: '12px',
                              borderRadius: '4px',
                              borderLeft: '3px solid #6366f1'
                            }}>
                              <div style={{
                                fontWeight: '500',
                                color: '#4f46e5',
                                fontSize: '0.8rem',
                                marginBottom: '6px'
                              }}>
                                Question {index + 1}
                              </div>
                              <div style={{
                                whiteSpace: 'pre-wrap',
                                fontSize: '0.875rem',
                                color: '#374151',
                                lineHeight: '1.5'
                              }}>
                                {notes || 'No notes'}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {evaluation.behavioralNotes && typeof evaluation.behavioralNotes === 'string' && evaluation.behavioralNotes.trim() && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontWeight: '600', color: '#374151', marginBottom: '4px', fontSize: '0.875rem' }}>
                          Behavioral Notes:
                        </div>
                        <div style={{
                          backgroundColor: '#f3f4f6',
                          padding: '8px',
                          borderRadius: '4px',
                          whiteSpace: 'pre-wrap',
                          fontSize: '0.875rem',
                          color: '#374151'
                        }}>
                          {evaluation.behavioralNotes}
                        </div>
                      </div>
                    )}

                    {/* Casing Notes for Final Round */}
                    {evaluation.casingNotes && typeof evaluation.casingNotes === 'object' && Object.keys(evaluation.casingNotes).length > 0 && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontWeight: '600', color: '#374151', marginBottom: '8px', fontSize: '0.875rem' }}>
                          Casing Notes:
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {Object.entries(evaluation.casingNotes).map(([sectionId, notes], index) => (
                            <div key={sectionId} style={{
                              backgroundColor: '#f3f4f6',
                              padding: '12px',
                              borderRadius: '4px',
                              borderLeft: '3px solid #10b981'
                            }}>
                              <div style={{
                                fontWeight: '500',
                                color: '#059669',
                                fontSize: '0.8rem',
                                marginBottom: '6px'
                              }}>
                                Section {index + 1}
                              </div>
                              <div style={{
                                whiteSpace: 'pre-wrap',
                                fontSize: '0.875rem',
                                color: '#374151',
                                lineHeight: '1.5'
                              }}>
                                {notes || 'No notes'}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {evaluation.casingNotes && typeof evaluation.casingNotes === 'string' && evaluation.casingNotes.trim() && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontWeight: '600', color: '#374151', marginBottom: '4px', fontSize: '0.875rem' }}>
                          Casing Notes:
                        </div>
                        <div style={{
                          backgroundColor: '#f3f4f6',
                          padding: '8px',
                          borderRadius: '4px',
                          whiteSpace: 'pre-wrap',
                          fontSize: '0.875rem',
                          color: '#374151'
                        }}>
                          {evaluation.casingNotes}
                        </div>
                      </div>
                    )}

                    {/* Candidate Details for Final Round */}
                    {evaluation.candidateDetails && typeof evaluation.candidateDetails === 'object' && Object.keys(evaluation.candidateDetails).length > 0 && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontWeight: '600', color: '#374151', marginBottom: '8px', fontSize: '0.875rem' }}>
                          Candidate Details:
                        </div>
                        <div style={{
                          backgroundColor: '#f3f4f6',
                          padding: '12px',
                          borderRadius: '4px',
                          borderLeft: '3px solid #f59e0b'
                        }}>
                          <div style={{
                            whiteSpace: 'pre-wrap',
                            fontSize: '0.875rem',
                            color: '#374151',
                            lineHeight: '1.5'
                          }}>
                            {JSON.stringify(evaluation.candidateDetails, null, 2)}
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* Regular Notes (for non-first-round interviews that aren't final round) */}
                {evaluation.interview.interviewType !== 'ROUND_ONE' && 
                 evaluation.interview.interviewType !== 'FINAL_ROUND' && 
                 evaluation.interview.interviewType !== 'ROUND_TWO' && 
                 evaluation.notes && (
                  <div style={{ marginBottom: '12px' }}>
                    <div style={{ fontWeight: '600', color: '#374151', marginBottom: '4px', fontSize: '0.875rem' }}>
                      Notes:
                    </div>
                    <div style={{
                      backgroundColor: '#f3f4f6',
                      padding: '8px',
                      borderRadius: '4px',
                      whiteSpace: 'pre-wrap',
                      fontSize: '0.875rem',
                      color: '#374151'
                    }}>
                      {evaluation.notes}
                    </div>
                  </div>
                )}

              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">No interview evaluations found for this application.</div>
        )}
      </div>

      {/* Score Detail Modal */}
      {scoreModalOpen && selectedScore && (
        <div 
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000
          }}
          onClick={() => setScoreModalOpen(false)}
        >
          <div 
            style={{
              backgroundColor: '#fff',
              borderRadius: '12px',
              padding: '24px',
              maxWidth: '500px',
              width: '90%',
              maxHeight: '80vh',
              overflow: 'auto'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: '600' }}>
                {selectedScore?.documentType || 'Document'} Score Details
              </h3>
              <button 
                onClick={() => setScoreModalOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '1.5rem',
                  cursor: 'pointer',
                  color: '#6b7280'
                }}
              >
                ×
              </button>
            </div>
            
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
                Evaluator
              </div>
              <div style={{ color: '#6b7280' }}>
                {selectedScore.evaluator?.fullName || selectedScore.evaluator?.email || 'Unknown'}
              </div>
            </div>

            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
                Date & Time
              </div>
              <div style={{ color: '#6b7280' }}>
                {new Date(selectedScore.createdAt).toLocaleString()}
              </div>
            </div>

            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontWeight: '600', color: '#374151', marginBottom: '8px' }}>
                Category Scores
              </div>
              <div style={{ display: 'grid', gap: '8px' }}>
                {selectedScore.documentType === 'Resume' && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px', backgroundColor: '#f9fafb', borderRadius: '4px' }}>
                      <span>Content, Relevance, and Impact</span>
                      <span style={{ fontWeight: '600' }}>{selectedScore.scoreOne || 'N/A'}/10</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px', backgroundColor: '#f9fafb', borderRadius: '4px' }}>
                      <span>Structure & Formatting</span>
                      <span style={{ fontWeight: '600' }}>{selectedScore.scoreTwo || 'N/A'}/3</span>
                    </div>
                  </>
                )}
                {selectedScore.documentType === 'Cover Letter' && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px', backgroundColor: '#f9fafb', borderRadius: '4px' }}>
                      <span>Consulting Interest</span>
                      <span style={{ fontWeight: '600' }}>{selectedScore.scoreOne || 'N/A'}/3</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px', backgroundColor: '#f9fafb', borderRadius: '4px' }}>
                      <span>UC Interest</span>
                      <span style={{ fontWeight: '600' }}>{selectedScore.scoreTwo || 'N/A'}/3</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px', backgroundColor: '#f9fafb', borderRadius: '4px' }}>
                      <span>Culture Addition</span>
                      <span style={{ fontWeight: '600' }}>{selectedScore.scoreThree || 'N/A'}/3</span>
                    </div>
                  </>
                )}
                {selectedScore.documentType === 'Video' && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px', backgroundColor: '#f9fafb', borderRadius: '4px' }}>
                    <span>Overall Video Assessment</span>
                    <span style={{ fontWeight: '600' }}>{selectedScore.scoreOne || 'N/A'}/2</span>
                  </div>
                )}
              </div>
            </div>

            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontWeight: '600', color: '#374151', marginBottom: '8px' }}>
                Overall Score
              </div>
              <div style={{ fontSize: '1.25rem', fontWeight: '600', color: '#059669' }}>
                {selectedScore.overallScore}/{selectedScore.documentType === 'Resume' ? '13' : 
                                           selectedScore.documentType === 'Cover Letter' ? '3' : 
                                           selectedScore.documentType === 'Video' ? '2' : '10'}
              </div>
            </div>

            {selectedScore.notes && (
              <div style={{ marginBottom: '16px' }}>
                <div style={{ fontWeight: '600', color: '#374151', marginBottom: '8px' }}>
                  Notes
                </div>
                <div style={{ 
                  padding: '12px', 
                  backgroundColor: '#f9fafb', 
                  borderRadius: '4px',
                  whiteSpace: 'pre-wrap',
                  color: '#374151'
                }}>
                  {selectedScore.notes}
                </div>
              </div>
            )}

            <div style={{ textAlign: 'right' }}>
              <button 
                onClick={() => setScoreModalOpen(false)}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#6b7280',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {preview.open && (
        <DocumentPreviewModal
          src={preview.src}
          kind={preview.kind}
          title={preview.title}
          onClose={() => setPreview({ open: false, src: '', kind: 'pdf', title: '' })}
        />
      )}

      {/* Referral Modal */}
      {isReferralModalOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            backgroundColor: 'white',
            padding: '24px',
            borderRadius: '12px',
            width: '90%',
            maxWidth: '500px',
            maxHeight: '90vh',
            overflow: 'auto'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: '600' }}>
                Add Referral
              </h3>
              <button
                onClick={() => setIsReferralModalOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '1.5rem',
                  cursor: 'pointer',
                  color: '#6b7280'
                }}
              >
                ×
              </button>
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500', color: '#374151' }}>
                Referrer Name *
              </label>
              <input
                type="text"
                value={referralForm.referrerName}
                onChange={(e) => setReferralForm(prev => ({ ...prev, referrerName: e.target.value }))}
                placeholder="Enter referrer's name"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  fontSize: '0.875rem'
                }}
              />
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500', color: '#374151' }}>
                Relationship *
              </label>
              <input
                type="text"
                value={referralForm.relationship}
                onChange={(e) => setReferralForm(prev => ({ ...prev, relationship: e.target.value }))}
                placeholder="e.g., Former colleague, Professor, Friend"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  fontSize: '0.875rem'
                }}
              />
            </div>


            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setIsReferralModalOpen(false)}
                style={{
                  padding: '10px 16px',
                  backgroundColor: '#f3f4f6',
                  color: '#374151',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '0.875rem',
                  fontWeight: '500',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={addReferral}
                disabled={isSubmittingReferral || !referralForm.referrerName.trim() || !referralForm.relationship.trim()}
                style={{
                  padding: '10px 16px',
                  backgroundColor: isSubmittingReferral || !referralForm.referrerName.trim() || !referralForm.relationship.trim() ? '#9ca3af' : '#3b82f6',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '0.875rem',
                  fontWeight: '500',
                  cursor: isSubmittingReferral || !referralForm.referrerName.trim() || !referralForm.relationship.trim() ? 'not-allowed' : 'pointer'
                }}
              >
                {isSubmittingReferral ? 'Adding...' : 'Add Referral'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Score Modal */}
      {editScoreModalOpen && editingScore && (
        <div 
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000
          }}
          onClick={() => setEditScoreModalOpen(false)}
        >
          <div 
            style={{
              backgroundColor: '#fff',
              borderRadius: '12px',
              padding: '24px',
              maxWidth: '600px',
              width: '90%',
              maxHeight: '80vh',
              overflow: 'auto'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: '600' }}>
                Edit {editingScoreType === 'resume' ? 'Resume' : editingScoreType === 'coverLetter' ? 'Cover Letter' : 'Video'} Score
              </h3>
              <button 
                onClick={() => setEditScoreModalOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '1.5rem',
                  cursor: 'pointer',
                  color: '#6b7280'
                }}
              >
                ×
              </button>
            </div>

            {saveError && (
              <div style={{ 
                padding: '12px', 
                backgroundColor: '#fee2e2', 
                color: '#991b1b', 
                borderRadius: '8px', 
                marginBottom: '16px' 
              }}>
                {saveError}
              </div>
            )}

            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
                Evaluator
              </div>
              <div style={{ color: '#6b7280' }}>
                {editingScore.evaluator?.fullName || 'Unknown'}
              </div>
            </div>

            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
                Date
              </div>
              <div style={{ color: '#6b7280' }}>
                {editingScore.createdAt ? new Date(editingScore.createdAt).toLocaleDateString() : 'N/A'}
              </div>
            </div>

            {editingScoreType === 'resume' && (
              <>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
                    Score One (Content/Relevance/Impact) (0-10)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="10"
                    value={editScoreForm.scoreOne}
                    onChange={(e) => setEditScoreForm({ ...editScoreForm, scoreOne: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '8px',
                      border: '1px solid #d1d5db',
                      borderRadius: '6px',
                      fontSize: '1rem'
                    }}
                  />
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
                    Score Two (Structure/Formatting) (0-3)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="3"
                    value={editScoreForm.scoreTwo}
                    onChange={(e) => setEditScoreForm({ ...editScoreForm, scoreTwo: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '8px',
                      border: '1px solid #d1d5db',
                      borderRadius: '6px',
                      fontSize: '1rem'
                    }}
                  />
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
                    Overall Score (0-13)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="13"
                    step="0.1"
                    value={editScoreForm.overallScore}
                    onChange={(e) => setEditScoreForm({ ...editScoreForm, overallScore: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '8px',
                      border: '1px solid #d1d5db',
                      borderRadius: '6px',
                      fontSize: '1rem'
                    }}
                  />
                  <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '4px' }}>
                    Leave empty to auto-calculate from Score One + Score Two
                  </div>
                </div>
              </>
            )}

            {editingScoreType === 'coverLetter' && (
              <>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
                    Score One (0-3)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="3"
                    value={editScoreForm.scoreOne}
                    onChange={(e) => setEditScoreForm({ ...editScoreForm, scoreOne: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '8px',
                      border: '1px solid #d1d5db',
                      borderRadius: '6px',
                      fontSize: '1rem'
                    }}
                  />
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
                    Score Two (0-3)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="3"
                    value={editScoreForm.scoreTwo}
                    onChange={(e) => setEditScoreForm({ ...editScoreForm, scoreTwo: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '8px',
                      border: '1px solid #d1d5db',
                      borderRadius: '6px',
                      fontSize: '1rem'
                    }}
                  />
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
                    Score Three (0-3)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="3"
                    value={editScoreForm.scoreThree}
                    onChange={(e) => setEditScoreForm({ ...editScoreForm, scoreThree: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '8px',
                      border: '1px solid #d1d5db',
                      borderRadius: '6px',
                      fontSize: '1rem'
                    }}
                  />
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
                    Overall Score (0-3)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="3"
                    step="0.1"
                    value={editScoreForm.overallScore}
                    onChange={(e) => setEditScoreForm({ ...editScoreForm, overallScore: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '8px',
                      border: '1px solid #d1d5db',
                      borderRadius: '6px',
                      fontSize: '1rem'
                    }}
                  />
                  <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '4px' }}>
                    Leave empty to auto-calculate from average of scores
                  </div>
                </div>
              </>
            )}

            {editingScoreType === 'video' && (
              <>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
                    Score One (0-2)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="2"
                    value={editScoreForm.scoreOne}
                    onChange={(e) => setEditScoreForm({ ...editScoreForm, scoreOne: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '8px',
                      border: '1px solid #d1d5db',
                      borderRadius: '6px',
                      fontSize: '1rem'
                    }}
                  />
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
                    Overall Score (0-2)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={editScoreForm.overallScore}
                    onChange={(e) => setEditScoreForm({ ...editScoreForm, overallScore: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '8px',
                      border: '1px solid #d1d5db',
                      borderRadius: '6px',
                      fontSize: '1rem'
                    }}
                  />
                  <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '4px' }}>
                    Leave empty to use Score One
                  </div>
                </div>
              </>
            )}

            <div style={{ marginBottom: '12px' }}>
              <label style={{ display: 'block', fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
                Notes
              </label>
              <textarea
                value={editScoreForm.notes}
                onChange={(e) => setEditScoreForm({ ...editScoreForm, notes: e.target.value })}
                rows={3}
                style={{
                  width: '100%',
                  padding: '8px',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  fontSize: '1rem',
                  fontFamily: 'inherit',
                  resize: 'vertical'
                }}
              />
            </div>

            <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid #e5e7eb' }}>
              <div style={{ fontWeight: '600', color: '#374151', marginBottom: '12px' }}>
                Admin Override (Optional)
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
                  Admin Score Override
                </label>
                <input
                  type="number"
                  min="0"
                  max={editingScoreType === 'resume' ? 13 : editingScoreType === 'coverLetter' ? 3 : 2}
                  step="0.1"
                  value={editScoreForm.adminScore}
                  onChange={(e) => setEditScoreForm({ ...editScoreForm, adminScore: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '8px',
                    border: '1px solid #d1d5db',
                    borderRadius: '6px',
                    fontSize: '1rem'
                  }}
                />
                <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '4px' }}>
                  Override the overall score with an admin score
                </div>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontWeight: '600', color: '#374151', marginBottom: '4px' }}>
                  Admin Notes
                </label>
                <textarea
                  value={editScoreForm.adminNotes}
                  onChange={(e) => setEditScoreForm({ ...editScoreForm, adminNotes: e.target.value })}
                  rows={3}
                  placeholder="Add admin notes about this score..."
                  style={{
                    width: '100%',
                    padding: '8px',
                    border: '1px solid #d1d5db',
                    borderRadius: '6px',
                    fontSize: '1rem',
                    fontFamily: 'inherit',
                    resize: 'vertical'
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '24px' }}>
              <button
                onClick={() => setEditScoreModalOpen(false)}
                disabled={savingScore}
                style={{
                  padding: '8px 16px',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  background: '#fff',
                  cursor: savingScore ? 'not-allowed' : 'pointer',
                  color: '#374151',
                  fontSize: '0.875rem',
                  fontWeight: '500'
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveScore}
                disabled={savingScore}
                style={{
                  padding: '8px 16px',
                  border: 'none',
                  borderRadius: '6px',
                  background: savingScore ? '#9ca3af' : '#2563eb',
                  cursor: savingScore ? 'not-allowed' : 'pointer',
                  color: '#fff',
                  fontSize: '0.875rem',
                  fontWeight: '500'
                }}
              >
                {savingScore ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Past Application Detail Modal */}
      {pastApplicationModalOpen && selectedPastApplication && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000
          }}
          onClick={() => setPastApplicationModalOpen(false)}
        >
          <div
            style={{
              backgroundColor: '#fff',
              borderRadius: '12px',
              padding: '24px',
              maxWidth: '700px',
              width: '90%',
              maxHeight: '85vh',
              overflow: 'auto'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: '600' }}>
                  Past Application Details
                </h3>
                <p style={{ margin: '4px 0 0 0', fontSize: '0.875rem', color: '#6b7280' }}>
                  {selectedPastApplication.cycle?.name || 'Unknown Cycle'}
                </p>
              </div>
              <button
                onClick={() => setPastApplicationModalOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '1.5rem',
                  cursor: 'pointer',
                  color: '#6b7280'
                }}
              >
                ×
              </button>
            </div>

            {/* Status Badge */}
            <div style={{ marginBottom: '20px' }}>
              <span style={{
                padding: '6px 12px',
                borderRadius: '9999px',
                fontSize: '0.875rem',
                fontWeight: '600',
                backgroundColor:
                  selectedPastApplication.status === 'ACCEPTED' ? '#dcfce7' :
                  selectedPastApplication.status === 'REJECTED' ? '#fee2e2' :
                  selectedPastApplication.status === 'WAITLISTED' ? '#fef3c7' :
                  '#e0e7ff',
                color:
                  selectedPastApplication.status === 'ACCEPTED' ? '#166534' :
                  selectedPastApplication.status === 'REJECTED' ? '#991b1b' :
                  selectedPastApplication.status === 'WAITLISTED' ? '#92400e' :
                  '#3730a3'
              }}>
                {selectedPastApplication.status.replace('_', ' ')}
              </span>
            </div>

            {/* Basic Info */}
            <div style={{ marginBottom: '20px' }}>
              <h4 style={{ margin: '0 0 12px 0', fontSize: '1rem', fontWeight: '600', color: '#374151' }}>
                Application Info
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div style={{ padding: '12px', backgroundColor: '#f9fafb', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '4px' }}>Submitted</div>
                  <div style={{ fontWeight: '500', color: '#374151' }}>
                    {new Date(selectedPastApplication.submittedAt).toLocaleDateString()}
                  </div>
                </div>
                <div style={{ padding: '12px', backgroundColor: '#f9fafb', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '4px' }}>Email</div>
                  <div style={{ fontWeight: '500', color: '#374151' }}>{selectedPastApplication.email}</div>
                </div>
                <div style={{ padding: '12px', backgroundColor: '#f9fafb', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '4px' }}>Graduation Year</div>
                  <div style={{ fontWeight: '500', color: '#374151' }}>{selectedPastApplication.graduationYear}</div>
                </div>
                <div style={{ padding: '12px', backgroundColor: '#f9fafb', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '4px' }}>Major</div>
                  <div style={{ fontWeight: '500', color: '#374151' }}>
                    {selectedPastApplication.major1}
                    {selectedPastApplication.major2 && `, ${selectedPastApplication.major2}`}
                  </div>
                </div>
                <div style={{ padding: '12px', backgroundColor: '#f9fafb', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '4px' }}>Cumulative GPA</div>
                  <div style={{ fontWeight: '500', color: '#374151' }}>{selectedPastApplication.cumulativeGpa}</div>
                </div>
                <div style={{ padding: '12px', backgroundColor: '#f9fafb', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '4px' }}>Major GPA</div>
                  <div style={{ fontWeight: '500', color: '#374151' }}>
                    {selectedPastApplication.majorGpa || 'Not provided'}
                  </div>
                </div>
              </div>
            </div>

            {/* Documents Section */}
            <div style={{ marginBottom: '20px' }}>
              <h4 style={{ margin: '0 0 12px 0', fontSize: '1rem', fontWeight: '600', color: '#374151' }}>
                Documents
              </h4>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                {selectedPastApplication.resumeUrl && (
                  <button
                    onClick={() => {
                      setPastApplicationModalOpen(false);
                      setPreview({
                        open: true,
                        src: selectedPastApplication.resumeUrl,
                        kind: 'pdf',
                        title: `${selectedPastApplication.firstName} ${selectedPastApplication.lastName} – Resume (${selectedPastApplication.cycle?.name || 'Past'})`
                      });
                    }}
                    style={{
                      padding: '10px 16px',
                      backgroundColor: '#eff6ff',
                      color: '#1e40af',
                      border: '1px solid #bfdbfe',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontWeight: '500',
                      fontSize: '0.875rem'
                    }}
                  >
                    View Resume
                  </button>
                )}
                {selectedPastApplication.coverLetterUrl && (
                  <button
                    onClick={() => {
                      setPastApplicationModalOpen(false);
                      setPreview({
                        open: true,
                        src: selectedPastApplication.coverLetterUrl,
                        kind: 'pdf',
                        title: `${selectedPastApplication.firstName} ${selectedPastApplication.lastName} – Cover Letter (${selectedPastApplication.cycle?.name || 'Past'})`
                      });
                    }}
                    style={{
                      padding: '10px 16px',
                      backgroundColor: '#eff6ff',
                      color: '#1e40af',
                      border: '1px solid #bfdbfe',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontWeight: '500',
                      fontSize: '0.875rem'
                    }}
                  >
                    View Cover Letter
                  </button>
                )}
                {selectedPastApplication.videoUrl && (
                  <button
                    onClick={() => {
                      setPastApplicationModalOpen(false);
                      setPreview({
                        open: true,
                        src: selectedPastApplication.videoUrl,
                        kind: 'video',
                        title: `${selectedPastApplication.firstName} ${selectedPastApplication.lastName} – Video (${selectedPastApplication.cycle?.name || 'Past'})`
                      });
                    }}
                    style={{
                      padding: '10px 16px',
                      backgroundColor: '#f0fdf4',
                      color: '#166534',
                      border: '1px solid #bbf7d0',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontWeight: '500',
                      fontSize: '0.875rem'
                    }}
                  >
                    View Video
                  </button>
                )}
                {!selectedPastApplication.resumeUrl && !selectedPastApplication.coverLetterUrl && !selectedPastApplication.videoUrl && (
                  <p style={{ color: '#6b7280', fontStyle: 'italic', margin: 0 }}>No documents available</p>
                )}
              </div>
            </div>

            {/* Additional Info */}
            <div style={{ marginBottom: '20px' }}>
              <h4 style={{ margin: '0 0 12px 0', fontSize: '1rem', fontWeight: '600', color: '#374151' }}>
                Additional Details
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div style={{ padding: '12px', backgroundColor: '#f9fafb', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '4px' }}>Transfer Student</div>
                  <div style={{ fontWeight: '500', color: '#374151' }}>
                    {selectedPastApplication.isTransferStudent ? 'Yes' : 'No'}
                  </div>
                </div>
                <div style={{ padding: '12px', backgroundColor: '#f9fafb', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '4px' }}>First Generation</div>
                  <div style={{ fontWeight: '500', color: '#374151' }}>
                    {selectedPastApplication.isFirstGeneration ? 'Yes' : 'No'}
                  </div>
                </div>
                {selectedPastApplication.gender && (
                  <div style={{ padding: '12px', backgroundColor: '#f9fafb', borderRadius: '6px' }}>
                    <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '4px' }}>Gender</div>
                    <div style={{ fontWeight: '500', color: '#374151' }}>{selectedPastApplication.gender}</div>
                  </div>
                )}
              </div>
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '24px', paddingTop: '16px', borderTop: '1px solid #e5e7eb' }}>
              <button
                onClick={() => setPastApplicationModalOpen(false)}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#f3f4f6',
                  color: '#374151',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: '500',
                  fontSize: '0.875rem'
                }}
              >
                Close
              </button>
              <button
                onClick={() => {
                  window.open(`/application/${selectedPastApplication.id}`, '_blank');
                }}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#2563eb',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: '500',
                  fontSize: '0.875rem'
                }}
              >
                Open Full Application
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </AccessControl>
  );
} 