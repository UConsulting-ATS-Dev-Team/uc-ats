// Who owns an application, and who is staff.
//
// Applications arrive from the Google Form before the applicant has an account,
// so there is no foreign key from Application to User to lean on. Ownership is
// therefore matched on the two identifiers the form collects: student ID and
// email, either directly on the Application row or on the Candidate it was
// linked to during sync.
//
// This lives here rather than in a route because more than one candidate
// self-service endpoint depends on it (resume replacement, applicant info), and
// the whole point is that they agree on the answer.

export function isOwnedBy(application, user) {
  if (!user) return false;

  const emails = [application.email, application.candidate?.email]
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  if (user.email && emails.includes(user.email.toLowerCase())) return true;

  const studentIds = [application.studentId, application.candidate?.studentId]
    .filter(Boolean)
    .map(String);
  if (user.studentId && studentIds.includes(String(user.studentId))) return true;

  return false;
}

export const isStaff = (user) => user?.role === 'ADMIN' || user?.role === 'MEMBER';

/**
 * The `where` clause matching everything this user owns.
 *
 * Student ID first and email second, the same identifiers - and the same order -
 * the Forms sync matches on in utils/dataMapper.js. A student who applied with a
 * personal address and signed up with their UCLA one is the same person, and the
 * student ID is what says so.
 *
 * Returns null when the account carries neither identifier, which is not the same
 * as "owns nothing": an empty OR matches every row, so callers must treat null as
 * "do not query" rather than passing it through.
 */
export function ownApplicationWhere(user) {
  const or = [];
  if (user?.studentId) or.push({ studentId: String(user.studentId) });
  if (user?.email) or.push({ email: user.email });
  return or.length ? { OR: or } : null;
}

export class AmbiguousApplicationError extends Error {
  constructor(count) {
    super('More than one application matches this account');
    this.name = 'AmbiguousApplicationError';
    this.status = 409;
    this.count = count;
  }
}

/**
 * This user's application in one cycle, for candidate self-service.
 *
 * Throws AmbiguousApplicationError when more than one matches, and that is the
 * point. Signup creates its own Candidate row, so an applicant who signed up with
 * a different address than they applied with ends up with two candidate rows and
 * can match twice (the bug documented in routes/candidateOnboarding.js). Picking
 * the first would book an interview slot against the wrong application, silently,
 * and nobody would find out until the candidate arrived and was not on the list.
 * A 409 telling them to contact recruitment is a far better failure.
 */
export async function findOwnApplication(client, user, cycleId) {
  const owned = ownApplicationWhere(user);
  if (!owned) return null;

  const applications = await client.application.findMany({
    where: { ...owned, ...(cycleId ? { cycleId } : {}) },
    // email and name come along because callers that book something also have
    // to tell the candidate about it. Leaving them out produced a booking that
    // succeeded and then failed while queueing its own confirmation.
    select: {
      id: true,
      cycleId: true,
      currentRound: true,
      status: true,
      candidateId: true,
      email: true,
      firstName: true,
      lastName: true
    },
    take: 2
  });

  if (applications.length === 0) return null;
  if (applications.length > 1) throw new AmbiguousApplicationError(applications.length);
  return applications[0];
}
