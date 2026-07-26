import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AccessControl from '../components/AccessControl';
import apiClient from '../utils/api';
import { formatDeadline, getNextDeadline } from '../utils/getNextDeadline';
import '../styles/CandidateDashboard.css';

export default function CandidateDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [deadline, setDeadline] = useState(null);
  const [deadlineLoading, setDeadlineLoading] = useState(true);

  const handleViewEvents = () => {
    navigate('/events');
  };

  const handleApplicationStatus = () => {
    navigate('/applications');
  };

  const handleInterviewPrep = () => {
    navigate('/interview-prep');
  };

  const handleJoinMailingList = () => {
    window.open('https://docs.google.com/forms/d/e/1FAIpQLSd-4BTc5wLDJte1YLc0jHi17FSrAAodb2AzKdEVhgAFxFEMpA/viewform', '_blank');
  };

  const handleVisitWebsite = () => {
    window.open('https://www.uconsulting.club', '_blank');
  };

  useEffect(() => {
    let cancelled = false;

    const fetchDeadline = async () => {
      try {
        setDeadlineLoading(true);
        const applications = await apiClient.get('/applications/my-applications');
        if (!cancelled) {
          setDeadline(getNextDeadline(applications));
        }
      } catch (error) {
        console.error('Error fetching next deadline:', error);
        if (!cancelled) {
          setDeadline(null);
        }
      } finally {
        if (!cancelled) {
          setDeadlineLoading(false);
        }
      }
    };

    fetchDeadline();

    return () => {
      cancelled = true;
    };
  }, []);

  const renderDeadlineValue = () => {
    if (deadlineLoading) {
      return 'Loading deadline…';
    }

    if (!deadline) {
      return 'No upcoming deadline posted';
    }

    const formatted = formatDeadline(deadline.date, deadline.hasTime);
    return `${formatted} (${deadline.cycleName || 'Unknown Cycle'})`;
  };

  return (
    <AccessControl allowedRoles={['USER']}>
      <div className="candidate-dashboard-container">
        <div className="dashboard-header">
          <h1 className="dashboard-title">Welcome, {user?.fullName}!</h1>
          <p className="dashboard-subtitle">
            Welcome to the UConsulting Application Tracking System. Here you can view events,
            track your application status, and prepare for interviews.
          </p>
        </div>

        <div className="next-deadline-banner" role="status" aria-live="polite" aria-atomic="true">
          <span className="next-deadline-label">Application deadline</span>
          <span className="next-deadline-value">{renderDeadlineValue()}</span>
        </div>

        <div className="dashboard-content">
          <div className="quick-actions">
            <h2>Quick Actions</h2>
            <div className="action-cards">
              <div className="action-card" onClick={handleViewEvents}>
                <h3>View Events</h3>
                <p>Check out upcoming UConsulting events and RSVP to attend.</p>
              </div>
              <div className="action-card" onClick={handleApplicationStatus}>
                <h3>Application Status</h3>
                <p>Track the status of your application and view feedback.</p>
              </div>
              <div className="action-card" onClick={handleInterviewPrep}>
                <h3>Recruitment Resources</h3>
                <p>Access resources to help you prepare for interviews.</p>
              </div>
              <div className="action-card" onClick={handleJoinMailingList}>
                <h3>Join Our Mailing List</h3>
                <p>Stay updated on recruitment opportunities and exclusive UConsulting events.</p>
              </div>
              <div className="action-card" onClick={handleVisitWebsite}>
                <h3>Visit Our Website</h3>
                <p>Learn more about UConsulting and explore our organization.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AccessControl>
  );
}
