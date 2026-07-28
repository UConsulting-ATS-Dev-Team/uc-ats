import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import MemberAvatar from '../components/MemberAvatar';
import AuthenticatedAvatar from '../components/AuthenticatedAvatar';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Box, 
  Paper, 
  Typography, 
  Button, 
  Avatar, 
  Chip, 
  LinearProgress,
  Stack,
  Divider,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Grid,
  Autocomplete,
  Alert
} from '@mui/material';
import {
  PlusIcon,
  UserPlusIcon,
  TrashIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  PencilIcon
} from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';

// Draggable Application Component
function DraggableApplication({ application, teamId, onRemove, onClick, isDragging, editMode }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: isDraggingState,
  } = useSortable({ 
    id: `${teamId}-${application.id}`,
    disabled: !editMode // Disable dragging when not in edit mode
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDraggingState ? 0.5 : 1,
  };

  return (
    <Paper
      ref={setNodeRef}
      style={style}
      {...(editMode ? { ...attributes, ...listeners } : {})}
      sx={{
        p: 2,
        border: '1px solid',
        borderColor: 'divider',
        backgroundColor: 'background.paper',
        cursor: editMode ? 'grab' : 'pointer',
        transition: 'all 0.2s ease-in-out',
        '&:hover': {
          borderColor: 'primary.main',
          backgroundColor: 'rgba(4, 39, 66, 0.04)',
          transform: editMode ? 'translateY(-1px)' : 'none',
          boxShadow: editMode ? '0 4px 8px rgba(0, 0, 0, 0.1)' : 'none'
        },
        '&:active': {
          cursor: editMode ? 'grabbing' : 'pointer',
        }
      }}
      onClick={(e) => {
        // Only handle click if not dragging
        if (!isDraggingState) {
          e.stopPropagation();
          onClick(application.id);
        }
      }}
    >
      <Grid container spacing={2} alignItems="center">
        <Grid item>
          <Avatar
            sx={{
              width: 48,
              height: 48,
              bgcolor: 'primary.main',
              fontSize: '1rem'
            }}
          >
            {application.avatar ? (
              <img src={application.avatar} alt={application.name} />
            ) : (
              application.name.split(' ').map(n => n[0]).join('')
            )}
          </Avatar>
        </Grid>
        
        <Grid item xs>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            {application.name}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {application.major} - {application.year} - GPA: {application.gpa}
          </Typography>
        </Grid>
        
        <Grid item>
          <Chip
            label={application.status}
            color="primary"
            size="small"
            sx={{ fontWeight: 500 }}
          />
        </Grid>
        
        <Grid item>
          <Stack direction="row" spacing={1}>
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                onClick(application.id);
              }}
              sx={{
                color: 'primary.main',
                '&:hover': {
                  backgroundColor: 'primary.light',
                  color: 'text.primary'
                }
              }}
            >
              <ArrowTopRightOnSquareIcon style={{ width: '1rem', height: '1rem' }} />
            </IconButton>
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(teamId, application.id);
              }}
              sx={{
                color: 'error.main',
                '&:hover': {
                  backgroundColor: 'error.light',
                  color: 'error.contrastText'
                }
              }}
            >
              <TrashIcon style={{ width: '1rem', height: '1rem' }} />
            </IconButton>
          </Stack>
        </Grid>
      </Grid>
    </Paper>
  );
}

