import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeftIcon,
  CalendarIcon,
  ClockIcon,
  MapPinIcon,
  UserGroupIcon,
  CheckIcon,
  PlayIcon,
  EyeIcon,
  PlusIcon,
  PencilIcon,
  TrashIcon,
  XMarkIcon,
  UsersIcon,
  DocumentDuplicateIcon,
  MagnifyingGlassIcon,
  ChevronDownIcon,
  ChevronUpIcon
} from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import AuthenticatedImage from '../components/AuthenticatedImage';
import '../styles/AdminAssignedInterviews.css';

const CALENDAR_STATUS_LABELS = {
  SYNCED: 'Interviewer invites sent',
  FAILED: 'Calendar invite failed',
  CANCELLED: 'Calendar invite cancelled',
  NOT_SYNCED: 'No calendar invite yet'
};

// Application Group Card Component for Admin
const AdminApplicationGroupCard = ({ group, interviewId }) => {
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const loadApplications = async () => {
    if (applications.length > 0) return; // Already loaded
    
    setLoading(true);
    try {
      const apps = await apiClient.get(`/admin/interviews/${interviewId}/applications?groupIds=${group.id}`);
      setApplications(apps);
    } catch (error) {
      console.error('Failed to load applications for group:', error);
      setApplications([]);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleExpanded = () => {
    if (!expanded) {
      loadApplications();
    }
    setExpanded(!expanded);
  };

  return (
    <div className="application-group-card">
      <div className="group-card-header" onClick={handleToggleExpanded}>
        <div className="group-info">
          <UserGroupIcon className="group-icon" />
          <div className="group-details">
            <h4 className="group-name">{group.name}</h4>
            <p className="group-meta">
              {group.applicationIds?.length || 0} candidates
            </p>
          </div>
        </div>
        <div className="group-actions">
          <span className="expand-indicator">
            {expanded ? '−' : '+'}
          </span>
        </div>
      </div>
      
      {expanded && (
        <div className="group-applications">
          {loading ? (
            <div className="loading-applications">
              <div className="loading-spinner"></div>
              <p>Loading candidates...</p>
            </div>
          ) : applications.length === 0 ? (
            <div className="no-applications">
              <p>No candidates found in this group</p>
            </div>
          ) : (
            <div className="applications-grid">
              {applications.map((application) => (
                <AdminCandidateCard key={application.id} application={application} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Candidate Card Component for Admin
const AdminCandidateCard = ({ application }) => {
  const [preview, setPreview] = useState({ open: false, src: '', kind: '', title: '' });

  return (
    <>
      <div className="candidate-card">
        <div className="candidate-header">
          <div className="candidate-avatar">
            {application.headshotUrl ? (
              <AuthenticatedImage
                src={application.headshotUrl}
                alt={application.name}
                style={{
                  width: '60px',
                  height: '60px',
                  borderRadius: '50%',
                  objectFit: 'cover'
                }}
              />
            ) : (
              <div className="avatar-fallback">
                {(application.name || '?').split(' ').map(n => n.charAt(0)).join('').slice(0,2).toUpperCase()}
              </div>
            )}
          </div>
          <div className="candidate-info">
            <h4 className="candidate-name">{application.name}</h4>
            <p className="candidate-meta">
              {application.major} • Class of {application.year}
            </p>
          </div>
        </div>
        
        <div className="candidate-documents">
          <h5>Documents</h5>
          <div className="document-links">
            {application.resumeUrl && (
              <button 
                className="document-btn"
                onClick={() => setPreview({ 
                  open: true, 
                  src: application.resumeUrl, 
                  kind: 'pdf', 
                  title: `${application.name} – Resume` 
                })}
              >
                <DocumentDuplicateIcon className="btn-icon" />
                Resume
              </button>
            )}
            {application.coverLetterUrl && (
              <button 
                className="document-btn"
                onClick={() => setPreview({ 
                  open: true, 
                  src: application.coverLetterUrl, 
                  kind: 'pdf', 
                  title: `${application.name} – Cover Letter` 
                })}
              >
                <DocumentDuplicateIcon className="btn-icon" />
                Cover Letter
              </button>
            )}
            {application.videoUrl && (
              <button 
                className="document-btn"
                onClick={() => setPreview({ 
                  open: true, 
                  src: application.videoUrl, 
                  kind: 'video', 
                  title: `${application.name} – Video` 
                })}
              >
                <EyeIcon className="btn-icon" />
                Video
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Document Preview Modal */}
      {preview.open && (
        <DocumentPreviewModal
          onClose={() => setPreview({ open: false, src: '', kind: '', title: '' })}
          src={preview.src}
          kind={preview.kind}
          title={preview.title}
        />
      )}
    </>
  );
};

export default function AdminAssignedInterviews() {
  const navigate = useNavigate();
  const [allMembers, setAllMembers] = useState([]); // Combined list of admins and interviewers
  const [applications, setApplications] = useState([]);
  const [activeCycle, setActiveCycle] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newInterview, setNewInterview] = useState({
    title: '',
    interviewType: 'COFFEE_CHAT',
    startDate: '',
    endDate: '',
    location: '',
    dresscode: ''
  });
  const [interviews, setInterviews] = useState([]);
  const [selectedInterviewId, setSelectedInterviewId] = useState(null);
  const [expandedInterviewId, setExpandedInterviewId] = useState(null);
  const [interviewData, setInterviewData] = useState({});
  const [coffeeChatApplications, setCoffeeChatApplications] = useState([]);
  const [preview, setPreview] = useState({ open: false, src: '', kind: '', title: '' });

  const [isEditMode, setIsEditMode] = useState(false);
  const [editedInterview, setEditedInterview] = useState(null);
  const [groupSelectionOpen, setGroupSelectionOpen] = useState(false);
  const [selectedInterviewForStart, setSelectedInterviewForStart] = useState(null);
  const [groupSearchTerm, setGroupSearchTerm] = useState('');
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [behavioralQuestionsConfig, setBehavioralQuestionsConfig] = useState([]);
  const [showBehavioralQuestionsConfig, setShowBehavioralQuestionsConfig] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  
  // Search/filter states for groups management
  const [calendarSyncingId, setCalendarSyncingId] = useState(null);
  const [memberGroupsSearch, setMemberGroupsSearch] = useState('');
  const [applicationGroupsSearch, setApplicationGroupsSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState(new Set()); // Track collapsed group IDs
  const [memberSearchByGroup, setMemberSearchByGroup] = useState({}); // Search terms for members within each group
  const [appGroupSearchByGroup, setAppGroupSearchByGroup] = useState({}); // Search terms for app groups when assigning
  const [applicationSearchByGroup, setApplicationSearchByGroup] = useState({}); // Search terms for applications within app groups

  // Fetch initial data
  useEffect(() => {
    const load = async () => {
      try {
        const [ivsRes, mems, adminUsers, apps, cycle, currentUserRes] = await Promise.allSettled([
          apiClient.get('/admin/interviews'),
          apiClient.get('/admin/users?role=INTERVIEWER'),
          apiClient.get('/admin/users?role=ADMIN'),
          apiClient.get('/admin/applications'),
          apiClient.get('/admin/cycles/active'),
          apiClient.get('/admin/profile')
        ]);

        const ivs = ivsRes.status === 'fulfilled' ? ivsRes.value : [];
        if (ivsRes.status === 'rejected') {
          console.warn('Interviews fetch failed, continuing without them');
        }

        setInterviews(ivs);
        const interviewers = mems.status === 'fulfilled' ? mems.value : [];
        const adminsList = adminUsers.status === 'fulfilled' ? adminUsers.value : [];
        setCurrentUser(currentUserRes.status === 'fulfilled' ? currentUserRes.value : null);
        
        // Combine admins and interviewers, adding a role property for identification
        const combined = [
          ...adminsList.map(admin => ({ ...admin, role: 'ADMIN', displayName: `${admin.fullName} (Admin)` })),
          ...interviewers.map(interviewer => ({ ...interviewer, role: 'INTERVIEWER', displayName: `${interviewer.fullName}` }))
        ];
        setAllMembers(combined);
        
        const allApps = apps.status === 'fulfilled' ? apps.value : [];
        setApplications(allApps);
        // Filter applications for Coffee Chat round
        // Use status to identify Coffee Chat candidates (UNDER_REVIEW)
        const coffeeChatApps = allApps.filter(app => app.status === 'UNDER_REVIEW');
        setCoffeeChatApplications(coffeeChatApps);
        setActiveCycle(cycle.status === 'fulfilled' ? cycle.value : null);

        // Initialize interview-specific data for each interview
        const initialData = {};
        ivs.forEach(interview => {
          const desc = interview.description;
          let parsed;
          try {
            parsed = typeof desc === 'string' ? JSON.parse(desc) : desc;
          } catch {
            parsed = {};
          }
          initialData[interview.id] = {
            memberGroups: parsed?.memberGroups || [],
            applicationGroups: parsed?.applicationGroups || [],
            groupAssignments: parsed?.groupAssignments || {} // Maps memberGroupId to array of applicationGroupIds
          };
        });
        setInterviewData(initialData);
      } catch (e) {
        console.error('Failed to load interview data', e);
      }
    };
    load();
  }, []);


  const handleStartInterview = async (interviewId) => {
    setSelectedInterviewForStart(interviewId);
    setGroupSelectionOpen(true);
    setGroupSearchTerm('');
    setSelectedGroups([]);
    setShowBehavioralQuestionsConfig(false);
    
    // Don't load questions here - we'll load them when groups are selected
    setBehavioralQuestionsConfig([]);
  };

  const addBehavioralQuestion = () => {
    setBehavioralQuestionsConfig(prev => [...prev, '']);
  };

  const updateBehavioralQuestion = (index, value) => {
    setBehavioralQuestionsConfig(prev => prev.map((q, i) => i === index ? value : q));
  };

  const removeBehavioralQuestion = (index) => {
    setBehavioralQuestionsConfig(prev => prev.filter((_, i) => i !== index));
  };

  const handleGroupToggle = (groupId) => {
    setSelectedGroups(prev => {
      // Check if this is a final round interview
      const interview = interviews.find(i => i.id === selectedInterviewForStart);
      const isFinalRound = interview?.interviewType === 'FINAL_ROUND' || interview?.interviewType === 'ROUND_TWO';
      const maxGroups = isFinalRound ? 1 : 3;
      
      let newGroups;
      if (prev.includes(groupId)) {
        // Remove group if already selected
        newGroups = prev.filter(id => id !== groupId);
      } else if (isFinalRound) {
        // For final round, replace the current selection
        newGroups = [groupId];
      } else if (prev.length < maxGroups) {
        // Add group if less than max selected
        newGroups = [...prev, groupId];
      } else {
        // Don't add if already at max
        return prev;
      }
      
      // Load behavioral questions for the selected groups
      loadBehavioralQuestionsForGroups(newGroups);
      
      return newGroups;
    });
  };

  const loadBehavioralQuestionsForGroups = async (groupIds) => {
    if (groupIds.length === 0) {
      setBehavioralQuestionsConfig([]);
      return;
    }

    try {
      const configRes = await apiClient.get(`/admin/interviews/${selectedInterviewForStart}/config?groupIds=${groupIds.join(',')}`);
      const questionsByGroup = configRes.behavioralQuestions || {};
      
      // Flatten questions from all groups
      const allQuestions = [];
      Object.values(questionsByGroup).forEach(groupQuestions => {
        allQuestions.push(...groupQuestions.map(q => q.text || q));
      });
      
      setBehavioralQuestionsConfig(allQuestions);
    } catch (error) {
      console.warn('Failed to load behavioral questions for groups:', error);
      setBehavioralQuestionsConfig([]);
    }
  };

  const handleStartWithSelectedGroups = async () => {
    if (selectedGroups.length === 0) return;
    
    const interview = interviews.find(i => i.id === selectedInterviewForStart);
    
    // Check if this is a round that needs behavioral questions configuration
    if ((interview?.interviewType === 'ROUND_TWO' || interview?.interviewType === 'FINAL_ROUND' || interview?.interviewType === 'ROUND_ONE') && !showBehavioralQuestionsConfig) {
      setShowBehavioralQuestionsConfig(true);
      return;
    }
    
    const groupIdsParam = selectedGroups.join(',');
    
    console.log('Admin - Interview found:', interview);
    console.log('Admin - Interview type:', interview?.interviewType);
    console.log('Admin - Is ROUND_ONE?', interview?.interviewType === 'ROUND_ONE');
    
    // Save behavioral questions configuration if provided
    if (showBehavioralQuestionsConfig && behavioralQuestionsConfig.length > 0) {
      try {
        await saveBehavioralQuestionsConfiguration();
        console.log('Admin - Behavioral questions saved successfully');
      } catch (error) {
        console.error('Admin - Failed to save behavioral questions:', error);
        alert('Failed to save behavioral questions. Please try again.');
        return; // Don't navigate if save failed
      }
    }
    
    // Route to appropriate interface based on interview type
    if (interview?.interviewType === 'ROUND_ONE') {
      console.log('Admin - Routing to first round interview interface');
      const url = `/member/first-round-interview?interviewId=${selectedInterviewForStart}&groupIds=${groupIdsParam}`;
      console.log('Admin - Navigating to:', url);
      navigate(url);
    } else if (interview?.interviewType === 'ROUND_TWO' || interview?.interviewType === 'FINAL_ROUND') {
      console.log('Admin - Routing to final round interview interface');
      const url = `/admin/final-round-interview?interviewId=${selectedInterviewForStart}&groupIds=${groupIdsParam}`;
      console.log('Admin - Navigating to:', url);
      navigate(url);
    } else {
      console.log('Admin - Routing to regular interview interface');
      const url = `/admin/interview-interface?interviewId=${selectedInterviewForStart}&groupIds=${groupIdsParam}`;
      console.log('Admin - Navigating to:', url);
      navigate(url);
    }
    
    setGroupSelectionOpen(false);
    setSelectedInterviewForStart(null);
    setSelectedGroups([]);
    setBehavioralQuestionsConfig([]);
    setShowBehavioralQuestionsConfig(false);
  };

  const saveBehavioralQuestionsConfiguration = async () => {
    try {
      // Save questions to each selected group individually
      const questionsToSave = behavioralQuestionsConfig.filter(q => q.trim() !== '');
      
      console.log('Admin - Saving behavioral questions:', {
        selectedGroups,
        questionsToSave,
        interviewId: selectedInterviewForStart
      });
      
      for (const groupId of selectedGroups) {
        console.log(`Admin - Saving questions for group ${groupId}:`, questionsToSave);
        const response = await apiClient.patch(`/admin/interviews/${selectedInterviewForStart}/config`, {
          type: 'behavioral_questions',
          config: {
            behavioralQuestions: true,
            groupId: groupId,
            questions: questionsToSave
          }
        });
        console.log(`Admin - Save response for group ${groupId}:`, response);
      }
      
      console.log('Admin - Behavioral questions saved successfully for groups:', selectedGroups);
      
    } catch (error) {
      console.error('Failed to save behavioral questions configuration:', error);
      alert('Failed to save behavioral questions configuration');
      throw error; // Re-throw so the calling function can handle it
    }
  };

  const handleCloseGroupSelection = () => {
    setGroupSelectionOpen(false);
    setSelectedInterviewForStart(null);
    setGroupSearchTerm('');
    setSelectedGroups([]);
    setBehavioralQuestionsConfig([]);
    setShowBehavioralQuestionsConfig(false);
  };

  // Applies the calendar fields the server returns after a create/roster save/retry
  const applyCalendarSync = (interviewId, calendarSync) => {
    if (!calendarSync) return;
    setInterviews(prev => prev.map(iv => iv.id === interviewId ? {
      ...iv,
      calendarEventId: calendarSync.calendarEventId ?? iv.calendarEventId,
      calendarSyncStatus: calendarSync.status,
      calendarSyncError: calendarSync.error ?? null
    } : iv));
  };

  const retryCalendarSync = async (interviewId) => {
    setCalendarSyncingId(interviewId);
    try {
      const result = await apiClient.post(`/admin/interviews/${interviewId}/calendar-sync`, {});
      applyCalendarSync(interviewId, result);
      if (result.status !== 'SYNCED' || result.error) {
        alert(result.error || 'Calendar invite could not be sent.');
      }
    } catch (e) {
      console.error('Failed to sync calendar invite', e);
      alert(e.message || 'Failed to sync calendar invite');
    } finally {
      setCalendarSyncingId(null);
    }
  };

  const handleEditInterview = (interviewId) => {
    const interview = interviews.find(i => i.id === interviewId);
    setEditedInterview({...interview});
    setIsEditMode(true);
  };

  const handleSaveInterview = () => {
    setInterviews(prev => prev.map(interview => 
      interview.id === editedInterview.id ? editedInterview : interview
    ));
    setIsEditMode(false);
    setEditedInterview(null);
  };

  const handleCancelEdit = () => {
    setIsEditMode(false);
    setEditedInterview(null);
  };

  const handleFieldChange = (field, value) => {
    setEditedInterview(prev => ({
      ...prev,
      [field]: value
    }));
  };



  const handleDeleteInterview = async (interviewId) => {
    if (!window.confirm('Are you sure you want to delete this interview?')) return;
    try {
      await apiClient.delete(`/admin/interviews/${interviewId}`);
      setInterviews(prev => prev.filter(interview => interview.id !== interviewId));
      if (selectedInterviewId === interviewId) setSelectedInterviewId(null);
      if (expandedInterviewId === interviewId) setExpandedInterviewId(null);
    } catch (e) {
      console.error('Failed to delete interview', e);
      alert(e.message || 'Failed to delete interview');
    }
  };

  const handleCreateInterview = () => {
    setCreateOpen(true);
  };

  const submitCreateInterview = async () => {
    if (!activeCycle) return;
    setCreating(true);
    try {
      const payload = {
        ...newInterview,
        cycleId: activeCycle.id
      };
      console.log('Creating interview with payload:', payload);
      const created = await apiClient.post('/admin/interviews', payload);
      const calendarSync = created.calendarSync;
      setInterviews([
        {
          ...created,
          calendarEventId: calendarSync?.calendarEventId ?? created.calendarEventId ?? null,
          calendarSyncStatus: calendarSync?.status ?? created.calendarSyncStatus ?? 'NOT_SYNCED',
          calendarSyncError: calendarSync?.error ?? null
        },
        ...interviews
      ]);
      // A SYNCED result can still carry an error (the invite went out but its state could not be
      // saved), so surface any error rather than only the non-synced ones.
      if (calendarSync?.error) {
        alert(calendarSync.status === 'SYNCED'
          ? `Interview created and invites sent, but: ${calendarSync.error}`
          : `Interview created, but the calendar invite was not sent: ${calendarSync.error}`);
      }
      setSelectedInterviewId(created.id);
      setEditedInterview(null);
      setCreateOpen(false);
      setNewInterview({ 
        title: '', 
        interviewType: 'COFFEE_CHAT', 
        startDate: '', 
        endDate: '', 
        location: '', 
        dresscode: ''
      });
    } catch (e) {
      console.error('Failed to create interview', e);
      alert(e.message || 'Failed to create interview');
    } finally {
      setCreating(false);
    }
  };

  const handleSelectInterview = (id) => {
    setSelectedInterviewId(id);
    setIsEditMode(false);
    setEditedInterview(null);
  };

  const toggleExpandInterview = (id) => {
    if (expandedInterviewId === id) {
      setExpandedInterviewId(null);
    } else {
      setExpandedInterviewId(id);
    }
  };

  const addMemberGroup = (interviewId) => {
    const currentGroups = interviewData[interviewId]?.memberGroups || [];
    setInterviewData(prev => ({
      ...prev,
      [interviewId]: {
        ...prev[interviewId],
        memberGroups: [
          ...currentGroups,
          { 
            id: crypto.randomUUID(), 
            name: `Member Group ${currentGroups.length + 1}`, 
            memberIds: [],
            notes: '' 
          }
        ]
      }
    }));
  };

  const addApplicationGroup = (interviewId) => {
    const currentGroups = interviewData[interviewId]?.applicationGroups || [];
    setInterviewData(prev => ({
      ...prev,
      [interviewId]: {
        ...prev[interviewId],
        applicationGroups: [
          ...currentGroups,
          { 
            id: crypto.randomUUID(), 
            name: `Application Group ${currentGroups.length + 1}`, 
            applicationIds: [],
            notes: '' 
          }
        ]
      }
    }));
  };

  const removeMemberGroup = (interviewId, groupId) => {
    const current = interviewData[interviewId] || { memberGroups: [], applicationGroups: [], groupAssignments: {} };
    const newAssignments = { ...current.groupAssignments };
    delete newAssignments[groupId];
    const updated = {
      ...current,
      memberGroups: (current.memberGroups || []).filter(g => g.id !== groupId),
      groupAssignments: newAssignments
    };
    setInterviewData(prev => ({
      ...prev,
      [interviewId]: updated
    }));
    // Persist immediately so deletion is saved
    persistInterviewConfig(interviewId, updated, { silent: true });
  };

  const removeApplicationGroup = (interviewId, groupId) => {
    const current = interviewData[interviewId] || { memberGroups: [], applicationGroups: [], groupAssignments: {} };
    const newAssignments = {};
    Object.entries(current.groupAssignments || {}).forEach(([memberGroupId, appGroupIds]) => {
      newAssignments[memberGroupId] = (appGroupIds || []).filter(id => id !== groupId);
    });
    const updated = {
      ...current,
      applicationGroups: (current.applicationGroups || []).filter(g => g.id !== groupId),
      groupAssignments: newAssignments
    };
    setInterviewData(prev => ({
      ...prev,
      [interviewId]: updated
    }));
    // Persist immediately so deletion is saved
    persistInterviewConfig(interviewId, updated, { silent: true });
  };

  const updateMemberGroup = (interviewId, groupId, changes) => {
    setInterviewData(prev => ({
      ...prev,
      [interviewId]: {
        ...prev[interviewId],
        memberGroups: prev[interviewId]?.memberGroups?.map(g => g.id === groupId ? { ...g, ...changes } : g) || []
      }
    }));
  };

  const updateApplicationGroup = (interviewId, groupId, changes) => {
    setInterviewData(prev => ({
      ...prev,
      [interviewId]: {
        ...prev[interviewId],
        applicationGroups: prev[interviewId]?.applicationGroups?.map(g => g.id === groupId ? { ...g, ...changes } : g) || []
      }
    }));
  };

  const assignGroupsToMemberGroup = (interviewId, memberGroupId, applicationGroupIds) => {
    setInterviewData(prev => ({
      ...prev,
      [interviewId]: {
        ...prev[interviewId],
        groupAssignments: {
          ...prev[interviewId]?.groupAssignments,
          [memberGroupId]: applicationGroupIds
        }
      }
    }));
  };

  const saveInterviewData = async (interviewId) => {
    const data = interviewData[interviewId];
    if (!data) return;
    try {
      const response = await apiClient.patch(`/admin/interviews/${interviewId}/config`, {
        type: 'full',
        config: data
      });
      // Update the interview's description with the new data
      setInterviews(prev => prev.map(iv => 
        iv.id === interviewId 
          ? { ...iv, description: JSON.stringify(data) } 
          : iv
      ));
      applyCalendarSync(interviewId, response?.calendarSync);
      alert('Interview data saved');
    } catch (e) {
      console.error('Failed to save interview data', e);
      alert(e.message || 'Failed to save interview data');
    }
  };

  const persistInterviewConfig = async (interviewId, data, { silent = true } = {}) => {
    try {
      const response = await apiClient.patch(`/admin/interviews/${interviewId}/config`, {
        type: 'full',
        config: data
      });
      setInterviews(prev => prev.map(iv => 
        iv.id === interviewId 
          ? { ...iv, description: JSON.stringify(data) } 
          : iv
      ));
      applyCalendarSync(interviewId, response?.calendarSync);
      if (!silent) alert('Interview data saved');
    } catch (e) {
      console.error('Failed to persist interview config', e);
      if (!silent) alert(e.message || 'Failed to save interview data');
    }
  };





  return (
    <AccessControl allowedRoles={['ADMIN']}>
      <div className="admin-assigned-interviews-container">
      {createOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Create Interview</h3>
              <button className="icon-btn" onClick={() => setCreateOpen(false)}>
                <XMarkIcon className="btn-icon" />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-row">
                <label>Title</label>
                <input type="text" value={newInterview.title} onChange={e => setNewInterview({ ...newInterview, title: e.target.value })} />
              </div>
              <div className="form-row">
                <label>Type</label>
                <select value={newInterview.interviewType} onChange={e => setNewInterview({ ...newInterview, interviewType: e.target.value })}>
                  <option value="COFFEE_CHAT">Coffee Chat</option>
                  <option value="ROUND_ONE">Round 1</option>
                  <option value="ROUND_TWO">Round 2</option>
                  <option value="FINAL_ROUND">Final Round</option>
                </select>
              </div>
              <div className="form-row two-col">
                <div>
                  <label>Start</label>
                  <input type="datetime-local" value={newInterview.startDate} onChange={e => setNewInterview({ ...newInterview, startDate: e.target.value })} />
                </div>
                <div>
                  <label>End</label>
                  <input type="datetime-local" value={newInterview.endDate} onChange={e => setNewInterview({ ...newInterview, endDate: e.target.value })} />
                </div>
              </div>
              <div className="form-row two-col">
                <div>
                  <label>Location</label>
                  <input type="text" value={newInterview.location} onChange={e => setNewInterview({ ...newInterview, location: e.target.value })} />
                </div>
                <div>
                  <label>Dresscode</label>
                  <input type="text" value={newInterview.dresscode} onChange={e => setNewInterview({ ...newInterview, dresscode: e.target.value })} />
                </div>
              </div>
              
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setCreateOpen(false)}>Cancel</button>
              <button className="btn-primary" onClick={submitCreateInterview} disabled={creating}>{creating ? 'Creating...' : 'Create'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Group Selection Modal */}
      {groupSelectionOpen && selectedInterviewForStart && (
        <div className="modal-overlay">
          <div className="modal-content group-selection-modal">
            <div className="modal-header">
              <h3>
                {showBehavioralQuestionsConfig 
                  ? 'Configure Behavioral Questions' 
                  : 'Select Application Groups to Evaluate'
                }
              </h3>
              {!showBehavioralQuestionsConfig && (() => {
                const interview = interviews.find(i => i.id === selectedInterviewForStart);
                const isFinalRound = interview?.interviewType === 'FINAL_ROUND' || interview?.interviewType === 'ROUND_TWO';
                const maxGroups = isFinalRound ? 1 : 3;
                return (
                  <div className="selection-info">
                    {selectedGroups.length}/{maxGroups} group{maxGroups === 1 ? '' : 's'} selected
                  </div>
                );
              })()}
              <button className="icon-btn" onClick={handleCloseGroupSelection}>
                <XMarkIcon className="btn-icon" />
              </button>
            </div>
            <div className="modal-body">
              {showBehavioralQuestionsConfig ? (
                <div className="behavioral-questions-config">
                  <p className="config-instruction">
                    Configure the behavioral questions for this interview. All interviewers will see these same questions.
                  </p>
                  {behavioralQuestionsConfig.map((question, index) => (
                    <div key={index} className="question-config-row">
                      <input
                        type="text"
                        value={question}
                        onChange={(e) => updateBehavioralQuestion(index, e.target.value)}
                        placeholder={`Question ${index + 1}`}
                        className="question-input"
                      />
                      <button
                        type="button"
                        className="remove-question-btn"
                        onClick={() => removeBehavioralQuestion(index)}
                      >
                        <XMarkIcon className="btn-icon" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="add-question-btn"
                    onClick={addBehavioralQuestion}
                  >
                    <PlusIcon className="btn-icon" />
                    Add Question
                  </button>
                </div>
              ) : (
                (() => {
                  const interview = interviews.find(i => i.id === selectedInterviewForStart);
                  const data = interviewData[selectedInterviewForStart] || { applicationGroups: [], groupAssignments: {} };
                  
                  // Filter to only show groups assigned to the current admin user
                  const adminAssignedGroups = data.applicationGroups.filter(group => {
                    if (!currentUser) return false;
                    
                    // Find member groups that include the current admin user
                    const memberGroupsWithCurrentAdmin = data.memberGroups?.filter(memberGroup => 
                      memberGroup.memberIds?.includes(currentUser.id)
                    ) || [];
                    
                    // Check if this application group is assigned to any of the current admin's member groups
                    return memberGroupsWithCurrentAdmin.some(memberGroup => 
                      data.groupAssignments?.[memberGroup.id]?.includes(group.id)
                    );
                  });
                  
                  const filteredGroups = adminAssignedGroups.filter(group =>
                    group.name.toLowerCase().includes(groupSearchTerm.toLowerCase())
                  );
                  
                  return (
                    <>
                      <div className="search-section">
                        <input
                          type="text"
                          placeholder="Search application groups..."
                          value={groupSearchTerm}
                          onChange={(e) => setGroupSearchTerm(e.target.value)}
                          className="group-search-input"
                        />
                      </div>
                      
                      <div className="groups-selection-list">
                        {filteredGroups.length === 0 ? (
                          <div className="no-groups-message">
                            {groupSearchTerm ? 'No groups match your search' : 'No application groups available'}
                          </div>
                        ) : (
                          filteredGroups.map(group => {
                            const isSelected = selectedGroups.includes(group.id);
                            const interview = interviews.find(i => i.id === selectedInterviewForStart);
                            const isFinalRound = interview?.interviewType === 'FINAL_ROUND' || interview?.interviewType === 'ROUND_TWO';
                            const maxGroups = isFinalRound ? 1 : 3;
                            const isDisabled = !isSelected && selectedGroups.length >= maxGroups;
                            
                            return (
                              <div 
                                key={group.id} 
                                className={`group-selection-item ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''}`}
                                onClick={() => !isDisabled && handleGroupToggle(group.id)}
                              >
                                <div className="group-checkbox">
                                  <input
                                    type={isFinalRound ? "radio" : "checkbox"}
                                    checked={isSelected}
                                    onChange={() => !isDisabled && handleGroupToggle(group.id)}
                                    disabled={isDisabled}
                                  />
                                  <span className="checkmark"></span>
                                </div>
                                <div className="group-info">
                                  <h4 className="group-name">{group.name}</h4>
                                  <p className="group-count">
                                    {group.applicationIds?.length || 0} applications
                                  </p>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </>
                  );
                })()
              )}
            </div>
            <div className="modal-footer">
              {showBehavioralQuestionsConfig ? (
                <>
                  <button 
                    className="btn-secondary" 
                    onClick={() => setShowBehavioralQuestionsConfig(false)}
                  >
                    Back to Groups
                  </button>
                  <button 
                    className="btn-primary" 
                    onClick={handleStartWithSelectedGroups}
                    disabled={behavioralQuestionsConfig.filter(q => q.trim() !== '').length === 0}
                  >
                    Start Interview
                  </button>
                </>
              ) : (
                <>
                  <button className="btn-secondary" onClick={handleCloseGroupSelection}>
                    Cancel
                  </button>
                  <button 
                    className="btn-primary" 
                    onClick={handleStartWithSelectedGroups}
                    disabled={selectedGroups.length === 0}
                  >
                    {(() => {
                      const interview = interviews.find(i => i.id === selectedInterviewForStart);
                      if (interview?.interviewType === 'ROUND_TWO' || interview?.interviewType === 'FINAL_ROUND') {
                        return 'Configure Questions';
                      }
                      return `Start Interview (${selectedGroups.length} group${selectedGroups.length !== 1 ? 's' : ''})`;
                    })()}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Header Section */}
      <div className="interview-header">
       
        <div className="header-actions">
          <button 
            className="btn-primary create-interview-btn"
            onClick={handleCreateInterview}
          >
            <PlusIcon className="btn-icon" />
            Create Interview
          </button>
        </div>
      </div>

      {/* Main Content - Interview Cards Grid */}
      <div className="interviews-grid">
        {interviews.length === 0 ? (
          <div className="no-interviews-card">
            <div className="no-interviews-icon">
              <CalendarIcon className="empty-icon" />
            </div>
            <h2>No Interviews Scheduled</h2>
            <p>Create your first interview to get started</p>
            <button className="btn-primary" onClick={handleCreateInterview}>
              <PlusIcon className="btn-icon" />
              Create First Interview
            </button>
          </div>
        ) : (
          interviews.map((interview) => {
            const startDate = new Date(interview.startDate);
            const endDate = new Date(interview.endDate);
            const isSelected = interview.id === selectedInterviewId;
            const isBeingEdited = isEditMode && editedInterview?.id === interview.id;
            const isExpanded = expandedInterviewId === interview.id;
            const data = interviewData[interview.id] || { 
              memberGroups: [], 
              applicationGroups: [], 
              groupAssignments: {}
            };
            
            return (
              <div 
                key={interview.id} 
                className={`interview-card ${isSelected ? 'selected' : ''} ${isBeingEdited ? 'editing' : ''} ${isExpanded ? 'expanded' : ''}`}
              >
                {/* Card Header */}
                <div className="interview-card-header" onClick={() => !isExpanded && handleSelectInterview(interview.id)}>
                  <div className="interview-type-badge">
                    {interview.interviewType?.replace(/_/g, ' ')}
                  </div>
                  <div className="interview-card-actions">
                    <button 
                      className={`icon-btn expand ${isExpanded ? 'expanded' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpandInterview(interview.id);
                      }}
                      title={isExpanded ? "Collapse" : "Expand"}
                    >
                      {isExpanded ? <XMarkIcon className="btn-icon" /> : <PlusIcon className="btn-icon" />}
                    </button>
                    {isBeingEdited ? (
                      <>
                        <button 
                          className="icon-btn save"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSaveInterview();
                          }}
                          title="Save Changes"
                        >
                          <CheckIcon className="btn-icon" />
                        </button>
                        <button 
                          className="icon-btn cancel"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCancelEdit();
                          }}
                          title="Cancel"
                        >
                          <XMarkIcon className="btn-icon" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button 
                          className="icon-btn edit"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEditInterview(interview.id);
                          }}
                          title="Edit Interview"
                        >
                          <PencilIcon className="btn-icon" />
                        </button>
                        <button 
                          className="icon-btn delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteInterview(interview.id);
                          }}
                          title="Delete Interview"
                        >
                          <TrashIcon className="btn-icon" />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Card Body */}
                <div className="interview-card-body">
                  {/* Date Section */}
                  <div className="interview-date-section">
                    <div className="interview-date-badge">
                      <div className="date-day">{startDate.toLocaleDateString('en-US', { weekday: 'short' })}</div>
                      <div className="date-number">{startDate.getDate()}</div>
                      <div className="date-month">{startDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</div>
                    </div>
                    
                    <div className="interview-info">
                      {isBeingEdited ? (
                        <input
                          type="text"
                          value={editedInterview.title}
                          onChange={(e) => handleFieldChange('title', e.target.value)}
                          className="edit-input interview-title-input"
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <h3 className="interview-card-title">{interview.title}</h3>
                      )}
                      
                      <div className="interview-details">
                        <div className="detail-item">
                          <ClockIcon className="detail-icon" />
                          <span>
                            {startDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} - 
                            {endDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        
                        <div className="detail-item">
                          <MapPinIcon className="detail-icon" />
                          {isBeingEdited ? (
                            <input
                              type="text"
                              value={editedInterview.location}
                              onChange={(e) => handleFieldChange('location', e.target.value)}
                              className="edit-input location-input"
                              placeholder="Location"
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : (
                            <span>{interview.location || 'No location set'}</span>
                          )}
                        </div>
                        
                        <div className="detail-item">
                          <UserGroupIcon className="detail-icon" />
                          {isBeingEdited ? (
                            <input
                              type="text"
                              value={editedInterview.dresscode}
                              onChange={(e) => handleFieldChange('dresscode', e.target.value)}
                              className="edit-input dresscode-input"
                              placeholder="Dress code"
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : (
                            <span>{interview.dresscode || 'No dress code specified'}</span>
                          )}
                        </div>

                        <div className="detail-item">
                          <CalendarIcon className="detail-icon" />
                          <span>
                            {CALENDAR_STATUS_LABELS[interview.calendarSyncStatus] || CALENDAR_STATUS_LABELS.NOT_SYNCED}
                          </span>
                          <button
                            className="btn-secondary small"
                            disabled={calendarSyncingId === interview.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              retryCalendarSync(interview.id);
                            }}
                            title="Create or refresh the Google Calendar invite for the assigned interviewers"
                          >
                            {calendarSyncingId === interview.id ? 'Sending…' : 'Send invites'}
                          </button>
                        </div>

                        {interview.calendarSyncError && (
                          <div className="detail-item calendar-sync-error">
                            <span>{interview.calendarSyncError}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Groups Summary - Show when not expanded */}
                  {!isExpanded && isSelected && (data.memberGroups.length > 0 || data.applicationGroups.length > 0) && (
                    <div className="interview-groups-summary">
                      <div className="groups-header">
                        <span className="groups-label">Groups:</span>
                        <span className="groups-count">
                          {data.memberGroups.length} member, {data.applicationGroups.length} application
                        </span>
                      </div>
                      <div className="groups-preview">
                        <div className="preview-section">
                          <UsersIcon className="group-type-icon" />
                          <span className="preview-label">Member Groups: </span>
                          <span className="preview-value">
                            {data.memberGroups.length > 0 
                              ? data.memberGroups.slice(0, 2).map(g => g.name).join(', ')
                              : 'None'}
                            {data.memberGroups.length > 2 && ` +${data.memberGroups.length - 2} more`}
                          </span>
                        </div>
                        <div className="preview-section">
                          <DocumentDuplicateIcon className="group-type-icon" />
                          <span className="preview-label">Application Groups: </span>
                          <span className="preview-value">
                            {data.applicationGroups.length > 0 
                              ? data.applicationGroups.slice(0, 2).map(g => g.name).join(', ')
                              : 'None'}
                            {data.applicationGroups.length > 2 && ` +${data.applicationGroups.length - 2} more`}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div className="interview-expanded-content">

                      {/* Groups Section */}
                      <div className="expanded-section">
                        <div className="expanded-section-header">
                          <h3 className="expanded-section-title">Group Assignments</h3>
                          <div className="section-actions">
                            <button className="btn-primary small" onClick={() => saveInterviewData(interview.id)}>
                              <CheckIcon className="btn-icon" /> Save All
                            </button>
                          </div>
                        </div>
                        
                        <div className="groups-split-container">
                          {/* Member Groups Column */}
                          <div className="groups-column">
                            <div className="column-header">
                              <h4><UsersIcon className="section-icon" /> Member Groups</h4>
                              <button className="btn-secondary small" onClick={() => addMemberGroup(interview.id)}>
                                <PlusIcon className="btn-icon" /> Add
                              </button>
                            </div>
                            {/* Search for member groups */}
                            {data.memberGroups?.length > 0 && (
                              <div className="groups-search-container">
                                <div className="search-input-wrapper">
                                  <MagnifyingGlassIcon className="search-icon" />
                                  <input
                                    type="text"
                                    placeholder="Search member groups..."
                                    value={memberGroupsSearch}
                                    onChange={e => setMemberGroupsSearch(e.target.value)}
                                    className="groups-search-input"
                                  />
                                </div>
                              </div>
                            )}
                            <div className="groups-list">
                              {data.memberGroups?.length === 0 && (
                                <div className="empty-state">No member groups yet</div>
                              )}
                              {data.memberGroups
                                ?.filter(group => 
                                  !memberGroupsSearch || 
                                  group.name?.toLowerCase().includes(memberGroupsSearch.toLowerCase())
                                )
                                .map(group => {
                                  const isCollapsed = collapsedGroups.has(`member-${group.id}`);
                                  const memberSearchTerm = memberSearchByGroup[group.id] || '';
                                  const appGroupSearchTerm = appGroupSearchByGroup[group.id] || '';
                                  
                                  // Filter members
                                  const filteredAdmins = allMembers
                                    .filter(m => m.role === 'ADMIN')
                                    .filter(m => !memberSearchTerm || m.displayName?.toLowerCase().includes(memberSearchTerm.toLowerCase()));
                                  const filteredInterviewers = allMembers
                                    .filter(m => m.role === 'INTERVIEWER')
                                    .filter(m => !memberSearchTerm || m.displayName?.toLowerCase().includes(memberSearchTerm.toLowerCase()));
                                  
                                  // Filter application groups for assignment
                                  const filteredAppGroups = data.applicationGroups?.filter(appGroup =>
                                    !appGroupSearchTerm || appGroup.name?.toLowerCase().includes(appGroupSearchTerm.toLowerCase())
                                  ) || [];
                                  
                                  return (
                                    <div key={group.id} className="group-card-compact">
                                      <div className="group-header-compact">
                                        <input
                                          className="group-name-input-compact"
                                          value={group.name || ''}
                                          onChange={e => updateMemberGroup(interview.id, group.id, { name: e.target.value })}
                                          placeholder="Group name"
                                        />
                                        <div className="group-header-actions">
                                          <button 
                                            className="icon-btn small collapse-btn" 
                                            onClick={() => {
                                              const newCollapsed = new Set(collapsedGroups);
                                              if (isCollapsed) {
                                                newCollapsed.delete(`member-${group.id}`);
                                              } else {
                                                newCollapsed.add(`member-${group.id}`);
                                              }
                                              setCollapsedGroups(newCollapsed);
                                            }}
                                            title={isCollapsed ? "Expand" : "Collapse"}
                                          >
                                            {isCollapsed ? <ChevronDownIcon className="btn-icon" /> : <ChevronUpIcon className="btn-icon" />}
                                          </button>
                                          <button className="icon-btn small" onClick={() => removeMemberGroup(interview.id, group.id)}>
                                            <TrashIcon className="btn-icon" />
                                          </button>
                                        </div>
                                      </div>
                                      
                                      {!isCollapsed && (
                                        <>
                                          {/* Members Section with Search */}
                                          <div className="group-members-list">
                                            <div className="members-search-wrapper">
                                              <MagnifyingGlassIcon className="search-icon small" />
                                              <input
                                                type="text"
                                                placeholder="Search members..."
                                                value={memberSearchTerm}
                                                onChange={e => setMemberSearchByGroup(prev => ({ ...prev, [group.id]: e.target.value }))}
                                                className="members-search-input"
                                              />
                                            </div>
                                            
                                            {/* Admins Section */}
                                            {filteredAdmins.length > 0 && (
                                              <>
                                                <div className="members-section-header">Admins</div>
                                                {filteredAdmins.map(m => (
                                                  <label key={m.id} className="member-checkbox admin-member">
                                                    <input
                                                      type="checkbox"
                                                      checked={group.memberIds?.includes(m.id) || false}
                                                      onChange={e => {
                                                        const next = new Set(group.memberIds || []);
                                                        if (e.target.checked) next.add(m.id); else next.delete(m.id);
                                                        updateMemberGroup(interview.id, group.id, { memberIds: Array.from(next) });
                                                      }}
                                                    />
                                                    <span className="member-name">{m.displayName}</span>
                                                  </label>
                                                ))}
                                              </>
                                            )}
                                            
                                            {/* Interviewers Section */}
                                            {filteredInterviewers.length > 0 && (
                                              <>
                                                <div className="members-section-header">Interviewers</div>
                                                {filteredInterviewers.map(m => (
                                                  <label key={m.id} className="member-checkbox interviewer-member">
                                                    <input
                                                      type="checkbox"
                                                      checked={group.memberIds?.includes(m.id) || false}
                                                      onChange={e => {
                                                        const next = new Set(group.memberIds || []);
                                                        if (e.target.checked) next.add(m.id); else next.delete(m.id);
                                                        updateMemberGroup(interview.id, group.id, { memberIds: Array.from(next) });
                                                      }}
                                                    />
                                                    <span className="member-name">{m.displayName}</span>
                                                  </label>
                                                ))}
                                              </>
                                            )}
                                            
                                            {filteredAdmins.length === 0 && filteredInterviewers.length === 0 && memberSearchTerm && (
                                              <div className="no-results">No members found</div>
                                            )}
                                          </div>
                                          
                                          {/* Application Groups Assignment with Search */}
                                          <div className="group-assignments">
                                            <div className="assignments-header">
                                              <label className="assignments-label">Assigned Application Groups:</label>
                                              {data.applicationGroups?.length > 0 && (
                                                <div className="assignments-search-wrapper">
                                                  <MagnifyingGlassIcon className="search-icon small" />
                                                  <input
                                                    type="text"
                                                    placeholder="Search app groups..."
                                                    value={appGroupSearchTerm}
                                                    onChange={e => setAppGroupSearchByGroup(prev => ({ ...prev, [group.id]: e.target.value }))}
                                                    className="assignments-search-input"
                                                  />
                                                </div>
                                              )}
                                            </div>
                                            <div className="assignments-list">
                                              {filteredAppGroups.length > 0 ? (
                                                filteredAppGroups.map(appGroup => (
                                                  <label key={appGroup.id} className="assignment-checkbox">
                                                    <input
                                                      type="checkbox"
                                                      checked={data.groupAssignments?.[group.id]?.includes(appGroup.id) || false}
                                                      onChange={e => {
                                                        const currentAssignments = data.groupAssignments?.[group.id] || [];
                                                        const newAssignments = e.target.checked
                                                          ? [...currentAssignments, appGroup.id]
                                                          : currentAssignments.filter(id => id !== appGroup.id);
                                                        assignGroupsToMemberGroup(interview.id, group.id, newAssignments);
                                                      }}
                                                    />
                                                    <span>{appGroup.name} ({appGroup.applicationIds?.length || 0} apps)</span>
                                                  </label>
                                                ))
                                              ) : (
                                                <span className="no-assignments">
                                                  {data.applicationGroups?.length === 0 
                                                    ? "No application groups available" 
                                                    : "No groups match your search"}
                                                </span>
                                              )}
                                            </div>
                                          </div>
                                        </>
                                      )}
                                    </div>
                                  );
                                })}
                            </div>
                          </div>

                          {/* Application Groups Column */}
                          <div className="groups-column">
                            <div className="column-header">
                              <h4><DocumentDuplicateIcon className="section-icon" /> Application Groups</h4>
                              <button className="btn-secondary small" onClick={() => addApplicationGroup(interview.id)}>
                                <PlusIcon className="btn-icon" /> Add
                              </button>
                            </div>
                            {/* Search for application groups */}
                            {data.applicationGroups?.length > 0 && (
                              <div className="groups-search-container">
                                <div className="search-input-wrapper">
                                  <MagnifyingGlassIcon className="search-icon" />
                                  <input
                                    type="text"
                                    placeholder="Search application groups..."
                                    value={applicationGroupsSearch}
                                    onChange={e => setApplicationGroupsSearch(e.target.value)}
                                    className="groups-search-input"
                                  />
                                </div>
                              </div>
                            )}
                            <div className="groups-list">
                              {data.applicationGroups?.length === 0 && (
                                <div className="empty-state">No application groups yet</div>
                              )}
                              {data.applicationGroups
                                ?.filter(group => 
                                  !applicationGroupsSearch || 
                                  group.name?.toLowerCase().includes(applicationGroupsSearch.toLowerCase())
                                )
                                .map(group => {
                                  const isCollapsed = collapsedGroups.has(`app-${group.id}`);
                                  const applicationSearchTerm = applicationSearchByGroup[group.id] || '';
                                  
                                  // Filter applications
                                  const filteredApplications = coffeeChatApplications.filter(app =>
                                    !applicationSearchTerm || app.name?.toLowerCase().includes(applicationSearchTerm.toLowerCase())
                                  );
                                  
                                  return (
                                    <div key={group.id} className="group-card-compact">
                                      <div className="group-header-compact">
                                        <input
                                          className="group-name-input-compact"
                                          value={group.name || ''}
                                          onChange={e => updateApplicationGroup(interview.id, group.id, { name: e.target.value })}
                                          placeholder="Group name"
                                        />
                                        <div className="group-header-actions">
                                          <button 
                                            className="icon-btn small collapse-btn" 
                                            onClick={() => {
                                              const newCollapsed = new Set(collapsedGroups);
                                              if (isCollapsed) {
                                                newCollapsed.delete(`app-${group.id}`);
                                              } else {
                                                newCollapsed.add(`app-${group.id}`);
                                              }
                                              setCollapsedGroups(newCollapsed);
                                            }}
                                            title={isCollapsed ? "Expand" : "Collapse"}
                                          >
                                            {isCollapsed ? <ChevronDownIcon className="btn-icon" /> : <ChevronUpIcon className="btn-icon" />}
                                          </button>
                                          <button className="icon-btn small" onClick={() => removeApplicationGroup(interview.id, group.id)}>
                                            <TrashIcon className="btn-icon" />
                                          </button>
                                        </div>
                                      </div>
                                      
                                      {!isCollapsed && (
                                        <div className="group-applications-list">
                                          <div className="applications-header">
                                            <div className="applications-label">Coffee Chat Round Applications:</div>
                                            {coffeeChatApplications.length > 0 && (
                                              <div className="applications-search-wrapper">
                                                <MagnifyingGlassIcon className="search-icon small" />
                                                <input
                                                  type="text"
                                                  placeholder="Search applications..."
                                                  value={applicationSearchTerm}
                                                  onChange={e => setApplicationSearchByGroup(prev => ({ ...prev, [group.id]: e.target.value }))}
                                                  className="applications-search-input"
                                                />
                                              </div>
                                            )}
                                          </div>
                                          {coffeeChatApplications.length === 0 ? (
                                            <div className="no-applications">No applications in coffee chat round</div>
                                          ) : filteredApplications.length === 0 ? (
                                            <div className="no-applications">No applications match your search</div>
                                          ) : (
                                            filteredApplications.map(app => (
                                              <label key={app.id} className="application-checkbox">
                                                <input
                                                  type="checkbox"
                                                  checked={group.applicationIds?.includes(app.id) || false}
                                                  onChange={e => {
                                                    const next = new Set(group.applicationIds || []);
                                                    if (e.target.checked) next.add(app.id); else next.delete(app.id);
                                                    updateApplicationGroup(interview.id, group.id, { applicationIds: Array.from(next) });
                                                  }}
                                                />
                                                <span>{app.name}</span>
                                              </label>
                                            ))
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Assigned Application Groups Section */}
                      <div className="expanded-section">
                        <div className="expanded-section-header">
                          <h3 className="expanded-section-title">Assigned Application Groups</h3>
                        </div>
                        {(() => {
                          const currentInterviewData = interviewData[interview.id];
                          const allApplicationGroups = currentInterviewData?.applicationGroups || [];
                          
                          // For admin, show only groups assigned to member groups that include the current admin
                          const assignedApplicationGroups = allApplicationGroups.filter(group => {
                            if (!currentUser) return false;
                            
                            const groupAssignments = currentInterviewData?.groupAssignments || {};
                            
                            // Find member groups that include the current admin user
                            const memberGroupsWithCurrentAdmin = currentInterviewData?.memberGroups?.filter(memberGroup => 
                              memberGroup.memberIds?.includes(currentUser.id)
                            ) || [];
                            
                            // Check if this application group is assigned to any of the current admin's member groups
                            return memberGroupsWithCurrentAdmin.some(memberGroup => 
                              groupAssignments[memberGroup.id]?.includes(group.id)
                            );
                          });
                          
                          return assignedApplicationGroups.length === 0 ? (
                            <div className="no-groups">
                              <UserGroupIcon className="no-groups-icon" />
                              <p>No application groups assigned to this interview</p>
                            </div>
                          ) : (
                            <div className="application-groups-list">
                              {assignedApplicationGroups.map((group) => (
                                <AdminApplicationGroupCard 
                                  key={group.id} 
                                  group={group} 
                                  interviewId={interview.id}
                                />
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  )}
                </div>

                {/* Card Footer */}
                <div className="interview-card-footer">
                  <button 
                    className="btn-primary interview-action-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedInterviewId(interview.id);
                      handleStartInterview(interview.id);
                    }}
                  >
                    <PlayIcon className="btn-icon" />
                    Start Interview
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
    </AccessControl>
  );
}
