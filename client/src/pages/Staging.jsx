import React, { useState, useEffect, useCallback, useRef, useMemo, useDeferredValue } from 'react';
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
  Alert,
  Snackbar,
  TextField,
  CircularProgress,
  Tooltip,
  Checkbox,
  FormControlLabel,
  Tabs,
  Tab,
  Collapse
} from '@mui/material';
import {
  ThumbUp as ThumbUpIcon,
  ThumbDown as ThumbDownIcon,
  SkipNext as SkipNextIcon,
  Refresh as RefreshIcon,
  ExpandMore as ExpandMoreIcon,
  Help as HelpIcon,
  Visibility as VisibilityIcon,
  Search as SearchIcon,
  Clear as ClearIcon,
  ArrowUpward as ArrowUpwardIcon,
  ArrowDownward as ArrowDownwardIcon,
  HowToVote as HowToVoteIcon,
  MenuBook as MenuBookIcon,
  HelpOutline as HelpOutlineIcon
} from '@mui/icons-material';
import '../styles/ApplicationList.css';
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
import { useLiveVote } from '../context/LiveVoteContext';
import liveVoteApi from '../utils/liveVoteApi';
import StagingLiveVoteSetupDialog from '../components/staging/StagingLiveVoteSetupDialog';
import RubricEditorDialog from '../components/staging/RubricEditorDialog';
import DecisionGuideEditorDialog from '../components/staging/DecisionGuideEditorDialog';
import LiveVoteResultChip from '../components/staging/LiveVoteResultChip';
import { stagingMax, useDocumentRubrics } from '../utils/documentRubrics';
import { rankByScore } from '../utils/stagingRank';

const EMPTY_LIVE_VOTE_RESULTS = { resume: {}, coffee: {}, firstRound: {}, final: {} };
const PHASE_LABELS = { resume: 'Resume Review', coffee: 'Coffee Chats', firstRound: 'First Round', final: 'Final Round' };

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

  // Processing moves candidates along and sends nothing. The decision emails it
  // queues are reviewed and sent from Master Communications.
  async processDecisions() {
    return await apiClient.post('/admin/process-decisions', {});
  },

  async processCoffeeDecisions() {
    return await apiClient.post('/admin/process-coffee-decisions', {});
  },

  async processFirstRoundDecisions() {
    return await apiClient.post('/admin/process-first-round-decisions', {});
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

const ordinal = (n) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
};

const initials = (candidate) =>
  `${candidate.firstName?.[0] || ''}${candidate.lastName?.[0] || ''}`.toUpperCase() || '?';

const ScoreDisplay = ({ score, maxScore = 10 }) => {
  if (score == null) {
    return <span className="staging-zero">—</span>;
  }
  const percentage = Math.min((score / maxScore) * 100, 100);
  const tone = percentage >= 80 ? 'high' : percentage >= 60 ? 'mid' : 'low';

  return (
    <div className="staging-score">
      <span className="staging-score-value">{score.toFixed(1)}</span>
      <span className="staging-score-track" aria-hidden="true">
        <span className={`staging-score-fill staging-score-fill--${tone}`} style={{ width: `${percentage}%` }} />
      </span>
    </div>
  );
};

// Event names a candidate attended this cycle, plus GTKUC. Names are matched loosely
// because attendance is keyed by whatever the event was called when it synced.
const attendedEventNames = (attendance, events) => {
  if (!attendance) return [];
  const names = (events || [])
    .map(event => event.eventName || event.name || event.id)
    .filter(eventName => {
      if (!eventName) return false;
      if (attendance[eventName] !== undefined) return Boolean(attendance[eventName]);
      const matchingKey = Object.keys(attendance).find(key =>
        key.toLowerCase() === eventName.toLowerCase() ||
        key.toLowerCase().includes(eventName.toLowerCase()) ||
        eventName.toLowerCase().includes(key.toLowerCase())
      );
      return matchingKey !== undefined ? Boolean(attendance[matchingKey]) : false;
    });
  return attendance.GTKUC ? [...names, 'GTKUC'] : names;
};

