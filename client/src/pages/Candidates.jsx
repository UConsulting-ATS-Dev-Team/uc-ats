import React, { useEffect, useMemo, useState } from 'react';
import { 
  MagnifyingGlassIcon,
  FunnelIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ArrowTopRightOnSquareIcon
} from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import { useAuth } from '../context/AuthContext';
import AccessControl from '../components/AccessControl';
import { isPointEligibleEvent } from '../utils/pointEvents';
import '../styles/ApplicationList.css';

export default function Candidates() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sort, setSort] = useState('name-az');
  const [filters, setFilters] = useState({
    status: '',
    year: '',
    gender: '',
    firstGen: '',
    transfer: '',
    eventAttendanceEventId: ''
  });
  const [expandedId, setExpandedId] = useState(null);
  const [scoreCache, setScoreCache] = useState({}); // key: candidateId -> { resume, cover, video }
  const [attendanceByAppId, setAttendanceByAppId] = useState({}); // key: applicationId -> array of attended keys
  const [events, setEvents] = useState([]);

  useEffect(() => {
    const load = async () => {
      if (!user?.id) return;
      setLoading(true);
      try {
        // Use member endpoint to get all applications, not just assigned ones
        const params = new URLSearchParams();
        if (filters.eventAttendanceEventId) params.append('eventAttendanceEventId', filters.eventAttendanceEventId);
        const queryString = params.toString();
        const data = await apiClient.get(`/member/all-applications${queryString ? '?' + queryString : ''}`);
        console.log('Fetched all applications data:', data);
        console.log('Number of applications:', data?.length || 0);
        setApplications(Array.isArray(data) ? data : []);
      } catch (e) {
        console.error('Error loading applications:', e);
        setError(e.message || 'Failed to load applications');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [user?.id, filters.eventAttendanceEventId]);

  // Fetch events (for the event attendance filter dropdown) once on mount
  useEffect(() => {
    const fetchEvents = async () => {
      try {
        const data = await apiClient.get('/member/events');
        setEvents((data || []).filter((event) => isPointEligibleEvent(event.eventName)));
      } catch (err) {
        console.error('Error loading events:', err);
      }
    };
    if (user?.id) {
      fetchEvents();
    }
  }, [user?.id]);

  const normalized = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    let list = applications.filter(app => {
      const matchesTerm = !term || app.name?.toLowerCase().includes(term) || app.email?.toLowerCase().includes(term);
      const matchesStatus = !filters.status || app.status === filters.status;
      const matchesYear = !filters.year || String(app.year) === filters.year;
      const matchesGender = !filters.gender || app.gender === filters.gender;
      const matchesFirstGen = !filters.firstGen || String(!!app.isFirstGeneration) === filters.firstGen;
      const matchesTransfer = !filters.transfer || String(!!app.isTransferStudent) === filters.transfer;
      return matchesTerm && matchesStatus && matchesYear && matchesGender && matchesFirstGen && matchesTransfer;
    });

    list = list.sort((a, b) => {
      if (sort === 'name-az') return a.name.localeCompare(b.name);
      if (sort === 'name-za') return b.name.localeCompare(a.name);
      return 0;
    });
    return list;
  }, [applications, searchTerm, filters, sort]);

  // Fetch attendance for visible applications
  useEffect(() => {
    const fetchAttendanceFor = async (appIds) => {
      const results = await Promise.allSettled(appIds.map(id => apiClient.get(`/applications/${id}/events`)));
      const next = {};
      results.forEach((res, idx) => {
        const appId = appIds[idx];
        if (res.status === 'fulfilled' && res.value && Array.isArray(res.value.events)) {
          const attended = res.value.events
            .filter(ev => ev.attendanceStatus === 'Attended')
            .map(ev => ev.eventName || '')
            .filter(Boolean);
          const mapName = (name) => {
            const n = name.toLowerCase();
            if (n.includes('info') && n.includes('session')) return 'Info Session';
            if (n.includes('case')) return 'Case Workshop';
            if (n.includes('gtkuc') || n.includes('get to know')) return 'GTKUC';
            return null;
          };
          const keys = Array.from(new Set(attended.map(mapName).filter(Boolean)));
          next[appId] = keys;
        }
      });
      if (Object.keys(next).length > 0) {
        setAttendanceByAppId(prev => ({ ...prev, ...next }));
      }
    };

    const idsToLoad = normalized
      .map(a => a.id)
      .filter(id => !attendanceByAppId[id]);
    if (idsToLoad.length > 0) {
      // Limit concurrent fetches if list is large
      const batch = idsToLoad.slice(0, 25);
      fetchAttendanceFor(batch);
    }
  }, [normalized, attendanceByAppId]);

  const onFilterChange = (name, value) => {
    setFilters(prev => ({ ...prev, [name]: value }));
  };

  

  const toggleExpand = async (app) => {
    setExpandedId(prev => (prev === app.id ? null : app.id));
    // Lazy-load averages when expanding
    if (!scoreCache[app.candidateId]) {
      try {
        const cycleIdParam = app.cycleId ? `?cycleId=${app.cycleId}` : '';
        const [resumeScores, coverScores, videoScores] = await Promise.allSettled([
          apiClient.get(`/review-teams/resume-scores/${app.candidateId}${cycleIdParam}`),
          apiClient.get(`/review-teams/cover-letter-scores/${app.candidateId}${cycleIdParam}`),
          apiClient.get(`/review-teams/video-scores/${app.candidateId}${cycleIdParam}`)
        ]);
        const avg = (arr, key) => {
          const list = Array.isArray(arr) ? arr : [];
          const values = list.map(s => parseFloat(s[key] ?? s.overallScore ?? 0)).filter(v => !isNaN(v));
          if (values.length === 0) return null;
          const total = values.reduce((sum, v) => sum + v, 0);
          return Math.round((total / values.length) * 10) / 10;
        };
        const resume = resumeScores.status === 'fulfilled' ? avg(resumeScores.value, 'overallScore') : null;
        const cover = coverScores.status === 'fulfilled' ? avg(coverScores.value, 'overallScore') : null;
        const video = videoScores.status === 'fulfilled' ? avg(videoScores.value, 'overallScore') : null;
        setScoreCache(prev => ({ ...prev, [app.candidateId]: { resume, cover, video } }));
      } catch (e) {
        // Ignore; leave scores as null
      }
    }
  };

  const getBadgeClass = (status) => {
    const s = (status || '').toUpperCase();
    if (s === 'ACCEPTED') return 'status-badge accepted';
    if (s === 'REJECTED') return 'status-badge rejected';
    if (s === 'UNDER_REVIEW') return 'status-badge reviewing';
    if (s === 'WAITLISTED') return 'status-badge waitlisted';
    return 'status-badge submitted';
  };

  if (loading) {
    return (
      <div className="application-list"><div className="loading-state">Loading applications...</div></div>
    );
  }
  if (error) {
    return (
      <div className="application-list"><div className="error-state">{error}</div></div>
    );
  }

  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <div className="application-list">
      <div className="application-list-header" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 className="header-title">Applications</h1>
        </div>
        <div className="search-section" style={{ gap: '0.75rem' }}>
          <div className="header-search">
            <MagnifyingGlassIcon className="search-icon" />
            <input
              type="text"
              placeholder="Search applications..."
              className="search-input"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="results-count">{normalized.length} application{normalized.length !== 1 ? 's' : ''}</div>
        </div>
      </div>

      <div className="filters-row">
        <select className="filter-select" value={filters.status} onChange={(e) => onFilterChange('status', e.target.value)}>
          <option value="">Status: All</option>
          <option value="SUBMITTED">Status: Submitted</option>
          <option value="UNDER_REVIEW">Status: Under Review</option>
          <option value="ACCEPTED">Status: Accepted</option>
          <option value="REJECTED">Status: Rejected</option>
          <option value="WAITLISTED">Status: Waitlisted</option>
        </select>
        <select className="filter-select" value={filters.year} onChange={(e) => onFilterChange('year', e.target.value)}>
          <option value="">Year: All</option>
          <option value="2024">Year: 2024</option>
          <option value="2025">Year: 2025</option>
          <option value="2026">Year: 2026</option>
          <option value="2027">Year: 2027</option>
          <option value="2028">Year: 2028</option>
        </select>
        <select className="filter-select" value={filters.gender} onChange={(e) => onFilterChange('gender', e.target.value)}>
          <option value="">Gender: All</option>
          <option value="Male">Gender: Male</option>
          <option value="Female">Gender: Female</option>
          <option value="Other">Gender: Other</option>
        </select>
        <select className="filter-select" value={filters.firstGen} onChange={(e) => onFilterChange('firstGen', e.target.value)}>
          <option value="">First Gen: All</option>
          <option value="true">First Gen: Yes</option>
          <option value="false">First Gen: No</option>
        </select>
        <select className="filter-select" value={filters.transfer} onChange={(e) => onFilterChange('transfer', e.target.value)}>
          <option value="">Transfer: All</option>
          <option value="true">Transfer: Yes</option>
          <option value="false">Transfer: No</option>
        </select>
        <select className="filter-select" value={filters.eventAttendanceEventId} onChange={(e) => onFilterChange('eventAttendanceEventId', e.target.value)}>
          <option value="">Event Attendance: All</option>
          {events.map(event => (
            <option key={`att-${event.id}`} value={event.id}>Attended: {event.eventName}</option>
          ))}
        </select>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <FunnelIcon style={{ width: 20, height: 20, color: '#64748b' }} />
          <select className="filter-select" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="name-az">Sort By: Name (A-Z)</option>
            <option value="name-za">Sort By: Name (Z-A)</option>
          </select>
        </div>
      </div>

      {normalized.length === 0 ? (
        <div className="empty-state">
          <h3>No applications found</h3>
          <p>Try adjusting your search or filters.</p>
        </div>
      ) : (
        <div className="applications-table-wrapper responsive-table">
          <table className="applications-table">
            <thead>
              <tr>
                <th>Applicant</th>
                <th>Status</th>
                <th>Major / Year / GPA</th>
                <th>Attendance</th>
                <th>Referrals</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {normalized.map(app => {
                const isExpanded = expandedId === app.id;
                const scores = scoreCache[app.candidateId] || {};
                return (
                  <React.Fragment key={app.id}>
                    <tr className="applications-row">
                      <td data-label="Applicant">
                        <div className="applicant-cell">
                          {app.headshotUrl ? (
                            <img
                              src={app.headshotUrl}
                              alt={app.name}
                              className="applicant-avatar"
                              onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'flex'; }}
                            />
                          ) : null}
                          <div className="applicant-avatar-fallback" style={{ display: app.headshotUrl ? 'none' : 'flex' }}>
                            {(app.name || '?').split(' ').map(n => n.charAt(0)).join('').slice(0,2).toUpperCase()}
                          </div>
                          <div>
                            <div className="applicant-name">{app.name}</div>
                            <div className="applicant-email">{app.email}</div>
                          </div>
                        </div>
                      </td>
                      <td data-label="Status">
                        <span className={getBadgeClass(app.status)}>{(app.status || '').replace('_', ' ')}</span>
                      </td>
                      <td data-label="Major / Year / GPA">{app.major} • {app.year} • GPA: {app.gpa}</td>
                      <td data-label="Attendance">
                        {attendanceByAppId[app.id] ? (
                          <div className="attendance-inline">
                            {attendanceByAppId[app.id].includes('Info Session') && (
                              <label><input type="checkbox" checked disabled readOnly /> Info Session</label>
                            )}
                            {attendanceByAppId[app.id].includes('Case Workshop') && (
                              <label><input type="checkbox" checked disabled readOnly /> Case Workshop</label>
                            )}
                            {attendanceByAppId[app.id].includes('GTKUC') && (
                              <label><input type="checkbox" checked disabled readOnly /> GTKUC</label>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: '#94a3b8' }}>—</span>
                        )}
                      </td>
                      <td data-label="Referrals">N/A</td>
                      <td data-label="" style={{ textAlign: 'right' }}>
                        {isAdmin && (
                          <button className="btn-secondary small" onClick={() => toggleExpand(app)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            {isExpanded ? 'Hide Details' : 'View Details'} {isExpanded ? <ChevronUpIcon className="btn-icon" /> : <ChevronDownIcon className="btn-icon" />}
                          </button>
                        )}
                      </td>
                    </tr>
                    {isAdmin && isExpanded && (
                      <tr className="applications-details-row">
                        <td colSpan={6}>
                          <div className="details-grid">
                            <div className="details-header">
                              <div>Document</div>
                              <div>Notes</div>
                              <div style={{ textAlign: 'right' }}>Score</div>
                            </div>
                            {[{ key: 'resume', label: 'Resume', url: app.resumeUrl }, { key: 'cover', label: 'Cover Letter', url: app.coverLetterUrl }, { key: 'video', label: 'Video', url: app.videoUrl }].map(row => (
                              <div key={row.key} className="details-row">
                                <div>
                                  <a href={row.url || '#'} target="_blank" rel="noreferrer" onClick={(e) => { if (!row.url) e.preventDefault(); }} className={`doc-link ${row.url ? '' : 'disabled'}`}>
                                    {row.label} {row.url ? <ArrowTopRightOnSquareIcon style={{ width: 16, height: 16 }} /> : null}
                                  </a>
                                </div>
                                <div className="doc-notes">—</div>
                                <div style={{ textAlign: 'right' }}>
                                  <span className="score-bubble">{scores[row.key] != null ? scores[row.key] : '—'}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </AccessControl>
  );
}
