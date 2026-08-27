// Withdrawing someone from the Talent Partner Network when their account is
// deactivated.
//
// Deactivation is how this app records that a person has left: a member who
// graduated, an account that was removed. Until now it flipped isActive and
// nothing else, so their resume kept going out to recruiters — and for members
// it was still assignable to *new* clients, because the member pool gate never
// checked isActive the way the external pool does.
//
// Two things have to happen, and the gate alone is not enough for either:
//
//   1. No new assignments. That is the pool gate, fixed in talentPoolFilters.
//   2. No existing access. Assignments are snapshots and are never re-derived,
//      so a client who already holds the resume keeps it until it is revoked.
//      This is that revocation.
//
// Consent itself is deliberately left alone. shareConsent and talentPoolOptIn
// record what the person chose, and overwriting them would mean a reactivated
// account silently comes back opted out of something they had agreed to.
import prisma from '../prismaClient.js';

/**
 * Revoke every live client assignment belonging to these users.
 *
 * Covers all three pools, because a person can be in more than one: a member
 * who also applied is in the applicant pool through their application and in
 * the member pool through their uploaded resume.
 *
 * @param {string[]} userIds
 * @param {string} revokedById  the admin performing the deactivation
 * @returns {Promise<{ revoked: number }>}
 */
export async function revokeTalentPoolAccess(userIds, revokedById) {
  if (!Array.isArray(userIds) || userIds.length === 0) return { revoked: 0 };

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true, studentId: true },
  });
  if (users.length === 0) return { revoked: 0 };

  const [memberResumes, externalResumes] = await Promise.all([
    prisma.memberResume.findMany({ where: { memberId: { in: userIds } }, select: { id: true } }),
    prisma.externalResume.findMany({ where: { userId: { in: userIds } }, select: { id: true } }),
  ]);

  // Applications carry no foreign key to User - they arrive from the Google
  // Form before an account exists - so they are matched on the same two
  // identifiers ownership is matched on everywhere else.
  const identityFilters = [];
  for (const user of users) {
    if (user.email) {
      identityFilters.push({ email: user.email });
      identityFilters.push({ candidate: { email: user.email } });
    }
    if (user.studentId) {
      identityFilters.push({ studentId: String(user.studentId) });
      identityFilters.push({ candidate: { studentId: String(user.studentId) } });
    }
  }
  const applications = identityFilters.length
    ? await prisma.application.findMany({ where: { OR: identityFilters }, select: { id: true } })
    : [];

  const targets = [];
  if (memberResumes.length) targets.push({ memberResumeId: { in: memberResumes.map((r) => r.id) } });
  if (externalResumes.length) targets.push({ externalResumeId: { in: externalResumes.map((r) => r.id) } });
  if (applications.length) targets.push({ applicationId: { in: applications.map((a) => a.id) } });
  if (targets.length === 0) return { revoked: 0 };

  const { count } = await prisma.clientResumeAssignment.updateMany({
    where: { revokedAt: null, OR: targets },
    data: { revokedAt: new Date(), revokedById },
  });

  return { revoked: count };
}
