import React, { useState, useEffect, useRef } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  Typography,
  TextField,
  Button,
  IconButton,
  Tabs,
  Tab,
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
  Description as DocumentIcon,
  Edit as EditIcon,
  Videocam as VideoIcon
} from '@mui/icons-material';
import { useAuth } from '../context/AuthContext';
import { useIsMobile } from '../hooks/useResponsive';
import apiClient from '../utils/api';

const DocumentGradingModal = ({ open, onClose, application, documentType }) => {
  const { user, token } = useAuth();
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [existingScore, setExistingScore] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [mobileTab, setMobileTab] = useState(0);

  // Resizable columns state
  const [leftWidth, setLeftWidth] = useState(documentType === 'video' ? 50 : 83.3);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef(null);

  // Grading form state
  const [scoreOne, setScoreOne] = useState('');
  const [scoreTwo, setScoreTwo] = useState('');
  const [scoreThree, setScoreThree] = useState('');
  const [notes, setNotes] = useState('');

  // Get document-specific configuration
  const getDocumentConfig = () => {
    switch (documentType) {
      case 'resume':
        return {
          title: 'Resume Grading',
          previewTitle: 'Resume Preview',
          icon: <DocumentIcon />,
          urlField: 'resumeUrl',
          rubricCategories: [
            {
              id: 'scoreOne',
              title: 'Content, Relevance, and Impact',
              description: 'Evaluates how well the resume showcases relevant experience, leadership, and business acumen while clearly demonstrating measurable impact and achievements.',
              maxScore: 10,
              criteria: {
                '1-3': 'Mostly generic experience, little relevance, no clear results',
                '4-6': 'Relevant experience present, but minimal quantification or impact',
                '7-10': 'Strong, relevant experience with leadership/impact metrics and quantifiable outcomes'
              }
            },
            {
              id: 'scoreTwo',
              title: 'Structure & Formatting',
              description: 'Assesses professionalism, organization, and readability.',
              maxScore: 3,
              criteria: {
                1: 'Major red flags',
                2: 'Easy to read but lacks professionalism',
                3: 'Professional, structured and fully complete bullet points'
              }
            }
          ],
          apiEndpoint: '/review-teams/resume-score',
          getScoreEndpoint: (candidateId, cycleId) => {
            const baseUrl = `/review-teams/resume-score/${candidateId}`;
            return cycleId ? `${baseUrl}?cycleId=${cycleId}` : baseUrl;
          }
        };
      case 'coverLetter':
        return {
          title: 'Cover Letter Grading',
          previewTitle: 'Cover Letter Preview',
          icon: <EditIcon />,
          urlField: 'coverLetterUrl',
          rubricCategories: [
            {
              id: 'scoreOne',
              title: 'Consulting Interest',
              description: 'Demonstrates understanding and passion for consulting career',
              maxScore: 3,
              criteria: {
                3: 'Clearly articulates professional goals in consulting that strongly align personal experiences, traits, and skills. Shows passion and purpose for consulting interest.',
                2: 'Shows substantial knowledge of consulting industry. Has clear goals set defining match between personality and consulting.',
                1: 'Minimal or unclear interest in consulting. Little to no effort made to explore or understand the field.'
              }
            },
            {
              id: 'scoreTwo',
              title: 'UC Interest',
              description: 'Shows specific knowledge and interest in UConsulting',
              maxScore: 3,
              criteria: {
                3: 'Applies specific references of UC to personal growth objectives. Displays sincere interest to capitalize on and contribute to UC initiatives and resources.',
                2: 'References to specific initiatives, including but not limited to past projects, committees, firm events, etc.',
                1: 'Fails to include any UC specific details. Absence of personalization.'
              }
            },
            {
              id: 'scoreThree',
              title: 'Culture Addition',
              description: 'Demonstrates unique traits and contributions to UC culture',
              maxScore: 3,
              criteria: {
                3: 'Exceptionally unique story and background. Advanced explanation of how candidate traits advance and contribute to UC.',
                2: 'Describes noteworthy traits, qualifications, or experiences and how to apply them at UC. Demonstrates passion for something.',
                1: 'Does not elaborate on any traits, qualifications, or experiences that make the candidate unique.'
              }
            }
          ],
          apiEndpoint: '/review-teams/cover-letter-score',
          getScoreEndpoint: (candidateId, cycleId) => {
            const baseUrl = `/review-teams/cover-letter-score/${candidateId}`;
            return cycleId ? `${baseUrl}?cycleId=${cycleId}` : baseUrl;
          }
        };
      case 'video':
        return {
          title: 'Video Review',
          previewTitle: 'Video Preview',
          icon: <VideoIcon />,
          urlField: 'videoUrl',
          rubricCategories: [
            {
              id: 'scoreOne',
              title: 'Overall Video Assessment',
              description: 'Comprehensive evaluation of the candidate based on video content',
              maxScore: 2,
              criteria: {
                0: 'Learn little about the person, low energy, not good fit for UC',
                1: 'Learn a little about the person, medium energy, ok fit',
                2: 'Awesome video learn a lot about the person, high energy, definite fit for UC'
              }
            }
          ],
          apiEndpoint: '/review-teams/video-score',
          getScoreEndpoint: (candidateId, cycleId) => {
            const baseUrl = `/review-teams/video-score/${candidateId}`;
            return cycleId ? `${baseUrl}?cycleId=${cycleId}` : baseUrl;
          }
        };
      default:
        return null;
    }
  };

  const config = getDocumentConfig();
  if (!config) return null;

  // Resize functionality
  const handleMouseDown = (e) => {
    setIsResizing(true);
    e.preventDefault();
  };

  const handleMouseMove = (e) => {
    if (!isResizing || !containerRef.current) return;
    
    const containerRect = containerRef.current.getBoundingClientRect();
    const newLeftWidth = ((e.clientX - containerRect.left) / containerRect.width) * 100;
    
    // Constrain between 20% and 80%
    const constrainedWidth = Math.min(Math.max(newLeftWidth, 20), 80);
    setLeftWidth(constrainedWidth);
  };

  const handleMouseUp = () => {
    setIsResizing(false);
  };

  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    } else {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  // Load existing score when modal opens
  useEffect(() => {
    if (open && application?.candidateId) {
      // Immediately reset form state before fetching
      setExistingScore(null);
      setScoreOne('');
      setScoreTwo('');
      setScoreThree('');
      setNotes('');
      setError(null);
      setSuccess(false);
      loadExistingScore();
    }
  }, [open, application?.candidateId, documentType]);

  // Build authenticated preview URL for document
  useEffect(() => {
    let localUrl;
    const loadPreview = async () => {
      setPreviewError(null);
      setPreviewUrl(null);
      setPreviewLoading(false);

      // Determine the URL field based on document type
      const urlField = documentType === 'resume' ? 'resumeUrl'
        : documentType === 'coverLetter' ? 'coverLetterUrl'
        : 'videoUrl';

      const documentUrl = application?.[urlField];
      if (!open || !documentUrl) return;

      setPreviewLoading(true);

      // Normalize URL: strip any localhost or production prefixes to make it relative
      let fileUrl = documentUrl;
      const prefixesToStrip = ['http://localhost:3001', 'http://localhost:5173', 'https://uconsultingats.com', 'https://www.uconsultingats.com'];
      for (const prefix of prefixesToStrip) {
        if (fileUrl.startsWith(prefix)) {
          fileUrl = fileUrl.replace(prefix, '');
          break;
        }
      }

      try {
        const resp = await fetch(fileUrl, {
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
        console.error(`Failed to load ${documentType} preview:`, e);
        setPreviewError(e.message || `Failed to load ${documentType} preview`);
      } finally {
        setPreviewLoading(false);
      }
    };

    loadPreview();
    return () => {
      if (localUrl) URL.revokeObjectURL(localUrl);
    };
  }, [open, application?.resumeUrl, application?.coverLetterUrl, application?.videoUrl, token, documentType]);

  const loadExistingScore = async () => {
    try {
      setLoading(true);
      const response = await apiClient.get(config.getScoreEndpoint(application.candidateId, application.cycleId));
      if (response) {
        setExistingScore(response);
        setScoreOne(response.scoreOne || '');
        setScoreTwo(response.scoreTwo || '');
        setScoreThree(response.scoreThree || '');
        setNotes(response.notes || '');
      } else {
        // Reset form state when no existing score is found
        setExistingScore(null);
        setScoreOne('');
        setScoreTwo('');
        setScoreThree('');
        setNotes('');
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

      await apiClient.post(config.apiEndpoint, scoreData);
      setSuccess(true);

      // Close modal after a short delay
      setTimeout(() => {
        onClose(true); // Pass true to indicate data was saved and refresh is needed
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
    // For video, we only use scoreOne since it's a single category
    if (documentType === 'video') {
      return scoreOne !== '' && scoreOne !== null ? scoreOne : 0;
    }
    
    // For resume, we have 2 categories that should be summed (10 + 3 = 13 total)
    if (documentType === 'resume') {
      const score1 = scoreOne !== '' && scoreOne !== null ? parseInt(scoreOne) : 0;
      const score2 = scoreTwo !== '' && scoreTwo !== null ? parseInt(scoreTwo) : 0;
      return score1 + score2;
    }
    
    // For other document types (cover letter), use all three scores
    const scores = [scoreOne, scoreTwo, scoreThree].filter(score => score !== '' && score !== null);
    if (scores.length === 0) return 0;
    const average = scores.reduce((sum, score) => sum + parseInt(score), 0) / scores.length;
    return average.toFixed(1);
  };

  const getMaxScore = () => {
    if (documentType === 'resume') {
      return 13; // Sum of (10 + 3) for Content/Relevance/Impact + Structure/Formatting
    }
    return config.rubricCategories[0]?.maxScore || 10;
  };

  const handleScoreChange = (field, value) => {
    // Allow empty string for deletion
    if (value === '') {
      switch (field) {
        case 'scoreOne':
          setScoreOne('');
          break;
        case 'scoreTwo':
          setScoreTwo('');
          break;
        case 'scoreThree':
          setScoreThree('');
          break;
        default:
          break;
      }
      return;
    }

    // Only allow integers - reject any input containing decimal points or non-numeric characters
    if (!/^\d+$/.test(value)) {
      return;
    }

    const numValue = parseInt(value);
    let minScore = 0;
    if (documentType === 'coverLetter') {
      minScore = 1;
    } else if (documentType === 'resume' && field === 'scoreOne') {
      minScore = 1; // Content, Relevance, and Impact minimum is 1
    }
    
    // Get the max score for the specific field
    let effectiveMaxScore;
    if (documentType === 'resume') {
      if (field === 'scoreOne') {
        effectiveMaxScore = 10; // Content, Relevance, and Impact
      } else if (field === 'scoreTwo') {
        effectiveMaxScore = 3; // Structure & Formatting
      } else {
        effectiveMaxScore = 0; // scoreThree not used for resume
      }
    } else if (documentType === 'video') {
      effectiveMaxScore = 2;
    } else if (documentType === 'coverLetter') {
      effectiveMaxScore = 3; // All cover letter categories now max at 3
    } else {
      effectiveMaxScore = getMaxScore();
    }
    
    // Allow intermediate states (like "4" when typing "42")
    if (!isNaN(numValue) && numValue >= minScore && numValue <= effectiveMaxScore) {
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
      onClose={() => onClose(false)}
      maxWidth="xl"
      fullWidth
      fullScreen={isMobile}
      PaperProps={{
        sx: {
          height: { xs: '100%', md: '90vh' },
          maxHeight: { xs: '100%', md: '90vh' },
          minWidth: { xs: 'auto', md: '1200px' }
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
            {application.studentId}
          </Typography>
          <Typography variant="body2" color="text.secondary" noWrap>
            {application.major} • {application.year}
          </Typography>
        </Box>
        {isMobile ? (
          <IconButton onClick={() => onClose(false)} aria-label="close">
            <CloseIcon />
          </IconButton>
        ) : (
          <Button
            onClick={() => onClose(false)}
            startIcon={<CloseIcon />}
            variant="outlined"
            size="small"
          >
            Close
          </Button>
        )}
      </DialogTitle>

      {isMobile && (
        <Tabs
          value={mobileTab}
          onChange={(_, v) => setMobileTab(v)}
          variant="fullWidth"
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          <Tab icon={config.icon} iconPosition="start" label="Preview" />
          <Tab icon={<EditIcon />} iconPosition="start" label="Grading" />
        </Tabs>
      )}

      <DialogContent sx={{ p: 0, display: 'flex', flexDirection: 'column' }}>
        <Box
          ref={containerRef}
          sx={{
            height: '100%',
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            position: 'relative'
          }}
        >
          {/* Document Preview - Left Side / Mobile tab 0 */}
          <Box
            sx={{
              display: isMobile && mobileTab !== 0 ? 'none' : 'flex',
              width: { xs: '100%', md: `${leftWidth}%` },
              borderRight: { xs: 0, md: 1 },
              borderColor: 'divider',
              flexDirection: 'column',
              minWidth: { xs: 'auto', md: '200px' },
              flex: { xs: 1, md: 'none' }
            }}
          >
            <Box sx={{ p: 2, height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
              <Typography variant="h6" sx={{ mb: 2, display: 'flex', alignItems: 'center' }}>
                {config.icon}
                <Box sx={{ ml: 1 }}>{config.previewTitle}</Box>
              </Typography>
              
              {previewLoading ? (
                <Paper sx={{ p: 2, textAlign: 'center', height: 'calc(100% - 60px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
                  <CircularProgress size={48} sx={{ mb: 2 }} />
                  <Typography color="text.secondary">
                    Loading {documentType}...
                  </Typography>
                </Paper>
              ) : previewUrl ? (
                <Box sx={{ height: 'calc(100% - 60px)', flex: 1 }}>
                  {documentType === 'video' ? (
                    <video
                      src={previewUrl}
                      controls
                      style={{
                        width: '100%',
                        height: '100%',
                        border: '1px solid var(--border-medium)',
                        borderRadius: '4px'
                      }}
                    />
                  ) : (
                    <iframe
                      src={previewUrl}
                      style={{
                        width: '100%',
                        height: '100%',
                        border: '1px solid var(--border-medium)',
                        borderRadius: '4px'
                      }}
                      title={`${config.previewTitle}`}
                    />
                  )}
                </Box>
              ) : (
                <Paper sx={{ p: 2, textAlign: 'center', height: 'calc(100% - 60px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
                  <Typography color="text.secondary" sx={{ mb: application?.[config.urlField] ? 2 : 0 }}>
                    {previewError ? 'Failed to load preview' : `No ${documentType} available for preview`}
                  </Typography>
                  {application?.[config.urlField] && (
                    <Button
                      variant="outlined"
                      href={application[config.urlField]}
                      target="_blank"
                      rel="noopener noreferrer"
                      startIcon={config.icon}
                    >
                      Open {documentType} in new tab
                    </Button>
                  )}
                </Paper>
              )}
            </Box>
          </Box>

          {/* Resizer (desktop only) */}
          {!isMobile && (
            <Box
              onMouseDown={handleMouseDown}
              sx={{
                width: '4px',
                backgroundColor: isResizing ? 'primary.main' : 'grey.300',
                cursor: 'col-resize',
                '&:hover': {
                  backgroundColor: 'primary.main'
                },
                transition: 'background-color 0.2s'
              }}
            />
          )}

          {/* Grading Rubric - Right Side / Mobile tab 1 */}
          <Box
            sx={{
              display: isMobile && mobileTab !== 1 ? 'none' : 'flex',
              width: { xs: '100%', md: `${100 - leftWidth}%` },
              flexDirection: 'column',
              minWidth: { xs: 'auto', md: '200px' },
              flex: { xs: 1, md: 'none' }
            }}
          >
            <Box sx={{ p: 2, height: '100%', overflow: 'auto' }}>
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
                      You have already graded this {documentType}. Your previous scores are loaded below.
                    </Alert>
                  )}

                  {/* Rubric Categories */}
                  <Box sx={{ mb: 3 }}>
                    {config.rubricCategories.map((category, index) => (
                      <Paper key={category.id} sx={{ p: 2, mb: 2 }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
                          {category.title} ({documentType === 'coverLetter' ? '1' : 
                                           documentType === 'resume' && category.id === 'scoreOne' ? '1' : 
                                           documentType === 'resume' && category.id === 'scoreTwo' ? '1' : '0'}-{documentType === 'video' ? Math.min(category.maxScore, 2) : category.maxScore})
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                          {category.description}
                        </Typography>
                        
                        {/* Show detailed criteria if available */}
                        {category.criteria && (
                          <Box sx={{ mb: 2 }}>
                            <Typography variant="body2" sx={{ fontWeight: 500, mb: 1 }}>
                              Scoring Criteria:
                            </Typography>
                            <Box sx={{ 
                              border: 1, 
                              borderColor: 'grey.300', 
                              borderRadius: 1, 
                              overflow: 'hidden',
                              mb: 1
                            }}>
                              <Box sx={{ 
                                display: 'grid', 
                                gridTemplateColumns: 'auto 1fr',
                                '& > *': { 
                                  borderBottom: 1, 
                                  borderColor: 'grey.300',
                                  p: 1
                                }
                              }}>
                                <Box sx={{ 
                                  bgcolor: 'grey.100', 
                                  fontWeight: 600,
                                  borderRight: 1,
                                  borderColor: 'grey.300'
                                }}>
                                  Score Range
                                </Box>
                                <Box sx={{ 
                                  bgcolor: 'grey.100', 
                                  fontWeight: 600
                                }}>
                                  Description
                                </Box>
                                {Object.entries(category.criteria).map(([score, description]) => (
                                  <React.Fragment key={score}>
                                    <Box sx={{ 
                                      bgcolor: 'grey.50',
                                      borderRight: 1,
                                      borderColor: 'grey.300',
                                      fontWeight: 500
                                    }}>
                                      {score}
                                    </Box>
                                    <Box sx={{ bgcolor: 'grey.50' }}>
                                      {description}
                                    </Box>
                                  </React.Fragment>
                                ))}
                              </Box>
                            </Box>
                          </Box>
                        )}
                        
                        <TextField
                          type="number"
                          label="Score"
                          value={category.id === 'scoreOne' ? scoreOne : category.id === 'scoreTwo' ? scoreTwo : scoreThree}
                          onChange={(e) => handleScoreChange(category.id, e.target.value)}
                          inputProps={{ 
                            min: (documentType === 'coverLetter') ? 1 : 
                                 (documentType === 'resume' && category.id === 'scoreOne') ? 1 : 0, 
                            max: category.maxScore,
                            onWheel: (e) => e.target.blur()
                          }}
                          sx={{ width: 100, mr: 2 }}
                        />
                      </Paper>
                    ))}
                  </Box>

                  {/* Overall Score */}
                  <Paper sx={{ p: 2, mb: 3, backgroundColor: 'primary.light', color: 'white' }}>
                    <Typography variant="h6" sx={{ fontWeight: 600 }}>
                      Overall Score: {calculateOverallScore()}/{getMaxScore()}
                    </Typography>
                    <Typography variant="body2">
                      {documentType === 'video' ? 'Single category score' : 
                       documentType === 'resume' ? 'Sum of Content/Relevance/Impact (1-10) and Structure/Formatting (1-3)' :
                       'Average of all three category scores'}
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
                    disabled={saving || (documentType === 'resume' ? (!scoreOne && !scoreTwo) : (!scoreOne && !scoreTwo && !scoreThree))}
                    fullWidth
                    size="large"
                  >
                    {saving ? 'Saving...' : 'Save Score'}
                  </Button>
                </>
              )}
            </Box>
          </Box>
        </Box>
      </DialogContent>
    </Dialog>
  );
};

export default DocumentGradingModal;
