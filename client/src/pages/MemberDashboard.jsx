import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  Box,
  Typography,
  Button,
  Paper,
  Stack,
  Chip,
  IconButton,
  Grid,
  Card,
  CardContent,
  CardActions,
  CircularProgress,
  Alert
} from '@mui/material';
import {
  Check as CheckIcon,
  Schedule as ClockIcon,
  Description as DocumentTextIcon,
  OpenInNew as ArrowTopRightOnSquareIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  Download as ArrowDownTrayIcon,
  Group as GroupIcon,
  Person as PersonIcon
} from '@mui/icons-material';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';

export default function MemberDashboard() {
  const { user } = useAuth();
  const [tasks, setTasks] = useState([]);

  const [resources, setResources] = useState([
    {
      id: 1,
      title: 'Document Grading Guide',
      type: 'document'
    },
    {
      id: 2,
      title: 'Interview Questions Bank',
      type: 'document'
    },
    {
      id: 3,
      title: 'RSVP Form for Coffee Chat',
      type: 'form'
    },
    {
      id: 4,
      title: 'First Round Interview Rubric',
      type: 'document'
    }
  ]);

  const [timelineEvents, setTimelineEvents] = useState([]);
  const [userTeam, setUserTeam] = useState(null);
  const [teamLoading, setTeamLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [error, setError] = useState('');
  const [timelineScrollPosition, setTimelineScrollPosition] = useState(0);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Fetch events from the current recruitment cycle
  const fetchTimelineEvents = async () => {
    try {
      setLoading(true);
      setError('');
      
      // Fetch all events from member endpoint (no admin auth required)
      const events = await apiClient.get('/member/events');
      
      // Sort by start date and map to timeline format
      const timelineEvents = events
        .sort((a, b) => new Date(a.eventStartDate) - new Date(b.eventStartDate))
        .map(event => {
          const eventDate = new Date(event.eventStartDate);
          const now = new Date();
          const isCompleted = eventDate < now;
          
          return {
            id: event.id,
            title: event.eventName,
            date: eventDate.toLocaleDateString('en-US', {
              month: 'numeric',
              day: 'numeric',
              year: '2-digit'
            }),
            status: isCompleted ? 'completed' : 'pending',
            eventStartDate: event.eventStartDate,
            eventEndDate: event.eventEndDate,
            eventLocation: event.eventLocation
          };
        });
      
      setTimelineEvents(timelineEvents);
    } catch (err) {
      console.error('Error fetching timeline events:', err);
      setError('Failed to load recruitment timeline events');
    } finally {
      setLoading(false);
    }
  };

  // Fetch user's team information
  const fetchUserTeam = async () => {
    try {
      setTeamLoading(true);
      const team = await apiClient.get('/member/my-team');
      setUserTeam(team);
    } catch (err) {
      console.error('Error fetching user team:', err);
      // Don't set error for team - user might not be assigned to a team yet
    } finally {
      setTeamLoading(false);
    }
  };

  // Fetch member tasks (document grading and RSVP tasks)
  const fetchMemberTasks = async () => {
    try {
      setTasksLoading(true);
      
      // Fetch member applications for document grading tasks
      const applications = await apiClient.get(`/review-teams/member-applications/${user.id}`);
      
      // Fetch events with RSVP information
      const events = await apiClient.get('/member/events');
      
      const tasksList = [];
      
      // Add document grading tasks
      if (applications && applications.length > 0) {
        const applicationsWithResumes = applications.filter(app => app.resumeUrl && !app.hasResumeScore);
        const applicationsWithCoverLetters = applications.filter(app => app.coverLetterUrl && !app.hasCoverLetterScore);
        const applicationsWithVideos = applications.filter(app => app.videoUrl && !app.hasVideoScore);
        
        if (applicationsWithResumes.length > 0) {
          tasksList.push({
            id: 'grade-resumes',
            title: 'Grade Resumes',
            type: 'document',
            documentType: 'resume',
            dueDate: 'Oct 4th, Morning',
            items: `${applicationsWithResumes.length} items to review`,
            status: 'pending',
            count: applicationsWithResumes.length
          });
        }
        
        if (applicationsWithCoverLetters.length > 0) {
          tasksList.push({
            id: 'grade-cover-letters',
            title: 'Grade Cover Letters',
            type: 'document',
            documentType: 'coverLetter',
            dueDate: 'Oct 4th, Morning',
            items: `${applicationsWithCoverLetters.length} items to review`,
            status: 'pending',
            count: applicationsWithCoverLetters.length
          });
        }
        
        if (applicationsWithVideos.length > 0) {
          tasksList.push({
            id: 'grade-videos',
            title: 'Grade Videos',
            type: 'document',
            documentType: 'video',
            dueDate: 'Oct 4th, Morning',
            items: `${applicationsWithVideos.length} items to review`,
            status: 'pending',
            count: applicationsWithVideos.length
          });
        }
      }
      
      // Add RSVP tasks for events that have member RSVP URLs and the member hasn't RSVP'd yet
      const eventsNeedingRsvp = events.filter(event => 
        event.memberRsvpUrl && 
        event.eventStartDate && 
        new Date(event.eventStartDate) > new Date() && // Only future events
        !event.hasMemberRsvpd
      );
      
      eventsNeedingRsvp.forEach(event => {
        tasksList.push({
          id: `rsvp-${event.id}`,
          title: `RSVP for ${event.eventName}`,
          type: 'rsvp',
          eventId: event.id,
          eventName: event.eventName,
          eventDate: new Date(event.eventStartDate).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
          }),
          dueDate: new Date(event.eventStartDate).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric'
          }),
          items: 'Pending Response',
          status: 'pending',
          rsvpUrl: event.memberRsvpUrl
        });
      });
      
      setTasks(tasksList);
    } catch (err) {
      console.error('Error fetching member tasks:', err);
      setTasks([]);
    } finally {
      setTasksLoading(false);
    }
  };

  const handleTimelineScroll = (direction) => {
    const timelineContainer = document.getElementById('member-timeline-container');
    if (!timelineContainer) return;

    const scrollAmount = 200; // pixels to scroll
    const newPosition = direction === 'left' 
      ? timelineScrollPosition - scrollAmount 
      : timelineScrollPosition + scrollAmount;

    timelineContainer.scrollTo({
      left: newPosition,
      behavior: 'smooth'
    });

    setTimelineScrollPosition(newPosition);
  };

  const updateScrollButtons = () => {
    const timelineContainer = document.getElementById('member-timeline-container');
    if (!timelineContainer) return;

    const { scrollLeft, scrollWidth, clientWidth } = timelineContainer;
    setCanScrollLeft(scrollLeft > 0);
    setCanScrollRight(scrollLeft < scrollWidth - clientWidth);
    setTimelineScrollPosition(scrollLeft);
  };

  useEffect(() => {
    fetchTimelineEvents();
    fetchUserTeam();
    fetchMemberTasks();
  }, [user?.id]);

  // Update scroll button states when timeline events change
  useEffect(() => {
    if (timelineEvents.length > 0) {
      // Use setTimeout to ensure DOM is updated
      setTimeout(updateScrollButtons, 100);
    }
  }, [timelineEvents]);

  const handleStartTask = (task) => {
    if (task.type === 'document') {
      // Navigate to document grading page
      window.location.href = '/document-grading';
    } else if (task.type === 'rsvp') {
      // Open RSVP form in new tab
      window.open(task.rsvpUrl, '_blank');
    }
  };

  const handleViewMore = (section) => {
    // TODO: Implement navigation to detailed views
    console.log('View more:', section);
  };

  const handleResourceAction = (resourceId, action) => {
    // TODO: Implement resource actions
    console.log('Resource action:', resourceId, action);
  };

  // Calculate team progress for different review types
  const calculateTeamProgress = (team) => {
    if (!team || !team.applications || team.applications.length === 0) {
      return { resume: 0, coverLetter: 0, video: 0 };
    }
    
    const totalApplications = team.applications.length;
    const resumeCompleted = team.applications.filter(a => a.resumeProgress === 100).length;
    const coverLetterCompleted = team.applications.filter(a => a.coverLetterProgress === 100).length;
    const videoCompleted = team.applications.filter(a => a.videoProgress === 100).length;
    
    return {
      resume: Math.round((resumeCompleted / totalApplications) * 100),
      coverLetter: Math.round((coverLetterCompleted / totalApplications) * 100),
      video: Math.round((videoCompleted / totalApplications) * 100)
    };
  };

  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <Box sx={{ maxWidth: 1200, mx: 'auto', p: 0 }}>
      {/* Welcome Section */}
      <Box sx={{ mb: 4 }}>
        <Typography variant="h3" component="h1" sx={{ fontWeight: 700, color: 'primary.dark' }}>
          Welcome, {user?.fullName}.
        </Typography>
      </Box>

      {/* Recruitment Timeline Section */}
      <Paper sx={{ p: 3, mb: 4 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
          <Typography variant="h5" component="h2" sx={{ fontWeight: 700, color: 'primary.dark' }}>
            Recruitment Timeline
          </Typography>
          <Button
            variant="text"
            endIcon={<ArrowTopRightOnSquareIcon />}
            onClick={() => handleViewMore('timeline')}
            sx={{ color: 'primary.main' }}
          >
            View More
          </Button>
        </Box>
        
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}
        
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
            <CircularProgress />
          </Box>
        ) : timelineEvents.length === 0 ? (
          <Box sx={{ textAlign: 'center', p: 4 }}>
            <Typography variant="body1" color="text.secondary">
              No events found for the current recruitment cycle.
            </Typography>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
            <IconButton
              onClick={() => handleTimelineScroll('left')}
              disabled={!canScrollLeft}
              sx={{
                bgcolor: 'grey.100',
                border: 1,
                borderColor: 'grey.300',
                '&:hover': { bgcolor: 'primary.main', color: 'white' },
                '&:disabled': { 
                  bgcolor: 'grey.50', 
                  color: 'grey.400',
                  borderColor: 'grey.200'
                }
              }}
            >
              <ChevronLeftIcon />
            </IconButton>
            
            <Box 
              id="member-timeline-container"
              sx={{ 
                display: 'flex', 
                alignItems: 'center', 
                flex: 1, 
                mx: 2, 
                gap: 4, 
                overflowX: 'auto',
                scrollbarWidth: 'none', // Firefox
                '&::-webkit-scrollbar': { display: 'none' } // Chrome, Safari
              }}
              onScroll={updateScrollButtons}
            >
              {timelineEvents.map((event, index) => (
                <Box key={event.id} sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 120 }}>
                  <Box
                    sx={{
                      width: 40,
                      height: 40,
                      borderRadius: '50%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      mb: 1.5,
                      bgcolor: event.status === 'completed' ? 'success.main' : 'grey.500',
                      color: 'white',
                      position: 'relative',
                      zIndex: 2
                    }}
                  >
                    {event.status === 'completed' ? <CheckIcon /> : <ClockIcon />}
                  </Box>
                  <Box sx={{ textAlign: 'center' }}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
                      {event.title}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {event.date}
                    </Typography>
                  </Box>
                  {index < timelineEvents.length - 1 && (
                    <Box
                      sx={{
                        position: 'absolute',
                        top: 20,
                        left: '50%',
                        width: 32,
                        height: 2,
                        bgcolor: 'grey.300',
                        zIndex: 1
                      }}
                    />
                  )}
                </Box>
              ))}
            </Box>
            
            <IconButton
              onClick={() => handleTimelineScroll('right')}
              disabled={!canScrollRight}
              sx={{
                bgcolor: 'grey.100',
                border: 1,
                borderColor: 'grey.300',
                '&:hover': { bgcolor: 'primary.main', color: 'white' },
                '&:disabled': { 
                  bgcolor: 'grey.50', 
                  color: 'grey.400',
                  borderColor: 'grey.200'
                }
              }}
            >
              <ChevronRightIcon />
            </IconButton>
          </Box>
        )}
      </Paper>

      {/* Tasks and Resources Container */}
      <Grid container spacing={3}>
        {/* Your Tasks Section */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Paper sx={{ height: 'fit-content' }}>
            <Box
              sx={{
                bgcolor: 'primary.main',
                color: 'white',
                p: 2,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                borderRadius: '4px 4px 0 0'
              }}
            >
              <Typography variant="h6" component="h2" sx={{ color: 'white', fontWeight: 700 }}>
                Your Tasks
              </Typography>
              <Chip
                label={`${tasks.filter(task => task.status === 'pending').length} Pending`}
                sx={{ bgcolor: 'white', color: 'primary.dark', fontWeight: 600 }}
                size="small"
              />
            </Box>
            
            <Box>
              {tasksLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
                  <CircularProgress />
                </Box>
              ) : tasks.length === 0 ? (
                <Box sx={{ textAlign: 'center', p: 4 }}>
                  <Typography variant="body1" color="text.secondary">
                    No pending tasks at this time.
                  </Typography>
                </Box>
              ) : (
                tasks.map((task, index) => (
                  <Box
                    key={task.id}
                    sx={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      p: 3,
                      borderBottom: index < tasks.length - 1 ? 1 : 0,
                      borderColor: 'grey.200'
                    }}
                  >
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
                        {task.title}
                      </Typography>
                      <Box sx={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <ClockIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                          <Typography variant="body2" color="text.secondary">
                            {task.type === 'rsvp' ? `Event: ${task.eventDate}` : `Due: ${task.dueDate}`}
                          </Typography>
                        </Box>
                        <Typography variant="body2" color="text.secondary">
                          {task.items}
                        </Typography>
                      </Box>
                    </Box>
                    <Button
                      variant="contained"
                      size="small"
                      onClick={() => handleStartTask(task)}
                      sx={{ ml: 2 }}
                    >
                      {task.type === 'rsvp' ? 'RSVP' : 'Start'}
                    </Button>
                  </Box>
                ))
              )}
            </Box>
          </Paper>
        </Grid>

        {/* Resources Section */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Paper sx={{ height: 'fit-content', mr: { xs: 0, md: -8.5 } }}>
            <Box
              sx={{
                bgcolor: 'primary.main',
                color: 'white',
                p: 2,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                borderRadius: '4px 4px 0 0'
              }}
            >
              <Typography variant="h6" component="h2" sx={{ color: 'white', fontWeight: 700 }}>
                Resources
              </Typography>
              <Button
                variant="text"
                endIcon={<ArrowTopRightOnSquareIcon />}
                onClick={() => handleViewMore('resources')}
                sx={{ color: 'white' }}
                size="small"
              >
                View More
              </Button>
            </Box>
            
            <Box>
              {resources.map((resource, index) => (
                <Box
                  key={resource.id}
                  sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    p: 2,
                    borderBottom: index < resources.length - 1 ? 1 : 0,
                    borderColor: 'grey.200'
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <DocumentTextIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {resource.title}
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    <IconButton
                      size="small"
                      onClick={() => handleResourceAction(resource.id, 'download')}
                      sx={{
                        border: 1,
                        borderColor: 'grey.300',
                        '&:hover': { bgcolor: 'grey.100' }
                      }}
                    >
                      <ArrowDownTrayIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                    <IconButton
                      size="small"
                      onClick={() => handleResourceAction(resource.id, 'external')}
                      sx={{
                        border: 1,
                        borderColor: 'grey.300',
                        '&:hover': { bgcolor: 'grey.100' }
                      }}
                    >
                      <ArrowTopRightOnSquareIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Box>
                </Box>
              ))}
            </Box>
          </Paper>
        </Grid>
      </Grid>

      {/* Review Team Section */}
      {!teamLoading && (
        <Paper sx={{ p: 3, mt: 4 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
            <Typography variant="h5" component="h2" sx={{ fontWeight: 700, color: 'primary.dark' }}>
              Review Team
            </Typography>
            <Button
              variant="text"
              endIcon={<ArrowTopRightOnSquareIcon />}
              onClick={() => handleViewMore('team')}
              sx={{ color: 'primary.main' }}
            >
              View Team Details
            </Button>
          </Box>
          
          {!userTeam ? (
            <Box sx={{ textAlign: 'center', p: 4 }}>
              <GroupIcon sx={{ fontSize: 60, color: 'grey.400', mb: 2 }} />
              <Typography variant="h6" color="text.secondary" sx={{ mb: 1 }}>
                No Team Assigned
              </Typography>
              <Typography variant="body2" color="text.secondary">
                You haven't been assigned to a review team yet. Contact an administrator.
              </Typography>
            </Box>
          ) : (
            <Grid container spacing={3}>
              {/* Team Members */}
              <Grid size={{ xs: 12, md: 6 }}>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 600, mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <PersonIcon sx={{ fontSize: 20 }} />
                    Team Members
                  </Typography>
                  <Stack spacing={2}>
                    {userTeam.members.map((member, index) => (
                      <Box
                        key={member.id}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 2,
                          p: 2,
                          border: 1,
                          borderColor: 'grey.200',
                          borderRadius: 1,
                          bgcolor: member.id === user?.id ? 'primary.50' : 'transparent'
                        }}
                      >
                        <Box
                          sx={{
                            width: 40,
                            height: 40,
                            borderRadius: '50%',
                            bgcolor: 'primary.main',
                            color: 'white',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontWeight: 600,
                            fontSize: '0.875rem'
                          }}
                        >
                          {member.name.split(' ').map(n => n[0]).join('')}
                        </Box>
                        <Box sx={{ flex: 1 }}>
                          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                            {member.name}
                            {member.id === user?.id && (
                              <Chip 
                                label="You" 
                                size="small" 
                                color="primary" 
                                variant="outlined" 
                                sx={{ ml: 1 }}
                              />
                            )}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {member.email}
                          </Typography>
                        </Box>
                      </Box>
                    ))}
                  </Stack>
                </Box>
              </Grid>

              {/* Team Progress */}
              <Grid size={{ xs: 12, md: 6 }}>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 600, mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <GroupIcon sx={{ fontSize: 20 }} />
                    Team Progress
                  </Typography>
                  
                  <Box sx={{ mb: 3 }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                      <Typography variant="body2" color="text.secondary">
                        Applications Assigned
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {userTeam.applications?.length || 0}
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                      <Typography variant="body2" color="text.secondary">
                        Team Code
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600, fontFamily: 'monospace' }}>
                        {userTeam.code}
                      </Typography>
                    </Box>
                  </Box>

                  {userTeam.applications && userTeam.applications.length > 0 ? (
                    <Box>
                      <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 2 }}>
                        Review Progress
                      </Typography>
                      <Stack spacing={2}>
                        <Box>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                            <Typography variant="body2" color="text.secondary">
                              Resume Reviews
                            </Typography>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                              {calculateTeamProgress(userTeam).resume}%
                            </Typography>
                          </Box>
                          <Box sx={{ width: '100%', bgcolor: 'grey.200', borderRadius: 1, height: 8 }}>
                            <Box
                              sx={{
                                width: `${calculateTeamProgress(userTeam).resume}%`,
                                height: '100%',
                                bgcolor: 'primary.main',
                                borderRadius: 1,
                                transition: 'width 0.3s ease'
                              }}
                            />
                          </Box>
                        </Box>
                        
                        <Box>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                            <Typography variant="body2" color="text.secondary">
                              Cover Letter Reviews
                            </Typography>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                              {calculateTeamProgress(userTeam).coverLetter}%
                            </Typography>
                          </Box>
                          <Box sx={{ width: '100%', bgcolor: 'grey.200', borderRadius: 1, height: 8 }}>
                            <Box
                              sx={{
                                width: `${calculateTeamProgress(userTeam).coverLetter}%`,
                                height: '100%',
                                bgcolor: 'success.main',
                                borderRadius: 1,
                                transition: 'width 0.3s ease'
                              }}
                            />
                          </Box>
                        </Box>
                        
                        <Box>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                            <Typography variant="body2" color="text.secondary">
                              Video Reviews
                            </Typography>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                              {calculateTeamProgress(userTeam).video}%
                            </Typography>
                          </Box>
                          <Box sx={{ width: '100%', bgcolor: 'grey.200', borderRadius: 1, height: 8 }}>
                            <Box
                              sx={{
                                width: `${calculateTeamProgress(userTeam).video}%`,
                                height: '100%',
                                bgcolor: 'warning.main',
                                borderRadius: 1,
                                transition: 'width 0.3s ease'
                              }}
                            />
                          </Box>
                        </Box>
                      </Stack>
                    </Box>
                  ) : (
                    <Box sx={{ textAlign: 'center', p: 3 }}>
                      <Typography variant="body2" color="text.secondary">
                        No applications assigned to your team yet.
                      </Typography>
                    </Box>
                  )}
                </Box>
              </Grid>
            </Grid>
          )}
        </Paper>
      )}
    </Box>
    </AccessControl>
  );
}
