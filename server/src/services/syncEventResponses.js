import prisma from '../prismaClient.js'; 
import { getResponses } from './google/forms.js'
import { extractFormIdFromUrl } from '../utils/formUtils.js'
import { transformEventFormResponse, createDynamicEventMapping } from '../utils/eventDataMapper.js'
import { sendRSVPConfirmation, sendAttendanceConfirmation, formatEventDate } from './emailNotifications.js'

// Transform event form responses using configuration-based mapping
function transformEventResponse(response, eventId, formType) {
  try {
    // Try to use configuration-based transformation first
    return transformEventFormResponse(response, formType, eventId);
  } catch (configError) {
    console.warn(`Configuration-based transformation failed for ${formType}, falling back to dynamic mapping:`, configError.message);
    
    // Fallback to dynamic mapping if config is missing or incomplete
    return createDynamicEventMapping(response, eventId, formType);
  }
}

// Sync attendance responses for a specific event
export async function syncEventAttendance(eventId) {
  try {
    console.log(`Syncing attendance for event ${eventId}...`);

    // Get the event with its attendance form URL
    const event = await prisma.events.findUnique({
      where: { id: eventId }
    });

    if (!event) {
      throw new Error(`Event not found: ${eventId}`);
    }

    if (!event.attendanceForm) {
      console.warn(`Event ${eventId} has no attendance form URL. Skipping sync.`);
      return { processed: 0, errors: 0 };
    }

    const formId = extractFormIdFromUrl(event.attendanceForm);
    if (!formId) {
      console.warn(`Invalid attendance form URL for event ${eventId}: ${event.attendanceForm}`);
      return { processed: 0, errors: 0 };
    }

    console.log(`Fetching responses from attendance form: ${formId}`);
    const responses = await getResponses(formId);

    // Get existing attendance response IDs for this event
    const existingResponseIds = new Set(
      (await prisma.eventAttendance.findMany({
        where: { eventId },
        select: { responseId: true }
      })).map(r => r.responseId)
    );

    // Filter out responses that are already processed
    const newResponses = responses.filter(response => !existingResponseIds.has(response.responseId));
    console.log(`Found ${newResponses.length} new attendance responses to process`);

    let successCount = 0;
    let errorCount = 0;
    let totalProcessed = 0;

    for (const response of newResponses) {
      totalProcessed++; // Count every response we attempt to process
      try {
        const transformedData = transformEventResponse(response, eventId, 'attendance');
        
        // Find or create the candidate
        let candidate = null;
        if (transformedData.studentId) {
          candidate = await prisma.candidate.findUnique({
            where: { studentId: transformedData.studentId }
          });
        }
        
        if (!candidate && transformedData.email) {
          candidate = await prisma.candidate.findUnique({
            where: { email: transformedData.email }
          });
        }

        // Auto-create candidate if not found
        if (!candidate) {
          if (!transformedData.firstName || !transformedData.email) {
            console.warn(`Missing required candidate information for attendance response: ${JSON.stringify({
              studentId: transformedData.studentId,
              email: transformedData.email,
              firstName: transformedData.firstName,
              lastName: transformedData.lastName
            })}`);
            errorCount++;
            continue;
          }

          console.log(`Creating new candidate for attendance response: ${transformedData.firstName} ${transformedData.lastName || '[no last name]'}`);
          
          candidate = await prisma.candidate.create({
            data: {
              firstName: transformedData.firstName,
              lastName: transformedData.lastName || '',
              email: transformedData.email,
              studentId: transformedData.studentId
            }
          });
        }

        // Create attendance record
        await prisma.eventAttendance.create({
          data: {
            responseId: transformedData.responseId,
            eventId: eventId,
            candidateId: candidate.id
          }
        });

        // Send attendance confirmation email
        try {
          const candidateName = `${candidate.firstName}${candidate.lastName ? ` ${candidate.lastName}` : ''}`;
          const eventDate = formatEventDate(event.eventStartDate);
          
          await sendAttendanceConfirmation(
            candidate.email,
            candidateName,
            event.eventName,
            eventDate,
            event.eventLocation
          );
        } catch (emailError) {
          console.error('Error sending attendance confirmation email:', emailError);
          // Don't fail the sync if email fails
        }

        successCount++;
      } catch (error) {
        console.error(`Error processing attendance response ${response.responseId}:`, error);
        errorCount++;
      }
    }

    console.log(`Attendance sync complete for event ${eventId}: ${totalProcessed} processed, ${errorCount} errors`);
    return { processed: totalProcessed, errors: errorCount };
    
  } catch (error) {
    console.error(`Error syncing attendance for event ${eventId}:`, error);
    throw error;
  }
}

