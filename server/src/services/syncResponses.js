import prisma from '../prismaClient.js'; 
import config from '../config.js';
import { getResponses } from './google/forms.js'
import { transformFormResponse } from '../utils/dataMapper.js'
import { extractFormIdFromUrl } from '../utils/formUtils.js'
import { resolveCandidateCycle } from './activeCycle.js'

export default async function syncFormResponses() {
  try {
    console.log('Fetching new responses from Google Forms...');

    // Require an active cycle and use its form URL exclusively.
    // Always the candidate pointer: applications belong to the cycle candidates are
    // applying to, and this cron has no request or role to key on.
    const activeCycle = await resolveCandidateCycle(prisma);
    if (!activeCycle) {
      console.warn('No active recruiting cycle. Skipping sync.');
      return;
    }
    
    console.log('Active cycle found:', {
      id: activeCycle.id,
      name: activeCycle.name,
      formUrl: activeCycle.formUrl
    });
    
    const formIdToUse = extractFormIdFromUrl(activeCycle.formUrl || '');
    console.log('Extracted form ID:', formIdToUse);
    
    if (!formIdToUse) {
      console.warn('Active cycle has no valid Google Form URL. Skipping sync.');
      console.warn('Form URL was:', activeCycle.formUrl);
      return;
    }

    console.log('Using form ID for API call:', formIdToUse);
    const responses = await getResponses(formIdToUse)
    
    // Get existing response IDs
    const existingResponseIds = new Set(
      (await prisma.application.findMany({
        select: { responseID: true }
      })).map(r => r.responseID)
    )
    
    // Filter out responses that are already in the database
    const newResponses = responses.filter(response => !existingResponseIds.has(response.responseId))
    
    console.log(`Found ${newResponses.length} new responses to process`);
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const response of newResponses) {
      try {
        const dbRecord = transformFormResponse(response);
        
        // Extract candidate information from the application data
        const studentId = dbRecord.studentId;
        const emailFromForm = (dbRecord.email || '').trim();

        // Prefer tying applications to an existing candidate by studentId or email
        let candidate = await prisma.candidate.findFirst({
          where: {
            OR: [
              studentId ? { studentId } : undefined,
              emailFromForm ? { email: emailFromForm } : undefined
            ].filter(Boolean)
          }
        });

        if (!candidate) {
          // No existing candidate, create a new one
          candidate = await prisma.candidate.create({
            data: {
              studentId,
              firstName: dbRecord.firstName,
              lastName: dbRecord.lastName,
              email: emailFromForm
            }
          });
          console.log(`Created new candidate for studentId ${studentId}: ${dbRecord.firstName} ${dbRecord.lastName}`);
        } else {
          // Candidate exists: backfill any missing fields but avoid overwriting existing non-null values
          const updates = {};
          if (!candidate.studentId && studentId) updates.studentId = studentId;
          if (!candidate.firstName && dbRecord.firstName) updates.firstName = dbRecord.firstName;
          if (!candidate.lastName && dbRecord.lastName) updates.lastName = dbRecord.lastName;
          if (!candidate.email && emailFromForm) updates.email = emailFromForm;

          if (Object.keys(updates).length > 0) {
            candidate = await prisma.candidate.update({
              where: { id: candidate.id },
              data: updates
            });
          }
          console.log(`Linked application to existing candidate id=${candidate.id} (${candidate.firstName} ${candidate.lastName})`);
        }

        // Create application with candidate connection
        const dataToCreate = {
          ...dbRecord,
          candidateId: candidate.id,
          currentRound: '1', // Set to Resume Review round for new applications
          ...(activeCycle ? { cycleId: activeCycle.id } : {})
        };

        // Remove undefined values to avoid Prisma validation errors
        Object.keys(dataToCreate).forEach(key => {
          if (dataToCreate[key] === undefined) {
            delete dataToCreate[key];
          }
        });

        // Sanitize any file URLs to ensure they are relative (prevent localhost URLs in production)
        const urlFields = ['resumeUrl', 'coverLetterUrl', 'videoUrl', 'headshotUrl'];
        const urlPrefixesToStrip = ['http://localhost:3001', 'http://localhost:5173', 'https://uconsultingats.com', 'https://www.uconsultingats.com'];
        urlFields.forEach(field => {
          if (dataToCreate[field]) {
            for (const prefix of urlPrefixesToStrip) {
              if (dataToCreate[field].startsWith(prefix)) {
                dataToCreate[field] = dataToCreate[field].replace(prefix, '');
                break;
              }
            }
          }
        });

        // Ensure we do not duplicate by responseID (already filtered), but also guard
        // against the same candidate submitting twice by cycle with the same responseID
        await prisma.application.create({ data: dataToCreate });
        successCount++;

      } catch (error) {
        console.error(`Error processing response ${response.responseId}:`, error);
        errorCount++;
      }
    }
    
    console.log(`Sync complete: ${successCount} processed successfully, ${errorCount} errored`);
    
  } catch (error) {
    console.error('Error syncing form responses:', error)
  }
} 

