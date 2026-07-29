import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Typography,
  Paper,
  Stack,
  Grid,
  Card,
  CardContent,
  Divider,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem,
  IconButton,
  Tooltip,
  Alert,
  CircularProgress,
  Tabs,
  Tab,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  Switch,
  FormControlLabel,
} from '@mui/material';
import MemberAvatar from '../components/MemberAvatar';
import {
  ArrowLeftIcon,
  UserGroupIcon,
  ClockIcon,
  Cog6ToothIcon,
  PlusIcon,
  TrashIcon,
  EyeIcon,
  PencilIcon,
  CheckIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import { useIsMobile } from '../hooks/useResponsive';

const INTERVIEW_TYPES = {
  COFFEE_CHAT: {
    label: 'Coffee Chat Round',
    icon: '☕',
    description: 'Speed networking format with candidate and interviewer rotations'
  },
  ROUND_ONE: {
    label: 'Round 1',
    icon: '👥',
    description: 'Traditional interview format with individual evaluations'
  },
  ROUND_TWO: {
    label: 'Round 2',
    icon: '⭐',
    description: 'Final round with comprehensive evaluation'
  }
};

const EVALUATION_RUBRICS = {
  COFFEE_CHAT: [
    { name: 'Communication Skills', maxScore: 5, description: 'Ability to articulate thoughts clearly' },
    { name: 'Cultural Fit', maxScore: 5, description: 'Alignment with UConsulting values and culture' },
    { name: 'Professional Presence', maxScore: 5, description: 'Professional demeanor and presentation' },
    { name: 'Engagement', maxScore: 5, description: 'Level of engagement and interest shown' }
  ],
  ROUND_ONE: [
    { name: 'Technical Skills', maxScore: 5, description: 'Relevant technical knowledge and abilities' },
    { name: 'Problem Solving', maxScore: 5, description: 'Analytical thinking and problem-solving approach' },
    { name: 'Communication', maxScore: 5, description: 'Clear and effective communication' },
    { name: 'Experience', maxScore: 5, description: 'Relevant experience and background' }
  ],
  ROUND_TWO: [
    { name: 'Leadership Potential', maxScore: 5, description: 'Demonstrated leadership qualities' },
    { name: 'Strategic Thinking', maxScore: 5, description: 'Ability to think strategically' },
    { name: 'Team Collaboration', maxScore: 5, description: 'Teamwork and collaboration skills' },
    { name: 'Overall Assessment', maxScore: 5, description: 'Overall candidate evaluation' }
  ]
};

export default function InterviewDetail() {
  const isMobile = useIsMobile();
  const { id } = useParams();
  const navigate = useNavigate();
  const [interview, setInterview] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [interviewers, setInterviewers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState(0);
  const [configDialog, setConfigDialog] = useState(false);
  const [pairingDialog, setPairingDialog] = useState(false);
  const [evaluationDialog, setEvaluationDialog] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [selectedInterviewer, setSelectedInterviewer] = useState(null);

  // Coffee Chat specific state
  const [coffeeChatConfig, setCoffeeChatConfig] = useState({
    rotationTime: 15, // minutes
    totalRounds: 4,
    candidatesPerGroup: 2,
    interviewersPerGroup: 2,
    autoAssign: true
  });

  // Pairing state
  const [candidatePairs, setCandidatePairs] = useState([]);
  const [interviewerPairs, setInterviewerPairs] = useState([]);
  const [rotationSchedule, setRotationSchedule] = useState([]);

  useEffect(() => {
    fetchInterviewDetails();
  }, [id]);

  const fetchInterviewDetails = async () => {
    try {
      setLoading(true);
      console.log('Fetching interview details for ID:', id);
      
      const [interviewData, candidatesData, interviewersData] = await Promise.all([
        apiClient.get(`/admin/interviews/${id}`),
        apiClient.get('/admin/candidates'),
        apiClient.get('/admin/users?role=MEMBER')
      ]);

      console.log('Interview data:', interviewData);
      console.log('Candidates data:', candidatesData);
      console.log('Interviewers data:', interviewersData);

      setInterview(interviewData);
      setCandidates(candidatesData);
      setInterviewers(interviewersData);

      // Initialize coffee chat configuration if it's a coffee chat interview
      if (interviewData.type === 'COFFEE_CHAT') {
        initializeCoffeeChatSetup();
      }
    } catch (e) {
      console.error('Error fetching interview details:', e);
      setError(e.message || 'Failed to load interview details');
    } finally {
      setLoading(false);
    }
  };

  const initializeCoffeeChatSetup = () => {
    // Create candidate pairs (randomly)
    const shuffledCandidates = [...candidates].sort(() => Math.random() - 0.5);
    const pairs = [];
    for (let i = 0; i < shuffledCandidates.length; i += 2) {
      if (i + 1 < shuffledCandidates.length) {
        pairs.push([shuffledCandidates[i], shuffledCandidates[i + 1]]);
      } else {
        pairs.push([shuffledCandidates[i]]);
      }
    }
    setCandidatePairs(pairs);

    // Create interviewer pairs
    const shuffledInterviewers = [...interviewers].sort(() => Math.random() - 0.5);
    const interviewerPairs = [];
    for (let i = 0; i < shuffledInterviewers.length; i += 2) {
      if (i + 1 < shuffledInterviewers.length) {
        interviewerPairs.push([shuffledInterviewers[i], shuffledInterviewers[i + 1]]);
      } else {
        interviewerPairs.push([shuffledInterviewers[i]]);
      }
    }
    setInterviewerPairs(interviewerPairs);

    // Generate rotation schedule
    generateRotationSchedule(pairs, interviewerPairs);
  };

  const generateRotationSchedule = (candidatePairs, interviewerPairs) => {
    const schedule = [];
    const rounds = coffeeChatConfig.totalRounds;
    
    for (let round = 0; round < rounds; round++) {
      const roundSchedule = [];
      
      interviewerPairs.forEach((interviewerPair, interviewerIndex) => {
        const candidatePair1Index = (interviewerIndex + round) % candidatePairs.length;
        const candidatePair2Index = (interviewerIndex + round + 1) % candidatePairs.length;
        
        roundSchedule.push({
          round: round + 1,
          interviewerPair,
          candidatePairs: [
            candidatePairs[candidatePair1Index],
            candidatePairs[candidatePair2Index]
          ],
          timeSlot: `${round * coffeeChatConfig.rotationTime}-${(round + 1) * coffeeChatConfig.rotationTime} min`
        });
      });
      
      schedule.push(roundSchedule);
    }
    
    setRotationSchedule(schedule);
  };

  const handleSaveConfiguration = async () => {
    try {
      await apiClient.patch(`/admin/interviews/${id}/config`, {
        type: interview.type,
        config: coffeeChatConfig
      });
      setConfigDialog(false);
      // Refresh the setup
      initializeCoffeeChatSetup();
    } catch (e) {
      setError(e.message || 'Failed to save configuration');
    }
  };

  const handleStartInterview = async () => {
    try {
      await apiClient.post(`/admin/interviews/${id}/start`);
      // Navigate to live interview view
      navigate(`/interviews/${id}/live`);
    } catch (e) {
      setError(e.message || 'Failed to start interview');
    }
  };

  const handleEvaluation = async (evaluationData) => {
    try {
      await apiClient.post(`/admin/interviews/${id}/evaluations`, evaluationData);
      setEvaluationDialog(false);
      setSelectedCandidate(null);
      setSelectedInterviewer(null);
    } catch (e) {
      setError(e.message || 'Failed to save evaluation');
    }
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  if (!interview) {
    return (
      <Box>
        <Alert severity="error">Interview not found</Alert>
      </Box>
    );
  }

  const interviewType = INTERVIEW_TYPES[interview.type];
  const rubric = EVALUATION_RUBRICS[interview.type];

  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <Box>
      {/* Header */}
      <Stack direction={{ xs: 'column', md: 'row' }} alignItems={{ xs: 'flex-start', md: 'center' }} spacing={2} mb={3}>
        <Stack direction="row" alignItems="center" spacing={2} sx={{ width: { xs: '100%', md: 'auto' } }}>
          <IconButton onClick={() => navigate('/interviews')}>
            <ArrowLeftIcon style={{ width: '1.5rem', height: '1.5rem' }} />
          </IconButton>
          <Box>
            <Typography variant="h4">{interview.name}</Typography>
            <Stack direction="row" alignItems="center" spacing={1}>
              <span style={{ fontSize: '1.5rem' }}>{interviewType.icon}</span>
              <Typography variant="body1" color="text.secondary">
                {interviewType.label}
              </Typography>
            </Stack>
          </Box>
        </Stack>
        <Box flexGrow={1} sx={{ display: { xs: 'none', md: 'block' } }} />
        <Stack direction="row" spacing={2} sx={{ width: { xs: '100%', md: 'auto' } }}>
          <Button
            variant="contained"
            startIcon={<Cog6ToothIcon style={{ width: '1.25rem', height: '1.25rem' }} />}
            onClick={() => setConfigDialog(true)}
            sx={{ flex: { xs: 1, md: 'none' } }}
          >
            Configure
          </Button>
          <Button
            variant="contained"
            color="success"
            onClick={handleStartInterview}
            sx={{ flex: { xs: 1, md: 'none' } }}
          >
            Start Interview
          </Button>
        </Stack>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {/* Tabs */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
        <Tabs value={activeTab} onChange={(e, newValue) => setActiveTab(newValue)} variant="scrollable" allowScrollButtonsMobile scrollButtons="auto">
          <Tab label="Overview" />
          <Tab label="Pairings" />
          <Tab label="Schedule" />
          <Tab label="Evaluations" />
        </Tabs>
      </Box>

      {/* Tab Content */}
      {activeTab === 0 && (
        <Grid container spacing={3}>
          {/* Interview Details */}
          <Grid item xs={12} md={6}>
            <Card>
              <CardContent>
                <Typography variant="h6" gutterBottom>Interview Details</Typography>
                <Stack spacing={2}>
                  <Box>
                    <Typography variant="body2" color="text.secondary">Type</Typography>
                    <Typography variant="body1">{interviewType.label}</Typography>
                  </Box>
                  <Box>
                    <Typography variant="body2" color="text.secondary">Date & Time</Typography>
                    <Typography variant="body1">
                      {new Date(interview.startDate).toLocaleString()} - {new Date(interview.endDate).toLocaleString()}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="body2" color="text.secondary">Location</Typography>
                    <Typography variant="body1">{interview.location || 'TBD'}</Typography>
                  </Box>
                  <Box>
                    <Typography variant="body2" color="text.secondary">Max Candidates</Typography>
                    <Typography variant="body1">{interview.maxCandidates || 'Unlimited'}</Typography>
                  </Box>
                </Stack>
              </CardContent>
            </Card>
          </Grid>

          {/* Statistics */}
          <Grid item xs={12} md={6}>
            <Card>
              <CardContent>
                <Typography variant="h6" gutterBottom>Statistics</Typography>
                <Stack spacing={2}>
                  <Box>
                    <Typography variant="body2" color="text.secondary">Total Candidates</Typography>
                    <Typography variant="h4">{candidates.length}</Typography>
                  </Box>
                  <Box>
                    <Typography variant="body2" color="text.secondary">Total Interviewers</Typography>
                    <Typography variant="h4">{interviewers.length}</Typography>
                  </Box>
                  {interview.type === 'COFFEE_CHAT' && (
                    <>
                      <Box>
                        <Typography variant="body2" color="text.secondary">Candidate Groups</Typography>
                        <Typography variant="h4">{candidatePairs.length}</Typography>
                      </Box>
                      <Box>
                        <Typography variant="body2" color="text.secondary">Interviewer Groups</Typography>
                        <Typography variant="h4">{interviewerPairs.length}</Typography>
                      </Box>
                    </>
                  )}
                </Stack>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}

      {activeTab === 1 && interview.type === 'COFFEE_CHAT' && (
        <Grid container spacing={3}>
          {/* Candidate Pairs */}
          <Grid item xs={12} md={6}>
            <Card>
              <CardContent>
                <Typography variant="h6" gutterBottom>Candidate Groups</Typography>
                <List>
                  {candidatePairs.map((pair, index) => (
                    <ListItem key={index} divider>
                      <ListItemText
                        primary={`Group ${index + 1}`}
                        secondary={pair.map(candidate => 
                          `${candidate.firstName} ${candidate.lastName}`
                        ).join(', ')}
                      />
                    </ListItem>
                  ))}
                </List>
              </CardContent>
            </Card>
          </Grid>

          {/* Interviewer Pairs */}
          <Grid item xs={12} md={6}>
            <Card>
              <CardContent>
                <Typography variant="h6" gutterBottom>Interviewer Groups</Typography>
                <List>
                  {interviewerPairs.map((pair, index) => (
                    <ListItem key={index} divider>
                      <ListItemText
                        primary={`Group ${index + 1}`}
                        secondary={
                          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" component="span">
                            {pair.map(interviewer => (
                              <Stack key={interviewer.id} direction="row" spacing={0.5} alignItems="center" component="span">
                                <MemberAvatar member={interviewer} size={20} />
                                <Typography variant="body2" component="span">{interviewer.fullName}</Typography>
                              </Stack>
                            ))}
                          </Stack>
                        }
                      />
                    </ListItem>
                  ))}
                </List>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}

      {activeTab === 2 && interview.type === 'COFFEE_CHAT' && (
        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>Rotation Schedule</Typography>
            {rotationSchedule.map((round, roundIndex) => (
              <Box key={roundIndex} mb={3}>
                <Typography variant="h6" color="primary" gutterBottom>
                  Round {roundIndex + 1} ({roundIndex * coffeeChatConfig.rotationTime}-{(roundIndex + 1) * coffeeChatConfig.rotationTime} min)
                </Typography>
                <Grid container spacing={2}>
                  {round.map((session, sessionIndex) => (
                    <Grid item xs={12} md={6} key={sessionIndex}>
                      <Paper sx={{ p: 2, border: '1px solid #e0e0e0' }}>
                        <Typography variant="subtitle1" gutterBottom>
                          Interviewer Group {sessionIndex + 1}
                        </Typography>
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" sx={{ mb: 1 }}>
                          <Typography variant="body2" color="text.secondary">Interviewers:</Typography>
                          {session.interviewerPair.map(i => (
                            <Stack key={i.id} direction="row" spacing={0.5} alignItems="center">
                              <MemberAvatar member={i} size={20} />
                              <Typography variant="body2">{i.fullName}</Typography>
                            </Stack>
                          ))}
                        </Stack>
                        <Typography variant="body2">
                          Candidates: {session.candidatePairs.flat().map(c => 
                            `${c.firstName} ${c.lastName}`
                          ).join(', ')}
                        </Typography>
                      </Paper>
                    </Grid>
                  ))}
                </Grid>
              </Box>
            ))}
          </CardContent>
        </Card>
      )}

      {activeTab === 3 && (
        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>Evaluations</Typography>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              {interview.type === 'COFFEE_CHAT' 
                ? 'Evaluations will be available during the live interview session.'
                : 'Manage candidate evaluations for this interview round.'
              }
            </Typography>
            <Button
              variant="outlined"
              startIcon={<PlusIcon style={{ width: '1.25rem', height: '1.25rem' }} />}
              onClick={() => setEvaluationDialog(true)}
            >
              Add Evaluation
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Configuration Dialog */}
      <Dialog open={configDialog} onClose={() => setConfigDialog(false)} maxWidth="md" fullWidth fullScreen={isMobile}>
        <DialogTitle>Configure {interviewType.label}</DialogTitle>
        <DialogContent>
          <Stack spacing={3} mt={1}>
            <TextField
              label="Rotation Time (minutes)"
              type="number"
              value={coffeeChatConfig.rotationTime}
              onChange={(e) => setCoffeeChatConfig({
                ...coffeeChatConfig,
                rotationTime: parseInt(e.target.value)
              })}
              fullWidth
            />
            <TextField
              label="Total Rounds"
              type="number"
              value={coffeeChatConfig.totalRounds}
              onChange={(e) => setCoffeeChatConfig({
                ...coffeeChatConfig,
                totalRounds: parseInt(e.target.value)
              })}
              fullWidth
            />
            <TextField
              label="Candidates per Group"
              type="number"
              value={coffeeChatConfig.candidatesPerGroup}
              onChange={(e) => setCoffeeChatConfig({
                ...coffeeChatConfig,
                candidatesPerGroup: parseInt(e.target.value)
              })}
              fullWidth
            />
            <TextField
              label="Interviewers per Group"
              type="number"
              value={coffeeChatConfig.interviewersPerGroup}
              onChange={(e) => setCoffeeChatConfig({
                ...coffeeChatConfig,
                interviewersPerGroup: parseInt(e.target.value)
              })}
              fullWidth
            />
            <FormControlLabel
              control={
                <Switch
                  checked={coffeeChatConfig.autoAssign}
                  onChange={(e) => setCoffeeChatConfig({
                    ...coffeeChatConfig,
                    autoAssign: e.target.checked
                  })}
                />
              }
              label="Auto-assign candidates and interviewers to groups"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfigDialog(false)}>Cancel</Button>
          <Button onClick={handleSaveConfiguration} variant="contained">Save Configuration</Button>
        </DialogActions>
      </Dialog>

      {/* Evaluation Dialog */}
      <Dialog open={evaluationDialog} onClose={() => setEvaluationDialog(false)} maxWidth="md" fullWidth fullScreen={isMobile}>
        <DialogTitle>Add Evaluation</DialogTitle>
        <DialogContent>
          <EvaluationForm
            rubric={rubric}
            candidates={candidates}
            interviewers={interviewers}
            onSubmit={handleEvaluation}
            onCancel={() => setEvaluationDialog(false)}
          />
        </DialogContent>
      </Dialog>
    </Box>
    </AccessControl>
  );
}

// Evaluation Form Component
function EvaluationForm({ rubric, candidates, interviewers, onSubmit, onCancel }) {
  const [formData, setFormData] = useState({
    candidateId: '',
    interviewerId: '',
    scores: {},
    comments: ''
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <Box component="form" onSubmit={handleSubmit}>
      <Stack spacing={3} mt={1}>
        <TextField
          select
          label="Candidate"
          value={formData.candidateId}
          onChange={(e) => setFormData({ ...formData, candidateId: e.target.value })}
          fullWidth
          required
        >
          {candidates.map((candidate) => (
            <MenuItem key={candidate.id} value={candidate.id}>
              {candidate.firstName} {candidate.lastName}
            </MenuItem>
          ))}
        </TextField>

        <TextField
          select
          label="Interviewer"
          value={formData.interviewerId}
          onChange={(e) => setFormData({ ...formData, interviewerId: e.target.value })}
          fullWidth
          required
        >
          {interviewers.map((interviewer) => (
            <MenuItem key={interviewer.id} value={interviewer.id}>
              {interviewer.fullName}
            </MenuItem>
          ))}
        </TextField>

        <Typography variant="h6" gutterBottom>Rubric Scores</Typography>
        {rubric.map((criterion) => (
          <Box key={criterion.name}>
            <Typography variant="body2" gutterBottom>
              {criterion.name} - {criterion.description}
            </Typography>
            <TextField
              type="number"
              label="Score"
              value={formData.scores[criterion.name] || ''}
              onChange={(e) => setFormData({
                ...formData,
                scores: {
                  ...formData.scores,
                  [criterion.name]: parseInt(e.target.value)
                }
              })}
              inputProps={{ min: 1, max: criterion.maxScore }}
              fullWidth
              required
            />
          </Box>
        ))}

        <TextField
          label="Comments"
          multiline
          rows={4}
          value={formData.comments}
          onChange={(e) => setFormData({ ...formData, comments: e.target.value })}
          fullWidth
        />

        <Stack direction="row" spacing={2} justifyContent="flex-end">
          <Button onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="contained">Save Evaluation</Button>
        </Stack>
      </Stack>
    </Box>
  );
}
