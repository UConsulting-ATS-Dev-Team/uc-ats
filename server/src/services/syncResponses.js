import prisma from '../prismaClient.js'; 
import config from '../config.js';
import { getResponses } from './google/forms.js'
import { transformFormResponse } from '../utils/dataMapper.js'
import { extractFormIdFromUrl } from '../utils/formUtils.js'
import { resolveCandidateCycle } from './activeCycle.js'
import { claimReferralsForCandidate } from './referrals.js'

/**
 * The candidate whose email this is, resolved so the answer never depends on
 * which row the database hands back first.
 *
 * `Candidate.email` is unique but case-sensitive, so rows differing only in case
 * can both exist and both match an insensitive compare. An exact hit is taken
 * first; past that the oldest row wins, because it is the one most likely to
 * carry the history everything else hangs off.
 */
async function findCandidateByEmail(email) {
  const exact = await prisma.candidate.findUnique({ where: { email } });
  if (exact) return exact;

  const matches = await prisma.candidate.findMany({
    where: { email: { equals: email, mode: 'insensitive' } },
    orderBy: { createdAt: 'asc' },
    take: 2
  });
  if (matches.length > 1) {
    console.warn(
      `[syncResponses] ${email} matches ${matches.length} candidate rows differing only in case; `
      + `using the oldest (${matches[0].id}). These rows should be merged.`
    );
  }
  return matches[0] ?? null;
}

/**
 * Which candidate a new application belongs to.
 *
 * The UID is asked first and normally answers: it is what the Luma sync keys a
 * candidate on, so it is the row carrying any event_rsvp / event_attendance
 * history, and nothing re-points those rows afterwards.
 *
 * But both identifiers are looked up, because the interesting case is when they
 * point at *two different people* - a UID typed wrong, or somebody else's. Then
 * the UID is the one to distrust: it is free text on a form, whereas the address
 * is where this applicant is actually reachable and what their own account will
 * match on. So a conflict resolves to the address and is logged; the alternative
 * files somebody's application onto a stranger's record.
 *
 * It is reported rather than refused because losing an application is worse than
 * linking it imperfectly - an admin can move it, and the Luma history it may
 * have missed is one link away in the guests panel.
 */
async function resolveCandidate({ studentId, email }) {
  const byUid = studentId
    ? await prisma.candidate.findUnique({ where: { studentId } })
    : null;
  const byEmail = email ? await findCandidateByEmail(email) : null;

  if (byUid && byEmail && byUid.id !== byEmail.id) {
    console.warn(
      `[syncResponses] conflicting identity: UID ${studentId} belongs to candidate ${byUid.id} `
      + `but ${email} belongs to ${byEmail.id}. Filing under the address; `
      + `check whether the UID was mistyped.`
    );
    return byEmail;
  }

  return byUid ?? byEmail;
}

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

        // Two lookups rather than one OR, and the UID asked first.
        //
        // Both columns are unique, so each answers at most one row - but an OR
        // across them can match two *different* candidates: the UID's owner and
        // the address's owner. Those come apart whenever somebody registered on
        // Luma under a personal address, or a UID was mistyped somewhere. The
        // old `findFirst` then returned whichever row the database happened to
        // hand back first, with no ordering to make it repeatable.
        //
        // The UID wins because it is what the Luma sync keys a candidate on, so
        // it is the row carrying any event_rsvp / event_attendance history -
        // and nothing re-points those rows afterwards. Choosing the address
        // instead would strand a person's RSVPs and door scans on a record no
        // application, and no candidate account, ever reaches.
        //
        // The address is compared case-insensitively: Luma emails are stored
        // lowercased, a Google Form answer is stored however it was typed, and
        // an exact compare turns "Maria@ucla.edu" into a second person.
        //
        // Both are still looked up, even once the UID has answered, because two
        // rows that disagree is the one case neither identifier should decide on
        // its own - see resolveCandidate.
        let candidate = await resolveCandidate({ studentId, email: emailFromForm });

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

        // A member may have referred this person by name before they applied.
        // Now that the application is actually on file, those referrals have
        // someone to point at.
        //
        // This runs after the application is written, not before: a response
        // that fails to insert must not leave a referral claiming that someone
        // applied when nothing was recorded. And a failure here must not cost
        // us an application we already saved, so it is logged and swallowed -
        // an unclaimed referral is visible and fixable, a lost application is
        // not.
        try {
          const claimed = await claimReferralsForCandidate({
            candidate,
            cycleId: activeCycle.id
          });
          if (claimed.length > 0) {
            console.log(`Claimed ${claimed.length} pre-application referral(s) for candidate id=${candidate.id}`);
          }
        } catch (referralError) {
          console.error(`Failed to claim referrals for candidate id=${candidate.id}:`, referralError);
        }

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

