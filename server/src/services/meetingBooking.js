import { Prisma } from '@prisma/client';
import prisma from '../prismaClient.js';

export class MeetingBookingConflictError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function formatExistingSignupMessage(existingSignup, perCycle = false) {
  const date = new Date(existingSignup.slot.startTime).toLocaleDateString();
  const suffix = perCycle ? 'one meeting slot per cycle' : 'one meeting slot';
  return `You have already signed up for a meeting on ${date}. You can only sign up for ${suffix}.`;
}

function isSignupInCycle(signup, activeCycle) {
  if (!activeCycle || (!activeCycle.startDate && !activeCycle.endDate)) return true;
  const slotDate = new Date(signup.slot.startTime);
  const isAfterStart = !activeCycle.startDate || slotDate >= new Date(activeCycle.startDate);
  const isBeforeEnd = !activeCycle.endDate || slotDate <= new Date(activeCycle.endDate);
  return isAfterStart && isBeforeEnd;
}

export async function createMeetingSignup({ slotId, fullName, email, studentId, maxRetries = 3 }) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const activeCycle = await tx.recruitingCycle.findFirst({ where: { isActive: true } });

          if (activeCycle && (activeCycle.startDate || activeCycle.endDate)) {
            const existingSignups = await tx.meetingSignup.findMany({
              where: { email },
              include: { slot: true },
            });

            const existingSignupInCycle = existingSignups.find((signup) =>
              isSignupInCycle(signup, activeCycle)
            );

            if (existingSignupInCycle) {
              throw new MeetingBookingConflictError(formatExistingSignupMessage(existingSignupInCycle, true));
            }
          } else {
            const existingSignup = await tx.meetingSignup.findFirst({
              where: { email },
              include: { slot: true },
            });

            if (existingSignup) {
              throw new MeetingBookingConflictError(formatExistingSignupMessage(existingSignup, false));
            }
          }

          const slot = await tx.meetingSlot.findUnique({
            where: { id: slotId },
            include: {
              signups: true,
              member: { select: { fullName: true, email: true } },
            },
          });

          if (!slot) {
            throw new MeetingBookingConflictError('Slot not found', 404);
          }

          if (slot.signups.length >= slot.capacity) {
            throw new MeetingBookingConflictError('This time slot is full');
          }

          const signup = await tx.meetingSignup.create({
            data: { slotId, fullName, email, studentId },
          });

          return { signup, slot };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (error) {
      if (error?.code === 'P2034') {
        if (attempt === maxRetries - 1) throw error;
        continue;
      }
      throw error;
    }
  }

  throw new Error('createMeetingSignup exhausted retries');
}
