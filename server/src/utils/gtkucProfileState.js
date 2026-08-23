// Loads a member's GTKUC profile together with the active cycle's confirmation
// row. Lives outside the route files because both the member portal and the
// admin console open timeslots and must apply the same per-cycle gate.
import prisma from '../prismaClient.js';
import { needsCycleConfirmation } from './gtkucProfile.js';

export const loadGtkucProfileState = async (userId) => {
  const [user, activeCycle] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, fullName: true, profileImage: true, graduationClass: true }
    }),
    prisma.recruitingCycle.findFirst({ where: { isActive: true } })
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
