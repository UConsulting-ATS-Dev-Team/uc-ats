import React, { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeftIcon, PencilIcon, TrashIcon } from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import AuthenticatedImage from '../components/AuthenticatedImage';
import AccessControl from '../components/AccessControl';
import EditCandidateModal from '../components/EditCandidateModal';
import { useAuth } from '../context/AuthContext';
import '../styles/CandidateDetail.css';

export default function CandidateDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [candidate, setCandidate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [deletingCandidate, setDeletingCandidate] = useState(false);
  const [campaignLogs, setCampaignLogs] = useState([]);

  const isAdmin = user?.role === 'ADMIN';

  useEffect(() => {
    const fetchCandidate = async () => {
      try {
        const candidate = await apiClient.get(`/member/candidate/${id}`);
        setCandidate(candidate);
      } catch (err) {
        console.error('Error loading candidate detail:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchCandidate();
  }, [id]);

  useEffect(() => {
    const fetchCampaignLogs = async () => {
      if (!id) return;
      try {
        const logs = await apiClient.get(`/member/candidate/${id}/campaign-logs`);
        setCampaignLogs(logs || []);
      } catch (err) {
        console.error('Error loading campaign logs:', err);
      }
    };

    fetchCampaignLogs();
  }, [id]);

  const getInitials = (name) => {
    if (!name) return '?';
    const nameParts = name.split(' ');
    return nameParts.map(part => part.charAt(0)).join('').toUpperCase().slice(0, 2);
  };

  // Helper function to get candidate display info from applications or candidate data
  const getCandidateDisplayInfo = (candidate) => {
    const latestApp = candidate.applications?.[0];
    if (!latestApp) {
      return {
        name: `${candidate.firstName} ${candidate.lastName}`,
        email: candidate.email,
        firstName: candidate.firstName,
        lastName: candidate.lastName
      };
    }
    
    return {
      name: `${latestApp.firstName} ${latestApp.lastName}`,
      email: latestApp.email,
      firstName: latestApp.firstName,
      lastName: latestApp.lastName
    };
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const handleEdit = () => {
    setShowEditModal(true);
  };

  const handleDelete = async () => {
    if (!candidate) return;
    
    const latestApp = candidate.applications?.[0];
    const candidateName = latestApp ? 
      `${latestApp.firstName} ${latestApp.lastName}` : 
      `${candidate.firstName} ${candidate.lastName}`;
    
    if (!window.confirm(`Are you sure you want to delete candidate ${candidateName}? This action cannot be undone.`)) {
      return;
    }

    // Check if candidate has applications
    if (candidate.applications && candidate.applications.length > 0) {
      alert('Cannot delete candidate with associated applications. Please delete applications first.');
      return;
    }

    setDeletingCandidate(true);
    try {
      await apiClient.delete(`/admin/candidates/${candidate.id}`);
      // Navigate back to candidate list
      navigate('/candidate-list');
    } catch (err) {
      alert(err.message || 'Failed to delete candidate');
      setDeletingCandidate(false);
    }
  };

  const handleCandidateUpdated = async () => {
    // Refresh the candidate data
    try {
      const updatedCandidate = await apiClient.get(`/member/candidate/${id}`);
      setCandidate(updatedCandidate);
    } catch (err) {
      console.error('Error loading candidate detail:', err);
      setError(err.message);
    }
    setShowEditModal(false);
  };

  if (loading) {
    return (
      <div className="candidate-detail">
        <div className="loading-state">Loading candidate details...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="candidate-detail">
        <div className="error-state">Error: {error}</div>
        <Link to="/candidate-list" className="back-link">
          <ArrowLeftIcon className="back-icon" />
          Back to Candidates
        </Link>
      </div>
    );
  }

  if (!candidate) {
    return (
      <div className="candidate-detail">
        <div className="error-state">Candidate not found</div>
        <Link to="/candidate-list" className="back-link">
          <ArrowLeftIcon className="back-icon" />
          Back to Candidates
        </Link>
      </div>
    );
  }

  const displayInfo = getCandidateDisplayInfo(candidate);

  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <div className="candidate-detail">
      {/* Header */}
      <div className="candidate-detail-header">
        <Link to="/candidate-list" className="back-link">
          <ArrowLeftIcon className="back-icon" />
          Back to Candidates
        </Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <h1 className="page-title">Candidate Details</h1>
          {isAdmin && (
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                className="action-btn edit-btn"
                onClick={handleEdit}
                title="Edit Candidate"
                style={{
                  padding: '0.5rem',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  backgroundColor: '#f3f4f6',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <PencilIcon style={{ width: '20px', height: '20px' }} />
              </button>
              <button
                className="action-btn delete-btn"
                onClick={handleDelete}
                disabled={deletingCandidate || (candidate.applications && candidate.applications.length > 0)}
                title={candidate.applications && candidate.applications.length > 0 ? "Cannot delete candidate with applications" : "Delete Candidate"}
                style={{
                  padding: '0.5rem',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: deletingCandidate || (candidate.applications && candidate.applications.length > 0) ? 'not-allowed' : 'pointer',
                  backgroundColor: deletingCandidate || (candidate.applications && candidate.applications.length > 0) ? '#e5e7eb' : '#fee2e2',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: deletingCandidate || (candidate.applications && candidate.applications.length > 0) ? 0.5 : 1
                }}
              >
                <TrashIcon style={{ width: '20px', height: '20px' }} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Candidate Info Card */}
      <div className="candidate-info-card">
        <div className="candidate-profile">
          {candidate.applications && candidate.applications.length > 0 && candidate.applications[0].headshotUrl ? (
            <AuthenticatedImage
              src={candidate.applications[0].headshotUrl}
              alt={displayInfo.name}
              className="candidate-avatar-large"
              style={{
                width: '120px',
                height: '120px',
                borderRadius: '50%',
                objectFit: 'cover'
              }}
            />
          ) : (
            <div className="candidate-avatar-large-fallback">
              {getInitials(displayInfo.name)}
            </div>
          )}
          <div className="candidate-basic-info">
            <h2 className="candidate-name">{displayInfo.name}</h2>
            <p className="candidate-email">{displayInfo.email}</p>
            <p className="candidate-student-id">Student ID: {candidate.studentId || 'N/A'}</p>
            <div className="candidate-status">
              <span className={`status-badge ${candidate.applications && candidate.applications.length > 0 ? 'applied' : 'not_applied'}`}>
                {candidate.applications && candidate.applications.length > 0 ? 'APPLIED' : 'NOT APPLIED'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Details Grid */}
      <div className="details-grid">
        {/* Applications Section */}
        <div className="detail-section">
          <h3 className="section-title">Applications ({candidate.applications?.length || 0})</h3>
          {candidate.applications && candidate.applications.length > 0 ? (
            <div className="applications-list">
              {candidate.applications.map((application, index) => (
                <div key={application.id} className="application-item">
                  <div className="application-header">
                    <span className="application-status">{application.status}</span>
                    <span className="application-date">{formatDate(application.submittedAt)}</span>
                  </div>
                  <div className="application-details">
                    <p><strong>Major:</strong> {application.major1} {application.major2 && `, ${application.major2}`}</p>
                    <p><strong>Graduation Year:</strong> {application.graduationYear}</p>
                    <p><strong>GPA:</strong> {application.cumulativeGpa}</p>
                    <p><strong>Transfer Student:</strong> {application.isTransferStudent ? 'Yes' : 'No'}</p>
                    <p><strong>First Generation:</strong> {application.isFirstGeneration ? 'Yes' : 'No'}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="no-data">No applications found</p>
          )}
        </div>

        {/* Group Assignment Section */}
        <div className="detail-section">
          <h3 className="section-title">Group Assignment</h3>
          {candidate.assignedGroup ? (
            <div className="group-info">
              <p><strong>Group ID:</strong> {candidate.assignedGroup.id}</p>
              <p><strong>Created:</strong> {formatDate(candidate.assignedGroup.createdAt)}</p>
            </div>
          ) : (
            <p className="no-data">Not assigned to any group</p>
          )}
        </div>

        {/* Event Attendance Section */}
        <div className="detail-section">
          <h3 className="section-title">Event Attendance ({candidate.eventAttendance?.length || 0})</h3>
          {candidate.eventAttendance && candidate.eventAttendance.length > 0 ? (
            <div className="events-list">
              {candidate.eventAttendance.map((attendance, index) => (
                <div key={attendance.id} className="event-item">
                  <p><strong>{attendance.event.eventName}</strong></p>
                  <p className="event-date">{formatDate(attendance.event.eventStartDate)}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="no-data">No event attendance recorded</p>
          )}
        </div>

        {/* Event RSVP Section */}
        <div className="detail-section">
          <h3 className="section-title">Event RSVPs ({candidate.eventRsvp?.length || 0})</h3>
          {candidate.eventRsvp && candidate.eventRsvp.length > 0 ? (
            <div className="events-list">
              {candidate.eventRsvp.map((rsvp, index) => (
                <div key={rsvp.id} className="event-item">
                  <p><strong>{rsvp.event.eventName}</strong></p>
                  <p className="event-date">{formatDate(rsvp.event.eventStartDate)}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="no-data">No event RSVPs recorded</p>
          )}
        </div>

        {/* Campaign Communications Section */}
        <div className="detail-section" style={{ gridColumn: '1 / -1' }}>
          <h3 className="section-title">Campaign Communications ({campaignLogs.length || 0})</h3>
          {campaignLogs && campaignLogs.length > 0 ? (
            <div className="campaign-logs-list">
              {campaignLogs.map((log) => (
                <div key={log.id} className="campaign-log-item" style={{ marginBottom: '12px', padding: '12px', border: '1px solid var(--border-color)', borderRadius: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <strong>{log.campaignSend?.template?.name || log.templateName || 'Campaign'}</strong>
                    <span className={`status-badge ${log.status.toLowerCase()}`}>{log.status}</span>
                  </div>
                  <p style={{ margin: '4px 0' }}><strong>Subject:</strong> {log.subject || log.campaignSend?.template?.subject || 'N/A'}</p>
                  <p style={{ margin: '4px 0' }}><strong>Sent:</strong> {formatDate(log.sentAt || log.createdAt)}</p>
                  <p style={{ margin: '4px 0' }}><strong>Sender:</strong> {log.campaignSend?.sender?.fullName || log.actor?.fullName || 'Unknown'}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="no-data">No campaign communications recorded</p>
          )}
        </div>

        {/* System Info Section */}
        <div className="detail-section">
          <h3 className="section-title">System Information</h3>
          <div className="system-info">
            <p><strong>Created:</strong> {formatDate(candidate.createdAt)}</p>
            <p><strong>Last Updated:</strong> {formatDate(candidate.updatedAt)}</p>
            <p><strong>Candidate ID:</strong> {candidate.id}</p>
          </div>
        </div>
      </div>

      {/* Edit Candidate Modal */}
      <EditCandidateModal
        isOpen={showEditModal}
        onClose={() => {
          setShowEditModal(false);
        }}
        onSuccess={handleCandidateUpdated}
        candidate={candidate}
      />
    </div>
    </AccessControl>
  );
}
