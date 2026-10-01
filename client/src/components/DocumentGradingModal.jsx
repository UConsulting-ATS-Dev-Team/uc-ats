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
  Stack,
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
import { signedDocumentTarget, toSameOriginDocumentUrl } from '../utils/documentUrl';
import { coverLetterLabel } from '../utils/coverLetter';
import {
  aggregationText,
  formatScore,
  rangeLabel,
  useDocumentRubrics
} from '../utils/documentRubrics';

const EMPTY_SCORES = Object.freeze({ scoreOne: '', scoreTwo: '', scoreThree: '' });

/** A stored score as the input shows it. 0 is a score, not a blank. */
const asInput = (value) => (value === null || value === undefined ? '' : String(value));

/** Whether a criterion's label ("4-6", "2") covers `score`, to highlight the row that applies. */
function labelCovers(label, score) {
  if (score === '') return false;
  const match = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(label);
  if (!match) return false;
  const value = Number(score);
  const low = Number(match[1]);
  const high = match[2] !== undefined ? Number(match[2]) : low;
  return value >= low && value <= high;
}

/** A category's score is out of its range (blank is not). */
const outOfRange = (category, value) =>
  value !== '' && (Number(value) < category.min || Number(value) > category.max);

const DocumentGradingModal = ({ open, onClose, onSaved, application, documentType }) => {
  const { user, token } = useAuth();
  const isMobile = useIsMobile();
  const {
    data: rubricData,
    error: rubricError,
    refreshError: rubricRefreshError,
    reload: reloadRubrics
  } = useDocumentRubrics();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [existingScore, setExistingScore] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [mobileTab, setMobileTab] = useState(0);

  // Resizable columns state. The rubric needs roughly a third of the width to
  // read without wrapping every word; a video wants more room than text.
  const [leftWidth, setLeftWidth] = useState(documentType === 'video' ? 50 : 62);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef(null);
  // One modal instance serves every row, and a save can outlive the opening
  // that made it: the grader may close the modal while the request is in
  // flight, or during the success message, and open another row. Each close
  // starts a new session, and a save answers only the session it began in, so
  // it never clears, flags or closes the form that is open now.
  const sessionRef = useRef(0);
  const closeTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(closeTimerRef.current), []);

  const close = () => {
    sessionRef.current += 1;
    clearTimeout(closeTimerRef.current);
    setSuccess(false);
    setSaving(false);
    onClose();
  };
  // The timer calls whichever close is current when it fires, not the one from
  // the render that saved, so it reaches the parent's current handler.
  const closeRef = useRef(close);
  closeRef.current = close;

  // Grading form state, keyed by score column
  const [scores, setScores] = useState(EMPTY_SCORES);
  const [notes, setNotes] = useState('');

  const rubricInfo = rubricData?.rubrics?.[documentType];
  const categories = rubricInfo?.rubric?.categories || [];

  // Fall 2026 onward the cover letter slot holds a written answer, not a file.
  // It is graded with the cover letter rubric and shown as text.
  const shortAnswerText = documentType === 'coverLetter' && !application?.coverLetterUrl
    ? application?.shortAnswer?.trim() || null
    : null;

  // Get document-specific configuration
  const getDocumentConfig = () => {
    switch (documentType) {
      case 'resume':
        return {
          title: 'Resume Grading',
          previewTitle: 'Resume Preview',
          icon: <DocumentIcon />,
          urlField: 'resumeUrl',
          apiEndpoint: '/review-teams/resume-score',
          getScoreEndpoint: (candidateId, cycleId) => {
            const baseUrl = `/review-teams/resume-score/${candidateId}`;
            return cycleId ? `${baseUrl}?cycleId=${cycleId}` : baseUrl;
          }
        };
      case 'coverLetter':
        return {
          title: `${coverLetterLabel(application)} Grading`,
          previewTitle: coverLetterLabel(application),
          icon: <EditIcon />,
          urlField: 'coverLetterUrl',
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

  // Pick up a rubric an admin edited since the page loaded.
  useEffect(() => {
    if (open) reloadRubrics();
  }, [open, reloadRubrics]);

  // Load existing score when modal opens
  useEffect(() => {
    if (open && application?.candidateId) {
      // Immediately reset form state before fetching
      setExistingScore(null);
      setScores(EMPTY_SCORES);
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

      const fileUrl = toSameOriginDocumentUrl(documentUrl);

      try {
        const resp = await fetch(fileUrl, {
          headers: {
            Authorization: `Bearer ${token || apiClient.token || localStorage.getItem('token')}`,
          },
        });
        if (!resp.ok) {
          const txt = await resp.text();
          let reason = resp.statusText;
          try { reason = JSON.parse(txt).error || reason; } catch { /* not JSON */ }
          throw new Error(`The server answered ${resp.status}: ${reason}`);
        }
        let blob;
        try {
          blob = await resp.blob();
        } catch (e) {
          // Headers arrived, the body did not: the connection dropped part way
          // through a large file.
          throw new Error(`The download stopped before the file finished (${e.message})`);
        }
        localUrl = URL.createObjectURL(blob);
        setPreviewUrl(localUrl);
      } catch (e) {
        console.error(`Failed to load ${documentType} preview:`, e);
        setPreviewError(
          e instanceof TypeError
            ? `Could not reach the server (${e.message})`
            : e.message || `Failed to load ${documentType} preview`
        );
      } finally {
        setPreviewLoading(false);
      }
    };

    loadPreview();
    return () => {
      if (localUrl) URL.revokeObjectURL(localUrl);
    };
  }, [open, application?.resumeUrl, application?.coverLetterUrl, application?.videoUrl, token, documentType]);

  const [openTabError, setOpenTabError] = useState(null);
  useEffect(() => { setOpenTabError(null); }, [open, documentType, application?.id]);

  const openDocumentInNewTab = async () => {
    const documentUrl = application?.[config.urlField];
    const target = signedDocumentTarget(documentUrl);
    if (!target) {
      window.open(documentUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    setOpenTabError(null);
    // Opened inside the click, before the await, or a popup blocker eats it.
    const tab = window.open('', '_blank');
    try {
      const { access } = await apiClient.post(target.linkEndpoint);
      if (!tab) {
        setOpenTabError('Your browser blocked the new tab. Allow pop-ups for this site and try again.');
        return;
      }
      tab.opener = null;
      tab.location.href = target.open(access);
    } catch (e) {
      tab?.close();
      setOpenTabError(e.serverMessage || e.message || `Could not open the ${documentType}.`);
    }
  };

  const loadExistingScore = async () => {
    try {
      setLoading(true);
      const response = await apiClient.get(config.getScoreEndpoint(application.candidateId, application.cycleId));
      if (response) {
        setExistingScore(response);
        setScores({
          scoreOne: asInput(response.scoreOne),
          scoreTwo: asInput(response.scoreTwo),
          scoreThree: asInput(response.scoreThree)
        });
        setNotes(response.notes || '');
      } else {
        // Reset form state when no existing score is found
        setExistingScore(null);
        setScores(EMPTY_SCORES);
        setNotes('');
      }
    } catch (err) {
      console.error('Error loading existing score:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    const session = sessionRef.current;
    const isCurrent = () => session === sessionRef.current;
    try {
      setSaving(true);
      setError(null);

      // A blank category is sent as null, not 0: 0 can be a real score, and
      // a blank must not pull an average down.
      const toPayload = (value) => (value === '' ? null : parseInt(value, 10));
      const scoreData = {
        candidateId: application.candidateId,
        assignedGroupId: application.groupId,
        scoreOne: toPayload(scores.scoreOne),
        scoreTwo: toPayload(scores.scoreTwo),
        scoreThree: toPayload(scores.scoreThree),
        notes
      };

      await apiClient.post(config.apiEndpoint, scoreData);
      // The grade is saved whether or not this modal is still showing it.
      onSaved?.({ application, documentType });
      if (!isCurrent()) return;

      setSuccess(true);
      // Close modal after a short delay
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = setTimeout(() => {
        setScores(EMPTY_SCORES);
        setNotes('');
        closeRef.current();
      }, 1500);

    } catch (err) {
      console.error('Error saving score:', err);
      if (!isCurrent()) return;
      setError(err?.message?.replace(/ \(Status: \d+\)$/, '') || 'Failed to save score. Please try again.');
      // The range changed under this grader: show them the one the server holds.
      if (err?.code === 'SCORE_OUT_OF_RANGE') reloadRubrics();
    } finally {
      if (isCurrent()) setSaving(false);
    }
  };

  // Mirrors computeOverall in server/src/services/documentRubrics.js: resume
  // sums, cover letter averages, video is its one category. Blanks are skipped.
  // A score still out of range is left out until it is fixed.
  const calculateOverallScore = () => {
    const values = categories
      .filter((category) => scores[category.id] !== '' && !outOfRange(category, scores[category.id]))
      .map((category) => Number(scores[category.id]));
    if (values.length === 0) return 0;
    if (documentType === 'resume') return values.reduce((sum, value) => sum + value, 0);
    if (documentType === 'coverLetter') return values.reduce((sum, value) => sum + value, 0) / values.length;
    return values[0];
  };

  // Whole numbers only. Anything else is ignored as it is typed; a number
  // outside the range is kept and flagged, so "15" can be typed on a 5-20 scale.
  const handleScoreChange = (field, value) => {
    if (value !== '' && !/^\d{1,3}$/.test(value)) return;
    setScores((current) => ({ ...current, [field]: value }));
  };

  const hasOutOfRange = categories.some((category) => outOfRange(category, scores[category.id]));
  const hasAnyScore = categories.some((category) => scores[category.id] !== '');

  if (!application) return null;

  return (
    <Dialog
      open={open}
      onClose={close}
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
          <IconButton onClick={close} aria-label="close">
            <CloseIcon />
          </IconButton>
        ) : (
          <Button
            onClick={close}
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

      <DialogContent sx={{ p: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Box
          ref={containerRef}
          sx={{
            flex: 1,
            minHeight: 0,
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
              minHeight: 0,
              // Gives way to the rubric's minimum width on a narrow screen.
              flex: { xs: 1, md: '0 1 auto' }
            }}
          >
            <Box sx={{ p: 2, height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
              <Typography variant="h6" sx={{ mb: 2, display: 'flex', alignItems: 'center' }}>
                {config.icon}
                <Box sx={{ ml: 1 }}>{config.previewTitle}</Box>
              </Typography>
              
              {shortAnswerText ? (
                <Paper variant="outlined" sx={{ p: 2, flex: 1, overflow: 'auto' }}>
                  <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                    {shortAnswerText}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
                    {shortAnswerText.split(/\s+/).filter(Boolean).length} words
                  </Typography>
                </Paper>
              ) : previewLoading ? (
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
                  <Typography color="text.secondary" sx={{ mb: previewError ? 1 : application?.[config.urlField] ? 2 : 0 }}>
                    {previewError ? 'Failed to load preview' : `No ${documentType} available for preview`}
                  </Typography>
                  {previewError && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2, maxWidth: 420, wordBreak: 'break-word' }}>
                      {previewError}
                    </Typography>
                  )}
                  {application?.[config.urlField] && (
                    <Button
                      variant="outlined"
                      onClick={openDocumentInNewTab}
                      startIcon={config.icon}
                    >
                      Open {documentType} in new tab
                    </Button>
                  )}
                  {openTabError && (
                    <Alert severity="error" sx={{ mt: 2, textAlign: 'left' }}>
                      {openTabError}
                    </Alert>
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
              width: { xs: '100%', md: 'auto' },
              flexDirection: 'column',
              minWidth: { xs: 'auto', md: '360px' },
              minHeight: 0,
              flex: { xs: 1, md: '1 1 0' }
            }}
          >
            <Box sx={{ p: 2, flex: 1, minHeight: 0, overflow: 'auto' }}>
              <Typography variant="h6" sx={{ mb: 2 }}>
                Grading Rubric
              </Typography>

              {loading || (!rubricInfo && !rubricError) ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                  <CircularProgress />
                </Box>
              ) : !rubricInfo ? (
                <Alert
                  severity="error"
                  action={<Button color="inherit" size="small" onClick={reloadRubrics}>Retry</Button>}
                >
                  The grading rubric could not be loaded. {rubricError}
                </Alert>
              ) : (
                <>
                  {error && (
                    <Alert severity="error" sx={{ mb: 2 }}>
                      {error}
                    </Alert>
                  )}

                  {rubricRefreshError && (
                    <Alert
                      severity="warning"
                      sx={{ mb: 2 }}
                      action={<Button color="inherit" size="small" onClick={reloadRubrics}>Retry</Button>}
                    >
                      The rubric could not be refreshed, so the ranges below may be out of date.
                    </Alert>
                  )}

                  {success && (
                    <Alert severity="success" sx={{ mb: 2 }}>
                      Score saved successfully!
                    </Alert>
                  )}

                  {existingScore && (
                    <Alert severity="info" sx={{ mb: 2 }}>
                      You have already graded this {documentType === 'coverLetter' ? coverLetterLabel(application).toLowerCase() : documentType}. Your previous scores are loaded below.
                    </Alert>
                  )}

                  {/* Rubric Categories */}
                  <Stack spacing={2} sx={{ mb: 3 }}>
                    {categories.map((category) => {
                      const value = scores[category.id];
                      const invalid = outOfRange(category, value);
                      const inputId = `rubric-score-${category.id}`;
                      return (
                        <Paper key={category.id} variant="outlined" sx={{ p: 2 }}>
                          <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2 }}>
                            <Box sx={{ minWidth: 0 }}>
                              <Typography
                                component="label"
                                htmlFor={inputId}
                                variant="subtitle1"
                                sx={{ fontWeight: 600, display: 'block', lineHeight: 1.3 }}
                              >
                                {category.title}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                Score {rangeLabel(category)}
                              </Typography>
                            </Box>
                            <TextField
                              id={inputId}
                              size="small"
                              value={value}
                              onChange={(e) => handleScoreChange(category.id, e.target.value)}
                              error={invalid}
                              placeholder="–"
                              inputProps={{
                                inputMode: 'numeric',
                                'aria-describedby': invalid ? `${inputId}-range` : undefined,
                                style: { textAlign: 'center', fontWeight: 600 }
                              }}
                              InputProps={{
                                endAdornment: (
                                  <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap', pl: 0.5 }}>
                                    / {category.max}
                                  </Typography>
                                )
                              }}
                              sx={{ width: 104, flexShrink: 0 }}
                            />
                          </Box>
                          {invalid && (
                            <Typography id={`${inputId}-range`} variant="caption" color="error" sx={{ display: 'block', mt: 0.5 }}>
                              Enter a whole number from {category.min} to {category.max}.
                            </Typography>
                          )}

                          {category.description && (
                            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                              {category.description}
                            </Typography>
                          )}

                          {category.criteria.length > 0 && (
                            <Stack component="ul" spacing={0.5} sx={{ listStyle: 'none', p: 0, m: 0, mt: 1.5 }}>
                              {category.criteria.map((criterion, index) => {
                                const applies = labelCovers(criterion.label, value);
                                return (
                                  <Box
                                    component="li"
                                    key={`${criterion.label}-${index}`}
                                    sx={{
                                      display: 'flex',
                                      gap: 1.5,
                                      alignItems: 'flex-start',
                                      p: 1,
                                      borderRadius: 1,
                                      bgcolor: applies ? 'action.selected' : 'grey.50',
                                      outline: applies ? 1 : 0,
                                      outlineColor: 'primary.main'
                                    }}
                                  >
                                    <Chip
                                      label={criterion.label}
                                      size="small"
                                      color={applies ? 'primary' : 'default'}
                                      sx={{ minWidth: 44, fontWeight: 600, flexShrink: 0 }}
                                    />
                                    <Typography variant="body2" sx={{ pt: 0.25 }}>
                                      {criterion.text}
                                    </Typography>
                                  </Box>
                                );
                              })}
                            </Stack>
                          )}
                        </Paper>
                      );
                    })}
                  </Stack>

                  {/* Overall Notes */}
                  <TextField
                    fullWidth
                    multiline
                    minRows={4}
                    label="Overall Notes"
                    placeholder="Write any overall feedback here..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </>
              )}
            </Box>

            {/* Overall score and Save stay in view while the rubric scrolls */}
            {rubricInfo && !loading && (
              <Box
                sx={{
                  borderTop: 1,
                  borderColor: 'divider',
                  p: 2,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  bgcolor: 'background.paper'
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="h6" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
                    Overall {formatScore(calculateOverallScore())} / {formatScore(rubricInfo.maxOverall)}
                  </Typography>
                  {hasOutOfRange ? (
                    <Typography variant="caption" color="error" role="status">
                      A score is outside its range. Fix it to save.
                    </Typography>
                  ) : (
                    <Typography variant="caption" color="text.secondary">
                      {aggregationText(documentType, rubricInfo.rubric)}
                    </Typography>
                  )}
                </Box>
                <Button
                  variant="contained"
                  startIcon={<SaveIcon />}
                  onClick={handleSave}
                  disabled={saving || !hasAnyScore || hasOutOfRange}
                  sx={{ flexShrink: 0 }}
                >
                  {saving ? 'Saving...' : 'Save Score'}
                </Button>
              </Box>
            )}
          </Box>
        </Box>
      </DialogContent>
    </Dialog>
  );
};

export default DocumentGradingModal;
