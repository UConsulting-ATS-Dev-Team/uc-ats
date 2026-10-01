#!/usr/bin/env node
// Evens out review-team sizes in one cycle by moving applicants nobody has
// scored yet. Anyone with a resume, cover letter or video score in the cycle
// stays on their team. Applicants on no team are placed in the same pass.
//
//   cd server && node scripts/rebalance-review-teams.js "Fall 2026"           # dry run: prints the plan
//   cd server && node scripts/rebalance-review-teams.js "Fall 2026" --apply   # moves them
//
// --apply writes every move to rebalance-<cycle>-<time>.json first, so a run
// can be undone by hand. Re-runnable: a balanced cycle plans no moves.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

const { default: prisma } = await import('../src/prismaClient.js');
const { planRebalance } = await import('../src/services/reviewTeamDistribution.js');

const apply = process.argv.includes('--apply');
const cycleName = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

// A score counts if it belongs to this cycle, or has no cycle at all (legacy
// rows) and was written during it.
function scoredInCycle(cycle) {
  const where = {
    OR: [
      { cycleId: cycle.id },
      { cycleId: null, createdAt: { gte: cycle.startDate ?? cycle.createdAt } }
    ]
  };
  return Promise.all([
    prisma.resumeScore.findMany({ where, select: { candidateId: true } }),
    prisma.coverLetterScore.findMany({ where, select: { candidateId: true } }),
    prisma.videoScore.findMany({ where, select: { candidateId: true } })
  ]).then((lists) => new Set(lists.flat().map((row) => row.candidateId)));
}

async function main() {
  if (!cycleName) throw new Error('Usage: node scripts/rebalance-review-teams.js "<cycle name>" [--apply]');

  const cycle = await prisma.recruitingCycle.findFirst({ where: { name: cycleName } });
  if (!cycle) throw new Error(`No recruiting cycle named "${cycleName}"`);

  const teams = await prisma.groups.findMany({
    where: { cycleId: cycle.id },
    select: { id: true, name: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  });
  if (teams.length === 0) throw new Error(`"${cycleName}" has no review teams`);
  const teamIds = new Set(teams.map((team) => team.id));

  const candidates = await prisma.candidate.findMany({
    where: { applications: { some: { cycleId: cycle.id } } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      assignedGroupId: true,
      applications: {
        where: { cycleId: cycle.id },
        orderBy: { submittedAt: 'desc' },
        take: 1,
        select: { submittedAt: true }
      }
    }
  });
  const scored = await scoredInCycle(cycle);

  // Oldest application first, so the most recent are the ones that move.
  candidates.sort((a, b) => a.applications[0].submittedAt - b.applications[0].submittedAt);

  const byTeam = new Map(teams.map((team) => [team.id, { id: team.id, scored: 0, unscored: [] }]));
  const unassigned = [];
  for (const candidate of candidates) {
    const team = teamIds.has(candidate.assignedGroupId) ? byTeam.get(candidate.assignedGroupId) : null;
    if (!team) unassigned.push(candidate.id);
    else if (scored.has(candidate.id)) team.scored += 1;
    else team.unscored.push(candidate.id);
  }

  const { moves, targets } = planRebalance([...byTeam.values()], unassigned);

  const nameOf = new Map(candidates.map((c) => [c.id, `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim()]));
  // Where each applicant actually is now: "no team" in the plan can also mean
  // a team from an older cycle.
  const currentGroupOf = new Map(candidates.map((c) => [c.id, c.assignedGroupId]));
  const teamName = new Map(teams.map((team) => [team.id, team.name]));

  console.log(`\n${cycle.name}: ${candidates.length} applicants, ${teams.length} teams, ${unassigned.length} on no team\n`);
  console.table(teams.map((team) => {
    const t = byTeam.get(team.id);
    return {
      team: team.name,
      now: t.scored + t.unscored.length,
      scored: t.scored,
      unscored: t.unscored.length,
      after: targets.get(team.id)
    };
  }));

  if (moves.length === 0) {
    console.log('Already balanced. Nothing to move.');
    return;
  }

  console.log(`\n${moves.length} moves:`);
  for (const move of moves) {
    console.log(`  ${nameOf.get(move.candidateId) || move.candidateId}: ${move.from ? teamName.get(move.from) : '(no team)'} -> ${teamName.get(move.to)}`);
  }

  if (!apply) {
    console.log('\nDry run. Nothing changed. Re-run with --apply to move them.');
    return;
  }

  const logPath = join(process.cwd(), `rebalance-${cycle.name.replace(/\W+/g, '-')}-${Date.now()}.json`);
  const record = moves.map((move) => ({ ...move, previousGroupId: currentGroupOf.get(move.candidateId) }));
  writeFileSync(logPath, JSON.stringify({ cycle: { id: cycle.id, name: cycle.name }, moves: record }, null, 2));
  console.log(`\nMoves written to ${logPath}`);

  // Each move is conditional on the applicant still being where the plan saw
  // them and still unscored, so a grade saved mid-run is never orphaned.
  let moved = 0;
  const skipped = [];
  for (const move of moves) {
    const result = await prisma.candidate.updateMany({
      where: {
        id: move.candidateId,
        assignedGroupId: currentGroupOf.get(move.candidateId),
        resumeScores: { none: { OR: [{ cycleId: cycle.id }, { cycleId: null }] } },
        coverLetterScores: { none: { OR: [{ cycleId: cycle.id }, { cycleId: null }] } },
        videoScores: { none: { OR: [{ cycleId: cycle.id }, { cycleId: null }] } }
      },
      data: { assignedGroupId: move.to }
    });
    if (result.count === 1) moved += 1;
    else skipped.push(move);
  }

  console.log(`Moved ${moved} of ${moves.length}.`);
  for (const move of skipped) {
    console.log(`  Skipped ${nameOf.get(move.candidateId) || move.candidateId}: scored or moved since the plan was made`);
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
