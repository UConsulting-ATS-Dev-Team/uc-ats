import React, { useEffect, useState } from 'react';
import { MapPinIcon } from '@heroicons/react/24/outline';
import { useAuth } from '../context/AuthContext';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import '../styles/CandidateEvents.css';

export default function MemberEvents() {
  const { user } = useAuth();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState(null);
  const [rsvpErrors, setRsvpErrors] = useState({});

  const fetchEvents = async () => {
    try {
      setLoading(true);
      // Use member events endpoint
      const data = await apiClient.get('/member/events');
      
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
  }, []);

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
    const day = date.getDate();
    const month = date.toLocaleDateString('en-US', { month: 'short' });
    const year = date.getFullYear();
    const time = date.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    });
    
    return {
      dayName,
      day: day.toString().padStart(2, '0'),
      monthYear: `${month}, ${year}`,
      time
    };
  };

  // RSVP straight from the page: members are signed in, so there is nothing a
  // form would need to ask. Only an RSVP made here can be cancelled here; one
  // from Luma or a Google Form has to be changed where it was made.
  const handleRSVP = async (event) => {
    const going = event.memberRsvpSource === 'IN_APP';
    setSavingId(event.id);
    setRsvpErrors((prev) => ({ ...prev, [event.id]: null }));
    try {
      const path = `/member/events/${event.id}/rsvp`;
      const status = going ? await apiClient.delete(path) : await apiClient.put(path, {});
      setEvents((prev) => prev.map((e) => (e.id === event.id ? { ...e, ...status } : e)));
    } catch (err) {
      console.error('Error saving RSVP:', err);
      if (err.body?.memberRsvpSource !== undefined) {
        setEvents((prev) => prev.map((e) => (e.id === event.id
          ? { ...e, hasMemberRsvpd: true, memberRsvpSource: err.body.memberRsvpSource }
          : e)));
      }
      setRsvpErrors((prev) => ({
        ...prev,
        [event.id]: err.code === 'EVENT_STARTED'
          ? 'This event has already started.'
          : (err.serverMessage || 'Could not save your RSVP. Please try again.')
      }));
    } finally {
      setSavingId(null);
    }
  };

  const rsvpButtonLabel = (event) => {
    if (savingId === event.id) return 'Saving…';
    switch (event.memberRsvpSource) {
      case 'IN_APP': return 'Going ✓ · Cancel';
      case 'LUMA': return "RSVP'd via Luma";
      case 'GOOGLE_FORM': return "RSVP'd via form";
      default: return 'RSVP';
    }
  };

  // An RSVP from Luma or a form is shown, but not changeable from here.
  const isExternalRsvp = (event) => event.hasMemberRsvpd && event.memberRsvpSource !== 'IN_APP';

  const handleAddToCalendar = (event) => {
    try {
      // Format dates for Google Calendar
      const startDate = new Date(event.eventStartDate);
      const endDate = event.eventEndDate ? new Date(event.eventEndDate) : new Date(startDate.getTime() + 2 * 60 * 60 * 1000); // Default 2 hours if no end date

      // Format dates to YYYYMMDDTHHMMSSZ format (UTC)
      const formatDateForGoogle = (date) => {
        return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      };

      const startTime = formatDateForGoogle(startDate);
      const endTime = formatDateForGoogle(endDate);

      // Create event details with time information
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

      // Create Google Calendar URL
      const googleCalendarUrl = new URL('https://calendar.google.com/calendar/render');
      googleCalendarUrl.searchParams.set('action', 'TEMPLATE');
      googleCalendarUrl.searchParams.set('text', eventTitle);
      googleCalendarUrl.searchParams.set('dates', `${startTime}/${endTime}`);
      googleCalendarUrl.searchParams.set('details', eventDescription);
      googleCalendarUrl.searchParams.set('location', eventLocation);
      googleCalendarUrl.searchParams.set('sf', 'true'); // Show form
      googleCalendarUrl.searchParams.set('output', 'xml'); // Open in new tab
      googleCalendarUrl.searchParams.set('ctz', 'America/Los_Angeles'); // Ensure Calendar UI opens with the intended timezone

      // Open Google Calendar in a new tab
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
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <div className="candidate-events-container">
      <div className="events-header">
        <div className="events-title-section">
          <h1 className="events-title">Events</h1>
          <p className="events-subtitle">
            Join us to learn more about UConsulting and network with candidates
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
                <div className="event-time">{dateInfo.time}</div>
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
                  <button
                    className="rsvp-button"
                    onClick={() => handleRSVP(event)}
                    disabled={savingId === event.id || isExternalRsvp(event)}
                    title={isExternalRsvp(event) ? 'Change this RSVP where you made it' : undefined}
                  >
                    {rsvpButtonLabel(event)}
                  </button>
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
                {rsvpErrors[event.id] && (
                  <div className="error" role="alert">{rsvpErrors[event.id]}</div>
                )}
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






