import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { MagnifyingGlassIcon, PlusIcon, PencilIcon, TrashIcon } from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import CandidateAvatar from '../components/CandidateAvatar';
import ImageCache from '../utils/imageCache';
import { useAuth } from '../context/AuthContext';
import AccessControl from '../components/AccessControl';
import EditCandidateModal from '../components/EditCandidateModal';
import { useCandidates } from '../hooks/useCandidates';
import { isPointEligibleEvent } from '../utils/pointEvents';
import Pagination from '../components/Pagination';
import '../styles/CandidateList.css';

export default function CandidateList() {
  const { user } = useAuth();

  // Pagination state
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);

  // Search and filter state (pending = what user is selecting, applied = what's sent to server)
  const [pendingSearch, setPendingSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [pendingFilters, setPendingFilters] = useState({
    group: '',
    createdDate: '',
    cycle: '',
    eventAttendanceEventId: ''
  });
  const [appliedFilters, setAppliedFilters] = useState({
    group: '',
    createdDate: '',
    cycle: '',
    eventAttendanceEventId: ''
  });

  // Check if there are unapplied filter or search changes
  const hasUnappliedFilters = JSON.stringify(pendingFilters) !== JSON.stringify(appliedFilters) || pendingSearch !== appliedSearch;

  // Apply filters handler
  const handleApplyFilters = useCallback(() => {
    setAppliedFilters(pendingFilters);
    setAppliedSearch(pendingSearch);
    setPage(1);
  }, [pendingFilters, pendingSearch]);

  // Clear all filters
  const handleClearFilters = useCallback(() => {
    const emptyFilters = { group: '', createdDate: '', cycle: '', eventAttendanceEventId: '' };
    setPendingFilters(emptyFilters);
    setAppliedFilters(emptyFilters);
    setPendingSearch('');
    setAppliedSearch('');
    setPage(1);
  }, []);

  // Use candidates hook with server-side search
  const {
    candidates: rawCandidates,
    pagination,
    loading,
    error,
    refetch: refetchCandidates
  } = useCandidates({
    page,
    limit,
    search: appliedSearch,
    endpoint: '/member/all-candidates',
    enabled: !!user?.id,
    eventAttendanceEventId: appliedFilters.eventAttendanceEventId
  });

  // Transform candidates data - apply client-side filters that aren't supported server-side
  const candidates = useMemo(() => {
    let data = rawCandidates || [];

    // Apply client-side filters (group, createdDate, cycle)
    if (appliedFilters.group) {
      data = data.filter(candidate =>
        (appliedFilters.group === 'applied' && candidate.applications && candidate.applications.length > 0) ||
        (appliedFilters.group === 'not_applied' && (!candidate.applications || candidate.applications.length === 0))
      );
    }

    if (appliedFilters.cycle) {
      data = data.filter(candidate =>
        candidate.applications?.some(app => app.cycleId === appliedFilters.cycle || app.cycle?.id === appliedFilters.cycle)
      );
    }

    if (appliedFilters.createdDate) {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
      const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

      data = data.filter(candidate => {
        const candidateDate = new Date(candidate.createdAt || candidate.applications?.[0]?.submittedAt);
        switch (appliedFilters.createdDate) {
          case 'today': return candidateDate >= today;
          case 'week': return candidateDate >= weekAgo;
          case 'month': return candidateDate >= monthAgo;
          default: return true;
        }
      });
    }

    return data;
  }, [rawCandidates, appliedFilters]);

  const [events, setEvents] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingCandidate, setEditingCandidate] = useState(null);
  const [deletingCandidate, setDeletingCandidate] = useState(null);

  const isAdmin = user?.role === 'ADMIN';

  // Fetch cycles and events separately (they don't change often)
  useEffect(() => {
    const fetchCycles = async () => {
      try {
        const cyclesData = await apiClient.get('/admin/cycles');
        setCycles(cyclesData || []);
      } catch (err) {
        console.error('Error loading cycles:', err);
      }
    };
    const fetchEvents = async () => {
      try {
        const eventsData = await apiClient.get('/member/events');
        setEvents((eventsData || []).filter((event) => isPointEligibleEvent(event.eventName)));
      } catch (err) {
        console.error('Error loading events:', err);
      }
    };
    if (user?.id) {
      fetchCycles();
      fetchEvents();
    }
  }, [user?.id]);

  // Preload images when candidates change
  useEffect(() => {
    if (candidates.length > 0) {
      const imageUrls = candidates
        .filter(candidate => candidate.applications && candidate.applications.length > 0)
        .map(candidate => candidate.applications[0].headshotUrl)
        .filter(url => url);

      if (imageUrls.length > 0) {
        console.log(`Preloading ${imageUrls.length} profile images...`);
        ImageCache.preloadImages(imageUrls, apiClient.token)
          .then(results => {
            const successful = results.filter(r => r.status === 'fulfilled').length;
            console.log(`Successfully preloaded ${successful}/${imageUrls.length} images`);
          })
          .catch(err => {
            console.error('Error preloading images:', err);
          });
      }
    }
  }, [candidates]);

  // Check if any client-side filters are active
  const hasClientSideFilters = appliedFilters.group || appliedFilters.createdDate || appliedFilters.cycle;

  // Check if any filters are active
  const hasActiveFilters = Object.values(appliedFilters).some(v => v !== '') || appliedSearch !== '';

  const handleFilterChange = (filterType, value) => {
    setPendingFilters(prev => ({
      ...prev,
      [filterType]: value
    }));
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  const handleEdit = async (e, candidate) => {
    e.preventDefault();
    e.stopPropagation();
    setEditingCandidate(candidate);
    setShowEditModal(true);
  };

  const handleDelete = async (e, candidate) => {
    e.preventDefault();
    e.stopPropagation();

    const candidateName = candidate.applications?.[0] ?
      `${candidate.applications[0].firstName} ${candidate.applications[0].lastName}` :
      `${candidate.firstName} ${candidate.lastName}`;

    if (!window.confirm(`Are you sure you want to delete candidate ${candidateName}? This action cannot be undone.`)) {
      return;
    }

    // Check if candidate has applications
    if (candidate.applications && candidate.applications.length > 0) {
      alert('Cannot delete candidate with associated applications. Please delete applications first.');
      return;
    }

    setDeletingCandidate(candidate.id);
    try {
      await apiClient.delete(`/admin/candidates/${candidate.id}`);
      await refetchCandidates();
    } catch (err) {
      alert(err.message || 'Failed to delete candidate');
    } finally {
      setDeletingCandidate(null);
    }
  };

  const handleCandidateUpdated = useCallback(() => {
    refetchCandidates();
    setShowEditModal(false);
    setEditingCandidate(null);
  }, [refetchCandidates]);

  // Handle page change
  const handlePageChange = useCallback((newPage) => {
    setPage(newPage);
  }, []);

  // Handle limit change
  const handleLimitChange = useCallback((newLimit) => {
    setLimit(newLimit);
    setPage(1);
  }, []);

  if (loading) {
    return (
      <div className="candidate-list">
        <div className="loading-state">Loading candidates...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="candidate-list">
        <div className="error-state">Error loading candidates: {error}</div>
      </div>
    );
  }

  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <div className="candidate-list">
      {/* Simple header */}
      <div className="candidate-list-header">
        <div className="header-top">
          <h1 className="header-title">View Candidates</h1>
        </div>
        
        <div className="search-section">
          <div className="header-search">
            <MagnifyingGlassIcon className="search-icon" />
            <input
              type="text"
              placeholder="Search candidates..."
              className="search-input"
              value={pendingSearch}
              onChange={(e) => setPendingSearch(e.target.value)}
            />
          </div>
          <div className="results-count">
            {hasClientSideFilters ? candidates.length : (pagination?.total || candidates.length)} candidate{(hasClientSideFilters ? candidates.length : (pagination?.total || candidates.length)) !== 1 ? 's' : ''}
            {pagination && !hasClientSideFilters && pagination.totalPages > 1 && ` (page ${pagination.page} of ${pagination.totalPages})`}
          </div>
        </div>
      </div>

      {/* Simple inline filters */}
      <div className="filters-row">
        <select
          className="filter-select"
          value={pendingFilters.group}
          onChange={(e) => handleFilterChange('group', e.target.value)}
        >
          <option value="">Application: All</option>
          <option value="applied">Application: Applied</option>
          <option value="not_applied">Application: Not Applied</option>
        </select>

        <select
          className="filter-select"
          value={pendingFilters.createdDate}
          onChange={(e) => handleFilterChange('createdDate', e.target.value)}
        >
          <option value="">Date Added: All</option>
          <option value="today">Date Added: Today</option>
          <option value="week">Date Added: This Week</option>
          <option value="month">Date Added: This Month</option>
        </select>

        <select
          className="filter-select"
          value={pendingFilters.cycle}
          onChange={(e) => handleFilterChange('cycle', e.target.value)}
        >
          <option value="">Cycle: All</option>
          {cycles.map(cycle => (
            <option key={cycle.id} value={cycle.id}>
              Cycle: {cycle.name}{cycle.isActive ? ' (Active)' : ''}
            </option>
          ))}
        </select>

        <select
          className="filter-select"
          value={pendingFilters.eventAttendanceEventId}
          onChange={(e) => handleFilterChange('eventAttendanceEventId', e.target.value)}
        >
          <option value="">Event Attendance: All</option>
          {events.map(event => (
            <option key={`att-${event.id}`} value={event.id}>
              Attended: {event.eventName}
            </option>
          ))}
        </select>

        <button
          className={`apply-filters-btn ${hasUnappliedFilters ? 'has-changes' : ''}`}
          onClick={handleApplyFilters}
          disabled={!hasUnappliedFilters || loading}
        >
          {loading ? 'Loading...' : 'Apply Filters'}
        </button>

        {hasActiveFilters && (
          <button
            className="clear-filters-btn"
            onClick={handleClearFilters}
            disabled={loading}
          >
            Clear All
          </button>
        )}
      </div>

      {/* Candidates List */}
      {candidates.length === 0 ? (
        <div className="empty-state">
          <h3>No candidates found</h3>
          <p>Try adjusting your search or filter criteria.</p>
        </div>
      ) : (
        <div className="candidates-grid">
          {candidates.map((candidate, index) => (
            <div key={candidate.id} className="candidate-card-wrapper">
              <Link
                to={`/candidate-detail/${candidate.id}`}
                className="candidate-card"
              >
                <div className="candidate-header">
                  <div className="candidate-info">
                    {/* Profile Picture with fallback - extract from application */}
                    <CandidateAvatar applicant={candidate} />
                    <div className="candidate-details">
                      <h3>{candidate.applications?.[0] ? 
                        `${candidate.applications[0].firstName} ${candidate.applications[0].lastName}` : 
                        `${candidate.firstName} ${candidate.lastName}`}</h3>
                      <p className="candidate-meta">
                        {candidate.studentId || 'N/A'} • {candidate.applications?.[0]?.email || candidate.email || 'N/A'}
                      </p>
                      <p className="candidate-meta">
                        Applications: {candidate.applications?.length || 0} • 
                        Group: {candidate.assignedGroup?.id ? `Group ${candidate.assignedGroup.id.slice(-4)}` : 'Unassigned'}
                      </p>
                      <p className="candidate-date">
                        Added: {formatDate(candidate.createdAt || candidate.applications?.[0]?.submittedAt)}
                      </p>
                    </div>
                  </div>
                  <div className="candidate-status">
                    <span className={`status-badge ${candidate.applications && candidate.applications.length > 0 ? 'applied' : 'not_applied'}`}>
                      {candidate.applications && candidate.applications.length > 0 ? 'APPLIED' : 'NOT APPLIED'}
                    </span>
                  </div>
                </div>
              </Link>
              {isAdmin && (
                <div className="candidate-actions">
                  <button
                    className="action-btn edit-btn"
                    onClick={(e) => handleEdit(e, candidate)}
                    title="Edit Candidate"
                  >
                    <PencilIcon className="action-icon" />
                  </button>
                  <button
                    className="action-btn delete-btn"
                    onClick={(e) => handleDelete(e, candidate)}
                    disabled={deletingCandidate === candidate.id || (candidate.applications && candidate.applications.length > 0)}
                    title={candidate.applications && candidate.applications.length > 0 ? "Cannot delete candidate with applications" : "Delete Candidate"}
                  >
                    <TrashIcon className="action-icon" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {pagination && (
        <Pagination
          page={page}
          totalPages={pagination.totalPages}
          total={pagination.total}
          limit={limit}
          onPageChange={handlePageChange}
          onLimitChange={handleLimitChange}
          loading={loading}
        />
      )}

      {/* Edit Candidate Modal */}
      <EditCandidateModal
        isOpen={showEditModal}
        onClose={() => {
          setShowEditModal(false);
          setEditingCandidate(null);
        }}
        onSuccess={handleCandidateUpdated}
        candidate={editingCandidate}
      />
    </div>
    </AccessControl>
  );
}