const AttendanceDisplay = ({ attendance, events }) => {
  if (!events || events.length === 0) {
    return <span className="staging-zero">—</span>;
  }
  const attended = attendedEventNames(attendance, events);
  if (attended.length === 0) {
    return <span className="staging-zero">None</span>;
  }
  return (
    <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{attended.join('\n')}</span>} arrow>
      <span className="staging-pill staging-pill--success">
        {attended.length} event{attended.length !== 1 ? 's' : ''}
      </span>
    </Tooltip>
  );
};

export default function Staging() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: rubricData } = useDocumentRubrics();
  const { triggerCelebration } = useCelebration();
  const isAdmin = user?.role === 'ADMIN';
  const { activeSession: activeLiveVote, refresh: refreshLiveVote } = useLiveVote();
  
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
  const [perRoundDecisions, setPerRoundDecisions] = useState({
    resume: {},
    coffee: {},
    firstRound: {},
    final: {}
  });
  // Closed live vote ballots by round and application, for the chip beside each decision.
  const [liveVoteResults, setLiveVoteResults] = useState(EMPTY_LIVE_VOTE_RESULTS);
  const [liveVoteSetupOpen, setLiveVoteSetupOpen] = useState(false);
  const [rubricEditorOpen, setRubricEditorOpen] = useState(false);
  const [decisionGuideOpen, setDecisionGuideOpen] = useState(false);
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
  const [demographicsOpen, setDemographicsOpen] = useState(false);
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
    setLiveVoteResults(data.liveVoteResults || EMPTY_LIVE_VOTE_RESULTS);

    setPagination(prev => ({
      ...prev,
      total: candidatesData.length,
      totalPages: Math.ceil(candidatesData.length / prev.limit),
      hasNextPage: prev.page < Math.ceil(candidatesData.length / prev.limit),
      hasPrevPage: prev.page > 1
    }));

    setLoading(false);
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
      liveVoteResults: snapshot.liveVoteResults || EMPTY_LIVE_VOTE_RESULTS
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

  // Null, not 0, when there is nothing to score: an all-NO interview averages to a
  // real 0, and that candidate has been seen and must still rank.
  const calculateRankingScore = (evaluations) => {
    if (!evaluations || evaluations.length === 0) return null;
    
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
    
    if (evaluationsWithDecisions.length === 0) return null;
    
    const totalScore = evaluationsWithDecisions.reduce((sum, evaluation) => {
      return sum + decisionScores[evaluation.decision];
    }, 0);
    
    return totalScore / evaluationsWithDecisions.length;
  };

  const calculateFirstRoundRankingScore = (evaluations) => {
    if (!evaluations || evaluations.length === 0) return null;
    
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

  // Application id behind a Staging row, indexed once per snapshot. Scores are read for
  // every comparison the sort makes, and scanning the applications for each one made
  // sorting quadratic in the size of the cycle.
  const adminAppIndex = useMemo(() => {
    const byId = new Map();
    const byCandidateId = new Map();
    (adminApplications || []).forEach(app => {
      byId.set(app.id, app);
      if (app.candidateId && !byCandidateId.has(app.candidateId)) byCandidateId.set(app.candidateId, app);
    });
    return { byId, byCandidateId };
  }, [adminApplications]);

  const appIdFor = (candidate) => {
    const adminApp = adminAppIndex.byId.get(candidate.id) || adminAppIndex.byCandidateId.get(candidate.candidateId);
    return adminApp?.id || candidate.id;
  };

  // A candidate's score in a round, or null when they have none yet. Resume Review's
  // total includes event points, so 0 there means nothing graded and no events.
  const getScoreForTab = (candidate, tab) => {
    if (tab === 0) {
      // Resume Review: use document scores
      return candidate.scores?.overall || null;
    } else if (tab === 1) {
      // Coffee Chat: use evaluation summaries
      const appId = appIdFor(candidate);
      const summary = evaluationSummaries[appId];
      if (summary?.evaluations?.length > 0) {
        return calculateRankingScore(summary.evaluations);
      }
      return null;
    } else if (tab === 2) {
      // First Round: use first round evaluation summaries
      const appId = appIdFor(candidate);
      const summary = evaluationSummariesFirstRound[appId];
      if (summary?.evaluations?.length > 0) {
        return calculateFirstRoundRankingScore(summary.evaluations);
      }
      return null;
    } else if (tab === 3) {
      // Final Round: use final round evaluation summaries
      const appId = appIdFor(candidate);
      const summary = evaluationSummariesFinal[appId];
      if (summary?.evaluations?.length > 0) {
        return calculateRankingScore(summary.evaluations);
      }
      return null;
    }
    return candidate.scores?.overall || null;
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

      const { summary, batchId } = result;
      if (summary) {
        const moved = currentTab === 3
          ? `${summary.accepted} accepted as members, ${summary.rejected} rejected`
          : `${summary.advanced} advanced to ${summary.nextRoundLabel}, ${summary.rejected} rejected`;
        const notes = [
          summary.undecided ? `${summary.undecided} still undecided` : null,
          summary.membersCreated
            ? `${summary.membersCreated} new member account${summary.membersCreated === 1 ? '' : 's'} created`
            : null,
          summary.conflicts?.length
            ? `Needs attention: ${summary.conflicts.map((conflict) => `${conflict.name} - ${conflict.reason}`).join('; ')}`
            : null
        ].filter(Boolean);
        const emails = summary.emailsQueued
          ? `${summary.emailsQueued} decision emails are waiting for your review. Nothing has been sent.`
          : 'No emails were queued.';
        setSnackbar({
          open: true,
          message: `Processed ${summary.processed} candidates: ${moved}.${notes.length ? ` ${notes.join('. ')}.` : ''} ${emails}`,
          severity: summary.conflicts?.length ? 'warning' : 'success',
          reviewBatchId: summary.emailsQueued ? batchId : null
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
      // The phase of the tab being processed. This used to be hard-coded to
      // 'resume', so fixing a coffee chat or final round decision here quietly
      // wrote it to resume review instead.
      await stagingAPI.saveDecision(candidateId, newDecision, tabToPhase(currentTab));

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

  // Breakdown of a round's candidates by year, gender and referral, with this
  // round's decisions. Derived during render (see `demographics` below).
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
    
    return { graduationYear: graduationYearBreakdown, gender: genderBreakdown, referral: referralBreakdown };
  }

  // Picks per candidate and round, counting up, so a failed save can tell whether a
  // newer pick has been made since it was sent.
  const decisionPickSeqRef = useRef({});

  // Optimistic: the pick shows at once and is put back if the save fails. There is
  // no forced reload afterwards - the save bumps the change token, so the next poll
  // (within STAGING_POLL_INTERVAL_MS) brings the server's copy, instead of every
  // click re-reading the whole snapshot.
  const handleInlineDecisionChange = async (item, value, tabIndex = currentTab) => {
    const phase = tabToPhase(tabIndex);
    const key = `${phase}:${item.id}`;
    const pick = (decisionPickSeqRef.current[key] || 0) + 1;
    decisionPickSeqRef.current[key] = pick;
    const previous = perRoundDecisions[phase]?.[item.id] || '';
    const setDecision = (decision) => setPerRoundDecisions(prev => ({
      ...prev,
      [phase]: { ...prev[phase], [item.id]: decision }
    }));

    setDecision(value);
    try {
      await stagingAPI.saveDecision(item.id, value, phase);
      stagingCache.invalidate();
    } catch (error) {
      console.error('Error saving inline decision:', error);
      // A newer pick owns the cell now; its own save decides what it shows.
      // Rolling back to `previous` here would overwrite it.
      if (decisionPickSeqRef.current[key] !== pick) return;
      setDecision(previous);
      setSnackbar({
        open: true,
        message: `Could not save the decision for ${item.firstName} ${item.lastName}. It has been put back.`,
        severity: 'error'
      });
      // `previous` can itself be an earlier pick whose save also failed, so take
      // the server's word for it. A failed save moves no change token, so the
      // poll alone would never correct it.
      fetchCandidates().catch(() => {});
    }
  };

  // Everything below is derived from the snapshot and recomputed only when an input
  // changes, not on every render: typing in search or opening a menu used to re-run
  // the whole filter, sort and breakdown for every applicant in the cycle. The
  // helpers they call read the same state listed in each dependency array.
  /* eslint-disable react-hooks/exhaustive-deps */
  const tabFilteredCandidates = useMemo(() => candidates.filter(candidate => {
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
  }), [candidates, currentTab, perRoundDecisions]);

  const scoreById = useMemo(() => {
    const scores = new Map();
    tabFilteredCandidates.forEach(candidate => scores.set(candidate.id, getScoreForTab(candidate, currentTab)));
    return scores;
  }, [tabFilteredCandidates, currentTab, adminAppIndex, evaluationSummaries, evaluationSummariesFirstRound, evaluationSummariesFinal]);
  const scoreOf = (candidate) => scoreById.get(candidate.id) ?? null;
  // For sorting: no score yet goes below a real 0.
  const sortScoreOf = (candidate) => scoreOf(candidate) ?? -1;

  const { ranks, rankedCount } = useMemo(
    () => rankByScore(tabFilteredCandidates.map(candidate => candidate.id), id => scoreById.get(id)),
    [tabFilteredCandidates, scoreById]
  );

  const demographics = useMemo(() => calculateDemographics(tabFilteredCandidates), [tabFilteredCandidates, perRoundDecisions, currentTab]);

  const searchTerm = useDeferredValue(filters.search);

  const filteredCandidates = useMemo(() => tabFilteredCandidates.filter(candidate => {
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
    
    const matchesSearch = searchTerm === '' ||
      `${candidate.firstName} ${candidate.lastName}`.toLowerCase().includes(searchTerm.toLowerCase()) ||
      candidate.email.toLowerCase().includes(searchTerm.toLowerCase());

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
        const diff = sortScoreOf(a) - sortScoreOf(b);
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
        const diff = sortScoreOf(a) - sortScoreOf(b);
        return multiplier * diff;
      }
    }
  }), [tabFilteredCandidates, filters, searchTerm, events, sortConfig, scoreById, perRoundDecisions, currentTab, coffeeChatInterviewFilter, coffeeChatInterviews, adminApplications]);
  /* eslint-enable react-hooks/exhaustive-deps */

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

  // Applicants in each round, for the tab labels.
  const tabCounts = useMemo(() => [
    candidates.length,
    candidates.filter(c => passedRound(c, 'resume')).length,
    candidates.filter(c => passedRound(c, 'coffee')).length,
    candidates.filter(c => passedRound(c, 'firstRound')).length
    // eslint-disable-next-line react-hooks/exhaustive-deps -- passedRound reads perRoundDecisions
  ], [candidates, perRoundDecisions]);

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  const phase = tabToPhase(currentTab);
  const decisionTotals = Object.values(demographics.referral).reduce(
    (totals, stats) => ({
      yes: totals.yes + stats.yes,
      no: totals.no + stats.no,
      maybe: totals.maybe + stats.maybe,
      pending: totals.pending + stats.pending
    }),
    { yes: 0, no: 0, maybe: 0, pending: 0 }
  );
  const nextStep = [
    '"Yes" advances to Coffee Chats',
    '"Yes" advances to First Round',
    '"Yes" advances to Final Round',
    '"Yes" accepts them as members and seals their recruiting records'
  ][currentTab];
  const processHelp = `Every candidate needs "Yes" or "No" first. ${nextStep}; "No" marks them rejected. No emails are sent here - they wait in Master Communications for you to review and send.`;
  const hasActiveFilters = filters.decision !== 'all' || filters.graduationYear !== 'all' || filters.gender !== 'all' ||
    filters.attendance !== 'all' || filters.referral !== 'all' || filters.reviewTeam !== 'all' || filters.search !== '' ||
    (currentTab === 1 && coffeeChatInterviewFilter !== 'all');
  const firstShown = filteredCandidates.length === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1;
  const lastShown = Math.min(pagination.page * pagination.limit, filteredCandidates.length);
  const totalPages = Math.max(1, Math.ceil(filteredCandidates.length / pagination.limit));
  const setFilter = (key) => (e) => setFilters({ ...filters, [key]: e.target.value });

  return (
    <AccessControl allowedRoles={['ADMIN']}>
      <div className="staging-page application-list">
        <header className="staging-header">
          <div>
            <h1 className="header-title">Staging</h1>
            <div className="staging-meta">
              <span>{currentCycle ? currentCycle.name : 'No active cycle'}</span>
              <span aria-hidden="true">·</span>
              <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{syncStatusTooltip}</span>}>
                <span className={`staging-sync staging-sync--${syncStatus === POLL_STATUS.ERROR ? 'error' : syncStatus === POLL_STATUS.PAUSED ? 'paused' : 'live'}`}>
                  {syncStatusLabel}
                </span>
              </Tooltip>
              <Tooltip title="Refresh now">
                <IconButton size="small" onClick={fetchCandidates} aria-label="Refresh staging data">
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </div>
          </div>
          {isAdmin && (
            <div className="staging-header-actions">
              <Tooltip title={`Configure the ${PHASE_LABELS[phase]} rubric`}>
                <IconButton onClick={() => setRubricEditorOpen(true)} aria-label={`Configure ${PHASE_LABELS[phase]} rubric`}>
                  <MenuBookIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Edit decision guide">
                <IconButton onClick={() => setDecisionGuideOpen(true)} aria-label="Edit decision guide">
                  <HelpOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              {activeLiveVote ? (
                <button type="button" className="staging-btn staging-btn--live" onClick={() => navigate(`/live-vote/${activeLiveVote.id}`)}>
                  <HowToVoteIcon fontSize="small" /> Live vote in progress · Open
                </button>
              ) : (
                <button type="button" className="staging-btn" onClick={() => setLiveVoteSetupOpen(true)}>
                  <HowToVoteIcon fontSize="small" /> Start live vote
                </button>
              )}
            </div>
          )}
        </header>

        <Tabs
          className="staging-tabs"
          value={currentTab}
          onChange={(e, v) => { setCurrentTab(v); setCoffeeChatInterviewFilter('all'); }}
          variant="scrollable"
          allowScrollButtonsMobile
        >
          {['Resume Review', 'Coffee Chats', 'First Round', 'Final Round'].map((label, index) => (
            <Tab
              key={label}
              label={<span className="staging-tab-label">{label}<span className="staging-tab-count">{tabCounts[index]}</span></span>}
            />
          ))}
        </Tabs>

        <section className="staging-summary" aria-label="Round summary">
          <div className="staging-summary-row">
            <div className="staging-summary-counts">
              <span className="staging-count staging-count--yes"><strong>{decisionTotals.yes}</strong> yes</span>
              <span className="staging-count staging-count--no"><strong>{decisionTotals.no}</strong> no</span>
              <span className="staging-count staging-count--maybe"><strong>{decisionTotals.maybe}</strong> maybe</span>
              <span className="staging-count"><strong>{decisionTotals.pending}</strong> pending</span>
              {tabFilteredCandidates.length > 0 && (
                <button
                  type="button"
                  className="staging-link"
                  onClick={() => setDemographicsOpen(open => !open)}
                  aria-expanded={demographicsOpen}
                >
                  Demographics
                  <ExpandMoreIcon fontSize="small" className={demographicsOpen ? 'staging-chevron open' : 'staging-chevron'} />
                </button>
              )}
            </div>
            <div className="staging-summary-actions">
              <Tooltip title={processHelp}>
                <HelpOutlineIcon fontSize="small" className="staging-help-icon" aria-label={processHelp} />
              </Tooltip>
              <button
                type="button"
                className="staging-btn staging-btn--primary"
                onClick={currentTab === 0 ? openPushAll : currentTab === 1 ? openPushAllCoffee : currentTab === 2 ? openPushAllFirstRound : openPushAllFinal}
              >
                <SkipNextIcon fontSize="small" /> Process all decisions
              </button>
            </div>
          </div>

          <Collapse in={demographicsOpen && tabFilteredCandidates.length > 0} unmountOnExit>
            <div className="staging-demographics">
              {[
                { title: 'Graduation year', rows: demographics.graduationYear, label: (key) => `Class of ${key}` },
                { title: 'Gender', rows: demographics.gender, label: (key) => key },
                { title: 'Referral', rows: demographics.referral, label: (key) => (key === 'Yes' ? 'Referred' : 'Not referred') }
              ].map(({ title, rows, label }) => {
                const groupTotal = Object.values(rows).reduce((sum, stats) => sum + stats.total, 0);
                return (
                  <table key={title} className="staging-demo-table">
                    <thead>
                      <tr>
                        <th>{title}</th>
                        <th className="num">Total</th>
                        <th className="num">Yes</th>
                        <th className="num">No</th>
                        <th className="num">Maybe</th>
                        <th className="num">Pending</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(rows).filter(([, stats]) => stats.total > 0).map(([key, stats]) => (
                        <tr key={key}>
                          <td>{label(key)}</td>
                          <td className="num">
                            {stats.total}
                            <span className="staging-muted"> {groupTotal ? Math.round((stats.total / groupTotal) * 100) : 0}%</span>
                          </td>
                          <td className={`num ${stats.yes ? 'staging-yes' : 'staging-zero'}`}>{stats.yes}</td>
                          <td className={`num ${stats.no ? 'staging-no' : 'staging-zero'}`}>{stats.no}</td>
                          <td className={`num ${stats.maybe ? 'staging-maybe' : 'staging-zero'}`}>{stats.maybe}</td>
                          <td className={`num ${stats.pending ? '' : 'staging-zero'}`}>{stats.pending}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                );
              })}
            </div>
          </Collapse>
        </section>

        <div className="staging-toolbar">
          <div className="header-search staging-search">
            <SearchIcon className="search-icon" />
            <input
              type="search"
              className="search-input"
              placeholder="Search by name or email"
              value={filters.search}
              onChange={setFilter('search')}
              aria-label="Search candidates"
            />
          </div>
          <select className="filter-select" value={filters.decision} onChange={setFilter('decision')} aria-label="Decision">
            <option value="all">Decision: All</option>
            <option value="yes">Yes</option>
            <option value="maybe_yes">Maybe Yes</option>
            <option value="maybe_no">Maybe No</option>
            <option value="no">No</option>
            <option value="pending">Pending</option>
          </select>
          <select className="filter-select" value={filters.graduationYear} onChange={setFilter('graduationYear')} aria-label="Graduation year">
            <option value="all">Year: All</option>
            {GRADUATION_YEARS.map((year) => <option key={year} value={year}>{year}</option>)}
          </select>
          <select className="filter-select" value={filters.gender} onChange={setFilter('gender')} aria-label="Gender">
            <option value="all">Gender: All</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="other">Other/Not Specified</option>
          </select>
          <select className="filter-select" value={filters.attendance} onChange={setFilter('attendance')} aria-label="Attendance">
            <option value="all">Attendance: All</option>
            <option value="high">High (80%+)</option>
            <option value="medium">Medium (60-79%)</option>
            <option value="low">Low (40-59%)</option>
            <option value="very_low">Very Low (&lt;40%)</option>
            <option value="none">No Events</option>
          </select>
          <select className="filter-select" value={filters.referral} onChange={setFilter('referral')} aria-label="Referral">
            <option value="all">Referral: All</option>
            <option value="yes">Has Referral</option>
            <option value="no">No Referral</option>
          </select>
          <select className="filter-select" value={filters.reviewTeam} onChange={setFilter('reviewTeam')} aria-label="Review team">
            <option value="all">Team: All</option>
            <option value="unassigned">Unassigned</option>
            {reviewTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
          </select>
          {currentTab === 1 && (
            <select className="filter-select" value={coffeeChatInterviewFilter} onChange={(e) => setCoffeeChatInterviewFilter(e.target.value)} aria-label="Coffee chat interview">
              <option value="all">Interview: All</option>
              {coffeeChatInterviews.map((interview) => <option key={interview.id} value={interview.id}>{interview.title}</option>)}
            </select>
          )}
          <div className="staging-sort">
            <select
              className="filter-select"
              value={sortConfig.field}
              onChange={(e) => setSortConfig({ field: e.target.value, direction: 'desc' })}
              aria-label="Sort by"
            >
              <option value="score">Sort: Score</option>
              <option value="name">Sort: Name</option>
              <option value="graduationYear">Sort: Grad Year</option>
              <option value="decision">Sort: Decision</option>
              <option value="attendance">Sort: Attendance</option>
              <option value="referral">Sort: Referral</option>
            </select>
            <Tooltip title={sortConfig.direction === 'desc' ? 'Descending' : 'Ascending'}>
              <IconButton
                size="small"
                onClick={() => setSortConfig({ ...sortConfig, direction: sortConfig.direction === 'desc' ? 'asc' : 'desc' })}
                aria-label={`Sort ${sortConfig.direction === 'desc' ? 'ascending' : 'descending'}`}
              >
                {sortConfig.direction === 'desc' ? <ArrowDownwardIcon fontSize="small" /> : <ArrowUpwardIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          </div>
          <div className="staging-toolbar-end">
            {hasActiveFilters && (
              <button
                type="button"
                className="staging-link"
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
              >
                Clear filters
              </button>
            )}
            {hasActiveFilters && (
              <span className="results-count">{filteredCandidates.length} of {tabFilteredCandidates.length}</span>
            )}
          </div>
        </div>

        {filteredCandidates.length === 0 ? (
          <div className="empty-state">
            <h3>{tabFilteredCandidates.length === 0 ? `No one in ${PHASE_LABELS[phase]} yet` : 'No candidates match these filters'}</h3>
          </div>
        ) : (
          <div className="staging-table-wrapper">
            <table className="staging-table">
              <colgroup>
                <col className="col-rank" />
                <col />
                <col className="col-score" />
                <col className="col-events" />
                <col className="col-decision" />
                <col className="col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th className="num">
                    <Tooltip title={`Rank on score among everyone in ${PHASE_LABELS[phase]}, whatever the filters or sort. Ties share a rank.`}>
                      <span>#</span>
                    </Tooltip>
                  </th>
                  <th>Candidate</th>
                  <th>Score</th>
                  <th>Events</th>
                  <th>Decision</th>
                  <th><span className="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {paginatedCandidates.map((candidate) => {
                  const rank = ranks.get(candidate.id);
                  const displayDecision = getDecisionForTab(candidate.id, currentTab);
                  const name = `${candidate.firstName} ${candidate.lastName}`;
                  return (
                    <tr key={candidate.id} className="staging-row">
                      <td className="num staging-rank" data-label="Rank">
                        {rank ? (
                          <Tooltip title={`${ordinal(rank)} of ${rankedCount} scored`} placement="left">
                            <span>{rank}</span>
                          </Tooltip>
                        ) : (
                          <span className="staging-zero" aria-label="Not scored yet">—</span>
                        )}
                      </td>
                      <td data-label="Candidate" data-no-track>
                        <div className="applicant-cell">
                          <AuthenticatedImage
                            src={candidate.headshotUrl}
                            alt={name}
                            className="staging-avatar"
                            fallback={<div className="staging-avatar staging-avatar--initials">{initials(candidate)}</div>}
                          />
                          <div className="staging-name-block">
                            <div className="applicant-name">{name}</div>
                            <div className="applicant-email">{candidate.email}</div>
                          </div>
                        </div>
                      </td>
                      <td data-label="Score">
                        <ScoreDisplay score={scoreOf(candidate)} maxScore={currentTab === 0 ? stagingMax(rubricData) : 10} />
                      </td>
                      <td data-label="Events">
                        <AttendanceDisplay attendance={candidate.attendance} events={events} />
                      </td>
                      <td data-label="Decision">
                        <div className="staging-decision-cell">
                          <select
                            className={`staging-decision staging-decision--${displayDecision || 'pending'}`}
                            value={displayDecision}
                            onChange={(e) => handleInlineDecisionChange(candidate, e.target.value)}
                            aria-label={`Decision for ${name}`}
                            data-track="staging-decision"
                          >
                            <option value="">Pending</option>
                            <option value="yes">Yes</option>
                            <option value="maybe_yes">Maybe Yes</option>
                            <option value="maybe_no">Maybe No</option>
                            <option value="no">No</option>
                          </select>
                          <LiveVoteResultChip ballots={liveVoteResults[phase]?.[candidate.id]} />
                        </div>
                      </td>
                      <td data-label="Actions" className="staging-actions">
                        <button
                          type="button"
                          className="staging-btn staging-btn--quiet"
                          onClick={() => {
                            setAppModal(candidate);
                            setAppModalOpen(true);
                          }}
                          aria-label={`View details for ${name}`}
                          data-track="staging-view-details"
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {filteredCandidates.length > 0 && (
          <div className="staging-pagination">
            <span className="results-count">Showing {firstShown}–{lastShown} of {filteredCandidates.length}</span>
            <div className="staging-pagination-controls">
              <select className="filter-select" value={pagination.limit} onChange={(e) => handleLimitChange(Number(e.target.value))} aria-label="Per page">
                <option value={25}>25 per page</option>
                <option value={50}>50 per page</option>
                <option value={100}>100 per page</option>
              </select>
              <button type="button" className="staging-btn staging-btn--quiet" disabled={pagination.page <= 1} onClick={() => handlePageChange(pagination.page - 1)}>
                Previous
              </button>
              <span className="results-count">Page {pagination.page} of {totalPages}</span>
              <button type="button" className="staging-btn staging-btn--quiet" disabled={pagination.page >= totalPages} onClick={() => handlePageChange(pagination.page + 1)}>
                Next
              </button>
            </div>
          </div>
        )}

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
                    {currentTab === 3
                      ? '🎉 This finalizes the Final Round. No emails are sent.'
                      : '🔄 This advances candidates to the next round. No emails are sent.'}
                  </Typography>
                  <Typography variant="body2">
                    {currentTab === 3 ? (
                      <>
                        • <strong>Yes</strong> decisions: Accepted, and their account becomes a member account (one is created if they have none)<br/>
                        • Accepted candidates' scores, feedback and application are sealed behind the executive password<br/>
                        • <strong>No</strong> decisions: Marked as rejected<br/>
                      </>
                    ) : (
                      <>
                        • <strong>Yes</strong> decisions: Advance to {['Coffee Chats', 'First Round Interviews', 'the Final Round'][currentTab]}<br/>
                        • <strong>No</strong> decisions: Marked as rejected<br/>
                      </>
                    )}
                    • Decision emails are queued in Master Communications, where you review the wording and send them<br/>
                    • This action cannot be easily undone
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
                  label={currentTab === 3
                    ? 'I understand this accepts these candidates as members and seals their records. Emails wait for my review.'
                    : 'I understand this advances candidates to the next round. Emails wait for my review.'}
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

          {isAdmin && (
            <>
              <StagingLiveVoteSetupDialog
                open={liveVoteSetupOpen}
                phase={tabToPhase(currentTab)}
                phaseLabel={PHASE_LABELS[tabToPhase(currentTab)]}
                candidates={tabFilteredCandidates}
                decisions={perRoundDecisions[tabToPhase(currentTab)]}
                activeSession={activeLiveVote}
                onClose={() => setLiveVoteSetupOpen(false)}
                onLaunched={(sessionId) => {
                  setLiveVoteSetupOpen(false);
                  refreshLiveVote();
                  navigate(`/live-vote/${sessionId}`);
                }}
                onOpenSession={(sessionId) => navigate(`/live-vote/${sessionId}`)}
                onEndSession={async (sessionId) => {
                  try {
                    await liveVoteApi.end(sessionId);
                    setSnackbar({ open: true, message: 'Live vote ended', severity: 'success' });
                  } catch (error) {
                    setSnackbar({ open: true, message: error.serverMessage || 'Failed to end the live vote', severity: 'error' });
                  } finally {
                    refreshLiveVote();
                  }
                }}
              />
              <RubricEditorDialog
                open={rubricEditorOpen}
                phase={tabToPhase(currentTab)}
                phaseLabel={PHASE_LABELS[tabToPhase(currentTab)]}
                onClose={() => setRubricEditorOpen(false)}
                onSaved={() => setSnackbar({ open: true, message: 'Rubric saved', severity: 'success' })}
              />
              <DecisionGuideEditorDialog
                open={decisionGuideOpen}
                phase={tabToPhase(currentTab)}
                onClose={() => setDecisionGuideOpen(false)}
                onSaved={() => setSnackbar({ open: true, message: 'Decision guide saved', severity: 'success' })}
              />
            </>
          )}

          {/* Stays open when processing queued emails, so the link to review them is not missed. */}
          <Snackbar
            open={snackbar.open}
            autoHideDuration={snackbar.reviewBatchId ? null : 6000}
            onClose={() => setSnackbar({ ...snackbar, open: false })}
          >
            <Alert
              onClose={() => setSnackbar({ ...snackbar, open: false })}
              severity={snackbar.severity}
              action={snackbar.reviewBatchId ? (
                <Stack direction="row" spacing={1}>
                  <Button
                    color="inherit"
                    size="small"
                    variant="outlined"
                    onClick={() => navigate(`/master-communications?tab=decisions&batch=${snackbar.reviewBatchId}`)}
                  >
                    Review emails
                  </Button>
                  <Button color="inherit" size="small" onClick={() => setSnackbar({ ...snackbar, open: false })}>
                    Later
                  </Button>
                </Stack>
              ) : undefined}
            >
              {snackbar.message}
            </Alert>
          </Snackbar>
      </div>
    </AccessControl>
  );
}
