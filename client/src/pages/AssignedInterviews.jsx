import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDaysIcon, ClockIcon, MapPinIcon, UserGroupIcon
} from '@heroicons/react/24/outline';
import { Box, Chip, Tab, Tabs, Typography } from '@mui/material';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import '../styles/AdminAssignedInterviews.css';

const SECTION_LABELS = {
  VIRTUAL_COFFEE_CHAT: 'Virtual Coffee Chats',
  COFFEE_CHAT_PART_ONE: 'Coffee Chat - Round 1',
  COFFEE_CHAT_PART_TWO: 'Coffee Chat - Round 2',
  ROUND_ONE: 'First Round Interviews',
  FINAL_ROUND: 'Final Round Interviews'
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
  if (configured) return configured;
  if (interview.interviewType === 'ROUND_ONE') return 'ROUND_ONE';
  if (interview.interviewType === 'FINAL_ROUND' || interview.interviewType === 'ROUND_TWO') return 'FINAL_ROUND';
  return 'VIRTUAL_COFFEE_CHAT';
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
  weekday: 'long', month: 'short', day: 'numeric'
}).format(new Date(value));

const formatTime = (start, end) => `${new Intl.DateTimeFormat(undefined, {
  hour: 'numeric', minute: '2-digit'
}).format(new Date(start))}–${new Intl.DateTimeFormat(undefined, {
  hour: 'numeric', minute: '2-digit'
}).format(new Date(end))}`;

export default function AssignedInterviews() {
  const navigate = useNavigate();
  const [interviews, setInterviews] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scheduleView, setScheduleView] = useState('upcoming');
  const [, setClockTick] = useState(0);

  useEffect(() => {
    Promise.all([
      apiClient.get('/member/interviews?includeHistory=true'),
      apiClient.get('/member/profile')
    ])
      .then(([interviewRows, profile]) => {
        setInterviews(interviewRows);
        setCurrentUser(profile);
      })
      .catch((requestError) => setError(requestError.message || 'Unable to load your interviews.'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((tick) => tick + 1), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const sorted = useMemo(() => [...interviews].sort(
    (a, b) => new Date(a.startDate) - new Date(b.startDate)
  ), [interviews]);

  const visibleInterviews = useMemo(() => sorted.filter((interview) => {
    const phase = getPhase(interview);
    return scheduleView === 'history' ? phase === 'ended' : phase !== 'ended';
  }), [scheduleView, sorted]);

  const join = (interview) => {
    const config = parseConfig(interview);
    const assignedSlotGroupIds = (config.slots || [])
      .filter((slot) => slot.interviewerIds?.includes(currentUser?.id))
      .map((slot) => slot.applicationGroupId)
      .filter(Boolean);
    const groupIds = assignedSlotGroupIds.length ? assignedSlotGroupIds.join(',') : 'direct';

    if (interview.interviewType === 'ROUND_ONE') {
      navigate(`/member/first-round-interview?interviewId=${interview.id}&groupIds=${groupIds}`);
    } else if (interview.interviewType === 'FINAL_ROUND' || interview.interviewType === 'ROUND_TWO') {
      navigate(`/member/final-round-interview?interviewId=${interview.id}&groupIds=${groupIds}`);
    } else {
      navigate(`/member/interview-interface?interviewId=${interview.id}&groupIds=${groupIds}`);
    }
  };

  return (
    <AccessControl allowedRoles={['MEMBER', 'ADMIN']}>
      <main className="interview-schedule member-schedule">
        <Box component="header" className="schedule-header">
          <Box>
            <Typography component="p" className="eyebrow">Your assignments</Typography>
            <Typography component="h1">Interviews</Typography>
            <Typography component="p">Your schedule updates automatically when an admin assigns you.</Typography>
          </Box>
        </Box>

        {!loading && !error && (
          <Box className="interview-dashboard-tabs">
            <Tabs value={scheduleView} onChange={(_, value) => setScheduleView(value)} variant="fullWidth">
              <Tab value="upcoming" label={`Upcoming (${sorted.filter((interview) => getPhase(interview) !== 'ended').length})`} />
              <Tab value="history" label={`History (${sorted.filter((interview) => getPhase(interview) === 'ended').length})`} />
            </Tabs>
          </Box>
        )}

        {loading && <div className="schedule-state">Loading your schedule…</div>}
        {error && <div className="schedule-state error">{error}</div>}
        {!loading && !error && !visibleInterviews.length && (
          <div className="schedule-state">
            <CalendarDaysIcon />
            <h2>{scheduleView === 'history' ? 'No completed interviews' : 'No interviews assigned'}</h2>
            <p>{scheduleView === 'history' ? 'Completed interview assignments will appear here.' : 'When an admin adds you to a session, it will appear here.'}</p>
          </div>
        )}

        <div className="member-session-list">
          {visibleInterviews.map((interview) => {
            const phase = getPhase(interview);
            const config = parseConfig(interview);
            return (
              <article className={`member-session-card ${phase === 'live' || phase === 'open' ? 'is-live' : ''}`} key={interview.id}>
                <div className="member-date">
                  <span>{new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(interview.startDate))}</span>
                  <strong>{new Date(interview.startDate).getDate()}</strong>
                </div>
                <div className="member-session-details">
                  <div className="session-title-line">
                    <p className="section-kicker">{SECTION_LABELS[sectionFor(interview)]}</p>
                    <Chip
                      className="phase-chip"
                      size="small"
                      color={phase === 'live' ? 'success' : phase === 'open' ? 'warning' : phase === 'upcoming' ? 'primary' : 'default'}
                      label={phase === 'live' ? 'Live Now' : phase === 'open' ? 'Starting Soon' : phase === 'upcoming' ? 'Upcoming' : 'Completed'}
                    />
                  </div>
                  <h2>{interview.title}</h2>
                  <div className="session-meta">
                    <span><CalendarDaysIcon /> {formatDate(interview.startDate)}</span>
                    <span><ClockIcon /> {formatTime(interview.startDate, interview.endDate)}</span>
                    <span><MapPinIcon /> {interview.location || 'Location TBD'}</span>
                    <span><UserGroupIcon /> {config.applicationIds?.length || 0} candidates</span>
                  </div>
                  {interview.dresscode && <p className="dress-code">Dress code: {interview.dresscode}</p>}
                </div>
                <div className="member-session-action">
                  {phase === 'live' || phase === 'open' ? (
                    <button className="join-button" onClick={() => join(interview)}>Join interview</button>
                  ) : (
                    <span>{phase === 'upcoming' ? 'Opens 5 minutes before start time' : 'Session ended'}</span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </main>
    </AccessControl>
  );
}
