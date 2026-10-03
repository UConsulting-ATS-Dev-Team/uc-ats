import prisma from '../prismaClient.js'; 
import config from '../config.js';
import { getResponses } from './google/forms.js'
import { transformFormResponse } from '../utils/dataMapper.js'
import { cycleFormIds } from '../utils/formUtils.js'
import { resolveCandidateCycle } from './activeCycle.js'
import { claimReferralsForCandidate } from './referrals.js'
import { claimLumaGuestsForCandidate } from './luma/ingestGuests.js'
import { sendApplicationReceipts } from './applicationReceipts.js'
import { applyResubmission, RESUBMISSION_ACTIONS } from './applicationResubmissions.js'

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

// What applyResubmission needs to know about the application already on file.
const RESUBMISSION_SELECT = {
  id: true,
  responseID: true,
  supersededResponseIds: true,
  submittedAt: true,
  resumeUrl: true,
  status: true,
  currentRound: true,
  approved: true,
  resumeDecision: true,
  coffeeChatDecision: true,
  firstRoundDecision: true,
  finalRoundDecision: true
};

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

        // One application per candidate per cycle. Someone who already applied
        // and submits again (a replaced form, or the same form twice) is folded
        // into the application they have; applicationResubmissions.js decides
        // whether the new answers replace the old ones or are only recorded.
        // Either way there is no second row, and nothing below runs again: the
        // receipt, referral and Luma claims all happened for the first one.
        const [existingApplication] = await prisma.application.findMany({
          where: { candidateId: candidate.id, cycleId: activeCycle.id },
          select: RESUBMISSION_SELECT,
          orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
          take: 1
        });
        if (existingApplication) {
          const outcome = await prisma.$transaction((tx) => applyResubmission(tx, {
            existing: existingApplication,
            incoming: record,
            candidateLocked: Boolean(candidate.recordsLockedAt)
          }));
          console.log(
            outcome.action === RESUBMISSION_ACTIONS.REPLACE
              ? `Resubmission ${record.responseID} replaced the answers on application id=${outcome.applicationId} (candidate id=${candidate.id}); ${existingApplication.responseID} kept as superseded`
              : `Resubmission ${record.responseID} recorded on application id=${outcome.applicationId} (candidate id=${candidate.id}) without changing it: ${outcome.reason}`
          );
          resubmissionCount++;
          continue;
        }

        // Create application with candidate connection
        const dataToCreate = {
          ...record,
          candidateId: candidate.id,
          currentRound: '1', // Set to Resume Review round for new applications
          ...(activeCycle ? { cycleId: activeCycle.id } : {})
        };

        await prisma.application.create({ data: dataToCreate });
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

