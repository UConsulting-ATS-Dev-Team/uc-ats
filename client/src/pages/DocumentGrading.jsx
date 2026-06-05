import React, { useState, useEffect, useContext, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import apiClient from '../utils/api';
import DocumentGradingModal from '../components/DocumentGradingModal';
import FlagDocumentModal from '../components/FlagDocumentModal';
import AccessControl from '../components/AccessControl';
import {
  Box,
  Typography,
  Paper,
  LinearProgress,
  TextField,
  InputAdornment,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Tabs,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Button,
  Chip,
  IconButton,
  Stack,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Tooltip
} from '@mui/material';
import {
  Search as SearchIcon,
  FilterList as FilterIcon,
  Sort as SortIcon,
  Description as DocumentIcon,
  Edit as EditIcon,
  Videocam as VideoIcon,
  Flag as FlagIcon,
  FlagOutlined as FlagOutlinedIcon,
  CheckCircle as CheckCircleIcon,
  Schedule as ScheduleIcon,
  Celebration as CelebrationIcon
} from '@mui/icons-material';

// Confetti Component
const Confetti = ({ active }) => {
  if (!active) return null;

  const confettiPieces = Array.from({ length: 50 }, (_, i) => (
    <div
      key={i}
      style={{
        position: 'fixed',
        width: '10px',
        height: '10px',
        backgroundColor: ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57', '#ff9ff3'][Math.floor(Math.random() * 6)],
        left: `${Math.random() * 100}%`,
        top: '-10px',
        animation: `confetti-fall ${2 + Math.random() * 3}s linear forwards`,
        zIndex: 9999,
        borderRadius: '50%'
      }}
    />
  ));

  return (
    <>
      <style>
        {`
          @keyframes confetti-fall {
            0% {
              transform: translateY(-100vh) rotate(0deg);
              opacity: 1;
            }
            100% {
              transform: translateY(100vh) rotate(720deg);
              opacity: 0;
            }
          }
        `}
      </style>
      {confettiPieces}
    </>
  );
};

// Tab Panel component
function TabPanel({ children, value, index, ...other }) {
  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`grading-tabpanel-${index}`}
      aria-labelledby={`grading-tab-${index}`}
      {...other}
    >
      {value === index && <Box sx={{ pt: 3 }}>{children}</Box>}
    </div>
  );
}