export default function ReviewTeams() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [newTeamDialogOpen, setNewTeamDialogOpen] = useState(false);
  const [addCandidateDialogOpen, setAddCandidateDialogOpen] = useState(false);
  const [addMemberDialogOpen, setAddMemberDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameTeamData, setRenameTeamData] = useState({ teamId: null, name: '' });
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [newTeamData, setNewTeamData] = useState({ 
    name: '', 
    description: '', 
    selectedMembers: [] 
  });
  const [expandedTeams, setExpandedTeams] = useState(new Set());
  const [users, setUsers] = useState([]);
  const [availableApplications, setAvailableApplications] = useState([]);
  const [clickedApplicationId, setClickedApplicationId] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [contributionsByTeam, setContributionsByTeam] = useState({});
  const [reminderPending, setReminderPending] = useState(new Set());
  const [reminderResult, setReminderResult] = useState({});

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Only start dragging after moving 8px
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Calculate team progress for different review types
  const calculateTeamProgress = (team) => {
    // Handle both old (candidates) and new (applications) data structures
    const applications = team.applications || team.candidates || [];
    if (applications.length === 0) return { resume: 0, coverLetter: 0, video: 0 };

    // Calculate average progress across all applications
    const totalApplications = applications.length;
    const resumeTotal = applications.reduce((sum, a) => sum + (a.resumeProgress || 0), 0);
    const coverLetterTotal = applications.reduce((sum, a) => sum + (a.coverLetterProgress || 0), 0);
    const videoTotal = applications.reduce((sum, a) => sum + (a.videoProgress || 0), 0);

    return {
      resume: Math.round(resumeTotal / totalApplications),
      coverLetter: Math.round(coverLetterTotal / totalApplications),
      video: Math.round(videoTotal / totalApplications)
    };
  };

  // Load data from API
  useEffect(() => {
    if (!user) return; // Don't load data if user is not authenticated
    
    const loadData = async () => {
      try {
        setLoading(true);
        
        // Load teams, available applications, and users in parallel
        const requests = [
          apiClient.get('/review-teams'),
          apiClient.get('/review-teams/available-applications'),
          apiClient.get('/review-teams/users')
        ];
        if (user.role === 'ADMIN') requests.push(apiClient.get('/review-teams/contributions'));
        const [teamsResponse, applicationsResponse, usersResponse, contributionsResponse] = await Promise.all(requests);

        console.log('Teams response:', teamsResponse);
        console.log('Applications response:', applicationsResponse);
        console.log('Users response:', usersResponse);

        setTeams(teamsResponse);
        setAvailableApplications(applicationsResponse);
        setUsers(usersResponse);
        setContributionsByTeam(Object.fromEntries((contributionsResponse || []).map(team => [team.groupId, team.members])));
      } catch (err) {
        console.error('Error loading data:', err);
        setError('Failed to load teams data');
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [user]);

  const handleCreateTeam = async () => {
    if (newTeamData.name.trim()) {
      try {
        // Get the active cycle ID
        const activeCycle = await apiClient.get('/admin/cycles/active');
        
        // Extract member IDs from selected members array
        const memberIds = newTeamData.selectedMembers.map(member => member.id);
        
        const newTeam = await apiClient.post('/review-teams', {
          memberIds,
          cycleId: activeCycle.id
        });
        
        setTeams([newTeam, ...teams]);
        setNewTeamData({ 
          name: '', 
          description: '', 
          selectedMembers: [] 
        });
        setNewTeamDialogOpen(false);
      } catch (err) {
        console.error('Error creating team:', err);
        setError(err.message || 'Failed to create team');
      }
    }
  };

  const handleAddApplication = (teamId) => {
    setSelectedTeam(teamId);
    setAddCandidateDialogOpen(true);
  };

  const handleAddMember = (teamId) => {
    setSelectedTeam(teamId);
    setAddMemberDialogOpen(true);
  };

  const handleOpenRenameDialog = (team) => {
    setRenameTeamData({ teamId: team.id, name: team.name });
    setRenameDialogOpen(true);
  };

  const handleRenameTeam = async () => {
    if (!renameTeamData.name.trim()) {
      setError('Team name is required');
      return;
    }

    try {
      await apiClient.put(`/review-teams/${renameTeamData.teamId}/rename`, {
        name: renameTeamData.name
      });

      // Update the teams state with the new name
      setTeams(teams.map(team =>
        team.id === renameTeamData.teamId
          ? { ...team, name: renameTeamData.name }
          : team
      ));

      setSuccess('Team renamed successfully!');
      setTimeout(() => setSuccess(''), 3000);
      setRenameDialogOpen(false);
      setRenameTeamData({ teamId: null, name: '' });
    } catch (err) {
      console.error('Error renaming team:', err);
      setError('Failed to rename team');
    }
  };

  const handleAddMemberToTeam = async (memberId) => {
    try {
      const team = teams.find(t => t.id === selectedTeam);
      if (!team) return;

      // Add the new member to the team
      await apiClient.put(`/review-teams/${selectedTeam}/members`, {
        memberId
      });

      // Refresh the data
      await refreshData();
      
      setSuccess('Team member added successfully!');
      setTimeout(() => setSuccess(''), 3000);
      setAddMemberDialogOpen(false);
      setSelectedTeam(null);
      
    } catch (error) {
      console.error('Error adding team member:', error);
      setError(error.message || 'Failed to add team member');
    }
  };

  const handleRemoveMemberFromTeam = async (teamId, memberId) => {
    try {
      // Call the API to remove the member
      await apiClient.delete(`/review-teams/${teamId}/members/${memberId}`);

      // Refresh the data
      await refreshData();
      
      setSuccess('Team member removed successfully!');
      setTimeout(() => setSuccess(''), 3000);
      
    } catch (error) {
      console.error('Error removing team member:', error);
      setError(error.message || 'Failed to remove team member');
    }
  };

    const handleAddApplicationToTeam = async (applicationId) => {
    try {
      const newApplication = await apiClient.post(`/review-teams/${selectedTeam}/assign-application`, {
        applicationId
      });
      
      // Update teams state
      const updatedTeams = teams.map(team => {
        if (team.id === selectedTeam) {
          return {
            ...team,
            applications: [...team.applications, newApplication]
          };
        }
        return team;
      });
      
      // Remove application from available applications
      const updatedAvailableApplications = availableApplications.filter(a => a.id !== applicationId);
      
      setTeams(updatedTeams);
      setAvailableApplications(updatedAvailableApplications);
      setAddCandidateDialogOpen(false);
      setSelectedTeam(null);
    } catch (err) {
      console.error('Error assigning application:', err);
      setError('Failed to assign application to team');
    }
  };

  const handleRemoveApplicationFromTeam = async (teamId, applicationId) => {
    try {
      await apiClient.delete(`/review-teams/${teamId}/remove-application/${applicationId}`);
      
      // Update teams state
      const updatedTeams = teams.map(team => {
        if (team.id === teamId) {
          return {
            ...team,
            applications: team.applications.filter(a => a.id !== applicationId)
          };
        }
        return team;
      });
      
      // Add application back to available applications
      const applicationToRemove = teams
        .find(team => team.id === teamId)
        ?.applications.find(a => a.id === applicationId);
      
      if (applicationToRemove) {
        setAvailableApplications([...availableApplications, applicationToRemove]);
      }
      
      setTeams(updatedTeams);
    } catch (err) {
      console.error('Error removing application:', err);
      setError('Failed to remove application from team');
    }
  };

  const toggleTeamExpansion = (teamId) => {
    const newExpandedTeams = new Set(expandedTeams);
    if (newExpandedTeams.has(teamId)) {
      newExpandedTeams.delete(teamId);
    } else {
      newExpandedTeams.add(teamId);
    }
    setExpandedTeams(newExpandedTeams);
  };

  const isTeamExpanded = (teamId) => expandedTeams.has(teamId);

  const handleApplicationClick = async (applicationId) => {
    try {
      setClickedApplicationId(applicationId);
      // Navigate directly to the application detail page
      navigate(`/application/${applicationId}`);
    } catch (error) {
      console.error('Error opening application:', error);
      setError('Failed to open application. Please try again.');
    } finally {
      setClickedApplicationId(null);
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'SUBMITTED':
        return 'primary';
      case 'APPROVED':
        return 'success';
      case 'REJECTED':
        return 'error';
      case 'PENDING':
        return 'warning';
      default:
        return 'default';
    }
  };

  const handleDragEnd = async (event) => {
    const { active, over } = event;

    if (!active || !over) {
      return;
    }

    const activeId = active.id;
    const overId = over.id;

    // Parse the IDs to get team and application IDs
    const [activeTeamId, activeApplicationId] = activeId.split('-');
    const [overTeamId, overApplicationId] = overId.split('-');

    // If dropping on a different team
    if (activeTeamId !== overTeamId) {
      try {
        // Move the application to the new team
        await apiClient.post(`/review-teams/${overTeamId}/assign-application`, {
          applicationId: activeApplicationId
        });

        // Refresh the data to show the updated assignments
        await refreshData();
        
        setSuccess(`Application moved to ${teams.find(t => t.id === overTeamId)?.name || 'new team'}`);
        setTimeout(() => setSuccess(''), 3000);
        
      } catch (error) {
        console.error('Error moving application:', error);
        setError('Failed to move application');
      }
    }
  };

  const handleAutoDistribute = async () => {
    try {
      setLoading(true);
      setError('');
      setSuccess('');
      
      // Call the backend endpoint to auto-distribute applications
      const response = await apiClient.post('/review-teams/auto-distribute');
      
      // Show success message
      setSuccess(response.message || 'Applications distributed successfully!');
      
      // Refresh the data to show the updated assignments
      await refreshData();
      
      // Clear success message after 5 seconds
      setTimeout(() => setSuccess(''), 5000);
      
    } catch (err) {
      console.error('Error auto-distributing applications:', err);
      setError('Failed to auto-distribute applications');
    } finally {
      setLoading(false);
    }
  };

  const getReminderKey = (teamId, memberId) => `${teamId}:${memberId}`;

  const handleSendReminder = async (teamId, memberId) => {
    const key = getReminderKey(teamId, memberId);
    if (reminderPending.has(key)) return;

    setReminderPending(prev => new Set(prev).add(key));
    setReminderResult(prev => ({ ...prev, [key]: {} }));

    try {
      await apiClient.post(`/review-teams/${teamId}/reviewers/${memberId}/reminder`);
      setReminderResult(prev => ({ ...prev, [key]: { success: true } }));
    } catch (err) {
      const message = err.message || 'Failed to send reminder';
      setReminderResult(prev => ({ ...prev, [key]: { error: message } }));
    } finally {
      setReminderPending(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const refreshData = async () => {
    try {
      setLoading(true);
      const requests = [
        apiClient.get('/review-teams'),
        apiClient.get('/review-teams/available-applications'),
        apiClient.get('/review-teams/users')
      ];
      if (user.role === 'ADMIN') requests.push(apiClient.get('/review-teams/contributions'));
      const [teamsResponse, applicationsResponse, usersResponse, contributionsResponse] = await Promise.all(requests);
      setTeams(teamsResponse);
      setAvailableApplications(applicationsResponse);
      setUsers(usersResponse);
      setContributionsByTeam(Object.fromEntries((contributionsResponse || []).map(team => [team.groupId, team.members])));
      setError('');
    } catch (err) {
      console.error('Error refreshing data:', err);
      setError('Failed to refresh data');
    } finally {
      setLoading(false);
    }
  };

  if (!user) {
    return (
      <Box>
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="h4" gutterBottom>
            Authentication Required
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Please log in to view review teams.
          </Typography>
        </Paper>
      </Box>
    );
  }

  if (loading) {
    return (
      <Box>
        <Typography variant="h4" gutterBottom>Review Teams</Typography>
        <LinearProgress />
      </Box>
    );
  }

  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <Box>
      {/* Header */}
      <Stack direction={{ xs: 'column', md: 'row' }} alignItems={{ xs: 'flex-start', md: 'center' }} justifyContent="space-between" spacing={{ xs: 2, md: 0 }} mb={3}>
        <Typography variant="h4" sx={{ fontWeight: 700, color: 'primary.main' }}>
          Review Teams
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ flexWrap: 'wrap', width: { xs: '100%', md: 'auto' } }}>
          <Button
            variant="outlined"
            startIcon={<ArrowPathIcon style={{ width: '1.25rem', height: '1.25rem' }} />}
            onClick={refreshData}
            disabled={loading}
            sx={{
              borderColor: 'primary.main',
              color: 'primary.main',
              '&:hover': {
                borderColor: 'primary.dark',
                backgroundColor: 'rgba(4, 39, 66, 0.04)'
              }
            }}
          >
            Refresh
          </Button>
          <Button
            variant={editMode ? "contained" : "outlined"}
            startIcon={<ArrowTopRightOnSquareIcon style={{ width: '1.25rem', height: '1.25rem' }} />}
            onClick={() => setEditMode(!editMode)}
            sx={{
              borderColor: editMode ? 'warning.main' : 'primary.main',
              color: editMode ? 'warning.contrastText' : 'primary.main',
              backgroundColor: editMode ? 'warning.main' : 'transparent',
              '&:hover': {
                borderColor: editMode ? 'warning.dark' : 'primary.dark',
                backgroundColor: editMode ? 'warning.dark' : 'rgba(4, 39, 66, 0.04)'
              }
            }}
          >
            {editMode ? 'Exit Edit Mode' : 'Edit Mode'}
          </Button>
          <Button
            variant="contained"
            startIcon={<UserPlusIcon style={{ width: '1.25rem', height: '1.25rem' }} />}
            onClick={handleAutoDistribute}
            disabled={loading || teams.length === 0}
            sx={{
              backgroundColor: 'secondary.main',
              color: 'secondary.contrastText',
              '&:hover': {
                backgroundColor: 'secondary.dark'
              }
            }}
          >
            Auto-Distribute Applications
          </Button>
          <Button
            variant="outlined"
            startIcon={<PlusIcon style={{ width: '1.25rem', height: '1.25rem' }} />}
            onClick={() => setNewTeamDialogOpen(true)}
            sx={{
              borderColor: 'primary.main',
              color: 'primary.main',
              '&:hover': {
                borderColor: 'primary.dark',
                backgroundColor: 'rgba(4, 39, 66, 0.04)'
              }
            }}
          >
            New Team
          </Button>
        </Stack>
      </Stack>

      {error && (
        <Paper sx={{ p: 2, mb: 3, backgroundColor: 'error.light', color: 'error.contrastText' }}>
          {error}
        </Paper>
      )}

      {success && (
        <Paper sx={{ p: 2, mb: 3, backgroundColor: 'success.light', color: 'success.contrastText' }}>
          {success}
        </Paper>
      )}

      {/* Total Teams Stats */}
      <Grid container spacing={3} sx={{ mb: 3 }}>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3, border: '1px solid', borderColor: 'divider' }}>
            <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
              Total Teams
            </Typography>
            <Typography variant="h3" sx={{ fontWeight: 700, color: 'primary.main' }}>
              {teams.length}
            </Typography>
          </Paper>
        </Grid>
      </Grid>

      {/* Teams List */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        {teams.map((team) => {
          console.log('Team structure:', team);
          return (
          <Paper key={team.id} sx={{ p: 3, mb: 3, border: '1px solid', borderColor: 'divider' }}>
          {/* Team Header with Expand/Collapse */}
          <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <IconButton
                onClick={() => toggleTeamExpansion(team.id)}
                size="small"
                aria-label={isTeamExpanded(team.id) ? 'Collapse team' : 'Expand team'}
                sx={{
                  color: 'primary.main',
                  '&:hover': {
                    backgroundColor: 'rgba(4, 39, 66, 0.04)'
                  }
                }}
              >
                {isTeamExpanded(team.id) ? (
                  <ChevronDownIcon style={{ width: '1.25rem', height: '1.25rem' }} />
                ) : (
                  <ChevronRightIcon style={{ width: '1.25rem', height: '1.25rem' }} />
                )}
              </IconButton>
              <Typography variant="h5" sx={{ fontWeight: 700, color: 'primary.main' }}>
                {team.name}
              </Typography>
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  handleOpenRenameDialog(team);
                }}
                sx={{
                  color: 'text.secondary',
                  '&:hover': {
                    color: 'primary.main',
                    backgroundColor: 'rgba(4, 39, 66, 0.04)'
                  }
                }}
                title="Rename team"
              >
                <PencilIcon style={{ width: '1rem', height: '1rem' }} />
              </IconButton>
            </Stack>
            <Chip
              label={`${team.applications?.length || 0} applications`}
              size="small"
              variant="outlined"
              sx={{
                borderColor: 'primary.main',
                color: 'primary.main',
                fontWeight: 500
              }}
            />
          </Stack>

          {/* Collapsible Content */}
          {isTeamExpanded(team.id) && (
            <>
              {/* Team Progress Overview */}
              <Box mb={3}>
                <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 2 }}>
                  Review Progress:
                </Typography>
                <Stack spacing={2}>
                  {(() => {
                    const progress = calculateTeamProgress(team);
                    
                    return (
                      <>
                        <Box>
                          <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                            <Typography variant="body2" sx={{ fontWeight: 500 }}>
                              Resume Review
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              {progress.resume}% Complete
                            </Typography>
                          </Stack>
                          <LinearProgress
                            variant="determinate"
                            value={progress.resume}
                            sx={{
                              height: 8,
                              borderRadius: 4,
                              backgroundColor: 'grey.200',
                              '& .MuiLinearProgress-bar': {
                                borderRadius: 4,
                                backgroundColor: 'primary.main'
                              }
                            }}
                          />
                        </Box>
                        
                        <Box>
                          <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                            <Typography variant="body2" sx={{ fontWeight: 500 }}>
                              Cover Letter Review
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              {progress.coverLetter}% Complete
                            </Typography>
                          </Stack>
                          <LinearProgress
                            variant="determinate"
                            value={progress.coverLetter}
                            sx={{
                              height: 8,
                              borderRadius: 4,
                              backgroundColor: 'grey.200',
                              '& .MuiLinearProgress-bar': {
                                borderRadius: 4,
                                backgroundColor: 'secondary.main'
                              }
                            }}
                          />
                        </Box>
                        
                        <Box>
                          <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                            <Typography variant="body2" sx={{ fontWeight: 500 }}>
                              Video Review
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              {progress.video}% Complete
                            </Typography>
                          </Stack>
                          <LinearProgress
                            variant="determinate"
                            value={progress.video}
                            sx={{
                              height: 8,
                              borderRadius: 4,
                              backgroundColor: 'grey.200',
                              '& .MuiLinearProgress-bar': {
                                borderRadius: 4,
                                backgroundColor: 'success.main'
                              }
                            }}
                          />
                        </Box>
                      </>
                    );
                  })()}
                </Stack>
              </Box>

              <Divider sx={{ my: 2 }} />

              {/* Team Members */}
              <Box mb={3}>
                <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 2 }}>
                  {user.role === 'ADMIN' ? 'Individual reviewer progress:' : 'Team members:'}
                </Typography>
                {user.role === 'ADMIN' ? (
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))',
                      gap: 2
                    }}
                  >
                    {team.members.map((member) => {
                      const contribution = (contributionsByTeam[team.id] || [])
                        .find(item => item.id === member.id);

                      return (
                        <Paper
                          key={member.id}
                          variant="outlined"
                          sx={{ px: 2.5, pt: 2.5, pb: 1.25, backgroundColor: 'grey.50' }}
                        >
                            <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}>
                              <Stack direction="row" spacing={1} alignItems="center">
                                <MemberAvatar member={member} size={34} />
                                <Box>
                                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                    {member.name}
                                  </Typography>
                                  <Typography variant="body2" color="text.secondary">
                                    {contribution?.completedTotal || 0}/{contribution?.expectedTotal || 0} total grades
                                  </Typography>
                                </Box>
                              </Stack>
                              {editMode && (
                                <IconButton
                                  size="small"
                                  color="error"
                                  title="Remove team member"
                                  onClick={() => handleRemoveMemberFromTeam(team.id, member.id)}
                                >
                                  <TrashIcon style={{ width: '1rem', height: '1rem' }} />
                                </IconButton>
                              )}
                            </Stack>

                            {[
                              ['Resume', 'resume'],
                              ['Cover letter', 'coverLetter'],
                              ['Video', 'video']
                            ].map(([label, key]) => {
                              const completed = contribution?.completed?.[key] || 0;
                              const expected = contribution?.eligible?.[key] || 0;
                              const percent = expected ? Math.round((completed / expected) * 100) : 0;

                              return (
                                <Box key={key} mb={1.25}>
                                  <Stack direction="row" justifyContent="space-between" mb={0.5}>
                                    <Typography variant="body2">{label}</Typography>
                                    <Typography variant="body2" color="text.secondary">
                                      {completed}/{expected}
                                    </Typography>
                                  </Stack>
                                  <LinearProgress
                                    variant="determinate"
                                    value={Math.min(percent, 100)}
                                    sx={{ height: 6, borderRadius: 3 }}
                                  />
                                </Box>
                              );
                            })}

                            <Stack
                              direction="row"
                              alignItems="center"
                              spacing={1}
                              sx={{ mt: 1, flexWrap: 'wrap' }}
                            >
                              <Chip
                                size="small"
                                color={(contribution?.completionPercent || 0) === 100 ? 'success' : 'primary'}
                                label={`${contribution?.completionPercent || 0}% complete`}
                                sx={{ fontWeight: 600 }}
                              />
                              {user.role === 'ADMIN' && (() => {
                                const reminderKey = getReminderKey(team.id, member.id);
                                const isReminderPending = reminderPending.has(reminderKey);
                                const reminderState = reminderResult[reminderKey] || {};

                                return (
                                  <>
                                    <Button
                                      size="small"
                                      variant="outlined"
                                      disabled={isReminderPending}
                                      onClick={() => handleSendReminder(team.id, member.id)}
                                    >
                                      {isReminderPending ? 'Sending...' : 'Send reminder'}
                                    </Button>
                                    {reminderState.success && (
                                      <Alert severity="success" sx={{ py: 0.25, px: 1, fontSize: '0.75rem' }}>
                                        Reminder sent
                                      </Alert>
                                    )}
                                    {reminderState.error && (
                                      <Alert severity="error" sx={{ py: 0.25, px: 1, fontSize: '0.75rem' }}>
                                        {reminderState.error}
                                      </Alert>
                                    )}
                                  </>
                                );
                              })()}
                            </Stack>
                        </Paper>
                      );
                    })}
                  </Box>
                ) : (
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    {team.members.map((member) => (
                      <Chip
                        key={member.id}
                        label={member.name}
                        avatar={
                          <AuthenticatedAvatar member={member} size={24} />
                        }
                        sx={{ backgroundColor: 'rgba(4, 39, 66, 0.08)' }}
                      />
                    ))}
                  </Stack>
                )}
                <Box sx={{ mt: 1 }}>
                  <IconButton
                    size="small"
                    onClick={() => handleAddMember(team.id)}
                    sx={{
                      width: 32,
                      height: 32,
                      border: '1px dashed',
                      borderColor: 'divider',
                      color: 'text.secondary',
                      cursor: 'pointer',
                      '&:hover': {
                        borderColor: 'primary.main',
                        backgroundColor: 'rgba(4, 39, 66, 0.04)'
                      }
                    }}
                    title="Add team member"
                  >
                    <UserPlusIcon style={{ width: '1rem', height: '1rem' }} />
                  </IconButton>
                </Box>
              </Box>

              <Divider sx={{ my: 2 }} />

              {/* Assigned Applications */}
              <Box
                sx={{
                  minHeight: '100px',
                  border: '2px dashed',
                  borderColor: editMode ? 'primary.main' : 'grey.300',
                  borderRadius: 1,
                  p: 2,
                  backgroundColor: editMode ? 'rgba(4, 39, 66, 0.02)' : 'grey.50',
                  transition: 'all 0.2s ease-in-out',
                  '&:hover': {
                    borderColor: editMode ? 'primary.dark' : 'primary.main',
                    backgroundColor: editMode ? 'rgba(4, 39, 66, 0.04)' : 'rgba(4, 39, 66, 0.02)'
                  }
                }}
              >
                <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}>
                  <Typography variant="h6" sx={{ fontWeight: 600 }}>
                    Assigned applications to Review:
                  </Typography>
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<PlusIcon style={{ width: '1rem', height: '1rem' }} />}
                    onClick={() => handleAddApplication(team.id)}
                    sx={{
                      borderColor: 'primary.main',
                      color: 'primary.main',
                      fontSize: '0.75rem',
                      '&:hover': {
                        borderColor: 'primary.dark',
                        backgroundColor: 'rgba(4, 39, 66, 0.04)'
                      }
                    }}
                  >
                    Add Application
                  </Button>
                </Stack>

                {(team.applications || team.candidates || []).length === 0 ? (
                  <Box sx={{ textAlign: 'center', py: 3 }}>
                    <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic', mb: 1 }}>
                      No applications assigned yet.
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {editMode ? 'Drag applications from other teams to assign them here' : 'Click "Edit Mode" to enable drag and drop'}
                    </Typography>
                  </Box>
                ) : (
                  <SortableContext 
                    items={(team.applications || team.candidates || []).map(app => `${team.id}-${app.id}`)}
                    strategy={verticalListSortingStrategy}
                  >
                    <Stack spacing={2}>
                      {(team.applications || team.candidates || []).map((application) => (
                        <DraggableApplication
                          key={application.id}
                          application={application}
                          teamId={team.id}
                          onRemove={handleRemoveApplicationFromTeam}
                          onClick={handleApplicationClick}
                          isDragging={clickedApplicationId === application.id}
                          editMode={editMode}
                        />
                      ))}
                    </Stack>
                  </SortableContext>
                )}
              </Box>
            </>
          )}
        </Paper>
      );
      })}
      </DndContext>

      {/* New Team Dialog */}
      <Dialog open={newTeamDialogOpen} onClose={() => setNewTeamDialogOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ fontWeight: 600 }}>Create New Team</DialogTitle>
        <DialogContent>
          <Stack spacing={3} sx={{ mt: 1 }}>
            <TextField
              autoFocus
              label="Team Name"
              fullWidth
              variant="outlined"
              value={newTeamData.name}
              onChange={(e) => setNewTeamData({ ...newTeamData, name: e.target.value })}
              helperText="Enter a descriptive name for the team"
            />
            
            <TextField
              label="Description (Optional)"
              fullWidth
              variant="outlined"
              multiline
              rows={2}
              value={newTeamData.description}
              onChange={(e) => setNewTeamData({ ...newTeamData, description: e.target.value })}
              helperText="Brief description of the team's purpose"
            />

            <Typography variant="h6" sx={{ fontWeight: 600, mt: 2 }}>
              Team Members
            </Typography>
            
            <Autocomplete
              multiple
              fullWidth
              options={users.filter(user => user.role === 'ADMIN' || user.role === 'MEMBER')}
              getOptionLabel={(option) => option.fullName || ''}
              value={newTeamData.selectedMembers}
              onChange={(_, newValue) => {
                setNewTeamData({ ...newTeamData, selectedMembers: newValue });
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Search and select team members"
                  placeholder="Type to search for members..."
                  helperText="Select team members"
                />
              )}
              renderOption={(props, option) => {
                const { key, ...otherProps } = props;
                return (
                  <Box component="li" key={key} {...otherProps}>
                    <Stack direction="row" alignItems="center" spacing={2}>
                      <AuthenticatedAvatar member={option} size={32} />
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Typography variant="body2" sx={{ fontWeight: 500, noWrap: false }}>
                          {option.fullName}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {option.role}
                        </Typography>
                      </Box>
                    </Stack>
                  </Box>
                );
              }}
              renderTags={(value, getTagProps) =>
                value.map((option, index) => (
                  <Chip
                    {...getTagProps({ index })}
                    key={option.id}
                    label={option.fullName}
                    avatar={
                      <AuthenticatedAvatar member={option} size={20} />
                    }
                    size="small"
                  />
                ))
              }
              isOptionEqualToValue={(option, value) => option.id === value?.id}
              sx={{
                '& .MuiAutocomplete-listbox': {
                  maxHeight: '200px'
                }
              }}
            />

            <Typography variant="h6" sx={{ fontWeight: 600, mt: 2 }}>
              Initial Applications (Optional)
            </Typography>
            
            <Typography variant="body2" color="text.secondary">
              You can assign applications to this team after creation, or select some now:
            </Typography>
            
            <FormControl fullWidth>
              <InputLabel>Select Applications</InputLabel>
              <Select
                multiple
                value={[]}
                onChange={() => {}} // Will implement application selection later
                label="Select Applications"
                renderValue={(selected) => (
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                    {selected.map((value) => {
                      const application = availableApplications.find(a => a.id === value);
                      return (
                        <Chip 
                          key={value} 
                          label={application?.name || value} 
                          size="small"
                        />
                      );
                    })}
                  </Box>
                )}
              >
                {availableApplications.map((application) => (
                  <MenuItem key={application.id} value={application.id}>
                    {application.name} - {application.major} ({application.year})
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewTeamDialogOpen(false)}>Cancel</Button>
          <Button 
            onClick={handleCreateTeam} 
            variant="contained"
            disabled={!newTeamData.name.trim() || newTeamData.selectedMembers.length === 0}
          >
            Create Team
          </Button>
        </DialogActions>
      </Dialog>

      {/* Add Member Dialog */}
      <Dialog open={addMemberDialogOpen} onClose={() => setAddMemberDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 600 }}>Add Team Member</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Select a team member to add:
          </Typography>
          {users.filter(user => user.role === 'ADMIN' || user.role === 'MEMBER').length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic', textAlign: 'center', py: 3 }}>
              No available users to add as team members.
            </Typography>
          ) : (
            <Stack spacing={1}>
              {users
                .filter(user => user.role === 'ADMIN' || user.role === 'MEMBER')
                .filter(user => {
                  // Filter out users who are already team members
                  const currentTeam = teams.find(t => t.id === selectedTeam);
                  if (!currentTeam || !currentTeam.members) return true;
                  return !currentTeam.members.some(member => member.id === user.id);
                })
                .map((user) => (
                  <Paper
                    key={user.id}
                    sx={{
                      p: 2,
                      cursor: 'pointer',
                      border: '1px solid',
                      borderColor: 'divider',
                      transition: 'all 0.2s ease-in-out',
                      '&:hover': {
                        borderColor: 'primary.main',
                        backgroundColor: 'rgba(4, 39, 66, 0.04)',
                        transform: 'translateY(-1px)',
                        boxShadow: '0 4px 8px rgba(0, 0, 0, 0.1)'
                      }
                    }}
                    onClick={() => handleAddMemberToTeam(user.id)}
                  >
                    <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-between">
                      <Stack direction="row" spacing={2} alignItems="center">
                        <MemberAvatar member={user} size={40} />
                        <Box>
                          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                            {user.fullName}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {user.role} • {user.email}
                          </Typography>
                        </Box>
                      </Stack>
                      <Chip
                        label={user.role}
                        size="small"
                        color={user.role === 'ADMIN' ? 'error' : 'primary'}
                        variant="outlined"
                      />
                    </Stack>
                  </Paper>
                ))}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddMemberDialogOpen(false)}>Cancel</Button>
        </DialogActions>
      </Dialog>

      {/* Add Application Dialog */}
      <Dialog open={addCandidateDialogOpen} onClose={() => setAddCandidateDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 600 }}>Add Application to Team</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Select an application to add to the team:
          </Typography>
          {availableApplications.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic', textAlign: 'center', py: 3 }}>
              No available applications to assign. All applications are already assigned to teams.
            </Typography>
          ) : (
            <Stack spacing={1}>
              {availableApplications.map((application) => (
                <Paper
                  key={application.id}
                  sx={{
                    p: 2,
                    cursor: 'pointer',
                    border: '1px solid',
                    borderColor: 'divider',
                    transition: 'all 0.2s ease-in-out',
                    '&:hover': {
                      borderColor: 'primary.main',
                      backgroundColor: 'rgba(4, 39, 66, 0.04)',
                      transform: 'translateY(-1px)',
                      boxShadow: '0 4px 8px rgba(0, 0, 0, 0.1)'
                    }
                  }}
                  onClick={() => handleAddApplicationToTeam(application.id)}
                >
                  <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-between">
                    <Stack direction="row" spacing={2} alignItems="center">
                      <Avatar sx={{ bgcolor: 'primary.main' }}>
                        {application.name.split(' ').map(n => n[0]).join('')}
                      </Avatar>
                      <Box>
                        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                          {application.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {application.major} - {application.year} - GPA: {application.gpa}
                        </Typography>
                      </Box>
                    </Stack>
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleApplicationClick(application.id);
                      }}
                      sx={{
                        color: 'primary.main',
                        '&:hover': {
                          backgroundColor: 'primary.light',
                          color: 'primary.contrastText'
                        }
                      }}
                    >
                      <ArrowTopRightOnSquareIcon style={{ width: '1rem', height: '1rem' }} />
                    </IconButton>
                  </Stack>
                </Paper>
              ))}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddCandidateDialogOpen(false)}>Cancel</Button>
        </DialogActions>
      </Dialog>

      {/* Rename Team Dialog */}
      <Dialog open={renameDialogOpen} onClose={() => setRenameDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 600 }}>Rename Team</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            label="Team Name"
            fullWidth
            variant="outlined"
            value={renameTeamData.name}
            onChange={(e) => setRenameTeamData({ ...renameTeamData, name: e.target.value })}
            sx={{ mt: 2 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleRenameTeam();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameDialogOpen(false)}>Cancel</Button>
          <Button
            onClick={handleRenameTeam}
            variant="contained"
            disabled={!renameTeamData.name.trim()}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
    </AccessControl>
  );
}
