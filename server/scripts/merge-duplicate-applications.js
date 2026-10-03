#!/usr/bin/env node
// One-time cleanup: fold every candidate's duplicate applications in a cycle
// into one.
//
//   cd server && node scripts/merge-duplicate-applications.js                 # dry run, candidate cycle
//   cd server && node scripts/merge-duplicate-applications.js --cycle=<id>    # dry run, that cycle
//   cd server && node scripts/merge-duplicate-applications.js --apply         # merge
//
// Before form sync folded resubmissions (applicationResubmissions.js), someone
// who submitted twice in a cycle got two Application rows, and their review
// split across the two. This keeps the oldest row, moves every decision,
// comment, evaluation and signup onto it, and deletes the rest. The answers it
// keeps are the ones reviewers saw: a reviewed row's, else the version graded
// first, else the latest submission (chooseContent in the service). The dry run
// says which rule decided for each person.
//
// Only the one cycle is touched. A group is skipped whole, and listed at the
// end, when merging it would mean choosing between two things people wrote, or
// might fold in somebody else: different decisions for one round, the same
// evaluator on both rows of one interview, a client assigned a resume that
// would change, a row submitted under another candidate's address, or a sealed
// candidate.
//
// The dry run reads only. --apply refuses to start until the migration is in and every
// table holding an application id is one this script knows how to move.
//
// Re-runnable: once merged, a cycle has no groups left to find.
//
// The rules live in src/services/applicationResubmissions.js. This file is the
// command line around them: arguments, printing, and one transaction per group.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

// Imported after .env is loaded: config.js throws without JWT_SECRET, and the
// Prisma client reads DATABASE_URL when it is constructed.
const { default: prisma } = await import('../src/prismaClient.js');
const { resolveCandidateCycle } = await import('../src/services/activeCycle.js');
const {
  APPLICATION_DEPENDENTS,
  APPLICATION_ID_ARRAYS,
  ApplicationMergeConflict,
  DECISION_FIELDS,
  contentRuleLabel,
  findDuplicateApplicationGroups,
  mergeDuplicateApplications
} = await import('../src/services/applicationResubmissions.js');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const cycleOption = args.find((a) => a.startsWith('--cycle='))?.split('=').slice(1).join('=');

const SHORT_DECISION = { resumeDecision: 'resume', coffeeChatDecision: 'coffee', firstRoundDecision: 'first', finalRoundDecision: 'final' };

const fmtDate = (value) => (value ? new Date(value).toISOString().replace('T', ' ').slice(0, 16) : '-');
const decisionsOf = (app) => DECISION_FIELDS
  .filter((field) => app[field])
  .map((field) => `${SHORT_DECISION[field]}=${app[field]}`)
  .join(' ') || 'none';

/**
 * Why --apply must not start, or null. Fails closed: a database this script
 * cannot fully see is one it could damage.
 */
async function preflight() {
  const problems = [];

  const [{ present }] = await prisma.$queryRaw`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'applications' AND column_name = 'supersededResponseIds'
    ) AS present`;
  if (!present) {
    problems.push('applications.supersededResponseIds does not exist. Apply migration 20261003120000_application_superseded_response_ids first.');
  }

  // Any column that looks like it holds an application id, not only ones
  // named exactly applicationId: currentApplicationId is one too.
  const columns = await prisma.$queryRaw`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name <> 'applications'
      AND column_name ILIKE '%applicationid%'`;
  const known = new Set([...APPLICATION_DEPENDENTS, ...APPLICATION_ID_ARRAYS].map((d) => `${d.table}.${d.column}`));
  const unknown = columns.map((c) => `${c.table_name}.${c.column_name}`).filter((key) => !known.has(key));
  if (unknown.length) {
    problems.push(
      `These columns hold application ids and the merge does not know how to move them: ${unknown.join(', ')}. `
      + 'Add them to APPLICATION_DEPENDENTS in src/services/applicationResubmissions.js before merging; '
      + 'otherwise their rows would be orphaned or cascade-deleted.'
    );
  }

  return problems;
}

