// Linking a Luma guest to a person by hand.
//
// ingestGuests decides who a guest is from their email and the UID they typed.
// When neither answers it files them UNMATCHED, and when the UID answered but
// the name did not corroborate it files them with a note. Both are held for a
// person to settle; this is how they settle them.
//
// Two things make a hand link more than a database edit:
//
//  - **The rows follow.** A guest's RSVP and attendance rows are derived from
//    their Luma status and who they are, so changing who they are has to re-run
//    the same reconcile a sync would (reconcileRows). Waiting for the next sync
//    would not do: an event leaves the routine's list three days after it
//    starts, so a link made after that would never be applied at all.
//  - **It sticks.** resolvePerson reuses an existing candidateId / userId
//    instead of matching again, so an hourly sync will not undo this. Clearing
//    the note is part of that: the note is what marks a guest as still needing a
//    look, and one a person has settled no longer does.
import prisma from '../../prismaClient.js';
import { MATCH_STATUS, MEMBER_ROLES, reconcileRows } from './ingestGuests.js';

export class LinkError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Points a stored Luma guest at a candidate, at a member, or at nobody, and
 * settles their rows to match.
 *
 * Passing neither id unlinks: the guest goes back to UNMATCHED and their Luma
 * rows are removed. That is the undo for a link made in error, and the only way
 * back from one — a wrong link cannot be corrected by a sync, because a match
 * that exists is never re-decided.
 *
 * @param {object} args
 * @param {string} args.lumaGuestId  LumaGuest.lumaGuestId (Luma's own id)
 * @param {string} [args.eventId]    ATS event the caller believes it belongs to
 * @param {string} [args.candidateId]
 * @param {string} [args.userId]
 * @param {string} [args.actorId]    admin making the link, for the log
 * @throws {LinkError} with an HTTP status the route can answer with
 */
export async function linkLumaGuest({ lumaGuestId, eventId, candidateId, userId, actorId }, { db = prisma } = {}) {
  if (candidateId && userId) {
    throw new LinkError(400, 'A guest is either a candidate or a member, not both');
  }

  return db.$transaction(async (tx) => {
    const previous = await tx.lumaGuest.findUnique({ where: { lumaGuestId } });
    if (!previous) throw new LinkError(404, 'That Luma guest is not in the ATS');
    // The route reaches a guest through its event, so a mismatch means the id
    // in the path and the id in the body disagree about which event this is.
    if (eventId && previous.eventId !== eventId) {
      throw new LinkError(404, 'That Luma guest belongs to a different event');
    }

    const person = { matchStatus: MATCH_STATUS.UNMATCHED, matchNote: null };
    if (candidateId) {
      const candidate = await tx.candidate.findUnique({
        where: { id: candidateId },
        select: { id: true, recordsLockedAt: true }
      });
      if (!candidate) throw new LinkError(404, 'That candidate no longer exists');
      // A sealed record is not somewhere to file new activity by hand. They are
      // a member now, so the member they became is who to link.
      if (candidate.recordsLockedAt) {
        throw new LinkError(409, 'That candidate\'s records are sealed; link their member account instead');
      }
      person.candidateId = candidate.id;
      person.matchStatus = MATCH_STATUS.MATCHED_CANDIDATE;
    } else if (userId) {
      const member = await tx.user.findFirst({
        where: { id: userId, role: { in: MEMBER_ROLES } },
        select: { id: true }
      });
      if (!member) throw new LinkError(404, 'That member no longer exists');
      person.userId = member.id;
      person.matchStatus = MATCH_STATUS.MATCHED_MEMBER;
    }

    await tx.lumaGuest.update({
      where: { lumaGuestId },
      data: {
        candidateId: person.candidateId ?? null,
        userId: person.userId ?? null,
        matchStatus: person.matchStatus,
        // Cleared, not appended to: the note is the "still needs a look" marker,
        // and a person has now looked. Provenance goes to the log below, since
        // nothing reads a note except the panel this link removes them from.
        matchNote: null
      }
    });

    const effects = await reconcileRows(
      tx,
      previous.eventId,
      { lumaGuestId, approvalStatus: previous.approvalStatus, checkedInAt: previous.checkedInAt },
      person,
      previous
    );

    console.log(
      `[luma] guest ${lumaGuestId} on event ${previous.eventId} linked by hand to `
      + `${person.candidateId ? `candidate ${person.candidateId}` : person.userId ? `member ${person.userId}` : 'nobody'}`
      + ` by ${actorId || 'an admin'}`
    );

    return {
      lumaGuestId,
      eventId: previous.eventId,
      candidateId: person.candidateId ?? null,
      userId: person.userId ?? null,
      matchStatus: person.matchStatus,
      effects
    };
  });
}

export default linkLumaGuest;