// Sync RSVP responses for a specific event
export async function syncEventRSVP(eventId) {
  try {
    console.log(`Syncing RSVP for event ${eventId}...`);

    // Get the event with its RSVP form URL
    const event = await prisma.events.findUnique({
      where: { id: eventId }
    });

    if (!event) {
      throw new Error(`Event not found: ${eventId}`);
    }

    if (!event.rsvpForm) {
      console.warn(`Event ${eventId} has no RSVP form URL. Skipping sync.`);
      return { processed: 0, errors: 0 };
    }

    const formId = extractFormIdFromUrl(event.rsvpForm);
    if (!formId) {
      console.warn(`Invalid RSVP form URL for event ${eventId}: ${event.rsvpForm}`);
      return { processed: 0, errors: 0 };
    }

    console.log(`Fetching responses from RSVP form: ${formId}`);
    const responses = await getResponses(formId);

    // Get existing RSVP response IDs for this event
    const existingResponseIds = new Set(
      (await prisma.eventRsvp.findMany({
        where: { eventId },
        select: { responseId: true }
      })).map(r => r.responseId)
    );

    // Filter out responses that are already processed
    const newResponses = responses.filter(response => !existingResponseIds.has(response.responseId));
    console.log(`Found ${newResponses.length} new RSVP responses to process`);

    let successCount = 0;
    let errorCount = 0;
    let totalProcessed = 0;

    for (const response of newResponses) {
      totalProcessed++; // Count every response we attempt to process
      try {
        const transformedData = transformEventResponse(response, eventId, 'rsvp');
        
        console.log(`Transformed data for RSVP response:`, JSON.stringify(transformedData, null, 2));
        
        // Find or create the candidate
        let candidate = null;
        if (transformedData.studentId) {
          candidate = await prisma.candidate.findUnique({
            where: { studentId: transformedData.studentId }
          });
        }
        
        if (!candidate && transformedData.email) {
          candidate = await prisma.candidate.findUnique({
            where: { email: transformedData.email }
          });
        }

        // Auto-create candidate if not found
        if (!candidate) {
          if (!transformedData.firstName || !transformedData.email) {
            console.warn(`Missing required candidate information for RSVP response: ${JSON.stringify({
              studentId: transformedData.studentId,
              email: transformedData.email,
              firstName: transformedData.firstName,
              lastName: transformedData.lastName
            })}`);
            errorCount++;
            continue;
          }

          console.log(`Creating new candidate for RSVP response: ${transformedData.firstName} ${transformedData.lastName || '[no last name]'}`);
          
          candidate = await prisma.candidate.create({
            data: {
              firstName: transformedData.firstName,
              lastName: transformedData.lastName || '',
              email: transformedData.email,
              studentId: transformedData.studentId
            }
          });
        }

        // Create RSVP record
        await prisma.eventRsvp.create({
          data: {
            responseId: transformedData.responseId,
            eventId: eventId,
            candidateId: candidate.id
          }
        });

        // Send RSVP confirmation email
        try {
          const candidateName = `${candidate.firstName}${candidate.lastName ? ` ${candidate.lastName}` : ''}`;
          const eventDate = formatEventDate(event.eventStartDate);
          
          await sendRSVPConfirmation(
            candidate.email,
            candidateName,
            event.eventName,
            eventDate,
            event.eventLocation
          );
        } catch (emailError) {
          console.error('Error sending RSVP confirmation email:', emailError);
          // Don't fail the sync if email fails
        }

        successCount++;
      } catch (error) {
        console.error(`Error processing RSVP response ${response.responseId}:`, error);
        errorCount++;
      }
    }

    console.log(`RSVP sync complete for event ${eventId}: ${totalProcessed} processed, ${errorCount} errors`);
    return { processed: totalProcessed, errors: errorCount };
    
  } catch (error) {
    console.error(`Error syncing RSVP for event ${eventId}:`, error);
    throw error;
  }
}

