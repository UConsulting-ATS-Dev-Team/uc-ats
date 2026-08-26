import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import apiClient from '../utils/api';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import AccessControl from '../components/AccessControl';
import ResumeReuploadSection from '../components/ResumeReuploadSection';
import '../styles/CandidateApplications.css';

// Application Detail Modal Component
function ApplicationDetailModal({ application, isOpen, onClose, onResumeReplaced }) {
  const [preview, setPreview] = useState({ open: false, src: '', kind: 'pdf', title: '' });

  if (!isOpen || !application) return null;

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getStatusColor = (status) => {
    switch (status.toLowerCase()) {
      case 'submitted': return '#fef3c7';
      case 'under_review': return '#dbeafe';
      case 'accepted': return '#d1fae5';
      case 'rejected': return '#fee2e2';
      case 'waitlisted': return '#f3e8ff';
      default: return '#f3f4f6';
    }
  };

  const getStatusTextColor = (status) => {
    switch (status.toLowerCase()) {
      case 'submitted': return '#92400e';
      case 'under_review': return '#1e40af';
      case 'accepted': return '#065f46';
      case 'rejected': return '#991b1b';
      case 'waitlisted': return '#7c3aed';
      default: return '#374151';
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Application Details</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        
        <div className="modal-body">
          <div className="application-overview">
            <div className="overview-header">
              <h3>{application.cycle?.name || 'Unknown Cycle'}</h3>
              <span 
                className="status-badge"
                style={{
                  backgroundColor: getStatusColor(application.status),
                  color: getStatusTextColor(application.status)
                }}
              >
                {application.status.replace('_', ' ')}
              </span>
            </div>
            <p className="submission-date">
              Submitted on {formatDate(application.submittedAt)}
            </p>
          </div>

          <div className="application-sections">
            <div className="section">
              <h4>Personal Information</h4>
              <div className="info-grid">
                <div className="info-item">
                  <label>Full Name:</label>
                  <span>{application.firstName} {application.lastName}</span>
                </div>
                <div className="info-item">
                  <label>Email:</label>
                  <span>{application.email}</span>
                </div>
                <div className="info-item">
                  <label>Student ID:</label>
                  <span>{application.studentId}</span>
                </div>
                <div className="info-item">
                  <label>Phone Number:</label>
                  <span>{application.phoneNumber}</span>
                </div>
              </div>
            </div>

            <div className="section">
              <h4>Academic Information</h4>
              <div className="info-grid">
                <div className="info-item">
                  <label>Graduation Year:</label>
                  <span>{application.graduationYear}</span>
                </div>
                <div className="info-item">
                  <label>Transfer Student:</label>
                  <span>{application.isTransferStudent ? 'Yes' : 'No'}</span>
                </div>
                {application.priorCollegeYears && (
                  <div className="info-item">
                    <label>Prior College Years:</label>
                    <span>{application.priorCollegeYears}</span>
                  </div>
                )}
                <div className="info-item">
                  <label>Cumulative GPA:</label>
                  <span>{application.cumulativeGpa}</span>
                </div>
                <div className="info-item">
                  <label>Major GPA:</label>
                  <span>{application.majorGpa}</span>
                </div>
                <div className="info-item">
                  <label>Primary Major:</label>
                  <span>{application.major1}</span>
                </div>
                {application.major2 && (
                  <div className="info-item">
                    <label>Secondary Major:</label>
                    <span>{application.major2}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="section">
              <h4>Additional Information</h4>
              <div className="info-grid">
                {application.gender && (
                  <div className="info-item">
                    <label>Gender:</label>
                    <span>{application.gender}</span>
                  </div>
                )}
                <div className="info-item">
                  <label>First Generation Student:</label>
                  <span>{application.isFirstGeneration ? 'Yes' : 'No'}</span>
                </div>
              </div>
            </div>

            <div className="section">
              <h4>Documents & Links</h4>
              <div className="documents-grid">
                {application.resumeUrl && (
                  <div className="document-item">
                    <label>Resume:</label>
                    <button 
                      className="document-link"
                      onClick={() => setPreview({ 
                        open: true, 
                        src: application.resumeUrl, 
                        kind: 'pdf', 
                        title: `${application.firstName} ${application.lastName} – Resume` 
                      })}
                    >
                      View Resume
                    </button>
                  </div>
                )}
                {application.headshotUrl && (
                  <div className="document-item">
                    <label>Headshot:</label>
                    <button 
                      className="document-link"
                      onClick={() => setPreview({ 
                        open: true, 
                        src: application.headshotUrl, 
                        kind: 'image', 
                        title: `${application.firstName} ${application.lastName} – Headshot` 
                      })}
                    >
                      View Headshot
                    </button>
                  </div>
                )}
                {application.coverLetterUrl && (
                  <div className="document-item">
                    <label>Cover Letter:</label>
                    <button 
                      className="document-link"
                      onClick={() => setPreview({ 
                        open: true, 
                        src: application.coverLetterUrl, 
                        kind: 'pdf', 
                        title: `${application.firstName} ${application.lastName} – Cover Letter` 
                      })}
                    >
                      View Cover Letter
                    </button>
                  </div>
                )}
                {application.videoUrl && (
                  <div className="document-item">
                    <label>Video:</label>
                    <button 
                      className="document-link"
                      onClick={() => setPreview({ 
                        open: true, 
                        src: application.videoUrl, 
                        kind: 'video', 
                        title: `${application.firstName} ${application.lastName} – Video` 
                      })}
                    >
                      View Video
                    </button>
                  </div>
                )}
              </div>

              <ResumeReuploadSection
                applicationId={application.id}
                onPreview={(src, title) => setPreview({
                  open: true,
                  src,
                  kind: 'pdf',
                  title: `${application.firstName} ${application.lastName} – ${title}`,
                })}
                onReplaced={onResumeReplaced}
              />
            </div>


          </div>
        </div>
      </div>
      
      {/* Document Preview Modal */}
      {preview.open && (
        <DocumentPreviewModal
          src={preview.src}
          kind={preview.kind}
          title={preview.title}
          onClose={() => setPreview({ open: false, src: '', kind: 'pdf', title: '' })}
        />
      )}
    </div>
  );
}

export default function CandidateApplications() {
  const { user } = useAuth();
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedApplication, setSelectedApplication] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const fetchApplications = async () => {
    try {
      setLoading(true);
      const data = await apiClient.get('/applications/my-applications');
      setApplications(data);
    } catch (e) {
      console.error('Error fetching applications:', e);
      // If it's a 404 (no applications found), show empty state instead of error
      if (e.message.includes('User not found or no studentId associated') || 
          e.message.includes('Candidate not found for this user')) {
        setApplications([]); // Show empty state
      } else {
        setError(`Failed to load applications: ${e.message}`);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleApplicationClick = (application) => {
    setSelectedApplication(application);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setSelectedApplication(null);
  };

  // The upload response carries the new URL, so repoint the open modal and the
  // cached list rather than refetching everything.
  const handleResumeReplaced = (resumeUrl) => {
    setSelectedApplication((current) => (current ? { ...current, resumeUrl } : current));
    setApplications((current) =>
      current.map((application) =>
        application.id === selectedApplication?.id ? { ...application, resumeUrl } : application
      )
    );
  };

  useEffect(() => {
    fetchApplications();
  }, []);

  if (loading) {
    return (
      <div className="candidate-applications-container">
        <div className="loading">Loading applications...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="candidate-applications-container">
        <div className="error">{error}</div>
      </div>
    );
  }

  return (
    <AccessControl allowedRoles={['USER']}>
      <div className="candidate-applications-container">
      <div className="applications-header">
        <h1 className="applications-title">My Applications</h1>
        <p className="applications-subtitle">
          Track the status of your UConsulting applications
        </p>
      </div>

      <div className="applications-content">
        {applications.length === 0 ? (
          <div className="no-applications">
            <h2>No Applications Found</h2>
            <p>
              You haven't submitted any applications yet. Check back here once you've 
              applied to track your status.
            </p>
          </div>
        ) : (
          <div className="applications-list">
            {applications.map((application) => (
              <div 
                key={application.id} 
                className="application-card clickable"
                onClick={() => handleApplicationClick(application)}
              >
                <div className="application-header">
                  <h3>Application for {application.cycle?.name || 'Unknown Cycle'}</h3>
                  <span className={`status ${application.status.toLowerCase().replace('_', '-')}`}>
                    {application.status.replace('_', ' ')}
                  </span>
                </div>
                <div className="application-details">
                  <p><strong>Submitted:</strong> {new Date(application.submittedAt).toLocaleDateString()}</p>
                  <p><strong>Status:</strong> {application.status.replace('_', ' ')}</p>
                  {application.currentRound && (
                    <p><strong>Current Round:</strong> {application.currentRound}</p>
                  )}
                  {application.cycle && (
                    <div className="cycle-info">
                      <p><strong>Cycle:</strong> {application.cycle.name}</p>
                      {application.cycle.startDate && application.cycle.endDate && (
                        <p><strong>Duration:</strong> {new Date(application.cycle.startDate).toLocaleDateString()} - {new Date(application.cycle.endDate).toLocaleDateString()}</p>
                      )}
                    </div>
                  )}
                </div>
                <div className="application-actions">
                  <span className="view-details">Click to view details →</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      
      {/* Application Detail Modal */}
      <ApplicationDetailModal
        application={selectedApplication}
        isOpen={isModalOpen}
        onClose={closeModal}
        onResumeReplaced={handleResumeReplaced}
      />
    </div>
    </AccessControl>
  );
}
