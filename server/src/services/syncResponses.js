import prisma from '../prismaClient.js'; 
import config from '../config.js';
import { getResponses } from './google/forms.js'
import { transformFormResponse } from '../utils/dataMapper.js'
import { cycleFormIds } from '../utils/formUtils.js'
import { resolveCandidateCycle } from './activeCycle.js'
import { claimReferralsForCandidate } from './referrals.js'
import { claimLumaGuestsForCandidate } from './luma/ingestGuests.js'
import { sendApplicationReceipts } from './applicationReceipts.js'
import { fileSubmission, RESUBMISSION_ACTIONS, RESUBMISSION_REASONS } from './applicationResubmissions.js'

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
 * The UID answers wherever it can. It is what the Luma sync keys a candidate on,
 * so it is the row carrying any event_rsvp / event_attendance history, and
 * nothing re-points those rows afterwards: resolving to anything else strands a
 * person's RSVPs and door scans on a record no application ever reaches.
 *
 * Both identifiers are still looked up, because two rows that disagree is worth
 * knowing about - a UID typed wrong, or somebody else's. The conflict is logged
 * and the UID still wins.
 *
 * It is deliberately **not** resolved to the address instead. That trade looks
 * appealing from one direction (a stolen UID files your application onto its
 * owner's record) and is worse from the other (your own UID with someone else's
 * address files your application onto *theirs*) - the two cases are mirror
 * images and no choice here is safe in both. What makes either of them exposure
 * rather than just bad data is `GET /api/applications/:id` treating
 * `application.studentId`, the form value, as proof of ownership. That is the
 * place to fix it; until it is fixed, both resolutions leak the same way, and
 * only the UID keeps the event history attached.
 *
 * Returns `emailTaken` alongside, because the caller backfills empty fields onto
 * whichever row it gets: `Candidate.email` is unique and not nullable, so a row
 * with an empty address would otherwise be handed one another candidate already
 * owns, and the write would fail the whole response - every hour, forever, since
 * a response with no application row is new again on the next run.
 */
async function resolveCandidate({ studentId, email }) {
  const byUid = studentId
    ? await prisma.candidate.findUnique({ where: { studentId } })
    : null;
  const byEmail = email ? await findCandidateByEmail(email) : null;

  if (byUid && byEmail && byUid.id !== byEmail.id) {
    console.warn(
      `[syncResponses] conflicting identity: UID ${studentId} belongs to candidate ${byUid.id} `
      + `but ${email} belongs to ${byEmail.id}. Filing under the UID, which is what carries `
      + `any Luma event history; check whether the UID was mistyped.`
    );
  }

  const candidate = byUid ?? byEmail;
  return { candidate, emailTaken: Boolean(byEmail && candidate && byEmail.id !== candidate.id) };
}

const RECEIPT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const URL_FIELDS = ['resumeUrl', 'coverLetterUrl', 'videoUrl', 'headshotUrl'];
const URL_PREFIXES_TO_STRIP = ['http://localhost:3001', 'http://localhost:5173', 'https://uconsultingats.com', 'https://www.uconsultingats.com'];

/**
 * The record as it is stored, whether it creates an application or replaces
 * one's answers: undefined values dropped (Prisma rejects them), and file URLs
 * made relative so a row never carries a localhost or production origin.
 */
