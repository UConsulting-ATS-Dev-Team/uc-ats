#!/usr/bin/env node
//
// Turn each interview's JSON applicationGroups into real slots and signups.
//
//   node scripts/backfill-interview-slots.js --dry-run          # print the plan
//   node scripts/backfill-interview-slots.js                    # apply it
//   node scripts/backfill-interview-slots.js --cycle <cycleId>  # one cycle only
//   node scripts/backfill-interview-slots.js --types ALL        # include final round
//
// Only COFFEE_CHAT and ROUND_ONE by default - the rounds this feature actually
// schedules. Final round groups are one candidate each (they are named after the
// candidate), deliberations have no roster, and neither has been exercised
// against slots. They keep reading the JSON blob, which the roster service still
// handles, until somebody migrates them deliberately.
//
// Idempotent twice over: @@unique([interviewId, legacyGroupId]) means a group
// becomes at most one slot however many times this runs, and the partial unique
// index on confirmed signups means a candidate lands in at most one seat.
//
// Rollback:
//   DELETE FROM interview_slot_signups WHERE "placedById" = 'BACKFILL';
//   DELETE FROM interview_slots WHERE "legacyGroupId" IS NOT NULL;
//
// The blob is left exactly as it is. Nothing here deletes a group, and
// getRosterForInterview keeps answering from slots once they exist - so a bad
// run is undone by the two statements above and nothing is lost.

import prisma from '../src/prismaClient.js';
import { parseLegacyConfig } from '../src/services/interviewRoster.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const cycleId = args[args.indexOf('--cycle') + 1] ?? null;
const onlyCycle = args.includes('--cycle') ? cycleId : null;

const DEFAULT_TYPES = ['COFFEE_CHAT', 'ROUND_ONE'];
const typesArg = args.includes('--types') ? args[args.indexOf('--types') + 1] : null;
const interviewTypes =
  typesArg && typesArg.toUpperCase() === 'ALL'
    ? null
    : (typesArg ? typesArg.split(',').map((t) => t.trim().toUpperCase()) : DEFAULT_TYPES);

const log = (...parts) => console.log(...parts);

async function main() {
  const interviews = await prisma.interview.findMany({
    where: {
      ...(onlyCycle ? { cycleId: onlyCycle } : {}),
      ...(interviewTypes ? { interviewType: { in: interviewTypes } } : {}),
    },
    select: {
      id: true,
      title: true,
      interviewType: true,
      description: true,
      startDate: true,
      endDate: true,
      createdAt: true,
      cycleId: true,
      slots: { select: { id: true, legacyGroupId: true } },
    },
    orderBy: { startDate: 'asc' },
  });

  let slotsPlanned = 0;
  let signupsPlanned = 0;
  let assignmentsPlanned = 0;
  let skipped = 0;

  for (const interview of interviews) {
    const config = parseLegacyConfig(interview);
    const groups = config.applicationGroups ?? [];
    if (groups.length === 0) {
      skipped += 1;
      continue;
    }

    const already = new Set(interview.slots.map((slot) => slot.legacyGroupId).filter(Boolean));

    // memberGroupId -> [applicationGroupId], inverted so a slot can find the
    // interviewers that were pointed at it.
    const membersByGroup = new Map();
    for (const [memberGroupId, appGroupIds] of Object.entries(config.groupAssignments ?? {})) {
      const memberGroup = (config.memberGroups ?? []).find((g) => g.id === memberGroupId);
      if (!memberGroup) continue;
      for (const appGroupId of appGroupIds ?? []) {
        const existing = membersByGroup.get(appGroupId) ?? [];
        membersByGroup.set(appGroupId, [...existing, ...(memberGroup.memberIds ?? [])]);
      }
    }

    for (const group of groups) {
      if (already.has(group.id)) {
        log(`  = ${interview.title}: group ${group.id} already backfilled`);
        continue;
      }

      const applicationIds = [...new Set(group.applicationIds ?? [])];
      const memberIds = [...new Set(membersByGroup.get(group.id) ?? [])];

      log(
        `  + ${interview.title} [${interview.interviewType}] "${group.name ?? 'Session'}" ` +
          `-> ${applicationIds.length} candidate(s), ${memberIds.length} interviewer(s)`
      );
      slotsPlanned += 1;
      signupsPlanned += applicationIds.length;
      assignmentsPlanned += memberIds.length;

      if (dryRun) continue;

      await prisma.$transaction(async (tx) => {
        const slot = await tx.interviewSlot.create({
          data: {
            interviewId: interview.id,
            legacyGroupId: group.id,
            label: group.name || 'Session',
            notes: group.notes || null,
            // The interview's own window: a group had no time of its own, which
            // is precisely the gap slots exist to close. An admin re-times these
            // in the roster view afterwards.
            startTime: interview.startDate,
            endTime: interview.endDate,
            // Not opened to self-signup. These are historical rosters, and
            // making a past interview bookable would be an odd surprise.
            candidateCapacity: null,
          },
        });

        for (const applicationId of applicationIds) {
          // Skip anyone already holding a confirmed seat in this interview - the
          // partial unique index would reject it, and a group that listed the
          // same person twice is a blob artefact rather than an intent.
          const existing = await tx.interviewSlotSignup.findFirst({
            where: { interviewId: interview.id, applicationId, status: 'CONFIRMED' },
            select: { id: true },
          });
          if (existing) continue;

          await tx.interviewSlotSignup.create({
            data: {
              slotId: slot.id,
              interviewId: interview.id,
              applicationId,
              status: 'CONFIRMED',
              signedUpAt: interview.createdAt,
              placedById: 'BACKFILL',
            },
          });
        }

        for (const userId of memberIds) {
          await tx.interviewSlotAssignment.create({
            data: { slotId: slot.id, interviewId: interview.id, userId },
          });
        }
      });
    }
  }

  log('');
  log(dryRun ? '--- DRY RUN, nothing written ---' : '--- applied ---');
  log(`interview types    : ${interviewTypes ? interviewTypes.join(', ') : 'ALL'}`);
  log(`interviews scanned : ${interviews.length}`);
  log(`without groups     : ${skipped}`);
  log(`slots              : ${slotsPlanned}`);
  log(`signups            : ${signupsPlanned}`);
  log(`assignments        : ${assignmentsPlanned}`);
}

main()
  .catch((error) => {
    console.error('[backfill-interview-slots] failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
