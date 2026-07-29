import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDaysIcon, ChevronDownIcon, ChevronRightIcon, ClockIcon,
  DocumentDuplicateIcon, MagnifyingGlassIcon, MapPinIcon, PencilSquareIcon, PlusIcon,
  TrashIcon, UserGroupIcon, XMarkIcon
} from '@heroicons/react/24/outline';
import {
  Box, Button, Chip, FormControl, InputLabel, MenuItem, Select, Stack, Tab, Tabs, Typography
} from '@mui/material';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import '../styles/AdminAssignedInterviews.css';

const SECTIONS = [
  ['COFFEE_CHATS', 'Coffee Chats'],
  ['ROUND_ONE', 'First Round Interviews'],
  ['FINAL_ROUND', 'Final Round Interviews']
];

const FORM_SECTIONS = [
  ['VIRTUAL_COFFEE_CHAT', 'Virtual Coffee Chats'],
  ['COFFEE_CHAT_PART_ONE', 'Coffee Chat - Round 1'],
  ['COFFEE_CHAT_PART_TWO', 'Coffee Chat - Round 2'],
  ['ROUND_ONE', 'First Round Interviews'],
  ['FINAL_ROUND', 'Final Round Interviews']
];

const COFFEE_CHAT_SECTIONS = new Set([
  'VIRTUAL_COFFEE_CHAT',
  'COFFEE_CHAT_PART_ONE',
  'COFFEE_CHAT_PART_TWO'
]);

const emptyForm = {
  title: '',
  section: 'VIRTUAL_COFFEE_CHAT',
  startDate: '',
  endDate: '',
  location: '',
  dresscode: '',
  slots: []
};

const emptyBulkForm = {
  sourceCycleId: '',
  sourceInterviewId: '',
  title: '',
  section: 'ROUND_ONE',
  startDate: '',
  durationMinutes: '30',
  slotIntervalMinutes: '30',
  location: '',
  dresscode: '',
  maxCandidates: '1',
  teamIds: [],
  requestKey: ''
};

const parseConfig = (interview) => {
  try {
    return typeof interview.description === 'string'
      ? JSON.parse(interview.description || '{}')
      : interview.description || {};
  } catch {
    return {};
  }
};

const sectionFor = (interview) => {
  const configured = parseConfig(interview).section;
  if (configured && configured !== 'COFFEE_CHATS') {
    if (configured === 'ROUND_TWO') return 'FINAL_ROUND';
    if (configured === 'COFFEE_CHAT') return 'VIRTUAL_COFFEE_CHAT';
    return configured;
  }
  if (interview.interviewType === 'ROUND_ONE') return 'ROUND_ONE';
  if (interview.interviewType === 'FINAL_ROUND' || interview.interviewType === 'ROUND_TWO') return 'FINAL_ROUND';
  return 'VIRTUAL_COFFEE_CHAT';
};

const displaySectionFor = (interview) => {
  const section = sectionFor(interview);
  return COFFEE_CHAT_SECTIONS.has(section) ? 'COFFEE_CHATS' : section;
};

const interviewTypeFor = (section) => {
  if (section === 'ROUND_ONE') return 'ROUND_ONE';
  if (section === 'FINAL_ROUND') return 'FINAL_ROUND';
  return 'COFFEE_CHAT';
};

const toLocalInput = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

const getPhase = (interview) => {
  const now = Date.now();
  const startsAt = new Date(interview.startDate).getTime();
  const opensAt = new Date(interview.startDate).getTime() - (5 * 60 * 1000);
  if (now < opensAt) return 'upcoming';
  if (now < startsAt) return 'open';
  if (now <= new Date(interview.endDate).getTime()) return 'live';
  return 'ended';
};

const formatDate = (value) => new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric'
}).format(new Date(value));

const formatTime = (start, end) => `${new Intl.DateTimeFormat(undefined, {
  hour: 'numeric', minute: '2-digit'
}).format(new Date(start))}–${new Intl.DateTimeFormat(undefined, {
  hour: 'numeric', minute: '2-digit'
}).format(new Date(end))}`;

const candidateName = (application) =>
  application.name ||
  `${application.firstName || ''} ${application.lastName || ''}`.trim() ||
  application.candidate?.fullName ||
  application.email;

const matchesApplicantSearch = (application, term) => {
  const normalizedTerm = term.trim().toLowerCase();
  return !normalizedTerm || candidateName(application).toLowerCase().includes(normalizedTerm);
};

