import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { GRADUATION_YEARS } from '../utils/graduationYears';
import {
  Box,
  Typography,
  Button,
  Stack,
  IconButton,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Alert,
  Snackbar,
  TextField,
  CircularProgress,
  Card,
  Grid,
  CardContent,
  Divider,
  Badge,
  Tooltip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Checkbox,
  FormControlLabel,
  Switch,
  Tabs,
  Tab
} from '@mui/material';
import {
  Edit as EditIcon,
  ThumbUp as ThumbUpIcon,
  ThumbDown as ThumbDownIcon,
  SkipNext as SkipNextIcon,
  Refresh as RefreshIcon,
  ExpandMore as ExpandMoreIcon,
  CheckCircle as CheckCircleIcon,
  Cancel as CancelIcon,
  Help as HelpIcon,
  Event as EventIcon,
  Grade as GradeIcon,
  Person as PersonIcon,
  School as SchoolIcon,
  Email as EmailIcon,
  Phone as PhoneIcon,
  CalendarToday as CalendarIcon,
  TrendingUp as TrendingUpIcon,
  Visibility as VisibilityIcon,
  Send as SendIcon,
  FilterList as FilterListIcon,
  Search as SearchIcon,
  Clear as ClearIcon,
  Download as DownloadIcon,
  ArrowUpward as ArrowUpwardIcon,
  ArrowDownward as ArrowDownwardIcon,
  Sort as SortIcon
} from '@mui/icons-material';
import '../styles/Staging.css';
import apiClient from '../utils/api';
import usePolling, { POLL_STATUS, POLL_NO_CHANGE } from '../hooks/usePolling';
import stagingCache from '../utils/stagingCache';
import AuthenticatedImage from '../components/AuthenticatedImage';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import AccessControl from '../components/AccessControl';
import { useAuth } from '../context/AuthContext';
import { useCelebration } from '../context/CelebrationContext';
import ApplicationDetail from './ApplicationDetail';

// Staging is a QA/admin console: refresh often enough for multiple operators to
// converge, but keep the interval bounded and back off hard when the API is down.
//
// Each tick reads a change token, not the snapshot. The token costs one row (~0.4s)
// against the snapshot's six serialized loaders (~13s, ~840KB), which is what makes an
// interval this short affordable: a quiet console does no snapshot reads at all, and a
// change is picked up within one interval instead of one minute.
const STAGING_POLL_INTERVAL_MS = 5 * 1000;
const STAGING_MAX_POLL_INTERVAL_MS = 5 * 60 * 1000;

// API functions for staging
const stagingAPI = {
  // One transactional read of every resource this page renders, carrying the database
  // version that orders it against other snapshots.
  async fetchSnapshot(options) {
    return await apiClient.get('/admin/staging/snapshot', options);
  },

  // One row, bumped by database triggers on every write the snapshot can see. Compare
  // for equality only: it reports that something changed, not what or in what order.
  async fetchVersion(options) {
    return await apiClient.get('/admin/staging/version', options);
  },

  async updateApproval(applicationId, approved) {
    return await apiClient.patch(`/admin/candidates/${applicationId}/approval`, { approved });
  },

  async addApplicationComment(applicationId, content) {
    return await apiClient.post(`/applications/${applicationId}/comments`, { content });
  },

  async fetchCandidateDetails(candidateId) {
    return await apiClient.get(`/applications/${candidateId}`);
  },

  async fetchCandidateScores(candidateId) {
    return await apiClient.get(`/applications/${candidateId}/grades/average`);
  },

  async updateCandidateStatus(candidateId, status, notes = '') {
    return await apiClient.patch(`/admin/staging/candidates/${candidateId}/status`, {
      status,
      notes
    });
  },

  async submitFinalDecision(candidateId, decision, feedback = '') {
    return await apiClient.post(`/admin/staging/candidates/${candidateId}/final-decision`, {
      decision,
      feedback
    });
  },

  async advanceToNextRound(candidateId, roundNumber) {
    return await apiClient.post(`/admin/staging/candidates/${candidateId}/advance-round`, {
      roundNumber
    });
  },

  async fetchAdminCandidates() {
    return await apiClient.get('/admin/candidates');
  },

  async advanceRound() {
    return await apiClient.post('/admin/advance-round', {});
  },

  async processDecisions() {
    return await apiClient.post('/admin/process-decisions', { sendEmails: false });
  },

  async processCoffeeDecisions() {
    return await apiClient.post('/admin/process-coffee-decisions', {});
  },

  async processFirstRoundDecisions() {
    return await apiClient.post('/admin/process-first-round-decisions', { sendEmails: false });
  },

  async processFinalDecisions() {
    return await apiClient.post('/admin/process-final-decisions', {});
  },

  async saveDecision(candidateId, decision, phase = 'resume') {
    return await apiClient.post('/admin/save-decision', { 
      candidateId, 
      decision, 
      phase 
    });
  },

  async fetchEvaluationSummaries(applicationIds) {
    return await apiClient.post('/admin/applications/evaluation-summaries', { applicationIds });
  }
};

const buildGradingMap = (adminApplications) => {
  const gradingMap = {};

  (adminApplications || []).forEach(app => {
    const hasResume = Boolean(app.resumeUrl);
    const hasCoverLetter = Boolean(app.coverLetterUrl);
    const hasVideo = Boolean(app.videoUrl);

    const hasResumeScore = Boolean(app.hasResumeScore);
    const hasCoverLetterScore = Boolean(app.hasCoverLetterScore);
    const hasVideoScore = Boolean(app.hasVideoScore);

    let gradingComplete = true;

    if (hasResume && !hasResumeScore) gradingComplete = false;
    if (hasCoverLetter && !hasCoverLetterScore) gradingComplete = false;
    if (hasVideo && !hasVideoScore) gradingComplete = false;

    gradingMap[app.candidateId] = {
      complete: gradingComplete,
      hasResume,
      hasCoverLetter,
      hasVideo,
      hasResumeScore,
      hasCoverLetterScore,
      hasVideoScore
    };
  });

  return gradingMap;
};

// Decision options
const decisionOptions = [
  { value: 'ADVANCE', label: 'Advance to Next Round', color: 'success', icon: <ThumbUpIcon /> },
  { value: 'REJECT', label: 'Reject', color: 'error', icon: <ThumbDownIcon /> },
  { value: 'WAITLIST', label: 'Waitlist', color: 'warning', icon: <HelpIcon /> },
  { value: 'HOLD', label: 'Hold for Review', color: 'info', icon: <VisibilityIcon /> }
];

const StatusChip = ({ status, size = 'small' }) => {
  const getStatusConfig = (status) => {
    switch (status) {
      case 'SUBMITTED':
        return { color: 'default', label: 'Submitted' };
      case 'UNDER_REVIEW':
        return { color: 'primary', label: 'Under Review' };
      case 'ACCEPTED':
        return { color: 'success', label: 'Accepted' };
      case 'REJECTED':
        return { color: 'error', label: 'Rejected' };
      case 'WAITLISTED':
        return { color: 'warning', label: 'Waitlisted' };
      default:
        return { color: 'default', label: status };
    }
  };

  const config = getStatusConfig(status);
  return <Chip label={config.label} color={config.color} size={size} />;
};

const DecisionChip = ({ decision, size = 'small' }) => {
  const getDecisionConfig = (decision) => {
    switch (decision) {
      case 'ADVANCE':
        return { color: 'success', label: 'Advance', icon: <ThumbUpIcon fontSize="small" /> };
      case 'REJECT':
        return { color: 'error', label: 'Reject', icon: <ThumbDownIcon fontSize="small" /> };
      case 'WAITLIST':
        return { color: 'warning', label: 'Waitlist', icon: <HelpIcon fontSize="small" /> };
      case 'HOLD':
        return { color: 'info', label: 'Hold', icon: <VisibilityIcon fontSize="small" /> };
      default:
        return { color: 'default', label: 'Pending', icon: null };
    }
  };

  const config = getDecisionConfig(decision);
  return (
    <Chip 
      label={config.label} 
      color={config.color} 
      size={size}
      icon={config.icon}
    />
  );
};

const ScoreDisplay = ({ score, maxScore = 10 }) => {
  const percentage = (score / maxScore) * 100;
  const getColor = (percentage) => {
    if (percentage >= 80) return 'success';
    if (percentage >= 60) return 'warning';
    return 'error';
  };

  return (
    <Box display="flex" alignItems="center" gap={1}>
      <Typography variant="body2" fontWeight="bold">
        {score.toFixed(1)}
      </Typography>
      <Box
        sx={{
          width: 40,
          height: 8,
          backgroundColor: 'grey.200',
          borderRadius: 1,
          overflow: 'hidden'
        }}
      >
        <Box
          sx={{
            width: `${percentage}%`,
            height: '100%',
            backgroundColor: `${getColor(percentage)}.main`,
            transition: 'width 0.3s ease'
          }}
        />
      </Box>
    </Box>
  );
};

