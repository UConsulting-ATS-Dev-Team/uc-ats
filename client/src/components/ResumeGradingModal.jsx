import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  Typography,
  TextField,
  Button,
  IconButton,
  Grid,
  Paper,
  Rating,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Chip,
  Divider,
  Alert,
  CircularProgress
} from '@mui/material';
import {
  Close as CloseIcon,
  Save as SaveIcon,
  Description as DocumentIcon
} from '@mui/icons-material';
import { useAuth } from '../context/AuthContext';
import { useIsMobile } from '../hooks/useResponsive';
import apiClient from '../utils/api';

const ResumeGradingModal = ({ open, onClose, application }) => {
  const { user, token } = useAuth();
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [existingScore, setExistingScore] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [allScores, setAllScores] = useState([]);
  const [scoresLoading, setScoresLoading] = useState(false);
  const [selectedScore, setSelectedScore] = useState(null);

  // Grading form state
  const [scoreOne, setScoreOne] = useState('');
  const [scoreTwo, setScoreTwo] = useState('');
  const [scoreThree, setScoreThree] = useState('');
  const [notes, setNotes] = useState('');

  // Rubric categories (you can customize these)
  const rubricCategories = [
    {
      id: 'scoreOne',
      title: 'Content & Relevance',
      description: 'How well does the resume showcase relevant experience and skills?',
      maxScore: 10
    },
    {
      id: 'scoreTwo',
      title: 'Structure & Formatting',
      description: 'Is the resume well-organized, professional, and easy to read?',
      maxScore: 10
    },
    {
      id: 'scoreThree',
      title: 'Impact & Achievement',
      description: 'How effectively does the resume demonstrate quantifiable achievements?',
      maxScore: 10
    }
  ];

  // Load existing score when modal opens
  useEffect(() => {
    if (open && application?.candidateId) {
      loadExistingScore();
    }
  }, [open, application?.candidateId]);

  // Build authenticated preview URL for resume (PDF) - using same approach as DocumentPreviewModal
  useEffect(() => {
    let localUrl;
    const loadPreview = async () => {
      setPreviewError(null);
      setPreviewUrl(null);
      if (!open || !application?.resumeUrl) return;

      try {
        const resp = await fetch(application.resumeUrl, {
          headers: {
            Authorization: `Bearer ${token || apiClient.token || localStorage.getItem('token')}`,
          },
        });
        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(`${resp.status} ${resp.statusText} - ${txt}`);
        }
        const blob = await resp.blob();
        localUrl = URL.createObjectURL(blob);
        setPreviewUrl(localUrl);
      } catch (e) {
        console.error('Failed to load resume preview:', e);
        setPreviewError(e.message || 'Failed to load resume preview');
      }
    };

    loadPreview();
    return () => {
      if (localUrl) URL.revokeObjectURL(localUrl);
    };
  }, [open, application?.resumeUrl, token]);

  const loadExistingScore = async () => {
    try {
      setLoading(true);
      const url = application.cycleId 
        ? `/review-teams/resume-score/${application.candidateId}?cycleId=${application.cycleId}`
        : `/review-teams/resume-score/${application.candidateId}`;
      const response = await apiClient.get(url);
      if (response) {
        setExistingScore(response);
        setScoreOne(response.scoreOne || '');
        setScoreTwo(response.scoreTwo || '');
        setScoreThree(response.scoreThree || '');
        setNotes(response.notes || '');
      }
    } catch (err) {
      console.error('Error loading existing score:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);

      const scoreData = {
        candidateId: application.candidateId,
        assignedGroupId: application.groupId,
        scoreOne: parseInt(scoreOne) || 0,
        scoreTwo: parseInt(scoreTwo) || 0,
        scoreThree: parseInt(scoreThree) || 0,
        notes
      };

      await apiClient.post('/review-teams/resume-score', scoreData);
      setSuccess(true);
      
      // Close modal after a short delay
      setTimeout(() => {
        onClose();
        setSuccess(false);
        // Reset form
        setScoreOne('');
        setScoreTwo('');
        setScoreThree('');
        setNotes('');
      }, 1500);

    } catch (err) {
      console.error('Error saving score:', err);
      setError('Failed to save score. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const calculateOverallScore = () => {
    const scores = [scoreOne, scoreTwo, scoreThree].filter(score => score !== '' && score !== null);
    if (scores.length === 0) return 0;
    return (scores.reduce((sum, score) => sum + parseInt(score), 0) / scores.length).toFixed(1);
  };

  const handleScoreChange = (field, value) => {
    const numValue = parseInt(value);
    if (numValue >= 0 && numValue <= 10) {
      switch (field) {
        case 'scoreOne':
          setScoreOne(value);
          break;
        case 'scoreTwo':
          setScoreTwo(value);
          break;
        case 'scoreThree':
          setScoreThree(value);
          break;
        default:
          break;
      }
    }
  };

  if (!application) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      fullScreen={isMobile}
      PaperProps={{
        sx: {
          height: { xs: '100%', md: '90vh' },
          maxHeight: { xs: '100%', md: '90vh' }
        }
      }}
    >
      <DialogTitle sx={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottom: 1,
        borderColor: 'divider',
        gap: 1
      }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" component="div" noWrap>
            Resume Grading - {application.name}
          </Typography>
          <Typography variant="body2" color="text.secondary" noWrap>
            {application.major} • {application.year}
          </Typography>
        </Box>
        {isMobile ? (
          <IconButton onClick={onClose} aria-label="close">
            <CloseIcon />
          </IconButton>
        ) : (
          <Button
            onClick={onClose}
            startIcon={<CloseIcon />}
            variant="outlined"
            size="small"
          >
            Close
          </Button>
        )}
      </DialogTitle>

      <DialogContent sx={{ p: 0, display: 'flex', flexDirection: 'column' }}>
        <Grid container sx={{ height: '100%' }}>
          {/* Resume Preview - Left Side */}
          <Grid item xs={12} md={6} sx={{ borderRight: 1, borderColor: 'divider' }}>
            <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
              <Typography variant="h6" sx={{ mb: 2, display: 'flex', alignItems: 'center' }}>
                <DocumentIcon sx={{ mr: 1 }} />
                Resume Preview
              </Typography>
              
              {previewUrl ? (
                <Box sx={{ height: 'calc(100% - 60px)' }}>
                  <iframe
                    src={previewUrl}
                    style={{
                      width: '100%',
                      height: '100%',
                      border: '1px solid #ddd',
                      borderRadius: '4px'
                    }}
                    title="Resume Preview"
                  />
                </Box>
              ) : (
                <Paper sx={{ p: 3, textAlign: 'center', height: 'calc(100% - 60px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Typography color="text.secondary">
                    {previewError || 'No resume available for preview'}
                  </Typography>
                </Paper>
              )}
            </Box>
          </Grid>

          {/* Grading Rubric - Right Side */}
          <Grid item xs={12} md={6}>
            <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
              <Typography variant="h6" sx={{ mb: 3 }}>
                Grading Rubric
              </Typography>

              {loading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                  <CircularProgress />
                </Box>
              ) : (
                <>
                  {error && (
                    <Alert severity="error" sx={{ mb: 2 }}>
                      {error}
                    </Alert>
                  )}

                  {success && (
                    <Alert severity="success" sx={{ mb: 2 }}>
                      Score saved successfully!
                    </Alert>
                  )}

                  {existingScore && (
                    <Alert severity="info" sx={{ mb: 2 }}>
                      You have already graded this resume. Your previous scores are loaded below.
                    </Alert>
                  )}

                  {/* Rubric Categories */}
                  <Box sx={{ mb: 3 }}>
                    {rubricCategories.map((category, index) => (
                      <Paper key={category.id} sx={{ p: 2, mb: 2 }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
                          {category.title} (0-{category.maxScore})
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                          {category.description}
                        </Typography>
                        
                        <TextField
                          type="number"
                          label="Score"
                          value={category.id === 'scoreOne' ? scoreOne : category.id === 'scoreTwo' ? scoreTwo : scoreThree}
                          onChange={(e) => handleScoreChange(category.id, e.target.value)}
                          inputProps={{ min: 0, max: category.maxScore }}
                          sx={{ width: 100, mr: 2 }}
                        />
                      </Paper>
                    ))}
                  </Box>

                  {/* Overall Score */}
                  <Paper sx={{ p: 2, mb: 3, backgroundColor: 'primary.light', color: 'white' }}>
                    <Typography variant="h6" sx={{ fontWeight: 600 }}>
                      Overall Score: {calculateOverallScore()}/10
                    </Typography>
                    <Typography variant="body2">
                      Average of all three category scores
                    </Typography>
                  </Paper>

                  {/* Overall Notes */}
                  <TextField
                    fullWidth
                    multiline
                    minRows={4}
                    label="Overall Notes"
                    placeholder="Write any overall feedback here..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    sx={{ mb: 3 }}
                  />

                  {/* Save Button */}
                  <Button
                    variant="contained"
                    startIcon={<SaveIcon />}
                    onClick={handleSave}
                    disabled={saving || (!scoreOne && !scoreTwo && !scoreThree)}
                    fullWidth
                    size="large"
                  >
                    {saving ? 'Saving...' : 'Save Score'}
                  </Button>
                </>
              )}
            </Box>
          </Grid>
        </Grid>
      </DialogContent>
    </Dialog>
  );
};

export default ResumeGradingModal;