const newId = () => globalThis.crypto?.randomUUID?.() ||
  `slot-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const makeSlot = (applicationIds = [], interviewerIds = []) => ({
  id: newId(),
  applicationIds: Array.isArray(applicationIds) ? applicationIds : applicationIds ? [applicationIds] : [],
  interviewerIds
});

const slotsFromLegacyConfig = (config) => {
  if (Array.isArray(config.slots)) {
    return config.slots.map((slot) => ({
      ...slot,
      applicationIds: slot.applicationIds || (slot.applicationId ? [slot.applicationId] : []),
      interviewerIds: slot.interviewerIds || []
    }));
  }

  const memberGroups = config.memberGroups || [];
  const groupAssignments = config.groupAssignments || {};
  const slots = [];
  memberGroups.forEach((memberGroup) => {
    const assignedApplicationIds = (groupAssignments[memberGroup.id] || [])
      .flatMap((applicationGroupId) => {
        const applicationGroup = (config.applicationGroups || []).find((group) => group.id === applicationGroupId);
        return applicationGroup?.applicationIds || [];
      });
    if (assignedApplicationIds.length) slots.push(makeSlot(assignedApplicationIds, memberGroup.memberIds || []));
  });
  const assignedApplicationGroupIds = new Set(Object.values(groupAssignments).flat());
  (config.applicationGroups || []).forEach((applicationGroup) => {
    if (!assignedApplicationGroupIds.has(applicationGroup.id)) {
      slots.push(makeSlot(applicationGroup.applicationIds || []));
    }
  });

  if (!slots.length) {
    slots.push(...(config.applicationIds || []).map((applicationId) => makeSlot([applicationId])));
  }
  return slots;
};

const buildCompatibleSlotConfig = (form) => {
  const slots = form.slots.map((slot, index) => {
    const id = slot.id || newId();
    return {
      ...slot,
      id,
      name: `Slot ${index + 1}`,
      interviewerIds: slot.interviewerIds.filter(Boolean),
      applicationIds: slot.applicationIds.filter(Boolean),
      applicationGroupId: `slot-${id}-candidate`,
      memberGroupId: `slot-${id}-team`
    };
  });
  const applicationGroups = slots.map((slot) => ({
    id: slot.applicationGroupId,
    name: slot.name,
    applicationIds: slot.applicationIds
  }));
  const memberGroups = slots.map((slot) => ({
    id: slot.memberGroupId,
    name: `${slot.name} Interviewers`,
    memberIds: slot.interviewerIds
  }));

  return {
    section: form.section,
    teamSize: Math.max(1, ...slots.map((slot) => slot.interviewerIds.length)),
    slots,
    applicationIds: [...new Set(slots.flatMap((slot) => slot.applicationIds))],
    applicationGroups,
    memberGroups,
    groupAssignments: Object.fromEntries(
      slots.map((slot) => [slot.memberGroupId, [slot.applicationGroupId]])
    )
  };
};

export default function AdminAssignedInterviews() {
  const navigate = useNavigate();
  const [interviews, setInterviews] = useState([]);
  const [members, setMembers] = useState([]);
  const [applications, setApplications] = useState([]);
  const [activeCycle, setActiveCycle] = useState(null);
  const [cycles, setCycles] = useState([]);
  const [selectedCycleId, setSelectedCycleId] = useState('');
  const [scheduleView, setScheduleView] = useState('upcoming');
  const [expanded, setExpanded] = useState(new Set(SECTIONS.map(([key]) => key)));
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkForm, setBulkForm] = useState(emptyBulkForm);
  const [bulkTeams, setBulkTeams] = useState([]);
  const [bulkTemplates, setBulkTemplates] = useState([]);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkError, setBulkError] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState(null);
  const [availableApplicantSearch, setAvailableApplicantSearch] = useState('');
  const [selectedApplicantSearch, setSelectedApplicantSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [, setClockTick] = useState(0);

  const load = async (requestedCycleId = selectedCycleId) => {
    const [cycleResult, cyclesResult] = await Promise.allSettled([
      apiClient.get('/admin/cycles/active'),
      apiClient.get('/admin/cycles')
    ]);
    const active = cycleResult.status === 'fulfilled' ? cycleResult.value : null;
    const cycleRows = cyclesResult.status === 'fulfilled' && Array.isArray(cyclesResult.value) ? cyclesResult.value : [];
    const targetCycleId = requestedCycleId || active?.id || '';
    const cycleQuery = targetCycleId ? `?cycleId=${encodeURIComponent(targetCycleId)}` : '';
    const [interviewResult, memberResult, adminResult, applicationResult] =
      await Promise.allSettled([
        apiClient.get(`/admin/interviews${cycleQuery}`),
        apiClient.get('/admin/users?role=INTERVIEWER'),
        apiClient.get('/admin/users?role=ADMIN'),
        apiClient.get(`/admin/applications${cycleQuery}`)
      ]);

    setInterviews(interviewResult.status === 'fulfilled' ? interviewResult.value : []);
    const memberRows = memberResult.status === 'fulfilled' ? memberResult.value : [];
    const adminRows = adminResult.status === 'fulfilled' ? adminResult.value : [];
    setMembers([...adminRows, ...memberRows].filter(
      (person, index, all) => all.findIndex((candidate) => candidate.id === person.id) === index
    ));
    const apps = applicationResult.status === 'fulfilled' ? applicationResult.value : [];
    setApplications(Array.isArray(apps) ? apps : apps.applications || []);
    setActiveCycle(active);
    setCycles(cycleRows);
    setSelectedCycleId(targetCycleId);
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((tick) => tick + 1), 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!selectedMemberId && members.length) setSelectedMemberId(members[0].id);
  }, [members, selectedMemberId]);

  const grouped = useMemo(() => Object.fromEntries(
    SECTIONS.map(([key]) => [
      key,
      interviews.filter((interview) => displaySectionFor(interview) === key)
    ])
  ), [interviews]);

  const displayedCycle = cycles.find((cycle) => cycle.id === selectedCycleId) || activeCycle;
  const isViewingActiveCycle = Boolean(activeCycle?.id && selectedCycleId === activeCycle.id);
  const matchesScheduleView = (interview) => {
    const phase = getPhase(interview);
    if (scheduleView === 'history') return phase === 'ended';
    if (scheduleView === 'live') return phase === 'open' || phase === 'live';
    if (scheduleView === 'all') return true;
    return phase !== 'ended';
  };

  const changeCycle = async (cycleId) => {
    setScheduleView('upcoming');
    await load(cycleId);
  };

  const filteredAvailableApplicants = useMemo(
    () => applications.filter((application) => matchesApplicantSearch(application, availableApplicantSearch)),
    [applications, availableApplicantSearch]
  );

  const assignmentsByMember = useMemo(() => Object.fromEntries(
    members.map((member) => [
      member.id,
      interviews.filter((interview) => {
        const phase = getPhase(interview);
        if (scheduleView === 'history') return phase === 'ended';
        if (scheduleView === 'live') return phase === 'open' || phase === 'live';
        if (scheduleView === 'all') return true;
        return phase !== 'ended';
      }).flatMap((interview) => {
        const slots = slotsFromLegacyConfig(parseConfig(interview));
        const grouped = new Map();
        slots.filter((slot) => slot.interviewerIds?.includes(member.id)).forEach((slot) => {
          const partners = slot.interviewerIds
            .filter((id) => id && id !== member.id)
            .map((id) => members.find((person) => person.id === id))
            .filter(Boolean);
          const key = `${interview.id}:${partners.map(({ id }) => id).sort().join(',')}`;
          const existing = grouped.get(key) || { interview, partners, applicants: [] };
          existing.applicants.push(...slot.applicationIds.map((applicationId) =>
            applications.find((application) => application.id === applicationId)
          ).filter(Boolean));
          grouped.set(key, existing);
        });
        return [...grouped.values()];
      })
    ])
  ), [members, interviews, applications, scheduleView]);

  const openCreate = (section = 'VIRTUAL_COFFEE_CHAT') => {
    if (!isViewingActiveCycle) {
      window.alert('Archived cycles are read-only. Switch to the active recruiting cycle to create a session.');
      return;
    }
    setEditingId(null);
    setForm({ ...emptyForm, section: section === 'COFFEE_CHATS' ? 'VIRTUAL_COFFEE_CHAT' : section });
    setAvailableApplicantSearch('');
    setSelectedApplicantSearch('');
    setError('');
    setModalOpen(true);
  };

  const openEdit = (interview) => {
    const config = parseConfig(interview);
    setEditingId(interview.id);
    setForm({
      title: interview.title,
      section: sectionFor(interview),
      startDate: toLocalInput(interview.startDate),
      endDate: toLocalInput(interview.endDate),
      location: interview.location || '',
      dresscode: interview.dresscode || '',
      slots: slotsFromLegacyConfig(config)
    });
    setAvailableApplicantSearch('');
    setSelectedApplicantSearch('');
    setError('');
    setModalOpen(true);
  };

  const addTeams = (count = 1) => {
    setForm((current) => ({
      ...current,
      slots: [
        ...current.slots,
        ...Array.from({ length: count }, () => makeSlot([], ['', '']))
      ]
    }));
  };

  const updateSlot = (slotId, changes) => {
    setForm((current) => ({
      ...current,
      slots: current.slots.map((slot) =>
        slot.id === slotId ? { ...slot, ...changes } : slot
      )
    }));
  };

  const removeSlot = (slotId) => {
    setForm((current) => ({
      ...current,
      slots: current.slots.filter((slot) => slot.id !== slotId)
    }));
  };

  const copyTeam = (slotId) => {
    setForm((current) => {
      const index = current.slots.findIndex((slot) => slot.id === slotId);
      if (index < 0) return current;
      const source = current.slots[index];
      const slots = [...current.slots];
      slots.splice(index + 1, 0, makeSlot([], [...source.interviewerIds]));
      return { ...current, slots };
    });
  };

  const loadBulkTeams = async (cycleId) => {
    const result = await apiClient.get(`/admin/interviews/bulk-teams?cycleId=${encodeURIComponent(cycleId)}`);
    const teams = Array.isArray(result.teams) ? result.teams : [];
    setBulkTeams(teams);
    return teams;
  };

  const loadBulkTemplates = async (sourceCycleId) => {
    if (!sourceCycleId) {
      setBulkTemplates([]);
      return [];
    }
    const result = await apiClient.get(`/admin/interviews/templates?sourceCycleId=${encodeURIComponent(sourceCycleId)}`);
    const templates = Array.isArray(result.templates) ? result.templates : [];
    setBulkTemplates(templates);
    return templates;
  };

  const openBulkCreate = async () => {
    if (!activeCycle || !isViewingActiveCycle) {
      window.alert('Create and activate a recruiting cycle before creating interview slots.');
      return;
    }

    setBulkModalOpen(true);
    setBulkForm({ ...emptyBulkForm, requestKey: `bulk-${newId()}` });
    setBulkTeams([]);
    setBulkTemplates([]);
    setBulkError('');
    setBulkLoading(true);
    try {
      const teams = await loadBulkTeams(activeCycle.id);
      setBulkForm((current) => ({
        ...current,
        teamIds: teams.filter((team) => team.members?.length).map((team) => team.id)
      }));
    } catch (loadError) {
      setBulkError(loadError.message || 'Unable to load review teams for this cycle.');
    } finally {
      setBulkLoading(false);
    }
  };

  const chooseTemplateCycle = async (sourceCycleId) => {
    setBulkForm((current) => ({ ...current, sourceCycleId, sourceInterviewId: '' }));
    setBulkTemplates([]);
    if (!sourceCycleId) return;

    setBulkLoading(true);
    try {
      await loadBulkTemplates(sourceCycleId);
    } catch (loadError) {
      setBulkError(loadError.message || 'Unable to load templates from that recruiting cycle.');
    } finally {
      setBulkLoading(false);
    }
  };

  const chooseTemplate = (sourceInterviewId) => {
    const template = bulkTemplates.find((item) => item.id === sourceInterviewId);
    setBulkForm((current) => {
      if (!template) return { ...current, sourceInterviewId: '' };
      return {
        ...current,
        sourceInterviewId,
        title: template.title || current.title,
        section: template.section || current.section,
        durationMinutes: String(template.durationMinutes || current.durationMinutes),
        location: template.location || current.location,
        dresscode: template.dresscode || current.dresscode,
        maxCandidates: String(template.maxCandidates || current.maxCandidates)
      };
    });
  };

  const toggleBulkTeam = (teamId) => {
    setBulkForm((current) => ({
      ...current,
      teamIds: current.teamIds.includes(teamId)
        ? current.teamIds.filter((id) => id !== teamId)
        : [...current.teamIds, teamId]
    }));
  };

  const bulkPreview = useMemo(() => {
    const start = new Date(bulkForm.startDate);
    const duration = Number(bulkForm.durationMinutes);
    const interval = Number(bulkForm.slotIntervalMinutes);
    if (!Number.isFinite(start.getTime()) || !Number.isInteger(duration) || duration <= 0 || !Number.isInteger(interval) || interval <= 0) {
      return [];
    }
    return bulkTeams
      .filter((team) => bulkForm.teamIds.includes(team.id))
      .map((team, index) => {
        const slotStart = new Date(start.getTime() + index * interval * 60000);
        return {
          team,
          startDate: slotStart,
          endDate: new Date(slotStart.getTime() + duration * 60000)
        };
      });
  }, [bulkForm.durationMinutes, bulkForm.slotIntervalMinutes, bulkForm.startDate, bulkForm.teamIds, bulkTeams]);

  const saveBulk = async (event) => {
    event.preventDefault();
    if (!activeCycle) return setBulkError('Create and activate a recruiting cycle first.');
    if (!bulkForm.teamIds.length) return setBulkError('Select at least one review team.');
    if (!bulkForm.requestKey) return setBulkError('Unable to prepare a retry-safe bulk request. Close and reopen this window.');

    setBulkSaving(true);
    setBulkError('');
    try {
      await apiClient.post('/admin/interviews/bulk-create', {
        cycleId: activeCycle.id,
        sourceCycleId: bulkForm.sourceCycleId || null,
        sourceInterviewId: bulkForm.sourceInterviewId || null,
        requestKey: bulkForm.requestKey,
        title: bulkForm.title,
        section: bulkForm.section,
        startDate: new Date(bulkForm.startDate).toISOString(),
        durationMinutes: Number(bulkForm.durationMinutes),
        slotIntervalMinutes: Number(bulkForm.slotIntervalMinutes),
        location: bulkForm.location,
        dresscode: bulkForm.dresscode,
        maxCandidates: Number(bulkForm.maxCandidates),
        teamIds: bulkForm.teamIds
      });
      await load();
      setBulkModalOpen(false);
    } catch (saveError) {
      setBulkError(saveError.message || 'Unable to create interview slots.');
    } finally {
      setBulkSaving(false);
    }
  };

  const save = async (event) => {
    event.preventDefault();
    if (!activeCycle && !editingId) return setError('Create an active recruiting cycle first.');
    if (new Date(form.endDate) <= new Date(form.startDate)) {
      return setError('End time must be after the start time.');
    }
    if (!form.dresscode) return setError('Choose a dress code.');
    if (!form.slots.length) return setError('Create at least one interviewer team.');
    const invalidSlot = form.slots.find((slot) =>
      !slot.applicationIds.length ||
      !slot.interviewerIds.filter(Boolean).length ||
      new Set(slot.interviewerIds.filter(Boolean)).size !== slot.interviewerIds.filter(Boolean).length
    );
    if (invalidSlot) {
      return setError('Every interviewer team needs at least one club member and one applicant.');
    }

    setSaving(true);
    setError('');
    const slotConfig = buildCompatibleSlotConfig(form);
    const payload = {
      title: form.title,
      interviewType: interviewTypeFor(form.section),
      startDate: new Date(form.startDate).toISOString(),
      endDate: new Date(form.endDate).toISOString(),
      location: form.location,
      dresscode: form.dresscode,
      memberIds: [...new Set(slotConfig.slots.flatMap((slot) => slot.interviewerIds))],
      applicationIds: slotConfig.applicationIds,
      description: slotConfig,
      ...(!editingId && { cycleId: activeCycle.id })
    };

    try {
      const saved = editingId
        ? await apiClient.patch(`/admin/interviews/${editingId}/config`, {
            type: 'schedule',
            config: payload
          })
        : await apiClient.post('/admin/interviews', payload);

      // Read back from the server so the modal only closes after persistence is confirmed.
      const refreshed = await apiClient.get(`/admin/interviews?cycleId=${encodeURIComponent(selectedCycleId || activeCycle.id)}`);
      const persisted = refreshed.find((interview) => interview.id === saved.id);
      const persistedConfig = persisted ? parseConfig(persisted) : {};
      if (
        !persisted ||
        persisted.title !== payload.title ||
        persisted.location !== payload.location ||
        (persisted.dresscode || '') !== payload.dresscode ||
        (persistedConfig.slots || []).length !== slotConfig.slots.length
      ) {
        throw new Error('The server did not persist all interview changes. Restart the API server and try again.');
      }
      setInterviews(refreshed);
      setModalOpen(false);
    } catch (saveError) {
      setError(saveError.message || 'Unable to save interview.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (interview) => {
    if (!window.confirm(`Delete “${interview.title}”? Evaluations tied to it will also be deleted.`)) return;
    try {
      await apiClient.delete(`/admin/interviews/${interview.id}`);
      setInterviews((current) => current.filter(({ id }) => id !== interview.id));
    } catch (deleteError) {
      window.alert(deleteError.message || 'Unable to delete interview.');
    }
  };

  const join = (interview) => {
    const type = interview.interviewType;
    const config = parseConfig(interview);
    const groupIds = config.slots?.map((slot) => slot.applicationGroupId).filter(Boolean).join(',') || 'direct';
    if (type === 'ROUND_ONE') {
      navigate(`/member/first-round-interview?interviewId=${interview.id}&groupIds=${groupIds}`);
    } else if (type === 'FINAL_ROUND' || type === 'ROUND_TWO') {
      navigate(`/admin/final-round-interview?interviewId=${interview.id}&groupIds=${groupIds}`);
    } else {
      navigate(`/admin/interview-interface?interviewId=${interview.id}&groupIds=${groupIds}`);
    }
  };

  return (
    <AccessControl allowedRoles={['ADMIN']}>
      <main className="interview-schedule">
        <Box component="header" className="schedule-header">
          <Box>
            <Typography component="p" className="eyebrow">Recruiting cycle</Typography>
            <Typography component="h1">Manage Interviews</Typography>
            <Typography component="p">{displayedCycle?.name || 'Select a recruiting cycle'}{isViewingActiveCycle ? ' · Active' : ' · Read-only history'}</Typography>
          </Box>
          <Stack className="schedule-actions" direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <FormControl size="small" className="cycle-selector">
              <InputLabel id="interview-cycle-label">Recruiting Cycle</InputLabel>
              <Select
                labelId="interview-cycle-label"
                label="Recruiting Cycle"
                value={selectedCycleId}
                onChange={(event) => changeCycle(event.target.value)}
              >
                {cycles.map((cycle) => <MenuItem key={cycle.id} value={cycle.id}>{cycle.name}{cycle.isActive ? ' (Active)' : ''}</MenuItem>)}
              </Select>
            </FormControl>
            <Button variant="outlined" startIcon={<DocumentDuplicateIcon />} onClick={openBulkCreate} disabled={!isViewingActiveCycle}>
              Create team slots
            </Button>
            <Button variant="contained" startIcon={<PlusIcon />} onClick={() => openCreate()} disabled={!isViewingActiveCycle}>
              New interview
            </Button>
          </Stack>
        </Box>

        <Box component="section" className="schedule-summary">
          <span><strong>{interviews.length}</strong> sessions</span>
          <span><strong>{interviews.filter((item) => getPhase(item) === 'live').length}</strong> live now</span>
          <span><strong>{interviews.filter((item) => getPhase(item) === 'upcoming').length}</strong> upcoming</span>
          <Chip size="small" color={isViewingActiveCycle ? 'success' : 'default'} label={isViewingActiveCycle ? 'Active cycle' : 'Archived cycle'} />
        </Box>

        <Box className="interview-dashboard-tabs">
          <Tabs value={scheduleView} onChange={(_, value) => setScheduleView(value)} variant="scrollable" allowScrollButtonsMobile>
            <Tab value="upcoming" label={`Upcoming (${interviews.filter((item) => getPhase(item) !== 'ended').length})`} />
            <Tab value="live" label={`Starting Soon & Live (${interviews.filter((item) => ['open', 'live'].includes(getPhase(item))).length})`} />
            <Tab value="history" label={`History (${interviews.filter((item) => getPhase(item) === 'ended').length})`} />
            <Tab value="all" label={`All (${interviews.length})`} />
          </Tabs>
        </Box>

        <div className="schedule-sections">
          {SECTIONS.map(([key, label]) => {
            const rows = (grouped[key] || []).filter(matchesScheduleView);
            const isExpanded = expanded.has(key);
            return (
              <section className="schedule-section" key={key}>
                <div className="section-heading">
                  <button
                    className="section-toggle"
                    onClick={() => setExpanded((current) => {
                      const next = new Set(current);
                      next.has(key) ? next.delete(key) : next.add(key);
                      return next;
                    })}
                  >
                    <span>{isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}</span>
                    <strong>{label}</strong>
                    <span className="section-count">{rows.length}</span>
                  </button>
                  {isViewingActiveCycle && scheduleView !== 'history' && (
                    <button className="section-add" onClick={() => openCreate(key)}>
                      <PlusIcon /> Add Session
                    </button>
                  )}
                </div>
                {isExpanded && (
                  <div className="session-list">
                    {!rows.length && (
                      isViewingActiveCycle && scheduleView !== 'history' ? (
                        <button className="empty-session" onClick={() => openCreate(key)}>
                          <PlusIcon /> Add the first session
                        </button>
                      ) : <p className="empty-session">No {scheduleView === 'history' ? 'completed' : 'matching'} sessions.</p>
                    )}
                    {rows.map((interview) => {
                      const phase = getPhase(interview);
                      const config = parseConfig(interview);
                      return (
                        <article className="session-row" key={interview.id}>
                          <div className="session-when">
                            <strong>{formatDate(interview.startDate)}</strong>
                            <span>{formatTime(interview.startDate, interview.endDate)}</span>
                          </div>
                          <div className="session-main">
                            <div className="session-title-line">
                              <h2>{interview.title}</h2>
                              <Chip
                                className="phase-chip"
                                size="small"
                                color={phase === 'live' ? 'success' : phase === 'open' ? 'warning' : phase === 'upcoming' ? 'primary' : 'default'}
                                label={phase === 'live' ? 'Live Now' : phase === 'open' ? 'Starting Soon' : phase === 'upcoming' ? 'Upcoming' : 'Completed'}
                              />
                            </div>
                            <div className="session-meta">
                              <span><MapPinIcon /> {interview.location || 'Location TBD'}</span>
                              {interview.dresscode && <span>{interview.dresscode}</span>}
                            </div>
                          </div>
                          <div className="participant-counts">
                            <span><UserGroupIcon /> {interview.assignments?.length || 0} members</span>
                            <span>{config.applicationIds?.length || 0} candidates</span>
                          </div>
                          <div className="session-actions">
                            {(phase === 'open' || phase === 'live') && (
                              <button className="join-button" onClick={() => join(interview)}>Join</button>
                            )}
                            {isViewingActiveCycle && (
                              <>
                                <button className="icon-button" aria-label={`Edit ${interview.title}`} onClick={() => openEdit(interview)}>
                                  <PencilSquareIcon />
                                </button>
                                <button className="icon-button danger" aria-label={`Delete ${interview.title}`} onClick={() => remove(interview)}>
                                  <TrashIcon />
                                </button>
                              </>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        <section className="member-assignment-browser">
          <header>
            <div>
              <p className="eyebrow">Member Assignment View</p>
              <h2>Assignments by Club Member</h2>
              <p>Choose a member to see their rounds, interviewer partners, and applicants.</p>
            </div>
          </header>
          <div className="member-browser-layout">
            <div className="member-browser-list">
              {members.map((member) => {
                const count = assignmentsByMember[member.id]?.length || 0;
                return (
                  <button
                    key={member.id}
                    className={selectedMemberId === member.id ? 'selected' : ''}
                    onClick={() => setSelectedMemberId(member.id)}
                  >
                    <span>{member.fullName}</span>
                    <small>{count} assignment{count === 1 ? '' : 's'}</small>
                  </button>
                );
              })}
            </div>
            <div className="member-browser-detail">
              {(() => {
                const member = members.find(({ id }) => id === selectedMemberId);
                const assignments = assignmentsByMember[selectedMemberId] || [];
                if (!member) return <p className="member-browser-empty">Select a club member.</p>;
                return (
                  <>
                    <div className="member-detail-heading">
                      <h3>{member.fullName}</h3>
                      <span>{assignments.length} total</span>
                    </div>
                    {!assignments.length ? (
                      <p className="member-browser-empty">No interview assignments yet.</p>
                    ) : assignments.map(({ interview, applicants, partners }, index) => (
                      <article className="member-assignment-row" key={`${interview.id}-${partners.map(({ id }) => id).join('-')}-${index}`}>
                        <div>
                          <span className="assignment-round">{SECTIONS.find(([key]) => key === displaySectionFor(interview))?.[1]}</span>
                          <strong>{interview.title}</strong>
                          <small>{formatDate(interview.startDate)} · {formatTime(interview.startDate, interview.endDate)}</small>
                        </div>
                        <div>
                          <small>Paired with</small>
                          <strong>{partners.length ? partners.map(({ fullName }) => fullName).join(', ') : 'No partner assigned'}</strong>
                        </div>
                        <div>
                          <small>Applicants ({applicants.length})</small>
                          {applicants.length ? (
                            <ul className="assignment-applicant-list">
                              {applicants.map((application, applicantIndex) => (
                                <li key={`${interview.id}-${application.id}-${applicantIndex}`}>{candidateName(application)}</li>
                              ))}
                            </ul>
                          ) : <strong>No applicants assigned</strong>}
                        </div>
                      </article>
                    ))}
                  </>
                );
              })()}
            </div>
          </div>
        </section>
      </main>

      {modalOpen && (
        <div className="interview-modal-backdrop" role="presentation" onMouseDown={() => setModalOpen(false)}>
          <div className="interview-modal" role="dialog" aria-modal="true" aria-labelledby="interview-modal-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="eyebrow">{editingId ? 'Update session' : 'Schedule a session'}</p>
                <h2 id="interview-modal-title">{editingId ? 'Edit interview' : 'New interview'}</h2>
              </div>
              <button className="icon-button" onClick={() => setModalOpen(false)} aria-label="Close">
                <XMarkIcon />
              </button>
            </header>
            <form onSubmit={save}>
              <div className="form-grid">
                <label className="title-field">Title
                  <input required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="e.g. F27 Coffee Chat - Round 1" />
                </label>
                <label className="section-field">Round
                  <select value={form.section} onChange={(event) => setForm({ ...form, section: event.target.value })}>
                    {FORM_SECTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                </label>
                <label>Dress Code
                  <select required value={form.dresscode} onChange={(event) => setForm({ ...form, dresscode: event.target.value })}>
                    <option value="">Select a dress code</option>
                    <option value="Business Professional">Business Professional</option>
                    <option value="Business Casual">Business Casual</option>
                    <option value="Smart Casual">Smart Casual</option>
                    <option value="Casual">Casual</option>
                  </select>
                </label>
                <label><CalendarDaysIcon /> Starts
                  <input required type="datetime-local" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} />
                </label>
                <label><ClockIcon /> Ends
                  <input required type="datetime-local" value={form.endDate} onChange={(event) => setForm({ ...form, endDate: event.target.value })} />
                </label>
                <label><MapPinIcon /> Location
                  <input required value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} placeholder="Room or meeting link" />
                </label>
              </div>
              <section className="slot-builder">
                <div className="slot-builder-header">
                  <div>
                    <p className="eyebrow">Interviewer Teams</p>
                    <h3>Build the teams first, then assign applicants</h3>
                    <p>Each row is one interviewer team and the applicants they will interview together.</p>
                  </div>
                  <div className="team-tools">
                    <div className="team-add-actions">
                    <button type="button" className="secondary-button" onClick={() => addTeams(5)}>
                      <PlusIcon /> Add 5 Teams
                    </button>
                    <button type="button" className="primary-button" onClick={() => addTeams(1)}>
                      <PlusIcon /> Add Team
                    </button>
                    </div>
                  </div>
                </div>

                <div className="slot-list">
                  <div className="slot-list-heading">
                    <strong>{form.slots.length} Interviewer Team{form.slots.length === 1 ? '' : 's'}</strong>
                    <span>Choose the pair, then use Add to assign one or more applicants.</span>
                  </div>
                  {!form.slots.length && (
                    <div className="slot-empty">Add an interviewer team to begin.</div>
                  )}
                  {form.slots.map((slot, index) => (
                    <div className="slot-row" key={slot.id}>
                      <span className="slot-number">{index + 1}</span>
                      <div className="interviewer-stack">
                        {Array.from({ length: Math.max(2, slot.interviewerIds.length) }, (_, interviewerIndex) => (
                          <label key={interviewerIndex}>Interviewer {interviewerIndex + 1}
                            <select
                              value={slot.interviewerIds[interviewerIndex] || ''}
                              onChange={(event) => {
                                const interviewerIds = [...slot.interviewerIds];
                                interviewerIds[interviewerIndex] = event.target.value;
                                updateSlot(slot.id, { interviewerIds });
                              }}
                            >
                              <option value="">Select member</option>
                              {members.map((member) => (
                                <option
                                  key={member.id}
                                  value={member.id}
                                  disabled={slot.interviewerIds.some((id, selectedIndex) =>
                                    selectedIndex !== interviewerIndex && id === member.id
                                  )}
                                >
                                  {member.fullName}{member.role === 'ADMIN' ? ' (Admin)' : ''}
                                </option>
                              ))}
                            </select>
                          </label>
                        ))}
                      </div>
                      <span className="team-arrow" aria-hidden="true">→</span>
                      <div className="assigned-applicants-field">
                        <div className="assigned-applicants-label">
                          <span>Assigned Applicants</span>
                          <small>Add names from the available list</small>
                        </div>
                        <div className="applicant-picker">
                          <div className="applicant-picker-column">
                            <div className="applicant-picker-heading">
                              <strong>Available</strong>
                              <span>{filteredAvailableApplicants.filter((application) => !slot.applicationIds.includes(application.id)).length}</span>
                            </div>
                            <label className="applicant-picker-search">
                              <MagnifyingGlassIcon />
                              <input
                                type="search"
                                value={availableApplicantSearch}
                                onChange={(event) => setAvailableApplicantSearch(event.target.value)}
                                placeholder="Search available applicants…"
                              />
                            </label>
                            <div className="applicant-name-list" role="list" aria-label="Available applicants">
                              {filteredAvailableApplicants.filter((application) => !slot.applicationIds.includes(application.id)).map((application) => (
                                <button
                                  type="button"
                                  className="applicant-name-option"
                                  key={application.id}
                                  onClick={() => updateSlot(slot.id, {
                                    applicationIds: [...slot.applicationIds, application.id]
                                  })}
                                >
                                  <span>{candidateName(application)}</span>
                                  <span className="applicant-option-action"><PlusIcon /> Add</span>
                                </button>
                              ))}
                              {!filteredAvailableApplicants.some((application) => !slot.applicationIds.includes(application.id)) && (
                                <p className="applicant-list-empty">No available applicants match your search.</p>
                              )}
                            </div>
                          </div>
                          <div className="applicant-picker-column selected">
                            <div className="applicant-picker-heading">
                              <strong>Selected</strong>
                              <span>{slot.applicationIds.length}</span>
                            </div>
                            <label className="applicant-picker-search">
                              <MagnifyingGlassIcon />
                              <input
                                type="search"
                                value={selectedApplicantSearch}
                                onChange={(event) => setSelectedApplicantSearch(event.target.value)}
                                placeholder="Search selected applicants…"
                              />
                            </label>
                            <div className="applicant-name-list" role="list" aria-label="Selected applicants">
                              {slot.applicationIds.map((applicationId) => {
                                const application = applications.find((candidate) => candidate.id === applicationId);
                                if (!application || !matchesApplicantSearch(application, selectedApplicantSearch)) return null;
                                return (
                                  <button
                                    type="button"
                                    className="applicant-name-option selected"
                                    key={application.id}
                                    onClick={() => updateSlot(slot.id, {
                                      applicationIds: slot.applicationIds.filter((id) => id !== application.id)
                                    })}
                                  >
                                    <span>{candidateName(application)}</span>
                                    <span className="applicant-option-action"><XMarkIcon /> Remove</span>
                                  </button>
                                );
                              })}
                              {!slot.applicationIds.some((applicationId) => {
                                const application = applications.find((candidate) => candidate.id === applicationId);
                                return application && matchesApplicantSearch(application, selectedApplicantSearch);
                              }) && (
                                <p className="applicant-list-empty">
                                  {slot.applicationIds.length ? 'No selected applicants match your search.' : 'No applicants selected yet.'}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="team-row-actions">
                        <button type="button" className="icon-button" onClick={() => copyTeam(slot.id)} aria-label={`Copy interviewer team ${index + 1}`} title="Copy team">
                          <DocumentDuplicateIcon />
                        </button>
                        <button type="button" className="icon-button danger" onClick={() => removeSlot(slot.id)} aria-label={`Remove interviewer team ${index + 1}`} title="Remove team">
                          <TrashIcon />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
              {error && <p className="form-error">{error}</p>}
              <footer>
                <button type="button" className="secondary-button" onClick={() => setModalOpen(false)}>Cancel</button>
                <button type="submit" className="primary-button" disabled={saving}>
                  {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create interview'}
                </button>
              </footer>
            </form>
          </div>
        </div>
      )}

      {bulkModalOpen && (
        <div className="interview-modal-backdrop" role="presentation" onMouseDown={() => !bulkSaving && setBulkModalOpen(false)}>
          <div className="interview-modal bulk-interview-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-interview-modal-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="eyebrow">Repeatable schedule setup</p>
                <h2 id="bulk-interview-modal-title">Create slots for review teams</h2>
              </div>
              <button className="icon-button" onClick={() => setBulkModalOpen(false)} aria-label="Close" disabled={bulkSaving}>
                <XMarkIcon />
              </button>
            </header>
            <form onSubmit={saveBulk}>
              <p className="bulk-intro">
                Pick a prior-cycle session or define a new pattern, then create one scheduled slot for every selected team in {activeCycle?.name || 'the active cycle'}.
              </p>

              <div className="bulk-template-grid">
                <label>Copy a previous cycle <span>(optional)</span>
                  <select
                    value={bulkForm.sourceCycleId}
                    onChange={(event) => {
                      setBulkError('');
                      chooseTemplateCycle(event.target.value);
                    }}
                    disabled={bulkLoading}
                  >
                    <option value="">Define a new pattern</option>
                    {cycles.filter((cycle) => cycle.id !== activeCycle?.id).map((cycle) => (
                      <option key={cycle.id} value={cycle.id}>{cycle.name}</option>
                    ))}
                  </select>
                </label>
                <label>Interview template
                  <select
                    value={bulkForm.sourceInterviewId}
                    onChange={(event) => chooseTemplate(event.target.value)}
                    disabled={!bulkForm.sourceCycleId || bulkLoading}
                  >
                    <option value="">{bulkForm.sourceCycleId ? 'Choose a previous session' : 'Choose a previous cycle first'}</option>
                    {bulkTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.title} · {template.durationMinutes} min
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="form-grid bulk-form-grid">
                <label className="title-field">Title prefix
                  <input required value={bulkForm.title} onChange={(event) => setBulkForm({ ...bulkForm, title: event.target.value })} placeholder="e.g. W27 First Round Interview" />
                </label>
                <label className="section-field">Round
                  <select value={bulkForm.section} onChange={(event) => setBulkForm({ ...bulkForm, section: event.target.value })}>
                    {FORM_SECTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                </label>
                <label>Dress Code
                  <select required value={bulkForm.dresscode} onChange={(event) => setBulkForm({ ...bulkForm, dresscode: event.target.value })}>
                    <option value="">Select a dress code</option>
                    <option value="Business Professional">Business Professional</option>
                    <option value="Business Casual">Business Casual</option>
                    <option value="Smart Casual">Smart Casual</option>
                    <option value="Casual">Casual</option>
                  </select>
                </label>
                <label><CalendarDaysIcon /> First Slot Starts
                  <input required type="datetime-local" value={bulkForm.startDate} onChange={(event) => setBulkForm({ ...bulkForm, startDate: event.target.value })} />
                </label>
                <label><ClockIcon /> Slot Duration
                  <div className="number-with-unit">
                    <input required min="1" step="1" type="number" value={bulkForm.durationMinutes} onChange={(event) => setBulkForm({ ...bulkForm, durationMinutes: event.target.value })} />
                    <span>minutes</span>
                  </div>
                </label>
                <label><ClockIcon /> Start Next Slot Every
                  <div className="number-with-unit">
                    <input required min="1" step="1" type="number" value={bulkForm.slotIntervalMinutes} onChange={(event) => setBulkForm({ ...bulkForm, slotIntervalMinutes: event.target.value })} />
                    <span>minutes</span>
                  </div>
                </label>
                <label><MapPinIcon /> Location
                  <input required value={bulkForm.location} onChange={(event) => setBulkForm({ ...bulkForm, location: event.target.value })} placeholder="Room or meeting link" />
                </label>
                <label>Candidates per team
                  <input required min="1" step="1" type="number" value={bulkForm.maxCandidates} onChange={(event) => setBulkForm({ ...bulkForm, maxCandidates: event.target.value })} />
                </label>
              </div>

              <section className="bulk-team-picker">
                <div className="bulk-team-picker-header">
                  <div>
                    <p className="eyebrow">Review Teams</p>
                    <h3>Choose the teams to schedule</h3>
                    <p>Each selected team gets its own time window and its current members are assigned as interviewers.</p>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setBulkForm((current) => ({
                      ...current,
                      teamIds: bulkTeams.filter((team) => team.members?.length).map((team) => team.id)
                    }))}
                  >
                    Select all ready teams
                  </button>
                </div>

                {bulkLoading ? <p className="bulk-state">Loading review teams…</p> : (
                  <div className="bulk-team-list" role="group" aria-label="Review teams to schedule">
                    {!bulkTeams.length && <p className="bulk-state">No review teams exist in this recruiting cycle yet.</p>}
                    {bulkTeams.map((team) => {
                      const ready = team.members?.length > 0;
                      return (
                        <label className={`bulk-team-option${ready ? '' : ' unavailable'}`} key={team.id}>
                          <input
                            type="checkbox"
                            checked={bulkForm.teamIds.includes(team.id)}
                            onChange={() => toggleBulkTeam(team.id)}
                            disabled={!ready}
                          />
                          <span className="bulk-team-copy">
                            <strong>{team.name}</strong>
                            <small>{ready ? team.members.map((member) => member.fullName).join(', ') : 'Add a member before scheduling this team'}</small>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>

              {!!bulkPreview.length && (
                <section className="bulk-preview">
                  <div>
                    <p className="eyebrow">Schedule Preview</p>
                    <h3>{bulkPreview.length} team slot{bulkPreview.length === 1 ? '' : 's'} will be created</h3>
                  </div>
                  <ul>
                    {bulkPreview.slice(0, 4).map((slot) => (
                      <li key={slot.team.id}>
                        <strong>{slot.team.name}</strong>
                        <span>{formatDate(slot.startDate)} · {formatTime(slot.startDate, slot.endDate)}</span>
                      </li>
                    ))}
                    {bulkPreview.length > 4 && <li className="bulk-preview-more">+ {bulkPreview.length - 4} more team slots</li>}
                  </ul>
                </section>
              )}

              {bulkError && <p className="form-error">{bulkError}</p>}
              <footer>
                <button type="button" className="secondary-button" onClick={() => setBulkModalOpen(false)} disabled={bulkSaving}>Cancel</button>
                <button type="submit" className="primary-button" disabled={bulkSaving || bulkLoading || !bulkTeams.length}>
                  <DocumentDuplicateIcon /> {bulkSaving ? 'Creating slots…' : `Create ${bulkForm.teamIds.length} team slot${bulkForm.teamIds.length === 1 ? '' : 's'}`}
                </button>
              </footer>
            </form>
          </div>
        </div>
      )}
    </AccessControl>
  );
}