function sanitizeRecord(dbRecord) {
  const record = { ...dbRecord };
  Object.keys(record).forEach(key => {
    if (record[key] === undefined) delete record[key];
  });
  URL_FIELDS.forEach(field => {
    if (record[field]) {
      for (const prefix of URL_PREFIXES_TO_STRIP) {
        if (record[field].startsWith(prefix)) {
          record[field] = record[field].replace(prefix, '');
          break;
        }
      }
    }
  });
  return record;
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
      formUrl: activeCycle.formUrl,
      previousFormUrls: activeCycle.previousFormUrls
    });

    // The current form and every earlier version of it. Each is read on its
    // own, so one the service account cannot open does not stop the others.
    const formIds = cycleFormIds(activeCycle);
    if (formIds.length === 0) {
      console.warn('Active cycle has no valid Google Form URL. Skipping sync.');
      console.warn('Form URL was:', activeCycle.formUrl);
      return;
    }

    const responses = [];
    for (const formId of formIds) {
      try {
        console.log('Using form ID for API call:', formId);
        responses.push(...await getResponses(formId));
      } catch (error) {
        console.error(`Could not read responses for form ${formId}:`, error.message);
      }
    }

    // Every response already on file: each application's own, plus the ones it
    // absorbed or ignored as a resubmission from the same person
    // (applicationResubmissions.js). Without the second half a resubmission
    // that was only recorded would be new again on every run.
    const existingResponseIds = new Set(
      (await prisma.application.findMany({
        select: { responseID: true, supersededResponseIds: true }
      })).flatMap(r => [r.responseID, ...(r.supersededResponseIds || [])])
    )
    
    // Filter out responses that are already in the database, oldest first, so
    // two unseen submissions from one person fold in the order they were sent.
    const submitTime = (response) => Date.parse(response.createTime) || 0;
    const newResponses = responses
      .filter(response => !existingResponseIds.has(response.responseId))
      .sort((a, b) => submitTime(a) - submitTime(b))
    
    console.log(`Found ${newResponses.length} new responses to process`);
    
    let successCount = 0;
    let resubmissionCount = 0;
    const filedResponseIDs = [];
    let errorCount = 0;
    
    for (const response of newResponses) {
      try {
        const dbRecord = transformFormResponse(response);
        
        // Extract candidate information from the application data
        const studentId = dbRecord.studentId;
        const emailFromForm = (dbRecord.email || '').trim();

        // Neither identifier mapped means the response came from a form whose
        // question ids form-config.json does not know yet, typically a new
        // version of the form. Nothing is written, so it syncs in full once
        // the mappings are added instead of being stored as a nameless row.
        if (!studentId && !emailFromForm) {
          console.warn(`Skipping response ${response.responseId}: no mapped email or UID. Add the form's question ids to form-config.json.`);
          continue;
        }

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
        const { candidate: matched, emailTaken } = await resolveCandidate({
          studentId,
          email: emailFromForm
        });
        let candidate = matched;

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
          // Skipped when another candidate already holds this address: the
          // column is unique, so writing it would fail the response rather than
          // fill a gap, and the conflict above has already been logged.
          if (!candidate.email && emailFromForm && !emailTaken) updates.email = emailFromForm;

          if (Object.keys(updates).length > 0) {
            candidate = await prisma.candidate.update({
              where: { id: candidate.id },
              data: updates
            });
          }
          console.log(`Linked application to existing candidate id=${candidate.id} (${candidate.firstName} ${candidate.lastName})`);
        }

        const record = sanitizeRecord(dbRecord);

        // Create application with candidate connection
        const dataToCreate = {
          ...record,
          candidateId: candidate.id,
          currentRound: '1', // Set to Resume Review round for new applications
          ...(activeCycle ? { cycleId: activeCycle.id } : {})
        };

        // One application per candidate per cycle. applicationResubmissions.js
        // decides, under a lock on this candidate and cycle, whether this
        // response creates their application or folds into the one they have,
        // and if it folds, whether the new answers replace the old ones or are
        // only recorded.
        //
        // A UID that resolved to one candidate while the address belongs to
        // another (emailTaken) is never folded: the response may be somebody
        // else's, so it is filed as its own application, as it always was.
        const outcome = await prisma.$transaction(
          (tx) => fileSubmission(tx, {
            candidateId: candidate.id,
            cycleId: activeCycle.id,
            record,
            createData: dataToCreate,
            candidateLocked: Boolean(candidate.recordsLockedAt),
            identityConflict: emailTaken
          }),
          { maxWait: 10 * 1000, timeout: 30 * 1000 }
        );

        if (outcome.action !== RESUBMISSION_ACTIONS.CREATED) {
          // A resubmission. Nothing below runs again: the referral and Luma
          // claims happened for the first submission. If that first submission
          // was filed earlier in this run and has just been replaced, its
          // receipt is still owed, and the sweep finds it by response id, so
          // the id it is listed under follows the row.
          if (outcome.previousResponseID) {
            const at = filedResponseIDs.indexOf(outcome.previousResponseID);
            if (at !== -1) filedResponseIDs[at] = record.responseID;
          }
          console.log(
            outcome.action === RESUBMISSION_ACTIONS.REPLACE
              ? `Resubmission ${record.responseID} replaced the answers on application id=${outcome.applicationId} (candidate id=${candidate.id}); ${outcome.previousResponseID} kept as superseded`
              : `Resubmission ${record.responseID} recorded on application id=${outcome.applicationId} (candidate id=${candidate.id}) without changing it: ${outcome.reason}`
          );
          resubmissionCount++;
          continue;
        }

        if (outcome.reason === RESUBMISSION_REASONS.IDENTITY_CONFLICT) {
          console.warn(
            `[syncResponses] response ${record.responseID} filed as its own application for candidate id=${candidate.id}, `
            + `not folded into an existing one: its UID and address belong to different candidates.`
          );
        }
        successCount++;
        filedResponseIDs.push(dataToCreate.responseID);

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

        // Luma guests the sync could not place - usually a registration under
        // an address the ATS had never seen - are theirs now that the
        // application gives us the address. Same rule as the referrals above:
        // a failure is logged, never allowed to cost the application.
        try {
          const lumaClaimed = await claimLumaGuestsForCandidate({
            candidateId: candidate.id,
            // When the address belongs to another candidate (the UID won - see
            // resolveCandidate), its registrations are that person's, not these.
            email: emailTaken ? null : emailFromForm,
            studentId
          });
          if (lumaClaimed.length > 0) {
            console.log(`Linked ${lumaClaimed.length} Luma registration(s) to candidate id=${candidate.id}`);
          }
        } catch (lumaError) {
          console.error(`Failed to link Luma registrations for candidate id=${candidate.id}:`, lumaError);
        }

      } catch (error) {
        console.error(`Error processing response ${response.responseId}:`, error);
        errorCount++;
      }
    }
    
    console.log(`Sync complete: ${successCount} processed successfully, ${resubmissionCount} folded into an existing application, ${errorCount} errored`);

    // "We received your application" for everything this sync and recent
    // ones filed. Not awaited: a slow SES must not hold up server startup,
    // which awaits the first sync. Sweeping a window rather than this run's
    // list is what makes that safe - a send lost to a deploy goes out on the
    // next tick. The window is a week of submittedAt, which is the form's own
    // timestamp; this run's own applications are passed too, so one that
    // syncs later than that (an unmapped form version) still gets one.
    // applicationReceipts.js owns who is owed one and sending it once.
    sendApplicationReceipts({
      cycle: activeCycle,
      since: new Date(Date.now() - RECEIPT_WINDOW_MS),
      responseIDs: filedResponseIDs,
    })
      .catch((error) => console.error('Failed to send application received emails:', error));
    
  } catch (error) {
    console.error('Error syncing form responses:', error)
  }
} 