export default function DocumentGrading() {
  const { user } = useAuth();
  const [tabValue, setTabValue] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState('name-az');
  const [statusFilter, setStatusFilter] = useState('all');
  const [yearFilter, setYearFilter] = useState('all');
  const [genderFilter, setGenderFilter] = useState('all');
  const [firstGenFilter, setFirstGenFilter] = useState('all');
  const [transferFilter, setTransferFilter] = useState('all');
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [gradingModalOpen, setGradingModalOpen] = useState(false);
  const [selectedApplication, setSelectedApplication] = useState(null);
  const [selectedDocumentType, setSelectedDocumentType] = useState('resume');
  const [showCompletionCelebration, setShowCompletionCelebration] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const [hasShownCelebration, setHasShownCelebration] = useState(false);
  const [flagModalOpen, setFlagModalOpen] = useState(false);
  const [flaggingApplication, setFlaggingApplication] = useState(null);
  const [flaggingDocumentType, setFlaggingDocumentType] = useState('resume');
  const scrollPositionRef = useRef(0);

  // Calculate progress data based on actual grading completion
  const calculateProgressData = () => {
    // Ensure applications is an array
    const apps = Array.isArray(applications) ? applications : [];
    
    // Count applications that have documents for each category
    const applicationsWithResumes = apps.filter(app => app.resumeUrl).length;
    const applicationsWithCoverLetters = apps.filter(app => app.coverLetterUrl).length;
    const applicationsWithVideos = apps.filter(app => app.videoUrl).length;
    
    // Count applications that have been graded for each category
    const resumeGraded = apps.filter(app => app.hasResumeScore).length;
    const coverLetterGraded = apps.filter(app => app.hasCoverLetterScore).length;
    const videoGraded = apps.filter(app => app.hasVideoScore).length;

    return [
      {
        title: 'Resume Completion',
        icon: <DocumentIcon />,
        completed: resumeGraded,
        total: applicationsWithResumes,
        deadline: 'Oct 4th, Morning',
        percentage: applicationsWithResumes > 0 ? Math.round((resumeGraded / applicationsWithResumes) * 100) : 100,
        color: 'success'
      },
      {
        title: 'Cover Letter Completion',
        icon: <EditIcon />,
        completed: coverLetterGraded,
        total: applicationsWithCoverLetters,
        deadline: 'Oct 4th, Morning',
        percentage: applicationsWithCoverLetters > 0 ? Math.round((coverLetterGraded / applicationsWithCoverLetters) * 100) : 100,
        color: 'success'
      },
      {
        title: 'Video Review Completion',
        icon: <VideoIcon />,
        completed: videoGraded,
        total: applicationsWithVideos,
        deadline: 'Oct 4th, Morning',
        percentage: applicationsWithVideos > 0 ? Math.round((videoGraded / applicationsWithVideos) * 100) : 100,
        color: 'success'
      }
    ];
  };

  const progressData = calculateProgressData();

  // Check if all documents are completed
  const checkAllDocumentsCompleted = () => {
    // Ensure applications is an array
    const apps = Array.isArray(applications) ? applications : [];
    
    const applicationsWithResumes = apps.filter(app => app.resumeUrl).length;
    const applicationsWithCoverLetters = apps.filter(app => app.coverLetterUrl).length;
    const applicationsWithVideos = apps.filter(app => app.videoUrl).length;
    
    const resumeGraded = apps.filter(app => app.hasResumeScore).length;
    const coverLetterGraded = apps.filter(app => app.hasCoverLetterScore).length;
    const videoGraded = apps.filter(app => app.hasVideoScore).length;

    const allResumesGraded = applicationsWithResumes === 0 || resumeGraded === applicationsWithResumes;
    const allCoverLettersGraded = applicationsWithCoverLetters === 0 || coverLetterGraded === applicationsWithCoverLetters;
    const allVideosGraded = applicationsWithVideos === 0 || videoGraded === applicationsWithVideos;

    return allResumesGraded && allCoverLettersGraded && allVideosGraded && apps.length > 0;
  };

  // Trigger celebration when all documents are completed
  useEffect(() => {
    if (Array.isArray(applications) && applications.length > 0 && checkAllDocumentsCompleted() && !hasShownCelebration) {
      console.log('Triggering celebration!');
      setShowConfetti(true);
      setShowCompletionCelebration(true);
      setHasShownCelebration(true);
      
      // Stop confetti after 3 seconds
      setTimeout(() => {
        setShowConfetti(false);
      }, 3000);
    }
  }, [applications, hasShownCelebration]);

  // Fetch applications assigned to the member's review team
  useEffect(() => {
    fetchMemberApplications();
  }, [user?.id]);

  // Restore scroll position after loading completes
  useEffect(() => {
    if (!loading && scrollPositionRef.current > 0) {
      // Use setTimeout to ensure DOM has updated
      const timer = setTimeout(() => {
        window.scrollTo(0, scrollPositionRef.current);
        scrollPositionRef.current = 0; // Reset after restoring
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [loading]);

  // Get unique years from applications for filter dropdown
  const availableYears = [...new Set(
    (Array.isArray(applications) ? applications : [])
      .map(app => app.year)
      .filter(year => year && year !== 'N/A')
  )].sort((a, b) => b - a); // Sort descending (newest first)

  // Filter and sort applications based on current filters
  const filteredApplications = (Array.isArray(applications) ? applications : []).filter(app => {
    const matchesSearch = app.studentId.toString().includes(searchTerm) ||
                         app.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         app.major.toLowerCase().includes(searchTerm.toLowerCase());

    // Determine grading status based on current tab
    let gradingStatus = 'pending';
    if (tabValue === 0) {
      // Resume tab
      gradingStatus = app.hasResumeScore ? 'completed' : 'pending';
    } else if (tabValue === 1) {
      // Cover Letter tab
      gradingStatus = app.hasCoverLetterScore ? 'completed' : 'pending';
    } else if (tabValue === 2) {
      // Video tab
      gradingStatus = app.hasVideoScore ? 'completed' : 'pending';
    }

    const matchesStatus = statusFilter === 'all' || gradingStatus === statusFilter;
    const matchesYear = yearFilter === 'all' || app.year.toString() === yearFilter;
    const matchesGender = genderFilter === 'all' || app.gender.toLowerCase() === genderFilter;
    const matchesFirstGen = firstGenFilter === 'all' ||
                           (firstGenFilter === 'yes' && app.isFirstGeneration) ||
                           (firstGenFilter === 'no' && !app.isFirstGeneration);
    const matchesTransfer = transferFilter === 'all' ||
                           (transferFilter === 'yes' && app.isTransferStudent) ||
                           (transferFilter === 'no' && !app.isTransferStudent);

    return matchesSearch && matchesStatus && matchesYear && matchesGender && matchesFirstGen && matchesTransfer;
  });

  // Sort applications
  const sortedApplications = [...filteredApplications].sort((a, b) => {
    switch (sortBy) {
      case 'name-az':
        return a.studentId - b.studentId;
      case 'name-za':
        return b.studentId - a.studentId;
      case 'date-new':
        return new Date(b.submittedAt) - new Date(a.submittedAt);
      case 'date-old':
        return new Date(a.submittedAt) - new Date(b.submittedAt);
      default:
        return 0;
    }
  });

  // Generate grading data for each document type
  const generateGradingData = (documentType) => {
    return sortedApplications.map(app => {
      let document = '';
      let hasDocument = false;
      let isGraded = false;
      let status = 'pending';

      switch (documentType) {
        case 'resume':
          document = 'Resume';
          hasDocument = !!app.resumeUrl;
          isGraded = app.hasResumeScore;
          break;
        case 'coverLetter':
          document = 'Cover Letter';
          hasDocument = !!app.coverLetterUrl;
          isGraded = app.hasCoverLetterScore;
          break;
        case 'video':
          document = 'Video';
          hasDocument = !!app.videoUrl;
          isGraded = app.hasVideoScore;
          break;
        default:
          return null;
      }

      // Determine status based on document availability and grading status
      if (!hasDocument) {
        status = 'no-document';
      } else if (isGraded) {
        status = 'completed';
      } else {
        status = 'pending';
      }

      return {
        id: `${app.id}-${documentType}`,
        candidate: `Student ${app.studentId}`,
        document,
        hasDocument,
        isGraded,
        status,
        application: app
      };
    }).filter(Boolean);
  };

  const handleTabChange = (event, newValue) => {
    setTabValue(newValue);
  };

  const handleGradeDocument = (application, documentType) => {
    setSelectedApplication(application);
    setSelectedDocumentType(documentType);
    setGradingModalOpen(true);
  };

  const handleCloseGradingModal = () => {
    // Store current scroll position before closing modal
    scrollPositionRef.current = window.scrollY || window.pageYOffset || document.documentElement.scrollTop;
    setGradingModalOpen(false);
    setSelectedApplication(null);
    // Refresh applications to update grading status
    if (user?.id) {
      fetchMemberApplications();
    }
  };

  const handleCloseCelebration = () => {
    console.log('Closing celebration dialog');
    setShowCompletionCelebration(false);
    setShowConfetti(false);
  };

  const handleFlagDocument = (application, documentType) => {
    setFlaggingApplication(application);
    setFlaggingDocumentType(documentType);
    setFlagModalOpen(true);
  };

  const handleCloseFlagModal = () => {
    setFlagModalOpen(false);
    setFlaggingApplication(null);
    setFlaggingDocumentType('resume');
  };

  const fetchMemberApplications = async () => {
    if (!user?.id) return;
    
    try {
      setLoading(true);
      const response = await apiClient.get(`/review-teams/member-applications/${user.id}`);
      
      // Check if response is an array, if not, log the issue and set empty array
      if (Array.isArray(response)) {
        setApplications(response);
        setError(null);
      } else {
        console.error('No applications data received or invalid format:', response);
        setApplications([]);
        setError('No applications data received or invalid format');
      }
    } catch (err) {
      console.error('Error fetching member applications:', err);
      setApplications([]);
      setError('Failed to load applications. Please try again.');
    } finally {
      setLoading(false);
    }
  };



  const getStatusText = (status) => {
    switch (status) {
      case 'completed':
        return 'Completed';
      case 'pending':
        return 'Grade Now';
      case 'no-document':
        return 'No Document';
      default:
        return 'Unknown';
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'completed':
        return 'success';
      case 'pending':
        return 'warning';
      case 'no-document':
        return 'error';
      default:
        return 'default';
    }
  };

  // Debug logging
  console.log('showCompletionCelebration:', showCompletionCelebration);
  console.log('showConfetti:', showConfetti);

  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <Box sx={{ p: 3 }}>
      {/* Confetti Animation */}
      <Confetti active={showConfetti} />
      
      {/* Main Title */}
      <Typography variant="h4" component="h1" sx={{ fontWeight: 700, color: 'primary.dark', mb: 4 }}>
        Document Grading
      </Typography>

      {/* Member Team Summary */}
      {!loading && !error && (
        <Paper sx={{ p: 3, mb: 4 }}>
          <Typography variant="h6" component="h2" sx={{ fontWeight: 600, color: 'primary.dark', mb: 2 }}>
            Your Review Teams
          </Typography>
          {applications.length > 0 ? (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                You are assigned to review applications from the following teams:
              </Typography>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {[...new Set((Array.isArray(applications) ? applications : []).map(app => app.groupName))].map((teamName, index) => (
                  <Chip
                    key={index}
                    label={teamName}
                    color="primary"
                    variant="outlined"
                    size="small"
                  />
                ))}
              </Box>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                Total applications assigned: {applications.length}
              </Typography>
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              You are not currently assigned to any review teams, or there are no applications assigned to your teams.
            </Typography>
          )}
        </Paper>
      )}

      {/* Progress Section */}
      <Paper sx={{ p: 3, mb: 4 }}>
        <Typography variant="h6" component="h2" sx={{ fontWeight: 600, color: 'primary.dark', mb: 3 }}>
          Document Grading Progress
        </Typography>
        
        <Stack spacing={3}>
          {progressData.map((item, index) => (
            <Box key={index}>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                <Box sx={{ color: 'primary.main', mr: 2 }}>
                  {item.icon}
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                    {item.title}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {item.completed} / {item.total} Documents Graded | Deadline: {item.deadline}
                  </Typography>
                </Box>
                <Typography variant="body2" sx={{ fontWeight: 600, color: 'success.main' }}>
                  Complete {item.percentage}%
                </Typography>
              </Box>
              <LinearProgress
                variant="determinate"
                value={item.percentage}
                sx={{
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: 'grey.200',
                  '& .MuiLinearProgress-bar': {
                    backgroundColor: 'success.main'
                  }
                }}
              />
            </Box>
          ))}
        </Stack>
      </Paper>

      {/* Start Grading Section */}
      <Paper sx={{ p: 3 }}>
        <Typography variant="h5" component="h2" sx={{ fontWeight: 600, color: 'primary.dark', mb: 3 }}>
          Start Grading
        </Typography>

        {/* Search and Sort Row */}
        <Box sx={{ display: 'flex', gap: 2, mb: 3, alignItems: 'center' }}>
          <TextField
            placeholder="Search by student ID, email, or major..."
            variant="outlined"
            size="small"
            sx={{ flex: 1, maxWidth: 300 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon />
                </InputAdornment>
              ),
            }}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          
          <FormControl size="small" sx={{ minWidth: 200 }}>
            <InputLabel>Sort By</InputLabel>
            <Select
              value={sortBy}
              label="Sort By"
              onChange={(e) => setSortBy(e.target.value)}
              startAdornment={
                <InputAdornment position="start">
                  <SortIcon />
                </InputAdornment>
              }
            >
              <MenuItem value="name-az">Student ID (Low to High)</MenuItem>
              <MenuItem value="name-za">Student ID (High to Low)</MenuItem>
              <MenuItem value="date-new">Date (Newest)</MenuItem>
              <MenuItem value="date-old">Date (Oldest)</MenuItem>
            </Select>
          </FormControl>
        </Box>

        {/* Filters Row */}
        <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap' }}>
          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel>Status</InputLabel>
            <Select
              value={statusFilter}
              label="Status"
              onChange={(e) => setStatusFilter(e.target.value)}
              startAdornment={
                <InputAdornment position="start">
                  <FilterIcon />
                </InputAdornment>
              }
            >
              <MenuItem value="all">All</MenuItem>
              <MenuItem value="pending">Pending</MenuItem>
              <MenuItem value="completed">Completed</MenuItem>
            </Select>
          </FormControl>

          <FormControl size="small" sx={{ minWidth: 100 }}>
            <InputLabel>Year</InputLabel>
            <Select
              value={yearFilter}
              label="Year"
              onChange={(e) => setYearFilter(e.target.value)}
            >
              <MenuItem value="all">All</MenuItem>
              {availableYears.map(year => (
                <MenuItem key={year} value={year.toString()}>{year}</MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl size="small" sx={{ minWidth: 100 }}>
            <InputLabel>Gender</InputLabel>
            <Select
              value={genderFilter}
              label="Gender"
              onChange={(e) => setGenderFilter(e.target.value)}
            >
              <MenuItem value="all">All</MenuItem>
              <MenuItem value="male">Male</MenuItem>
              <MenuItem value="female">Female</MenuItem>
              <MenuItem value="other">Other</MenuItem>
            </Select>
          </FormControl>

          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel>First Gen</InputLabel>
            <Select
              value={firstGenFilter}
              label="First Gen"
              onChange={(e) => setFirstGenFilter(e.target.value)}
            >
              <MenuItem value="all">All</MenuItem>
              <MenuItem value="yes">Yes</MenuItem>
              <MenuItem value="no">No</MenuItem>
            </Select>
          </FormControl>

          <FormControl size="small" sx={{ minWidth: 100 }}>
            <InputLabel>Transfer</InputLabel>
            <Select
              value={transferFilter}
              label="Transfer"
              onChange={(e) => setTransferFilter(e.target.value)}
            >
              <MenuItem value="all">All</MenuItem>
              <MenuItem value="yes">Yes</MenuItem>
              <MenuItem value="no">No</MenuItem>
            </Select>
          </FormControl>
        </Box>

        {/* Document Type Tabs */}
        <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
          <Tabs value={tabValue} onChange={handleTabChange} aria-label="document grading tabs">
            <Tab
              icon={<DocumentIcon />}
              label="Resumes"
              iconPosition="start"
              sx={{ textTransform: 'none', fontWeight: 600 }}
            />
            <Tab
              icon={<EditIcon />}
              label="Cover Letters"
              iconPosition="start"
              sx={{ textTransform: 'none', fontWeight: 600 }}
            />
            <Tab
              icon={<VideoIcon />}
              label="Videos"
              iconPosition="start"
              sx={{ textTransform: 'none', fontWeight: 600 }}
            />
          </Tabs>
        </Box>

        {/* Grading Table */}
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <LinearProgress sx={{ width: '100%' }} />
          </Box>
        ) : error ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <Typography color="error">{error}</Typography>
          </Box>
        ) : (
          <TableContainer className="responsive-table">
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 600 }}>Candidate</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Document</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Flag</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(() => {
                  const currentGradingData = generateGradingData(
                    tabValue === 0 ? 'resume' : tabValue === 1 ? 'coverLetter' : 'video'
                  );

                  if (currentGradingData.length === 0) {
                    return (
                      <TableRow>
                        <TableCell colSpan={4} sx={{ textAlign: 'center', py: 4 }}>
                          <Typography color="text.secondary">
                            No applications found for this document type.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    );
                  }

                  return currentGradingData.map((row) => (
                    <TableRow key={row.id} hover>
                      <TableCell data-label="Candidate">
                        <Typography variant="body2" sx={{ fontWeight: 500 }}>
                          {row.candidate}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {row.application?.major} • {row.application?.year}
                        </Typography>
                      </TableCell>
                      <TableCell data-label="Document">
                        <Button
                          variant="outlined"
                          size="small"
                          startIcon={<DocumentIcon />}
                          sx={{ textTransform: 'none' }}
                          disabled={!row.hasDocument}
                          onClick={() => row.hasDocument && handleGradeDocument(row.application, tabValue === 0 ? 'resume' : tabValue === 1 ? 'coverLetter' : 'video')}
                        >
                          {row.document}
                        </Button>
                      </TableCell>
                      <TableCell data-label="Flag">
                        {(() => {
                          const documentType = tabValue === 0 ? 'resume' : tabValue === 1 ? 'coverLetter' : 'video';
                          const isFlagged = row.application[`${documentType}Flagged`];

                          return (
                            <Tooltip title={isFlagged ? `Flagged: ${isFlagged.reason}` : "Flag document for review"}>
                              <IconButton
                                size="small"
                                onClick={() => handleFlagDocument(row.application, documentType)}
                                disabled={!row.hasDocument || isFlagged}
                                color={isFlagged ? "error" : "default"}
                              >
                                {isFlagged ? <FlagIcon /> : <FlagOutlinedIcon />}
                              </IconButton>
                            </Tooltip>
                          );
                        })()}
                      </TableCell>
                      <TableCell data-label="Status">
                        <Chip
                          label={getStatusText(row.status)}
                          color={getStatusColor(row.status)}
                          size="small"
                          icon={row.status === 'completed' ? <CheckCircleIcon /> : <ScheduleIcon />}
                          sx={{ fontWeight: 600 }}
                        />
                      </TableCell>
                    </TableRow>
                  ));
                })()}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      {/* Document Grading Modal */}
      <DocumentGradingModal
        open={gradingModalOpen}
        onClose={handleCloseGradingModal}
        application={selectedApplication}
        documentType={selectedDocumentType}
      />

      {/* Flag Document Modal */}
      <FlagDocumentModal
        open={flagModalOpen}
        onClose={handleCloseFlagModal}
        application={flaggingApplication}
        documentType={flaggingDocumentType}
      />

      {/* Completion Celebration Dialog */}
      <Dialog
        open={showCompletionCelebration}
        onClose={handleCloseCelebration}
        maxWidth="sm"
        fullWidth
        PaperProps={{
          sx: {
            textAlign: 'center',
            p: 3
          }
        }}
      >
        <DialogTitle sx={{ pb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', mb: 2 }}>
            <CelebrationIcon sx={{ fontSize: 48, color: 'primary.main', mr: 2 }} />
            <Typography variant="h4" component="div" sx={{ fontWeight: 700, color: 'primary.main' }}>
              🎉 Congratulations! 🎉
            </Typography>
          </Box>
        </DialogTitle>
        <DialogContent>
          <Typography variant="h6" sx={{ mb: 2, fontWeight: 600 }}>
            You've graded all documents!
          </Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
            Amazing work! You have successfully completed grading all the documents assigned to you. 
            Your thorough review helps ensure the best candidates are selected.
          </Typography>
          <Box sx={{ 
            backgroundColor: 'success.light', 
            color: 'success.contrastText', 
            p: 2, 
            borderRadius: 2,
            mb: 2
          }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              All document types have been reviewed and scored.
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions sx={{ justifyContent: 'center', pb: 3 }}>
          <Button
            variant="contained"
            size="large"
            onClick={handleCloseCelebration}
            sx={{ 
              px: 4,
              py: 1.5,
              fontSize: '1.1rem',
              fontWeight: 600
            }}
          >
            Awesome! 🚀
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
    </AccessControl>
  );
}