const AttendanceDisplay = ({ attendance, events }) => {
  if (!events || events.length === 0) {
    return (
      <Box display="flex" alignItems="center" justifyContent="center" minHeight="60px">
        <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
          No events available for this cycle
        </Typography>
      </Box>
    );
  }

  const getAttendanceStatus = (event) => {
    const eventName = event.eventName || event.name || event.id;
    let isAttended = false;
    
    if (attendance && eventName) {
      if (attendance[eventName] !== undefined) {
        isAttended = Boolean(attendance[eventName]);
      } else {
        const attendanceKeys = Object.keys(attendance);
        const matchingKey = attendanceKeys.find(key => 
          key.toLowerCase() === eventName.toLowerCase() ||
          key.toLowerCase().includes(eventName.toLowerCase()) || 
          eventName.toLowerCase().includes(key.toLowerCase())
        );
        if (matchingKey !== undefined) {
          isAttended = Boolean(attendance[matchingKey]);
        }
      }
    }
    
    return isAttended;
  };

  const attendedEventsList = events.filter(event => getAttendanceStatus(event));

  // Check if candidate attended GTKUC (Get to Know UC meeting)
  const hasGTKUC = attendance && attendance['GTKUC'];

  // Create a combined list including GTKUC if attended
  const allAttendedItems = [
    ...attendedEventsList,
    ...(hasGTKUC ? [{ id: 'gtkuc', eventName: 'GTKUC' }] : [])
  ];
  const totalAttendedCount = allAttendedItems.length;

  if (totalAttendedCount === 0) {
    return (
      <Box display="flex" alignItems="center" justifyContent="center" minHeight="60px">
        <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
          No events attended
        </Typography>
      </Box>
    );
  }

  const maxVisibleEvents = 2;
  const visibleEvents = allAttendedItems.slice(0, maxVisibleEvents);
  const hiddenCount = totalAttendedCount - maxVisibleEvents;

  const tooltipContent = allAttendedItems.map(e => e.eventName || e.name || e.id).join('\n');

  return (
    <Tooltip title={tooltipContent} arrow placement="top">
      <Stack spacing={0.25} sx={{ maxWidth: '100%', overflow: 'hidden' }}>
        <Chip
          label={`${totalAttendedCount} event${totalAttendedCount !== 1 ? 's' : ''}`}
          color="success"
          size="small"
          sx={{ fontSize: '0.7rem', height: 20 }}
        />

        {visibleEvents.map((event) => {
          const eventName = event.eventName || event.name || event.id;

          return (
            <Box key={event.id || event.name} display="flex" alignItems="center" gap={0.25}>
              <CheckCircleIcon sx={{ fontSize: 14, color: 'success.main' }} />
              <Typography
                variant="caption"
                color="success.main"
                sx={{
                  fontSize: '0.65rem',
                  fontWeight: 500,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {eventName}
              </Typography>
            </Box>
          );
        })}

        {hiddenCount > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.6rem' }}>
            +{hiddenCount} more
          </Typography>
        )}
      </Stack>
    </Tooltip>
  );
};

const getDecisionHighlight = (decision) => {
  switch (decision) {
    case 'yes':
      return { bg: 'success.light', border: 'success.main' };
    case 'maybe_yes':
      return { bg: 'info.light', border: 'info.main' };
    case 'maybe_no':
      return { bg: 'warning.light', border: 'warning.main' };
    case 'no':
      return { bg: 'error.light', border: 'error.main' };
    default:
      return { bg: 'grey.50', border: 'grey.300' };
  }
};

const GradingStatusDisplay = ({ candidate, gradingData }) => {
  if (!gradingData) {
    return (
      <Chip label="No Grading Data" color="default" size="small" />
    );
  }
  
  const { complete, hasResume, hasCoverLetter, hasVideo, hasResumeScore, hasCoverLetterScore, hasVideoScore } = gradingData;
  
  if (complete) {
    const tooltipText = `All available documents have been scored:
${hasResume ? '✓ Resume' : '✗ No Resume'}
${hasCoverLetter ? '✓ Cover Letter' : '✗ No Cover Letter'}
${hasVideo ? '✓ Video' : '✗ No Video'}`;
    
    return (
      <Tooltip title={tooltipText} arrow>
        <Chip label="Grading Complete" color="success" size="small" />
      </Tooltip>
    );
  }
  
  const missingItems = [];
  if (hasResume && !hasResumeScore) missingItems.push('Resume Score');
  if (hasCoverLetter && !hasCoverLetterScore) missingItems.push('Cover Letter Score');
  if (hasVideo && !hasVideoScore) missingItems.push('Video Score');
  
  const tooltipText = `Grading Progress:
${hasResume ? (hasResumeScore ? '✓ Resume Scored' : '⏳ Resume Pending') : '✗ No Resume'}
${hasCoverLetter ? (hasCoverLetterScore ? '✓ Cover Letter Scored' : '⏳ Cover Letter Pending') : '✗ No Cover Letter'}
${hasVideo ? (hasVideoScore ? '✓ Video Scored' : '⏳ Video Pending') : '✗ No Video'}`;
  
  return (
    <Tooltip title={tooltipText} arrow>
      <Box>
        <Chip label="Grading in Progress" color="warning" size="small" sx={{ mb: 1 }} />
        <Typography variant="caption" display="block" color="text.secondary">
          Missing: {missingItems.join(', ') || 'None'}
        </Typography>
      </Box>
    </Tooltip>
  );
};

export default function Staging() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { triggerCelebration } = useCelebration();
  const isAdmin = user?.role === 'ADMIN';
  
  const [candidates, setCandidates] = useState([]);
  const [events, setEvents] = useState([]);
  const [reviewTeams, setReviewTeams] = useState([]);
  const [adminApplications, setAdminApplications] = useState([]);

  const [pagination, setPagination] = useState({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
    hasNextPage: false,
    hasPrevPage: false
  });

  const [loading, setLoading] = useState(true);
  const initialCacheRef = useRef(null);
  const [currentCycle, setCurrentCycle] = useState(null);
  const [gradingCompleteByCandidate, setGradingCompleteByCandidate] = useState({});
  const [perRoundDecisions, setPerRoundDecisions] = useState({
    resume: {},
    coffee: {},
    firstRound: {},
    final: {}
  });
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [decisionDialogOpen, setDecisionDialogOpen] = useState(false);
  const [finalDecisionDialogOpen, setFinalDecisionDialogOpen] = useState(false);
  const [currentTab, setCurrentTab] = useState(0);
  const [filters, setFilters] = useState({
    status: 'all',
    round: 'all',
    decision: 'all',
    attendance: 'all',
    reviewTeam: 'all',
    referral: 'all',
    graduationYear: 'all',
    gender: 'all',
    search: ''
  });
  const [sortConfig, setSortConfig] = useState({ field: 'score', direction: 'desc' });
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' });
  const [pushAllDialogOpen, setPushAllDialogOpen] = useState(false);
  const [pushAllConfirmText, setPushAllConfirmText] = useState('');
  const [pushAllAcknowledge, setPushAllAcknowledge] = useState(false);
  const [pushAllLoading, setPushAllLoading] = useState(false);
  const [pushAllPreview, setPushAllPreview] = useState({ 
    totalApproved: 0, 
    invalidDecisions: 0,
    invalidDecisionCandidates: []
  });
  const [demographics, setDemographics] = useState({ graduationYear: {}, gender: {}, referral: {} });
  const [appModalOpen, setAppModalOpen] = useState(false);
  const [appModalLoading, setAppModalLoading] = useState(false);
  const [appModal, setAppModal] = useState(null);
  const [interviewEvaluations, setInterviewEvaluations] = useState([]);
  const [evaluationsLoading, setEvaluationsLoading] = useState(false);
  
  const [testForNote, setTestForNote] = useState('');
  const [isEditingTestFor, setIsEditingTestFor] = useState(false);
  const [savingTestFor, setSavingTestFor] = useState(false);
  
  const [coffeeChatInterviewFilter, setCoffeeChatInterviewFilter] = useState('all');
  const [coffeeChatInterviews, setCoffeeChatInterviews] = useState([]);
  
  const [coffeeChatDecisionFilter, setCoffeeChatDecisionFilter] = useState('all');
  
  const [firstRoundInterviewFilter, setFirstRoundInterviewFilter] = useState('all');
  const [firstRoundInterviews, setFirstRoundInterviews] = useState([]);
  
  const [firstRoundDecisionFilter, setFirstRoundDecisionFilter] = useState('all');
  
  const [modalResumeScores, setModalResumeScores] = useState([]);
  const [modalCoverLetterScores, setModalCoverLetterScores] = useState([]);
  const [modalVideoScores, setModalVideoScores] = useState([]);
  const [scoresLoading, setScoresLoading] = useState(false);
  const [docPreview, setDocPreview] = useState({ open: false, src: '', kind: 'pdf', title: '' });
  
  const [finalRoundNotesModalOpen, setFinalRoundNotesModalOpen] = useState(false);
  const [finalRoundNotesLoading, setFinalRoundNotesLoading] = useState(false);
  const [finalRoundInterviewNotes, setFinalRoundInterviewNotes] = useState([]);
  const [selectedCandidateForNotes, setSelectedCandidateForNotes] = useState(null);
  
  const [editScoreModalOpen, setEditScoreModalOpen] = useState(false);
  const [editingScore, setEditingScore] = useState(null);
  const [editingScoreType, setEditingScoreType] = useState(null);
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

  // Helper to map tab index to phase name
  const tabToPhase = (tabIndex) => {
    const phaseMap = { 0: 'resume', 1: 'coffee', 2: 'firstRound', 3: 'final' };
    return phaseMap[tabIndex] || 'resume';
  };

  // Helper to get decision for current tab
  const getDecisionForTab = (appId, tabIndex) => {
    const phase = tabToPhase(tabIndex);
    return perRoundDecisions[phase]?.[appId] || '';
  };

  // Helper to check if candidate passed a round (either via decision or already advanced past it)
  const passedRound = (candidate, round) => {
    const roundNum = parseInt(candidate.currentRound) || 1;
    if (round === 'resume') {
      // Passed resume if: explicit yes decision OR already at round 2+
      return perRoundDecisions.resume[candidate.id] === 'yes' || roundNum >= 2;
    } else if (round === 'coffee') {
      // Passed coffee chat if: explicit yes decision OR already at round 3+
      return perRoundDecisions.coffee[candidate.id] === 'yes' || roundNum >= 3;
    } else if (round === 'firstRound') {
      // Passed first round if: explicit yes decision OR already at round 4+
      return perRoundDecisions.firstRound[candidate.id] === 'yes' || roundNum >= 4;
    }
    return false;
  };

  const fetchModalResumeScores = async (candidateId, cycleId) => {
    try {
      if (!candidateId) return;
      const url = cycleId 
        ? `/review-teams/resume-scores/${candidateId}?cycleId=${cycleId}`
        : `/review-teams/resume-scores/${candidateId}`;
      const scores = await apiClient.get(url);
      setModalResumeScores(scores);
    } catch (e) {
      console.error('Error fetching resume scores:', e);
      setModalResumeScores([]);
    }
  };

  const fetchModalCoverLetterScores = async (candidateId, cycleId) => {
    try {
      if (!candidateId) return;
      const url = cycleId 
        ? `/review-teams/cover-letter-scores/${candidateId}?cycleId=${cycleId}`
        : `/review-teams/cover-letter-scores/${candidateId}`;
      const scores = await apiClient.get(url);
      setModalCoverLetterScores(scores);
    } catch (e) {
      console.error('Error fetching cover letter scores:', e);
      setModalCoverLetterScores([]);
    }
  };

  const fetchModalVideoScores = async (candidateId, cycleId) => {
    try {
      if (!candidateId) return;
      const url = cycleId 
        ? `/review-teams/video-scores/${candidateId}?cycleId=${cycleId}`
        : `/review-teams/video-scores/${candidateId}`;
      const scores = await apiClient.get(url);
      setModalVideoScores(scores);
    } catch (e) {
      console.error('Error fetching video scores:', e);
      setModalVideoScores([]);
    }
  };

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
  };

  const handleSaveScore = async () => {
    try {
      setSavingScore(true);
      
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
      
      if (editingScoreType === 'resume') {
        updateData.notes = editScoreForm.notes || undefined;
      } else {
        updateData.notesOne = editScoreForm.notes || undefined;
      }
      
      await apiClient.patch(endpoint, updateData);
      
      if (appModal?.candidateId) {
        await Promise.all([
          fetchModalResumeScores(appModal.candidateId),
          fetchModalCoverLetterScores(appModal.candidateId),
          fetchModalVideoScores(appModal.candidateId)
        ]);
      }
      
      await fetchCandidates();
      
      setEditScoreModalOpen(false);
      setSnackbar({ open: true, message: 'Score updated successfully. Rankings have been updated.', severity: 'success' });
    } catch (error) {
      console.error('Error updating score:', error);
      setSnackbar({ open: true, message: 'Failed to update score', severity: 'error' });
    } finally {
      setSavingScore(false);
    }
  };

  const handleSaveTestFor = async () => {
    if (!appModal?.id) return;
    
    try {
      setSavingTestFor(true);
      await apiClient.patch(`/admin/applications/${appModal.id}/test-for`, { testFor: testForNote });
      setAppModal(prev => prev ? { ...prev, testFor: testForNote } : null);
      setIsEditingTestFor(false);
      setSnackbar({ open: true, message: 'Test For note saved successfully', severity: 'success' });
    } catch (error) {
      console.error('Error saving testFor note:', error);
      setSnackbar({ open: true, message: 'Failed to save testFor note', severity: 'error' });
    } finally {
      setSavingTestFor(false);
    }
  };

  const loadFinalRoundInterviewNotes = async (applicationId) => {
    try {
      setFinalRoundNotesLoading(true);
      setSelectedCandidateForNotes(applicationId);
      
      const notes = await apiClient.get(`/admin/applications/${applicationId}/final-round-interview-evaluations`);
      
      setFinalRoundInterviewNotes(notes);
      setFinalRoundNotesModalOpen(true);
    } catch (error) {
      console.error('Failed to load final round interview notes:', error);
      setSnackbar({ open: true, message: 'Failed to load interview notes', severity: 'error' });
    } finally {
      setFinalRoundNotesLoading(false);
    }
  };

  const [evaluationSummaries, setEvaluationSummaries] = useState({});
  const [evaluationSummariesFirstRound, setEvaluationSummariesFirstRound] = useState({});
  const [evaluationSummariesFinal, setEvaluationSummariesFinal] = useState({});

  const handlePageChange = (newPage) => {
    setPagination(prev => ({
      ...prev,
      page: newPage,
      hasNextPage: newPage < prev.totalPages,
      hasPrevPage: newPage > 1
    }));
  };

  const handleLimitChange = (newLimit) => {
    setPagination(prev => {
      const newTotalPages = Math.ceil(prev.total / newLimit);
      return {
        ...prev,
        limit: newLimit,
        page: 1,
        totalPages: newTotalPages,
        hasNextPage: 1 < newTotalPages,
        hasPrevPage: false
      };
    });
  };

  useEffect(() => {
    setPagination(prev => ({ ...prev, page: 1 }));
  }, [filters]);

  const [currentDecision, setCurrentDecision] = useState({
    candidateId: null,
    decision: '',
    notes: '',
    round: null
  });

  const [finalDecision, setFinalDecision] = useState({
    candidateId: null,
    decision: '',
    feedback: ''
  });

  const applyStagingData = useCallback((data) => {
    const candidatesData = data.candidatesData || [];

    setCandidates(candidatesData);
    setCurrentCycle(data.activeCycle);
    setAdminApplications(data.adminApplicationsData || []);
    setEvents(data.eventsData || []);
    setReviewTeams(data.reviewTeamsData || []);
    setPerRoundDecisions(data.perRoundDecisions || { resume: {}, coffee: {}, firstRound: {}, final: {} });
    setGradingCompleteByCandidate(data.gradingMap || {});

    calculateDemographics(candidatesData, false);

    setPagination(prev => ({
      ...prev,
      total: candidatesData.length,
      totalPages: Math.ceil(candidatesData.length / prev.limit),
      hasNextPage: prev.page < Math.ceil(candidatesData.length / prev.limit),
      hasPrevPage: prev.page > 1
    }));

    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- calculateDemographics is a
    // hoisted declaration in this component and only writes state.
  }, []);

  // Change token behind the snapshot currently on screen. Null until the first
  // snapshot of this mount lands, which is what makes that first poll always fetch.
  const lastChangeTokenRef = useRef(null);

  const fetchStagingData = useCallback(async (signal) => {
    const { changeToken } = await stagingAPI.fetchVersion({ signal });

    // Nothing has changed since the snapshot on screen, so skip the expensive read.
    // A null token means the server could not report one; treat that as "unknown" and
    // fetch rather than risk sitting on stale data forever.
    if (changeToken != null && changeToken === lastChangeTokenRef.current) {
      return POLL_NO_CHANGE;
    }

    const snapshot = await stagingAPI.fetchSnapshot({ signal });

    // Recorded only once the snapshot has actually arrived: recording it before would
    // let one failed snapshot fetch suppress every later one. Recording the token read
    // *before* the snapshot also means a write landing between the two reads is seen
    // again on the next poll -- one redundant fetch, never a missed change.
    lastChangeTokenRef.current = changeToken;

    const candidatesData = snapshot.candidates || [];
    const adminApplicationsData = snapshot.applications || [];

    return {
      candidatesData,
      // Database version of the transaction all six resources were read in.
      snapshotVersion: snapshot.snapshotVersion ?? null,
      activeCycle: snapshot.activeCycle,
      adminApplicationsData,
      eventsData: snapshot.events || [],
      reviewTeamsData: snapshot.reviewTeams || [],
      perRoundDecisions: snapshot.perRoundDecisions || { resume: {}, coffee: {}, firstRound: {}, final: {} },
      gradingMap: buildGradingMap(adminApplicationsData)
    };
  }, []);

  // Serve the cached snapshot for the first paint; poll from then on.
  const [pollImmediately] = useState(() => {
    const cached = stagingCache.get();
    if (!cached) return true;
    initialCacheRef.current = cached;
    return false;
  });

  // The cached snapshot is already on screen, so the poller has to treat its version as
  // applied: without this a remount would accept the first response it gets, however
  // much older than the cache it is.
  const [initialSnapshotVersion] = useState(() => initialCacheRef.current?.snapshotVersion ?? null);

  useEffect(() => {
    const cached = initialCacheRef.current;
    if (!cached) return;
    initialCacheRef.current = null;
    applyStagingData(cached);
  }, [applyStagingData]);

  const {
    status: syncStatus,
    error: syncError,
    lastSyncAt,
    metrics: syncMetrics,
    refresh: refreshStagingData
  } = usePolling({
    fetcher: fetchStagingData,
    interval: STAGING_POLL_INTERVAL_MS,
    maxInterval: STAGING_MAX_POLL_INTERVAL_MS,
    immediate: pollImmediately,
    initialVersion: initialSnapshotVersion,
    // Never apply a snapshot the server read before the one already on screen.
    getVersion: (data) => data.snapshotVersion,
    // Editing dialogs hold pending user input, so do not overwrite state underneath them.
    enabled: !appModalOpen && !decisionDialogOpen && !finalDecisionDialogOpen && !editScoreModalOpen,
    onData: (data) => {
      stagingCache.set(data);
      applyStagingData(data);
    },
    onError: (error) => {
      console.error('Staging sync failed:', error.message);
    }
  });

  useEffect(() => {
    if (syncStatus === POLL_STATUS.ERROR) setLoading(false);
  }, [syncStatus]);

  useEffect(() => {
    if (currentTab === 1 && adminApplications.length > 0) {
      const coffeeChatApps = adminApplications.filter(app => String(app.currentRound) === '2');
      if (coffeeChatApps.length > 0) {
        fetchCoffeeChatEvaluations(coffeeChatApps);
      }
    }
  }, [currentTab, adminApplications]);

  useEffect(() => {
    if (currentTab === 1) {
      fetchCoffeeChatInterviews();
    }
  }, [currentTab]);

  useEffect(() => {
    if (currentTab === 2) {
      fetchFirstRoundInterviews();
    }
  }, [currentTab]);

  useEffect(() => {
    // Calculate demographics based on per-round filtering
    if (candidates && candidates.length > 0) {
      if (currentTab === 0) {
        // Resume Review: Show ALL candidates
        calculateDemographics(candidates, false);
      } else if (currentTab === 1) {
        // Coffee Chat: Show only candidates who passed resume review
        const coffeeChatCandidates = candidates.filter(c => passedRound(c, 'resume'));
        calculateDemographics(coffeeChatCandidates, false);
      } else if (currentTab === 2) {
        // First Round: Show only candidates who passed coffee chat
        const firstRoundCandidates = candidates.filter(c => passedRound(c, 'coffee'));
        calculateDemographics(firstRoundCandidates, false);
      } else if (currentTab === 3) {
        // Final Round: Show only candidates who passed first round
        const finalRoundCandidates = candidates.filter(c => passedRound(c, 'firstRound'));
        calculateDemographics(finalRoundCandidates, false);
      }
    }
  }, [currentTab, candidates, adminApplications, perRoundDecisions]);

  useEffect(() => {
    if (currentTab === 2 && adminApplications.length > 0) {
      const firstRoundApps = (adminApplications || []).filter(app => String(app.currentRound) === '3');
      if (firstRoundApps.length > 0) {
        fetchFirstRoundEvaluations(firstRoundApps);
      }
    }
  }, [currentTab, adminApplications]);

  useEffect(() => {
    if (currentTab === 3 && adminApplications.length > 0) {
      const finalRoundApps = (adminApplications || []).filter(app => String(app.currentRound) === '4');
      if (finalRoundApps.length > 0) {
        fetchFinalRoundEvaluations(finalRoundApps);
      }
    }
  }, [currentTab, adminApplications]);

  // Kept as the page-wide "reload now" entry point: it bypasses the cache and the
  // poll schedule, cancelling any request already in flight.
  const fetchCandidates = async () => {
    stagingCache.invalidate();
    await refreshStagingData();
  };

  const calculateRankingScore = (evaluations) => {
    if (!evaluations || evaluations.length === 0) return 0;
    
    const decisionScores = {
      'YES': 4,
      'MAYBE_YES': 3,
      'UNSURE': 2,
      'MAYBE_NO': 1,
      'NO': 0
    };
    
    const evaluationsWithDecisions = evaluations.filter(evaluation => 
      evaluation.decision && 
      evaluation.decision.trim() !== '' && 
      decisionScores.hasOwnProperty(evaluation.decision)
    );
    
    if (evaluationsWithDecisions.length === 0) return 0;
    
    const totalScore = evaluationsWithDecisions.reduce((sum, evaluation) => {
      return sum + decisionScores[evaluation.decision];
    }, 0);
    
    return totalScore / evaluationsWithDecisions.length;
  };

  const calculateFirstRoundRankingScore = (evaluations) => {
    if (!evaluations || evaluations.length === 0) return 0;
    
    const evaluationsWithScores = evaluations.filter(evaluation => 
      evaluation.behavioralTotal !== null && 
      evaluation.behavioralTotal !== undefined &&
      evaluation.marketSizingTotal !== null && 
      evaluation.marketSizingTotal !== undefined
    );
    
    if (evaluationsWithScores.length === 0) {
      return calculateRankingScore(evaluations);
    }
    
    const totalBehavioral = evaluationsWithScores.reduce((sum, evaluation) => {
      return sum + (evaluation.behavioralTotal || 0);
    }, 0);
    
    const totalMarketSizing = evaluationsWithScores.reduce((sum, evaluation) => {
      return sum + (evaluation.marketSizingTotal || 0);
    }, 0);
    
    const avgBehavioral = totalBehavioral / evaluationsWithScores.length;
    const avgMarketSizing = totalMarketSizing / evaluationsWithScores.length;
    
    const combinedScore = ((avgBehavioral + avgMarketSizing) / 30) * 10;

    return combinedScore;
  };

  // Helper function to get the appropriate score based on the current tab
  const getScoreForTab = (candidate, tab) => {
    if (tab === 0) {
      // Resume Review: use document scores
      return candidate.scores?.overall || 0;
    } else if (tab === 1) {
      // Coffee Chat: use evaluation summaries
      const adminApp = adminApplications.find(app => app.id === candidate.id || app.candidateId === candidate.candidateId);
      const appId = adminApp?.id || candidate.id;
      const summary = evaluationSummaries[appId];
      if (summary?.evaluations?.length > 0) {
        return calculateRankingScore(summary.evaluations);
      }
      return 0;
    } else if (tab === 2) {
      // First Round: use first round evaluation summaries
      const adminApp = adminApplications.find(app => app.id === candidate.id || app.candidateId === candidate.candidateId);
      const appId = adminApp?.id || candidate.id;
      const summary = evaluationSummariesFirstRound[appId];
      if (summary?.evaluations?.length > 0) {
        return calculateFirstRoundRankingScore(summary.evaluations);
      }
      return 0;
    } else if (tab === 3) {
      // Final Round: use final round evaluation summaries
      const adminApp = adminApplications.find(app => app.id === candidate.id || app.candidateId === candidate.candidateId);
      const appId = adminApp?.id || candidate.id;
      const summary = evaluationSummariesFinal[appId];
      if (summary?.evaluations?.length > 0) {
        return calculateRankingScore(summary.evaluations);
      }
      return 0;
    }
    return candidate.scores?.overall || 0;
  };

  const fetchCoffeeChatInterviews = async () => {
    try {
      const interviews = await apiClient.get('/admin/interviews');
      const coffeeChatInterviews = interviews.filter(interview => 
        interview.interviewType === 'COFFEE_CHAT'
      );
      setCoffeeChatInterviews(coffeeChatInterviews);
    } catch (error) {
      console.error('Error fetching coffee chat interviews:', error);
      setCoffeeChatInterviews([]);
    }
  };

  const fetchFirstRoundInterviews = async () => {
    try {
      const interviews = await apiClient.get('/admin/interviews');
      const firstRoundInterviews = interviews.filter(interview => 
        interview.interviewType === 'ROUND_ONE'
      );
      setFirstRoundInterviews(firstRoundInterviews);
    } catch (error) {
      console.error('Error fetching first round interviews:', error);
      setFirstRoundInterviews([]);
    }
  };

  const getApplicationsForInterview = (interviewId) => {
    const interview = coffeeChatInterviews.find(i => i.id === interviewId);
    if (!interview) return [];

    let config = {};
    try {
      config = typeof interview.description === 'string' 
        ? JSON.parse(interview.description) 
        : interview.description || {};
    } catch (e) {
      console.warn('Failed to parse interview description:', e);
      return [];
    }

    const applicationIds = new Set();
    config.applicationGroups?.forEach(group => {
      group.applicationIds?.forEach(appId => applicationIds.add(appId));
    });

    return adminApplications.filter(app => applicationIds.has(app.id));
  };

  const getApplicationsForFirstRoundInterview = (interviewId) => {
    const interview = firstRoundInterviews.find(i => i.id === interviewId);
    if (!interview) return [];

    let config = {};
    try {
      config = typeof interview.description === 'string' 
        ? JSON.parse(interview.description) 
        : interview.description || {};
    } catch (e) {
      console.warn('Failed to parse interview description:', e);
      return [];
    }

    const applicationIds = new Set();
    config.applicationGroups?.forEach(group => {
      group.applicationIds?.forEach(appId => applicationIds.add(appId));
    });

    return adminApplications.filter(app => applicationIds.has(app.id));
  };

  const fetchCoffeeChatEvaluations = async (applications) => {
    try {
      const applicationIds = applications.map(app => app.id);
      const summaries = await stagingAPI.fetchEvaluationSummaries(applicationIds);

      const filteredSummaries = {};
      Object.entries(summaries || {}).forEach(([appId, summary]) => {
        const onlyCoffeeChat = (summary?.evaluations || []).filter(e => e?.interview?.interviewType === 'COFFEE_CHAT');
        filteredSummaries[appId] = { evaluations: onlyCoffeeChat };
      });

      setEvaluationSummaries(filteredSummaries);
    } catch (error) {
      console.error('Error fetching evaluation summaries:', error);
    }
  };

  const fetchFirstRoundEvaluations = async (applications) => {
    try {
      const applicationIds = applications.map(app => app.id);
      const summaries = await stagingAPI.fetchEvaluationSummaries(applicationIds);

      const filteredSummaries = {};
      Object.entries(summaries || {}).forEach(([appId, summary]) => {
        const onlyFirstRound = (summary?.evaluations || []).filter(e => e?.interview?.interviewType === 'ROUND_ONE');
        filteredSummaries[appId] = { evaluations: onlyFirstRound };
      });

      setEvaluationSummariesFirstRound(filteredSummaries);
    } catch (error) {
      console.error('Error fetching first round evaluation summaries:', error);
    }
  };

  const fetchFinalRoundEvaluations = async (applications) => {
    try {
      const applicationIds = applications.map(app => app.id);
      const summaries = await stagingAPI.fetchEvaluationSummaries(applicationIds);

      const filteredSummaries = {};
      Object.entries(summaries || {}).forEach(([appId, summary]) => {
        const onlyFinalRound = (summary?.evaluations || []).filter(e =>
          e?.interview?.interviewType === 'FINAL_ROUND' || e?.interview?.interviewType === 'ROUND_TWO'
        );
        filteredSummaries[appId] = { evaluations: onlyFinalRound };
      });

      setEvaluationSummariesFinal(filteredSummaries);
    } catch (error) {
      console.error('Error fetching final round evaluation summaries:', error);
    }
  };

  const handleDecisionSubmit = async () => {
    try {
      await stagingAPI.updateCandidateStatus(
        currentDecision.candidateId,
        currentDecision.decision,
        currentDecision.notes
      );
      
      setDecisionDialogOpen(false);
      setCurrentDecision({ candidateId: null, decision: '', notes: '', round: null });
      await fetchCandidates();
      
      setSnackbar({
        open: true,
        message: 'Decision submitted successfully',
        severity: 'success'
      });
    } catch (error) {
      console.error('Error submitting decision:', error);
      setSnackbar({
        open: true,
        message: 'Error submitting decision',
        severity: 'error'
      });
    }
  };

  const handleFinalDecisionSubmit = async () => {
    try {
      await stagingAPI.submitFinalDecision(
        finalDecision.candidateId,
        finalDecision.decision,
        finalDecision.feedback
      );
      
      setFinalDecisionDialogOpen(false);
      setFinalDecision({ candidateId: null, decision: '', feedback: '' });
      await fetchCandidates();
      
      setSnackbar({
        open: true,
        message: 'Final decision submitted successfully',
        severity: 'success'
      });
    } catch (error) {
      console.error('Error submitting final decision:', error);
      setSnackbar({
        open: true,
        message: 'Error submitting final decision',
        severity: 'error'
      });
    }
  };

  const openDecisionDialog = (candidate, round) => {
    setCurrentDecision({
      candidateId: candidate.id,
      decision: '',
      notes: '',
      round
    });
    setSelectedCandidate(candidate);
    setDecisionDialogOpen(true);
  };

  const openFinalDecisionDialog = (candidate) => {
    setFinalDecision({
      candidateId: candidate.id,
      decision: '',
      feedback: ''
    });
    setSelectedCandidate(candidate);
    setFinalDecisionDialogOpen(true);
  };

  const openPushAll = async () => {
    try {
      const adminCandidates = await stagingAPI.fetchAdminCandidates();
      const eligibleStatuses = ['SUBMITTED', 'UNDER_REVIEW', 'WAITLISTED'];
      const totalApproved = adminCandidates.filter(c => c.approved === true && eligibleStatuses.includes(c.status)).length;

      const invalidDecisions = adminCandidates.filter(c => {
        const decision = c.approved;
        return decision === null || (decision !== true && decision !== false);
      });

      setPushAllPreview({
        totalApproved,
        invalidDecisions: invalidDecisions.length,
        invalidDecisionCandidates: invalidDecisions
      });
    } catch (e) {
      console.error('Error preparing push-all preview:', e);
      setPushAllPreview({ totalApproved: 0, invalidDecisions: 0, invalidDecisionCandidates: [] });
    }
    setPushAllConfirmText('');
    setPushAllAcknowledge(false);
    setPushAllDialogOpen(true);
  };

  const openPushAllCoffee = async () => {
    try {
      // Coffee Chat tab: candidates who passed resume review
      const coffeeCandidates = candidates.filter(c => passedRound(c, 'resume'));

      const invalidDecisions = coffeeCandidates.filter(c => {
        const decision = perRoundDecisions.coffee[c.id];
        return !decision || (decision !== 'yes' && decision !== 'no');
      });

      setPushAllPreview({
        totalApproved: coffeeCandidates.length,
        invalidDecisions: invalidDecisions.length,
        invalidDecisionCandidates: invalidDecisions
      });
    } catch (e) {
      console.error('Error preparing coffee chat push-all preview:', e);
      setPushAllPreview({ totalApproved: 0, invalidDecisions: 0, invalidDecisionCandidates: [] });
    }
    setPushAllConfirmText('');
    setPushAllAcknowledge(false);
    setPushAllDialogOpen(true);
  };

  const openPushAllFirstRound = async () => {
    try {
      // First Round tab: candidates who passed coffee chat
      const firstRoundCandidates = candidates.filter(c => passedRound(c, 'coffee'));

      const invalidDecisions = firstRoundCandidates.filter(c => {
        const decision = perRoundDecisions.firstRound[c.id];
        return !decision || (decision !== 'yes' && decision !== 'no');
      });

      setPushAllPreview({
        totalCandidates: firstRoundCandidates.length,
        validDecisions: firstRoundCandidates.length - invalidDecisions.length,
        invalidDecisions: invalidDecisions.length,
        invalidDecisionCandidates: invalidDecisions
      });

      setPushAllConfirmText('');
      setPushAllAcknowledge(false);
      setPushAllDialogOpen(true);
    } catch (error) {
      console.error('Error preparing first round push all:', error);
      setSnackbar({ open: true, message: 'Failed to prepare first round processing', severity: 'error' });
    }
  };

  const openPushAllFinal = async () => {
    try {
      // Final Round tab: candidates who passed first round
      const finalCandidates = candidates.filter(c => passedRound(c, 'firstRound'));

      const invalidDecisions = finalCandidates.filter(c => {
        const decision = perRoundDecisions.final[c.id];
        return !decision || (decision !== 'yes' && decision !== 'no');
      });

      setPushAllPreview({
        totalApproved: finalCandidates.length,
        invalidDecisions: invalidDecisions.length,
        invalidDecisionCandidates: invalidDecisions
      });
    } catch (e) {
      console.error('Error preparing final round push-all preview:', e);
      setPushAllPreview({ totalApproved: 0, invalidDecisions: 0, invalidDecisionCandidates: [] });
    }
    setPushAllConfirmText('');
    setPushAllAcknowledge(false);
    setPushAllDialogOpen(true);
  };

  const confirmPushAll = async () => {
    try {
      setPushAllLoading(true);

      let result;
      if (currentTab === 1) {
        result = await stagingAPI.processCoffeeDecisions();
      } else if (currentTab === 2) {
        result = await stagingAPI.processFirstRoundDecisions();
      } else if (currentTab === 3) {
        result = await stagingAPI.processFinalDecisions();
      } else {
        result = await stagingAPI.processDecisions();
      }

      setPushAllDialogOpen(false);

      const { summary } = result;
      if (summary) {
        const emailMessage = currentTab === 0 ? 'No emails sent (resume review round)' :
                           currentTab === 1 ? 'No emails sent (coffee chat round)' :
                           currentTab === 2 ? 'No emails sent (first round)' :
                           `${summary.emailsSent} emails sent`;
        setSnackbar({
          open: true,
          message: `Successfully processed ${summary.totalApplications} candidates: ${summary.accepted} accepted, ${summary.rejected} rejected. ${emailMessage}.`,
          severity: 'success'
        });
      } else {
        setSnackbar({ open: true, message: 'Processed decisions.', severity: 'success' });
      }

      if (currentTab === 3) {
        triggerCelebration('deliberations-completed');
      }

      await fetchCandidates();

    } catch (e) {
      console.error('Error processing decisions:', e);
      setSnackbar({ open: true, message: 'Failed to process decisions', severity: 'error' });
    } finally {
      setPushAllLoading(false);
    }
  };

  const fixInvalidDecision = async (candidateId, newDecision) => {
    try {
      await stagingAPI.saveDecision(candidateId, newDecision, 'resume');

      setPushAllPreview(prev => ({
        ...prev,
        invalidDecisions: prev.invalidDecisions - 1,
        invalidDecisionCandidates: prev.invalidDecisionCandidates.filter(c => c.id !== candidateId)
      }));

      await fetchCandidates();

      setSnackbar({ open: true, message: 'Decision updated successfully', severity: 'success' });
    } catch (error) {
      console.error('Error fixing invalid decision:', error);
      setSnackbar({ open: true, message: 'Failed to update decision', severity: 'error' });
    }
  };

  // Function declaration, not a const: applyStagingData above calls it during the
  // first render's data apply, which a const in this position would not have
  // initialised yet.
  function calculateDemographics(data, isApplicationData = false) {
    const graduationYearBreakdown = Object.fromEntries(
      GRADUATION_YEARS.map((year) => [year, { total: 0, yes: 0, no: 0, maybe: 0, pending: 0 }])
    );
    
    const genderBreakdown = {
      'Male': { total: 0, yes: 0, no: 0, maybe: 0, pending: 0 },
      'Female': { total: 0, yes: 0, no: 0, maybe: 0, pending: 0 },
      'Other/Prefer not to say': { total: 0, yes: 0, no: 0, maybe: 0, pending: 0 }
    };
    
    const referralBreakdown = {
      'Yes': { total: 0, yes: 0, no: 0, maybe: 0, pending: 0 },
      'No': { total: 0, yes: 0, no: 0, maybe: 0, pending: 0 }
    };

    data.forEach((item) => {
      const candidate = isApplicationData ? item.candidate : item;
      
      if (!isApplicationData && !candidate) return;
      
      let year, gender, hasReferral;
      if (isApplicationData) {
        year = item.year || item.graduationYear;
        gender = item.gender;
        hasReferral = item.hasReferral;
      } else {
        year = candidate.graduationYear;
        gender = candidate.gender;
        hasReferral = candidate.hasReferral;
      }
      
      if (!year || !GRADUATION_YEARS.includes(year)) {
        year = 'Other';
      }
      if (!graduationYearBreakdown[year]) {
        graduationYearBreakdown[year] = { total: 0, yes: 0, no: 0, maybe: 0, pending: 0 };
      }
      graduationYearBreakdown[year].total++;
      
      let decision = '';
      if (isApplicationData) {
        decision = getDecisionForTab(item.id, currentTab) || (item.approved === true ? 'yes' : item.approved === false ? 'no' : '');
      } else {
        decision = getDecisionForTab(candidate.id, currentTab) || '';
      }
      
      if (decision === 'yes') graduationYearBreakdown[year].yes++;
      else if (decision === 'no') graduationYearBreakdown[year].no++;
      else if (decision === 'maybe_yes' || decision === 'maybe_no') graduationYearBreakdown[year].maybe++;
      else graduationYearBreakdown[year].pending++;
      
      if (!gender) gender = 'Other/Prefer not to say';
      else if (gender.toLowerCase().includes('female')) gender = 'Female';
      else if (gender.toLowerCase().includes('male')) gender = 'Male';
      else gender = 'Other/Prefer not to say';
      
      genderBreakdown[gender].total++;
      if (decision === 'yes') genderBreakdown[gender].yes++;
      else if (decision === 'no') genderBreakdown[gender].no++;
      else if (decision === 'maybe_yes' || decision === 'maybe_no') genderBreakdown[gender].maybe++;
      else genderBreakdown[gender].pending++;

      const referralKey = hasReferral ? 'Yes' : 'No';
      referralBreakdown[referralKey].total++;
      if (decision === 'yes') referralBreakdown[referralKey].yes++;
      else if (decision === 'no') referralBreakdown[referralKey].no++;
      else if (decision === 'maybe_yes' || decision === 'maybe_no') referralBreakdown[referralKey].maybe++;
      else referralBreakdown[referralKey].pending++;
    });
    
    setDemographics({ graduationYear: graduationYearBreakdown, gender: genderBreakdown, referral: referralBreakdown });
  }

  const handleInlineDecisionChange = async (item, value, tabIndex = currentTab) => {
    const phase = tabToPhase(tabIndex);
    try {
      await stagingAPI.saveDecision(item.id, value, phase);
      setPerRoundDecisions(prev => ({
        ...prev,
        [phase]: { ...prev[phase], [item.id]: value }
      }));
      setSnackbar({ open: true, message: 'Decision saved successfully', severity: 'success' });
      await fetchCandidates();
    } catch (error) {
      console.error('Error saving inline decision:', error);
      setSnackbar({ open: true, message: 'Failed to save decision', severity: 'error' });
    }
  };

  const handleExportDecisions = () => {
    const dataSource = adminApplications || [];
    
    if (dataSource.length === 0) {
      setSnackbar({ open: true, message: 'No candidate data available to export', severity: 'warning' });
      return;
    }
    
    let roundFilteredData = dataSource;
    let roundName = 'All Rounds';

    // Filter based on previous round decisions (or currentRound for backward compatibility)
    if (currentTab === 0) {
      // Resume Review: Show ALL applicants
      roundFilteredData = dataSource;
      roundName = 'Resume Review';
    } else if (currentTab === 1) {
      // Coffee Chat: Show only applicants who passed resume review
      roundFilteredData = dataSource.filter(app => passedRound(app, 'resume'));
      roundName = 'Coffee Chat';
    } else if (currentTab === 2) {
      // First Round: Show only applicants who passed coffee chat
      roundFilteredData = dataSource.filter(app => passedRound(app, 'coffee'));
      roundName = 'First Round';
    } else if (currentTab === 3) {
      // Final Round: Show only applicants who passed first round
      roundFilteredData = dataSource.filter(app => passedRound(app, 'firstRound'));
      roundName = 'Final Round';
    }
    
    if (roundFilteredData.length === 0) {
      setSnackbar({ open: true, message: `No candidates found in ${roundName} round`, severity: 'warning' });
      return;
    }
    
    const exportDialog = window.confirm(
      `Export ${roundName} Decisions:\n\nOK = Only candidates with Yes/No decisions\nCancel = All candidates`
    );
    
    let candidatesToExport = roundFilteredData;
    if (exportDialog) {
      candidatesToExport = roundFilteredData.filter(app => {
        const decision = getDecisionForTab(app.id, currentTab);
        return decision === 'yes' || decision === 'no';
      });
    }

    const csvHeaders = ['Name', 'Email', 'Student ID', 'Decision', 'Grad Year', 'Gender', 'Referral'];
    const csvRows = candidatesToExport.map(app => {
      const name = `${app.firstName || ''} ${app.lastName || ''}`.trim();
      const email = app.email || '';
      const studentId = app.studentId || '';
      const roundDecision = getDecisionForTab(app.id, currentTab);
      const decision = roundDecision === 'yes' ? 'Yes' : roundDecision === 'no' ? 'No' : 'Pending';
      const gradYear = app.graduationYear || app.year || '';
      const gender = app.gender || '';
      const referral = app.hasReferral ? 'Yes' : 'No';

      return [name, email, studentId, decision, gradYear, gender, referral];
    });
    
    const csvContent = [csvHeaders, ...csvRows]
      .map(row => row.map(field => `"${(field || '').toString().replace(/"/g, '""')}"`).join(','))
      .join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `${roundName.replace(' ', '_')}_decisions_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    setSnackbar({ open: true, message: `Exported ${candidatesToExport.length} candidates`, severity: 'success' });
  };

  // First, filter candidates based on which tab we're on (previous round decisions)
  const tabFilteredCandidates = candidates.filter(candidate => {
    if (currentTab === 0) {
      // Resume Review: Show ALL applicants
      return true;
    } else if (currentTab === 1) {
      // Coffee Chat: Show only applicants who passed resume review
      return passedRound(candidate, 'resume');
    } else if (currentTab === 2) {
      // First Round: Show only applicants who passed coffee chat
      return passedRound(candidate, 'coffee');
    } else if (currentTab === 3) {
      // Final Round: Show only applicants who passed first round
      return passedRound(candidate, 'firstRound');
    }
    return true;
  });

  const filteredCandidates = tabFilteredCandidates.filter(candidate => {
    const matchesStatus = filters.status === 'all' || candidate.status === filters.status;
    const matchesRound = filters.round === 'all' || parseInt(candidate.currentRound) === parseInt(filters.round);

    let matchesDecision = true;
    if (filters.decision !== 'all') {
      const candidateDecision = getDecisionForTab(candidate.id, currentTab);
      if (filters.decision === 'pending') {
        matchesDecision = candidateDecision === '';
      } else {
        matchesDecision = candidateDecision === filters.decision;
      }
    }
    
    let matchesAttendance = true;
    if (filters.attendance !== 'all' && events.length > 0) {
      const totalEvents = events.length;
      const attendedEvents = events.filter(event => {
        const eventName = event.eventName || event.name || event.id;
        if (!candidate.attendance || !eventName) return false;
        
        if (candidate.attendance[eventName] !== undefined) {
          return Boolean(candidate.attendance[eventName]);
        }
        
        const attendanceKeys = Object.keys(candidate.attendance);
        const matchingKey = attendanceKeys.find(key => 
          key.toLowerCase() === eventName.toLowerCase() ||
          key.toLowerCase().includes(eventName.toLowerCase()) || 
          eventName.toLowerCase().includes(key.toLowerCase())
        );
        return matchingKey !== undefined ? Boolean(candidate.attendance[matchingKey]) : false;
      }).length;
      const attendancePercentage = totalEvents > 0 ? Math.round((attendedEvents / totalEvents) * 100) : 0;
      
      switch (filters.attendance) {
        case 'high':
          matchesAttendance = attendancePercentage >= 80;
          break;
        case 'medium':
          matchesAttendance = attendancePercentage >= 60 && attendancePercentage < 80;
          break;
        case 'low':
          matchesAttendance = attendancePercentage >= 40 && attendancePercentage < 60;
          break;
        case 'very_low':
          matchesAttendance = attendancePercentage < 40;
          break;
        case 'none':
          matchesAttendance = attendedEvents === 0;
          break;
        default:
          matchesAttendance = true;
      }
    }
    
    let matchesReviewTeam = true;
    if (filters.reviewTeam !== 'all') {
      if (filters.reviewTeam === 'unassigned') {
        matchesReviewTeam = !candidate.reviewTeam;
      } else {
        matchesReviewTeam = candidate.reviewTeam && candidate.reviewTeam.id === filters.reviewTeam;
      }
    }
    
    let matchesReferral = true;
    if (filters.referral !== 'all') {
      if (filters.referral === 'yes') {
        matchesReferral = candidate.hasReferral === true;
      } else if (filters.referral === 'no') {
        matchesReferral = candidate.hasReferral === false;
      }
    }
    
    const matchesSearch = filters.search === '' ||
      `${candidate.firstName} ${candidate.lastName}`.toLowerCase().includes(filters.search.toLowerCase()) ||
      candidate.email.toLowerCase().includes(filters.search.toLowerCase());

    let matchesGraduationYear = true;
    if (filters.graduationYear !== 'all') {
      matchesGraduationYear = candidate.graduationYear === filters.graduationYear;
    }

    let matchesGender = true;
    if (filters.gender !== 'all') {
      const candidateGender = candidate.gender?.toLowerCase() || '';
      if (filters.gender === 'male') {
        matchesGender = candidateGender.includes('male') && !candidateGender.includes('female');
      } else if (filters.gender === 'female') {
        matchesGender = candidateGender.includes('female');
      } else if (filters.gender === 'other') {
        matchesGender = !candidateGender.includes('male') && !candidateGender.includes('female');
      }
    }

    // Coffee Chat Interview Filter - only applies when on coffee chat tab (tab 1)
    let matchesInterview = true;
    if (currentTab === 1 && coffeeChatInterviewFilter !== 'all') {
      const interviewApplications = getApplicationsForInterview(coffeeChatInterviewFilter);
      const applicationIds = new Set(interviewApplications.map(app => app.id));
      matchesInterview = applicationIds.has(candidate.id);
    }

    return matchesStatus && matchesRound && matchesDecision && matchesAttendance && matchesReviewTeam && matchesReferral && matchesSearch && matchesGraduationYear && matchesGender && matchesInterview;
  }).sort((a, b) => {
    const multiplier = sortConfig.direction === 'asc' ? 1 : -1;

    switch (sortConfig.field) {
      case 'score': {
        // desc = high scores first (default), asc = low scores first
        const diff = getScoreForTab(a, currentTab) - getScoreForTab(b, currentTab);
        return multiplier * diff;
      }
      case 'name': {
        // asc = A-Z (default for name), desc = Z-A
        const diff = `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`);
        return multiplier * diff;
      }
      case 'graduationYear': {
        // asc = 2026 first, desc = 2029 first
        const diff = (a.graduationYear || '').localeCompare(b.graduationYear || '');
        return multiplier * diff;
      }
      case 'decision': {
        // desc = Yes first (default), asc = Pending first
        const decisionOrder = { 'yes': 1, 'maybe_yes': 2, 'maybe_no': 3, 'no': 4, '': 5 };
        const aDecision = getDecisionForTab(a.id, currentTab);
        const bDecision = getDecisionForTab(b.id, currentTab);
        const diff = (decisionOrder[aDecision] || 5) - (decisionOrder[bDecision] || 5);
        return multiplier * diff;
      }
      case 'attendance': {
        // desc = high attendance first (default), asc = low attendance first
        const getAttendanceCount = (candidate) => {
          if (!candidate.attendance || events.length === 0) return 0;
          return events.filter(event => {
            const eventName = event.eventName || event.name || event.id;
            return candidate.attendance[eventName] !== undefined ? Boolean(candidate.attendance[eventName]) : false;
          }).length;
        };
        const diff = getAttendanceCount(a) - getAttendanceCount(b);
        return multiplier * diff;
      }
      case 'referral': {
        // desc = referred first (default), asc = non-referred first
        const aRef = a.hasReferral ? 1 : 0;
        const bRef = b.hasReferral ? 1 : 0;
        const diff = aRef - bRef;
        return multiplier * diff;
      }
      default: {
        const diff = getScoreForTab(a, currentTab) - getScoreForTab(b, currentTab);
        return multiplier * diff;
      }
    }
  });

  const paginatedCandidates = filteredCandidates.slice(
    (pagination.page - 1) * pagination.limit,
    pagination.page * pagination.limit
  );

  const syncedAtLabel = lastSyncAt ? lastSyncAt.toLocaleTimeString() : 'never';
  const syncStatusLabel = {
    [POLL_STATUS.ERROR]: 'Sync failing — retrying',
    [POLL_STATUS.PAUSED]: 'Sync paused',
    [POLL_STATUS.LIVE]: `Synced ${syncedAtLabel}`
  }[syncStatus] || 'Syncing…';
  const syncStatusTooltip = [
    `Checks for changes every ${Math.round(STAGING_POLL_INTERVAL_MS / 1000)}s while this tab is visible`,
    `Last synced: ${syncedAtLabel}`,
    `Checks: ${syncMetrics.requests} · unchanged: ${syncMetrics.unchanged} · failures: ${syncMetrics.failures} · stale responses dropped: ${syncMetrics.discarded}`,
    syncMetrics.lastLatencyMs != null ? `Last latency: ${syncMetrics.lastLatencyMs}ms` : null,
    syncError ? `Last error: ${syncError.message}` : null
  ].filter(Boolean).join('\n');

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <Box className="staging-page" sx={{ p: 3 }}>
          <Box mb={3} display="flex" alignItems="center" justifyContent="space-between">
            <Box>
              <Typography variant="h4" gutterBottom sx={{ fontWeight: 700, color: 'text.primary' }}>
                Candidate Staging
              </Typography>
              <Typography variant="body1" color="text.secondary">
                Review candidates, track attendance, evaluate scores, and make decisions
              </Typography>
            </Box>
            <Box display="flex" alignItems="center" gap={2}>
              <Tooltip title={syncStatusTooltip}>
                <Chip
                  size="small"
                  variant="outlined"
                  color={syncStatus === POLL_STATUS.ERROR ? 'error' : syncStatus === POLL_STATUS.PAUSED ? 'default' : 'success'}
                  label={syncStatusLabel}
                />
              </Tooltip>
              <Tooltip title="Refresh now">
                <IconButton onClick={fetchCandidates} aria-label="Refresh staging data">
                  <RefreshIcon />
                </IconButton>
              </Tooltip>
              <Button
                variant="outlined"
                startIcon={<DownloadIcon />}
                onClick={handleExportDecisions}
              >
                Export Decisions
              </Button>
              <Chip 
                label={currentCycle ? `Current Cycle: ${currentCycle.name}` : 'No Active Cycle'}
                color={currentCycle ? 'primary' : 'default'}
              />
            </Box>
          </Box>

          <Card sx={{ mb: 3 }}>
            <CardContent>
              <Tabs value={currentTab} onChange={(e, v) => { setCurrentTab(v); setCoffeeChatInterviewFilter('all'); }}>
                <Tab label="Resume Review" />
                <Tab label="Coffee Chats" />
                <Tab label="First Round" />
                <Tab label="Final Round" />
              </Tabs>
            </CardContent>
          </Card>

          {/* Improved Demographics Section */}
          <Card sx={{ mb: 4 }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                📊 Demographics Overview ({currentTab === 0 ? 'Resume Review' : currentTab === 1 ? 'Coffee Chat' : currentTab === 2 ? 'First Round' : 'Final Round'} Round)
              </Typography>
              
              <Grid container spacing={4}>
                <Grid item xs={12} md={4}>
                  <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 'bold' }}>
                    Graduation Year
                  </Typography>
                  <Stack spacing={1.5}>
                    {Object.entries(demographics.graduationYear).map(([year, stats]) => {
                      const totalApps = Object.values(demographics.graduationYear).reduce((sum, s) => sum + s.total, 0);
                      const pct = totalApps > 0 ? ((stats.total / totalApps) * 100).toFixed(1) : 0;
                      const yesPct = stats.total > 0 ? ((stats.yes / stats.total) * 100).toFixed(1) : 0;
                      const noPct = stats.total > 0 ? ((stats.no / stats.total) * 100).toFixed(1) : 0;
                      return (
                        <Box key={year} sx={{ p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper' }}>
                          <Typography variant="body1" fontWeight="bold">
                            Class of {year} ({stats.total} • {pct}%)
                          </Typography>
                          <Stack direction="row" spacing={1} mt={1} flexWrap="wrap" gap={1}>
                            <Chip label={`Yes: ${stats.yes} (${yesPct}%)`} color="success" size="small" />
                            <Chip label={`No: ${stats.no} (${noPct}%)`} color="error" size="small" />
                            <Chip label={`Maybe: ${stats.maybe}`} color="warning" size="small" />
                            <Chip label={`Pending: ${stats.pending}`} size="small" />
                          </Stack>
                        </Box>
                      );
                    })}
                  </Stack>
                </Grid>

                <Grid item xs={12} md={4}>
                  <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 'bold' }}>
                    Gender
                  </Typography>
                  <Stack spacing={1.5}>
                    {Object.entries(demographics.gender).map(([gender, stats]) => {
                      const totalApps = Object.values(demographics.gender).reduce((sum, s) => sum + s.total, 0);
                      const pct = totalApps > 0 ? ((stats.total / totalApps) * 100).toFixed(1) : 0;
                      const yesPct = stats.total > 0 ? ((stats.yes / stats.total) * 100).toFixed(1) : 0;
                      const noPct = stats.total > 0 ? ((stats.no / stats.total) * 100).toFixed(1) : 0;
                      return (
                        <Box key={gender} sx={{ p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper' }}>
                          <Typography variant="body1" fontWeight="bold">
                            {gender} ({stats.total} • {pct}%)
                          </Typography>
                          <Stack direction="row" spacing={1} mt={1} flexWrap="wrap" gap={1}>
                            <Chip label={`Yes: ${stats.yes} (${yesPct}%)`} color="success" size="small" />
                            <Chip label={`No: ${stats.no} (${noPct}%)`} color="error" size="small" />
                            <Chip label={`Maybe: ${stats.maybe}`} color="warning" size="small" />
                            <Chip label={`Pending: ${stats.pending}`} size="small" />
                          </Stack>
                        </Box>
                      );
                    })}
                  </Stack>
                </Grid>

                <Grid item xs={12} md={4}>
                  <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 'bold' }}>
                    Referral Status
                  </Typography>
                  <Stack spacing={1.5}>
                    {Object.entries(demographics.referral).map(([ref, stats]) => {
                      const totalApps = Object.values(demographics.referral).reduce((sum, s) => sum + s.total, 0);
                      const pct = totalApps > 0 ? ((stats.total / totalApps) * 100).toFixed(1) : 0;
                      const yesPct = stats.total > 0 ? ((stats.yes / stats.total) * 100).toFixed(1) : 0;
                      const noPct = stats.total > 0 ? ((stats.no / stats.total) * 100).toFixed(1) : 0;
                      return (
                        <Box key={ref} sx={{ p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper' }}>
                          <Typography variant="body1" fontWeight="bold">
                            Referred: {ref} ({stats.total} • {pct}%)
                          </Typography>
                          <Stack direction="row" spacing={1} mt={1} flexWrap="wrap" gap={1}>
                            <Chip label={`Yes: ${stats.yes} (${yesPct}%)`} color="success" size="small" />
                            <Chip label={`No: ${stats.no} (${noPct}%)`} color="error" size="small" />
                            <Chip label={`Maybe: ${stats.maybe}`} color="warning" size="small" />
                            <Chip label={`Pending: ${stats.pending}`} size="small" />
                          </Stack>
                        </Box>
                      );
                    })}
                  </Stack>
                </Grid>
              </Grid>
            </CardContent>
          </Card>

          {/* Main Table */}
          <Card>
            <CardContent>
              <Box mb={2} display="flex" justifyContent="space-between" alignItems="center">
                <Typography variant="body2" color="text.secondary">
                  {currentTab === 0 && '⚠️ All candidates must have a "Yes" or "No" decision. "Yes" advances to Coffee Chats (no email), "No" marks as rejected (no email).'}
                  {currentTab === 1 && '⚠️ All candidates must have a "Yes" or "No" decision. "Yes" advances to First Round (no email), "No" marks as rejected (no email).'}
                  {currentTab === 2 && '⚠️ All candidates must have a "Yes" or "No" decision. "Yes" advances to Final Round (no email), "No" marks as rejected (no email).'}
                  {currentTab === 3 && '⚠️ All candidates must have a "Yes" or "No" decision. This will send emails and finalize decisions.'}
                </Typography>
                <Button
                  variant="contained"
                  color="primary"
                  startIcon={<SkipNextIcon />}
                  onClick={currentTab === 0 ? openPushAll : currentTab === 1 ? openPushAllCoffee : currentTab === 2 ? openPushAllFirstRound : openPushAllFinal}
                >
                  Process All Decisions
                </Button>
              </Box>

              {/* Filters and Sorting */}
              <Box sx={{ mb: 3, p: 2, bgcolor: 'grey.50', borderRadius: 2 }}>
                <Box display="flex" alignItems="center" gap={1} mb={2}>
                  <FilterListIcon color="action" />
                  <Typography variant="subtitle2" fontWeight="bold">Filters & Sorting</Typography>
                  <Chip
                    label={`${filteredCandidates.length} candidates`}
                    size="small"
                    color="primary"
                    sx={{ ml: 1 }}
                  />
                  {(filters.decision !== 'all' || filters.graduationYear !== 'all' || filters.gender !== 'all' || filters.attendance !== 'all' || filters.referral !== 'all' || filters.reviewTeam !== 'all' || filters.search !== '' || (currentTab === 1 && coffeeChatInterviewFilter !== 'all')) && (
                    <Button
                      size="small"
                      startIcon={<ClearIcon />}
                      onClick={() => {
                        setFilters({
                          ...filters,
                          decision: 'all',
                          graduationYear: 'all',
                          gender: 'all',
                          attendance: 'all',
                          referral: 'all',
                          reviewTeam: 'all',
                          search: ''
                        });
                        setCoffeeChatInterviewFilter('all');
                      }}
                      sx={{ ml: 'auto' }}
                    >
                      Clear Filters
                    </Button>
                  )}
                </Box>

                <Grid container spacing={2} alignItems="center">
                  {/* Search */}
                  <Grid item xs={12} md={3}>
                    <TextField
                      size="small"
                      fullWidth
                      placeholder="Search by name or email..."
                      value={filters.search}
                      onChange={(e) => setFilters({ ...filters, search: e.target.value })}
                      InputProps={{
                        startAdornment: <SearchIcon color="action" sx={{ mr: 1 }} />
                      }}
                    />
                  </Grid>

                  {/* Decision Filter */}
                  <Grid item xs={6} md={2}>
                    <FormControl size="small" fullWidth>
                      <InputLabel>Decision</InputLabel>
                      <Select
                        value={filters.decision}
                        label="Decision"
                        onChange={(e) => setFilters({ ...filters, decision: e.target.value })}
                      >
                        <MenuItem value="all">All Decisions</MenuItem>
                        <MenuItem value="yes">Yes</MenuItem>
                        <MenuItem value="maybe_yes">Maybe Yes</MenuItem>
                        <MenuItem value="maybe_no">Maybe No</MenuItem>
                        <MenuItem value="no">No</MenuItem>
                        <MenuItem value="pending">Pending</MenuItem>
                      </Select>
                    </FormControl>
                  </Grid>

                  {/* Graduation Year Filter */}
                  <Grid item xs={6} md={2}>
                    <FormControl size="small" fullWidth>
                      <InputLabel>Grad Year</InputLabel>
                      <Select
                        value={filters.graduationYear}
                        label="Grad Year"
                        onChange={(e) => setFilters({ ...filters, graduationYear: e.target.value })}
                      >
                        <MenuItem value="all">All Years</MenuItem>
                        {GRADUATION_YEARS.map((year) => (
                          <MenuItem key={year} value={year}>{year}</MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </Grid>

                  {/* Gender Filter */}
                  <Grid item xs={6} md={2}>
                    <FormControl size="small" fullWidth>
                      <InputLabel>Gender</InputLabel>
                      <Select
                        value={filters.gender}
                        label="Gender"
                        onChange={(e) => setFilters({ ...filters, gender: e.target.value })}
                      >
                        <MenuItem value="all">All Genders</MenuItem>
                        <MenuItem value="male">Male</MenuItem>
                        <MenuItem value="female">Female</MenuItem>
                        <MenuItem value="other">Other/Not Specified</MenuItem>
                      </Select>
                    </FormControl>
                  </Grid>

                  {/* Attendance Filter */}
                  <Grid item xs={6} md={2}>
                    <FormControl size="small" fullWidth>
                      <InputLabel>Attendance</InputLabel>
                      <Select
                        value={filters.attendance}
                        label="Attendance"
                        onChange={(e) => setFilters({ ...filters, attendance: e.target.value })}
                      >
                        <MenuItem value="all">All Attendance</MenuItem>
                        <MenuItem value="high">High (80%+)</MenuItem>
                        <MenuItem value="medium">Medium (60-79%)</MenuItem>
                        <MenuItem value="low">Low (40-59%)</MenuItem>
                        <MenuItem value="very_low">Very Low (&lt;40%)</MenuItem>
                        <MenuItem value="none">No Events</MenuItem>
                      </Select>
                    </FormControl>
                  </Grid>

                  {/* Referral Filter */}
                  <Grid item xs={6} md={2}>
                    <FormControl size="small" fullWidth>
                      <InputLabel>Referral</InputLabel>
                      <Select
                        value={filters.referral}
                        label="Referral"
                        onChange={(e) => setFilters({ ...filters, referral: e.target.value })}
                      >
                        <MenuItem value="all">All</MenuItem>
                        <MenuItem value="yes">Has Referral</MenuItem>
                        <MenuItem value="no">No Referral</MenuItem>
                      </Select>
                    </FormControl>
                  </Grid>

                  {/* Review Team Filter */}
                  <Grid item xs={6} md={2}>
                    <FormControl size="small" fullWidth>
                      <InputLabel>Review Team</InputLabel>
                      <Select
                        value={filters.reviewTeam}
                        label="Review Team"
                        onChange={(e) => setFilters({ ...filters, reviewTeam: e.target.value })}
                        renderValue={(selected) => {
                          if (selected === 'all') return 'All Teams';
                          if (selected === 'unassigned') return 'Unassigned';
                          const selectedTeam = reviewTeams.find(team => team.id === selected);
                          return selectedTeam ? selectedTeam.name : selected;
                        }}
                      >
                        <MenuItem value="all">All Teams</MenuItem>
                        <MenuItem value="unassigned">Unassigned</MenuItem>
                        {reviewTeams.map((team) => (
                          <MenuItem key={team.id} value={team.id}>
                            {team.name}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </Grid>

                  {/* Coffee Chat Interview Filter - Only shown on Coffee Chat tab */}
                  {currentTab === 1 && (
                    <Grid item xs={6} md={2}>
                      <FormControl size="small" fullWidth>
                        <InputLabel>Interview</InputLabel>
                        <Select
                          value={coffeeChatInterviewFilter}
                          label="Interview"
                          onChange={(e) => setCoffeeChatInterviewFilter(e.target.value)}
                          renderValue={(selected) => {
                            if (selected === 'all') return 'All Interviews';
                            const selectedInterview = coffeeChatInterviews.find(i => i.id === selected);
                            return selectedInterview ? selectedInterview.title : selected;
                          }}
                        >
                          <MenuItem value="all">All Interviews</MenuItem>
                          {coffeeChatInterviews.map((interview) => (
                            <MenuItem key={interview.id} value={interview.id}>
                              {interview.title}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    </Grid>
                  )}
                </Grid>

                {/* Sorting Row */}
                <Box display="flex" alignItems="center" gap={2} mt={2}>
                  <Box display="flex" alignItems="center" gap={1}>
                    <SortIcon color="action" fontSize="small" />
                    <Typography variant="body2" color="text.secondary">Sort by:</Typography>
                  </Box>
                  <Stack direction="row" spacing={1}>
                    {[
                      { field: 'score', label: 'Score' },
                      { field: 'name', label: 'Name' },
                      { field: 'graduationYear', label: 'Grad Year' },
                      { field: 'decision', label: 'Decision' },
                      { field: 'attendance', label: 'Attendance' },
                      { field: 'referral', label: 'Referral' }
                    ].map(({ field, label }) => (
                      <Chip
                        key={field}
                        label={
                          <Box display="flex" alignItems="center" gap={0.5}>
                            {label}
                            {sortConfig.field === field && (
                              sortConfig.direction === 'desc' ? <ArrowDownwardIcon fontSize="small" /> : <ArrowUpwardIcon fontSize="small" />
                            )}
                          </Box>
                        }
                        onClick={() => {
                          if (sortConfig.field === field) {
                            setSortConfig({ field, direction: sortConfig.direction === 'desc' ? 'asc' : 'desc' });
                          } else {
                            setSortConfig({ field, direction: 'desc' });
                          }
                        }}
                        color={sortConfig.field === field ? 'primary' : 'default'}
                        variant={sortConfig.field === field ? 'filled' : 'outlined'}
                        size="small"
                        sx={{ cursor: 'pointer' }}
                      />
                    ))}
                  </Stack>
                </Box>
              </Box>

              <TableContainer component={Paper} className="responsive-table">
                <Table stickyHeader sx={{ tableLayout: { xs: 'auto', md: 'fixed' }, minWidth: { xs: 'auto', md: 900 } }}>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ width: { xs: 'auto', md: 220 } }}>Candidate</TableCell>
                      <TableCell sx={{ width: { xs: 'auto', md: 100 } }}>Score</TableCell>
                      <TableCell sx={{ width: { xs: 'auto', md: 150 } }}>Grading</TableCell>
                      <TableCell sx={{ width: { xs: 'auto', md: 180 } }}>Attendance</TableCell>
                      <TableCell sx={{ width: { xs: 'auto', md: 140 } }}>Decision</TableCell>
                      <TableCell sx={{ width: { xs: 'auto', md: 110 } }}>Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {paginatedCandidates.map((candidate) => {
                      const gradingData = gradingCompleteByCandidate[candidate.id];
                      const displayDecision = getDecisionForTab(candidate.id, currentTab);
                      
                      return (
                        <TableRow key={candidate.id} hover>
                          <TableCell data-label="Candidate">
                            <Box display="flex" alignItems="center" gap={1} sx={{ overflow: 'hidden' }}>
                              <AuthenticatedImage
                                src={candidate.headshotUrl}
                                alt={`${candidate.firstName} ${candidate.lastName}`}
                                style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                                fallback={<PersonIcon />}
                              />
                              <Box sx={{ overflow: 'hidden', minWidth: 0 }}>
                                <Typography
                                  variant="body2"
                                  fontWeight="bold"
                                  sx={{
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap'
                                  }}
                                >
                                  {candidate.firstName} {candidate.lastName}
                                </Typography>
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                  sx={{
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    display: 'block'
                                  }}
                                >
                                  {candidate.email}
                                </Typography>
                              </Box>
                            </Box>
                          </TableCell>
                          <TableCell data-label="Score">
                            <ScoreDisplay score={getScoreForTab(candidate, currentTab)} />
                          </TableCell>
                          <TableCell data-label="Grading">
                            <GradingStatusDisplay candidate={candidate} gradingData={gradingData} />
                          </TableCell>
                          <TableCell data-label="Attendance">
                            <AttendanceDisplay attendance={candidate.attendance} events={events} />
                          </TableCell>
                          <TableCell data-label="Decision">
                            <FormControl size="small" fullWidth>
                              <Select
                                value={displayDecision}
                                displayEmpty
                                onChange={(e) => handleInlineDecisionChange(candidate, e.target.value)}
                                sx={{
                                  '& .MuiSelect-select': {
                                    bgcolor: getDecisionHighlight(displayDecision).bg,
                                    border: `1px solid ${getDecisionHighlight(displayDecision).border}`,
                                    borderRadius: 1,
                                  }
                                }}
                                renderValue={(selected) => {
                                  if (!selected) return <em>Pending</em>;
                                  const labels = { yes: 'Yes', maybe_yes: 'Maybe Yes', maybe_no: 'Maybe No', no: 'No' };
                                  return labels[selected] || selected;
                                }}
                              >
                                <MenuItem value=""><em>Pending</em></MenuItem>
                                <MenuItem value="yes">Yes</MenuItem>
                                <MenuItem value="maybe_yes">Maybe Yes</MenuItem>
                                <MenuItem value="maybe_no">Maybe No</MenuItem>
                                <MenuItem value="no">No</MenuItem>
                              </Select>
                            </FormControl>
                          </TableCell>
                          <TableCell data-label="Actions">
                            <Button
                              size="small"
                              onClick={() => {
                                setAppModal(candidate);
                                setAppModalOpen(true);
                              }}
                            >
                              View Details
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>

              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 3 }}>
                <Typography variant="body2">
                  Showing {(pagination.page - 1) * pagination.limit + 1} to {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total} candidates
                </Typography>
                <Box display="flex" gap={2} alignItems="center">
                  <FormControl size="small">
                    <InputLabel>Per page</InputLabel>
                    <Select value={pagination.limit} label="Per page" onChange={(e) => handleLimitChange(e.target.value)}>
                      <MenuItem value={25}>25</MenuItem>
                      <MenuItem value={50}>50</MenuItem>
                      <MenuItem value={100}>100</MenuItem>
                    </Select>
                  </FormControl>
                  <Button disabled={!pagination.hasPrevPage} onClick={() => handlePageChange(pagination.page - 1)}>Previous</Button>
                  <Typography>Page {pagination.page} of {pagination.totalPages}</Typography>
                  <Button disabled={!pagination.hasNextPage} onClick={() => handlePageChange(pagination.page + 1)}>Next</Button>
                </Box>
              </Box>
            </CardContent>
          </Card>

          {/* Candidate Details Modal - Popup with Embedded Application Detail */}
          <Dialog
            open={appModalOpen}
            onClose={() => {
              setAppModalOpen(false);
              setAppModal(null);
            }}
            maxWidth="xl"
            fullWidth
            sx={{
              '& .MuiDialog-paper': {
                bgcolor: 'background.paper',
                height: '90vh',
                maxHeight: '90vh'
              }
            }}
          >
            <DialogTitle sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              bgcolor: 'background.paper',
              borderBottom: 1,
              borderColor: 'divider',
              py: 1
            }}>
              <Box display="flex" alignItems="center" gap={2}>
                {appModal && (
                  <Typography variant="h6">
                    {appModal.firstName} {appModal.lastName} - Application Details
                  </Typography>
                )}
              </Box>
              <IconButton onClick={() => { setAppModalOpen(false); setAppModal(null); }}>
                <ClearIcon />
              </IconButton>
            </DialogTitle>
            <DialogContent sx={{ p: 0, overflow: 'auto' }}>
              {appModal && (
                <ApplicationDetail applicationId={appModal.id} embedded={true} />
              )}
            </DialogContent>
          </Dialog>

          {/* Push All Decisions Confirmation Dialog */}
          <Dialog open={pushAllDialogOpen} onClose={() => {
            setPushAllDialogOpen(false);
            setPushAllPreview({ totalApproved: 0, invalidDecisions: 0, invalidDecisionCandidates: [] });
          }} maxWidth="md" fullWidth>
            <DialogTitle>Process All Decisions</DialogTitle>
            <DialogContent>
              <Stack spacing={2} sx={{ mt: 1 }}>
                <Alert severity="info">
                  <Typography variant="subtitle2" gutterBottom>
                    {currentTab === 0 ? '🔄 This will advance candidates to the next round (no emails sent)' :
                     currentTab === 1 ? '🔄 This will advance candidates to the next round (no emails sent)' :
                     currentTab === 2 ? '🔄 This will advance candidates to the next round (no emails sent)' :
                     '📧 This will send emails and advance candidates to the next round'}
                  </Typography>
                  <Typography variant="body2">
                    {currentTab === 0 ? (
                      <>
                        • <strong>Yes</strong> decisions: Advance to Coffee Chats round (no email)<br/>
                        • <strong>No</strong> decisions: Mark as rejected (no email)<br/>
                        • This action cannot be easily undone
                      </>
                    ) : (
                      <>
                        • <strong>Yes</strong> decisions: Acceptance emails + advance to next round<br/>
                        • <strong>No</strong> decisions: Rejection emails + mark as rejected<br/>
                        • This action cannot be easily undone
                      </>
                    )}
                  </Typography>
                </Alert>

                {pushAllPreview.invalidDecisions > 0 && (
                  <Alert severity="error">
                    <Typography variant="subtitle2" gutterBottom>
                      ⚠️ Warning: {pushAllPreview.invalidDecisions} application(s) have no decision or decisions other than "Yes" or "No"
                    </Typography>
                    <Typography variant="body2" sx={{ mb: 2 }}>
                      All applications must have a clear "Yes" or "No" decision before proceeding.
                    </Typography>

                    <Stack spacing={1}>
                      {pushAllPreview.invalidDecisionCandidates?.map((candidate) => {
                        const currentDecisionValue = candidate.approved;
                        let decisionStatus = 'No decision';

                        if (currentDecisionValue === true) {
                          decisionStatus = 'Yes';
                        } else if (currentDecisionValue === false) {
                          decisionStatus = 'No';
                        }

                        return (
                          <Box key={candidate.id} sx={{ p: 1, border: '1px solid', borderColor: 'error.main', borderRadius: 1, bgcolor: 'error.light' }}>
                            <Typography variant="body2" fontWeight="bold" gutterBottom>
                              {candidate.firstName} {candidate.lastName} - {candidate.email}
                            </Typography>
                            <Typography variant="caption" display="block" sx={{ mb: 1 }}>
                              Current decision: <strong>{decisionStatus}</strong>
                            </Typography>
                            <Stack direction="row" spacing={1}>
                              <Button
                                size="small"
                                variant="contained"
                                color="success"
                                onClick={() => fixInvalidDecision(candidate.id, 'yes')}
                                sx={{ textTransform: 'none' }}
                              >
                                Set to Yes
                              </Button>
                              <Button
                                size="small"
                                variant="contained"
                                color="error"
                                onClick={() => fixInvalidDecision(candidate.id, 'no')}
                                sx={{ textTransform: 'none' }}
                              >
                                Set to No
                              </Button>
                            </Stack>
                          </Box>
                        );
                      })}
                    </Stack>
                  </Alert>
                )}

                <Typography variant="body2">
                  {currentTab === 1 ? (
                    (() => {
                      const coffeeApps = (adminApplications || []).filter(app => String(app.currentRound) === '2');
                      const toProcess = coffeeApps.filter(app => {
                        const localDecision = getDecisionForTab(app.id, currentTab);
                        const dbDecision = app.approved === true ? 'yes' : app.approved === false ? 'no' : '';
                        const decision = localDecision || dbDecision;
                        return decision === 'yes' || decision === 'no';
                      });
                      return (<span>Applications to process: <strong>{toProcess.length}</strong></span>);
                    })()
                  ) : currentTab === 2 ? (
                    (() => {
                      const firstRoundApps = (adminApplications || []).filter(app => String(app.currentRound) === '3');
                      const toProcess = firstRoundApps.filter(app => {
                        const localDecision = getDecisionForTab(app.id, currentTab);
                        const dbDecision = app.approved === true ? 'yes' : app.approved === false ? 'no' : '';
                        const decision = localDecision || dbDecision;
                        return decision === 'yes' || decision === 'no';
                      });
                      return (<span>Applications to process: <strong>{toProcess.length}</strong></span>);
                    })()
                  ) : currentTab === 3 ? (
                    (() => {
                      const finalRoundApps = (adminApplications || []).filter(app => String(app.currentRound) === '4');
                      const toProcess = finalRoundApps.filter(app => {
                        const localDecision = getDecisionForTab(app.id, currentTab);
                        const dbDecision = app.approved === true ? 'yes' : app.approved === false ? 'no' : '';
                        const decision = localDecision || dbDecision;
                        return decision === 'yes' || decision === 'no';
                      });
                      return (<span>Applications to process: <strong>{toProcess.length}</strong></span>);
                    })()
                  ) : (
                    <span>Candidates to process: <strong>{candidates.filter(c => getDecisionForTab(c.id, currentTab) === 'yes' || getDecisionForTab(c.id, currentTab) === 'no').length}</strong></span>
                  )}
                </Typography>
                <TextField
                  label="Type PROCESS to confirm"
                  value={pushAllConfirmText}
                  onChange={(e) => setPushAllConfirmText(e.target.value)}
                  placeholder="PROCESS"
                  fullWidth
                />
                <FormControlLabel
                  control={<Checkbox checked={pushAllAcknowledge} onChange={(e) => setPushAllAcknowledge(e.target.checked)} />}
                  label={currentTab === 0 ? "I understand this will advance candidates to the next round (no emails will be sent)" : "I understand this will send emails and advance candidates to the next round"}
                />
              </Stack>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setPushAllDialogOpen(false)} disabled={pushAllLoading}>Cancel</Button>
              <Button
                onClick={confirmPushAll}
                variant="contained"
                color="error"
                disabled={pushAllLoading || pushAllConfirmText !== 'PROCESS' || !pushAllAcknowledge || pushAllPreview.invalidDecisions > 0}
              >
                {pushAllLoading ? 'Processing…' : 'Process All Decisions'}
              </Button>
            </DialogActions>
          </Dialog>

          <Snackbar open={snackbar.open} autoHideDuration={6000} onClose={() => setSnackbar({ ...snackbar, open: false })}>
            <Alert onClose={() => setSnackbar({ ...snackbar, open: false })} severity={snackbar.severity}>
              {snackbar.message}
            </Alert>
          </Snackbar>
        </Box>
    </AccessControl>
  );
}