// Sync member RSVP responses for a specific event
export async function syncMemberEventRSVP(eventId) {
  try {
    console.log(`Syncing member RSVP for event ${eventId}...`);

    // Get the event with its member RSVP form URL
    const event = await prisma.events.findUnique({
      where: { id: eventId }
    });

    if (!event) {
      throw new Error(`Event not found: ${eventId}`);
    }

    if (!event.memberRsvpUrl) {
      console.warn(`Event ${eventId} has no member RSVP form URL. Skipping sync.`);
      return { processed: 0, errors: 0 };
    }

    const formId = extractFormIdFromUrl(event.memberRsvpUrl);
    if (!formId) {
      console.warn(`Invalid member RSVP form URL for event ${eventId}: ${event.memberRsvpUrl}`);
      return { processed: 0, errors: 0 };
    }

    console.log(`Fetching responses from member RSVP form: ${formId}`);
    const responses = await getResponses(formId);

    // Get existing member RSVP response IDs for this event
    const existingResponseIds = new Set(
      (await prisma.memberEventRsvp.findMany({
        where: { eventId },
        select: { responseId: true }
      })).map(r => r.responseId)
    );

    // Filter out responses that are already processed
    const newResponses = responses.filter(response => !existingResponseIds.has(response.responseId));
    console.log(`Found ${newResponses.length} new member RSVP responses to process`);

    let successCount = 0;
    let errorCount = 0;
    let totalProcessed = 0;

    for (const response of newResponses) {
      totalProcessed++; // Count every response we attempt to process
      
      try {
        const transformedData = transformEventResponse(response, eventId, 'member-rsvp');
        
        console.log(`Transformed data for member RSVP response:`, JSON.stringify(transformedData, null, 2));
        
        // Find the member by student ID or email
        let member = null;
        if (transformedData.studentId) {
          member = await prisma.user.findUnique({
            where: { studentId: transformedData.studentId }
          });
        }
        
        if (!member && transformedData.email) {
          member = await prisma.user.findUnique({
            where: { email: transformedData.email }
          });
        }

        if (!member) {
          console.warn(`Member not found for RSVP response: studentId=${transformedData.studentId}, email=${transformedData.email}`);
          errorCount++;
          continue; // Still count as processed, but as an error
        }

        // Create member RSVP record
        await prisma.memberEventRsvp.create({
          data: {
            responseId: transformedData.responseId,
            eventId: eventId,
            memberId: member.id
          }
        });

        successCount++;
        console.log(`Successfully processed member RSVP response ${transformedData.responseId} for member ${member.id}`);

      } catch (error) {
        console.error(`Error processing member RSVP response ${response.responseId}:`, error);
        errorCount++;
      }
    }

    console.log(`Member RSVP sync completed for event ${eventId}: ${totalProcessed} processed, ${errorCount} errors`);
    return { processed: totalProcessed, errors: errorCount };

  } catch (error) {
    console.error(`Error syncing member RSVP for event ${eventId}:`, error);
    throw error;
  }
}

// Sync all event forms (both RSVP and attendance) for all active events
export async function syncAllEventForms() {
  try {
    console.log('Starting sync for all event forms...');
    
    // Get all events that have form URLs
    const events = await prisma.events.findMany({
      where: {
        OR: [
          { rsvpForm: { not: null } },
          { attendanceForm: { not: null } },
          { memberRsvpUrl: { not: null } }
        ]
      }
    });

    console.log(`Found ${events.length} events with forms to sync`);

    const results = [];
    
    for (const event of events) {
      try {
        const eventResult = {
          eventId: event.id,
          eventName: event.eventName,
          rsvp: { processed: 0, errors: 0 },
          attendance: { processed: 0, errors: 0 },
          memberRsvp: { processed: 0, errors: 0 }
        };

        // Sync RSVP if form URL exists
        if (event.rsvpForm) {
          eventResult.rsvp = await syncEventRSVP(event.id);
        }

        // Sync attendance if form URL exists  
        if (event.attendanceForm) {
          eventResult.attendance = await syncEventAttendance(event.id);
        }

        // Sync member RSVP if form URL exists
        if (event.memberRsvpUrl) {
          eventResult.memberRsvp = await syncMemberEventRSVP(event.id);
        }

        results.push(eventResult);
      } catch (error) {
        console.error(`Error syncing event ${event.id}:`, error);
        results.push({
          eventId: event.id,
          eventName: event.eventName,
          error: error.message
        });
      }
    }

    console.log('Event form sync complete:', results);
    return results;
    
  } catch (error) {
    console.error('Error in syncAllEventForms:', error);
    throw error;
  }
}