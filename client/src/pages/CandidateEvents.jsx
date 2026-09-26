import React, { useEffect, useState } from 'react';
import { MapPinIcon } from '@heroicons/react/24/outline';
import { useAuth } from '../context/AuthContext';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import '../styles/CandidateEvents.css';

export default function CandidateEvents() {
  const { user } = useAuth();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchEvents = async () => {
    try {
      setLoading(true);
      // Pass user email to check RSVP status
      const data = await apiClient.get(`/events?userEmail=${encodeURIComponent(user?.email || '')}`);
      
      // Filter out past events
      const now = new Date();
      const upcomingEvents = data.filter(event => {
        const eventDate = new Date(event.eventStartDate);
        return eventDate >= now;
      });
      
      setEvents(upcomingEvents);
    } catch (e) {
      setError('Failed to load events');
      console.error('Error fetching events:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents();
  }, [user?.email]);

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
    const day = date.getDate();
    const month = date.toLocaleDateString('en-US', { month: 'short' });
    const year = date.getFullYear();
    
    return {
      dayName,
      day: day.toString().padStart(2, '0'),
      monthYear: `${month}, ${year}`
    };
  };

  const handleRSVP = async (event) => {
    try {
      if (event.hasAttended) {
        alert('You have already attended this event!');
        return;
      }
      
      if (event.hasRsvpd) {
        alert('You have already RSVP\'d for this event!');
        return;
      }
      
      // Luma first, where it is set: registration and the door check-in both
      // happen there now, and it sends its own confirmation and calendar invite.
      // The Google Form is the fallback for events that predate the move, and
      // for the rest of this cycle both can exist side by side.
      const destination = event.lumaUrl || event.rsvpForm;
      if (destination) {
        window.open(destination, '_blank', 'noopener,noreferrer');
      } else {
        alert('RSVP is not open for this event.');
      }
    } catch (error) {
      console.error('Error handling RSVP:', error);
    }
  };

  const handleAddToCalendar = (event) => {
    try {
      const startDate = new Date(event.eventStartDate);
      const endDate = event.eventEndDate ? new Date(event.eventEndDate) : new Date(startDate.getTime() + 2 * 60 * 60 * 1000);

      const formatDateForGoogle = (date) => {
        return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      };

      const startTime = formatDateForGoogle(startDate);
      const endTime = formatDateForGoogle(endDate);

      const eventTitle = event.eventName;
      const timeString = startDate.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/Los_Angeles'
      });
      const dateString = startDate.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'America/Los_Angeles'
      });

      const eventDescription = `${event.description || 'Join us for this exciting UConsulting event!'}\n\nEvent Details:\nDate: ${dateString}\nTime: ${timeString} PT\nLocation: ${event.eventLocation || 'Location TBD'}`;
      const eventLocation = event.eventLocation || 'Location TBD';

      const googleCalendarUrl = new URL('https://calendar.google.com/calendar/render');
      googleCalendarUrl.searchParams.set('action', 'TEMPLATE');
      googleCalendarUrl.searchParams.set('text', eventTitle);
      googleCalendarUrl.searchParams.set('dates', `${startTime}/${endTime}`);
      googleCalendarUrl.searchParams.set('details', eventDescription);
      googleCalendarUrl.searchParams.set('location', eventLocation);
      googleCalendarUrl.searchParams.set('sf', 'true');
      googleCalendarUrl.searchParams.set('output', 'xml');
      googleCalendarUrl.searchParams.set('ctz', 'America/Los_Angeles');

      window.open(googleCalendarUrl.toString(), '_blank');
    } catch (error) {
      console.error('Error adding to calendar:', error);
      alert('Failed to open calendar. Please try again.');
    }
  };

  if (loading) {
    return (
      <div className="candidate-events-container">
        <div className="loading">Loading events...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="candidate-events-container">
        <div className="error">{error}</div>
      </div>
    );
  }

  return (
    <AccessControl allowedRoles={['USER']}>
      <div className="candidate-events-container">
      <div className="events-header">
        <div className="events-title-section">
          <h1 className="events-title">Events</h1>
          <p className="events-subtitle">
            Join us to learn more about UConsulting and network with members
          </p>
        </div>
        
      </div>

      <div className="events-list">
        {events.map((event) => {
          const dateInfo = formatDate(event.eventStartDate);
          
          return (
            <div key={event.id} className="event-card">
              <div className="event-date">
                <div className="day-name">{dateInfo.dayName}</div>
                <div className="day-number">{dateInfo.day}</div>
                <div className="month-year">{dateInfo.monthYear}</div>
              </div>
              
              <div className="event-details">
                <h3 className="event-title">{event.eventName}</h3>
                <div className="event-location">
                  <MapPinIcon className="location-icon" />
                  <span>{event.eventLocation || 'Location TBD'}</span>
                </div>
                {event.description && (
                  <p className="event-description">
                    {event.description}
                  </p>
                )}
              </div>
              
              <div className="event-action">
                <div className="event-buttons">
                  {(event.lumaUrl || event.rsvpForm) && (
                    <button 
                      className={`rsvp-button ${event.hasAttended ? 'attended' : event.hasRsvpd ? 'rsvpd' : ''}`}
                      onClick={() => handleRSVP(event)}
                      disabled={event.hasAttended || event.hasRsvpd}
                    >
                      {event.hasAttended ? 'Attended' : event.hasRsvpd ? 'RSVP\'d' : 'RSVP'}
                    </button>
                  )}
                  <button 
                    className="calendar-button"
                    onClick={() => handleAddToCalendar(event)}
                    title="Add to Google Calendar"
                  >
                    <svg className="google-calendar-icon" viewBox="0 0 24 24" width="16" height="16">
                      <path fill="#4285F4" d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM7 10h5v5H7z"/>
                    </svg>
                    Add to Calendar
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        
        {events.length === 0 && (
          <div className="no-events">
            <p>No events scheduled at this time. Check back soon!</p>
          </div>
        )}
      </div>
    </div>
    </AccessControl>
  );
}