function printGroup(group, index) {
  const { candidate, applications, dependents, plan } = group;
  const name = [candidate?.firstName, candidate?.lastName].filter(Boolean).join(' ') || '(no name)';
  console.log(`${index + 1}. ${name} <${candidate?.email || '-'}>  candidate ${group.candidateId}${candidate?.recordsLockedAt ? '  [sealed]' : ''}`);

  for (const app of applications) {
    const role = app.id === plan.survivorId ? 'survives' : 'merged in';
    const content = app.id === plan.contentFrom ? ', answers kept' : '';
    console.log(`   ${app.id}  submitted ${fmtDate(app.submittedAt)}  response ${app.responseID}  (${role}${content})`);
    console.log(`      status ${app.status}, round ${app.currentRound ?? '-'}, approved ${app.approved ?? '-'}, decisions: ${decisionsOf(app)}`);
    const held = Object.entries(dependents)
      .map(([table, byApp]) => [table, byApp[app.id] || 0])
      .filter(([, n]) => n > 0)
      .map(([table, n]) => `${table} ${n}`);
    console.log(`      rows pointing at it: ${held.join(', ') || 'none'}`);
  }

  console.log(`   answers kept: ${plan.contentFrom}'s, ${contentRuleLabel(plan.contentRule)}`
    + `${group.firstScoreAt ? ` (first document score ${fmtDate(group.firstScoreAt)})` : ''}`);
  if (plan.conflicts.length) {
    console.log('   -> skip:');
    for (const conflict of plan.conflicts) console.log(`      ${conflict.code}: ${conflict.message}`);
  } else {
    const fromLosers = DECISION_FIELDS
      .filter((field) => plan.review[field].from && plan.review[field].from !== plan.survivorId)
      .map((field) => `${SHORT_DECISION[field]}=${plan.review[field].value} (from ${plan.review[field].from})`);
    console.log(`   -> merge into ${plan.survivorId}${fromLosers.length ? `; decisions carried over: ${fromLosers.join(', ')}` : ''}`);
  }
  console.log('');
}

async function main() {
  const cycle = cycleOption
    ? await prisma.recruitingCycle.findUnique({ where: { id: cycleOption }, select: { id: true, name: true } })
    : await resolveCandidateCycle(prisma);
  if (!cycle) {
    console.error(cycleOption ? `No recruiting cycle with id ${cycleOption}.` : 'No active candidate cycle. Pass --cycle=<id>.');
    process.exitCode = 1;
    return;
  }

  console.log(`Cycle: ${cycle.name} (${cycle.id})`);
  console.log(apply ? 'Mode: APPLY' : 'Mode: dry run (nothing is written; re-run with --apply to merge)');
  console.log('');

  if (apply) {
    const problems = await preflight();
    if (problems.length) {
      console.error('Refusing to merge:');
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }
  }

  const groups = await findDuplicateApplicationGroups(prisma, { cycleId: cycle.id });
  if (!groups.length) {
    console.log('No candidate has more than one application in this cycle. Nothing to do.');
    return;
  }

  groups.forEach(printGroup);

  const mergeable = groups.filter((group) => !group.plan.conflicts.length);
  const skipped = groups
    .filter((group) => group.plan.conflicts.length)
    .map((group) => ({ group, reason: group.plan.conflicts.map((c) => `${c.code}: ${c.message}`).join('; ') }));

  if (!apply) {
    console.log(`Totals: ${groups.length} candidate(s) with duplicates, `
      + `${groups.reduce((n, g) => n + g.applications.length, 0)} application(s); `
      + `${mergeable.length} would merge, ${skipped.length} would be skipped.`);
    console.log('\nDry run - nothing changed. Re-run with --apply to merge.');
    return;
  }

  const merged = [];
  for (const group of mergeable) {
    const { survivorId, loserIds } = group.plan;
    try {
      // One transaction per person, so a conflict found mid-merge leaves that
      // person exactly as they were and does not stop the rest.
      const summary = await prisma.$transaction(
        (tx) => mergeDuplicateApplications(tx, { survivorId, loserIds }),
        { maxWait: 10 * 1000, timeout: 60 * 1000 }
      );
      merged.push({ group, summary });
      const moved = Object.entries(summary.moved).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`).join(', ') || 'no rows';
      console.log(`Merged ${loserIds.join(', ')} into ${survivorId} (answers from ${summary.contentFrom}, ${contentRuleLabel(summary.contentRule)}); moved ${moved}.`);
    } catch (error) {
      if (!(error instanceof ApplicationMergeConflict)) {
        console.error(`Failed on candidate ${group.candidateId}:`, error);
      }
      skipped.push({ group, reason: error instanceof ApplicationMergeConflict ? `${error.code}: ${error.message}` : `error: ${error.message}` });
    }
  }

  console.log('');
  console.log(`Merged ${merged.length} of ${groups.length} candidate(s).`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length}, left exactly as they were:`);
    for (const { group, reason } of skipped) {
      const name = [group.candidate?.firstName, group.candidate?.lastName].filter(Boolean).join(' ');
      console.log(`  ${name} <${group.candidate?.email || '-'}> (${group.applications.map((a) => a.id).join(', ')}): ${reason}`);
    }
  }
  if (!merged.length) {
    // Groups exist and none merged: that is a problem to look at, not a
    // clean run.
    console.error('\nNothing was merged.');
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
