// Loads a member's GTKUC profile together with the active cycle's confirmation
// row. Lives outside the route files because both the member portal and the
// admin console open timeslots and must apply the same per-cycle gate.
import prisma from '../prismaClient.js';
import { needsCycleConfirmation } from './gtkucProfile.js';
import { resolveCandidateCycle } from '../services/activeCycle.js';

export const loadGtkucProfileState = async (userId) => {
  const [user, activeCycle] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, fullName: true, profileImage: true, graduationClass: true }
    }),
    // Candidate pointer even for admin callers: GTKUC is a candidate-facing
    // obligation, and MemberGtkucProfileConfirmation is unique per (profile, cycle),
    // so a confirmation written against the admin cycle would never clear the gate.
    resolveCandidateCycle(prisma)
  ]);

  const profile = await prisma.memberGtkucProfile.findUnique({
    where: { memberId: userId },
    include: { confirmations: true }
  });

  return {
    user,
    activeCycle,
    profile,
    confirmationRequired: needsCycleConfirmation({
      profile,
      user,
      activeCycleId: activeCycle?.id || null
    })
  };
};

export default loadGtkucProfileState;
