#!/usr/bin/env node
//
// Point the app at a different recruiting cycle.
//
//   node scripts/activate-cycle.js "Devin Test Cycle"            # both pointers
//   node scripts/activate-cycle.js "Devin Test Cycle" --admin    # admins only
//   node scripts/activate-cycle.js --status                      # who is active
//
// Separate from the seed script on purpose. Seeding writes rows nobody sees;
// this changes what every real candidate is shown the next time they sign in,
// which is a different kind of decision and should be made deliberately.
//
// Two pointers, because they are allowed to differ during a handover:
//   isActive       the cycle candidates, members and public pages see
//   isAdminActive  the cycle admin screens see
//
// Flipping only --admin lets the new cycle be set up and inspected while real
// candidates still see the old one. That is usually what you want first.
//
// At most one cycle may carry each flag, enforced by the partial unique indexes
// recruiting_cycles_single_active and recruiting_cycles_single_admin_active, so
// the clear and the set have to happen in one transaction.

import prisma from '../src/prismaClient.js';

const args = process.argv.slice(2);
const adminOnly = args.includes('--admin');
const statusOnly = args.includes('--status');
const name = args.find((arg) => !arg.startsWith('--'));

async function printStatus() {
  const cycles = await prisma.recruitingCycle.findMany({
    select: { name: true, isActive: true, isAdminActive: true, _count: { select: { applications: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log('\nCycle                     candidates see   admins see   applications');
  for (const cycle of cycles) {
    console.log(
      `${cycle.name.padEnd(26)}${(cycle.isActive ? 'yes' : '-').padEnd(17)}${(cycle.isAdminActive ? 'yes' : '-').padEnd(13)}${cycle._count.applications}`
    );
  }
  console.log('');
}

async function main() {
  if (statusOnly || !name) {
    await printStatus();
    if (!name && !statusOnly) {
      console.log('Pass a cycle name to activate one. Add --admin to move only the admin pointer.');
    }
    return;
  }

  const cycle = await prisma.recruitingCycle.findFirst({ where: { name } });
  if (!cycle) throw new Error(`No cycle named "${name}".`);

  const before = await prisma.recruitingCycle.findMany({
    where: { OR: [{ isActive: true }, { isAdminActive: true }] },
    select: { name: true, isActive: true, isAdminActive: true },
  });

  await prisma.$transaction(async (tx) => {
    // Clear before setting: the partial unique indexes reject a second row
    // carrying either flag, so these cannot overlap even for an instant.
    await tx.recruitingCycle.updateMany({
      where: { isAdminActive: true },
      data: { isAdminActive: false },
    });
    if (!adminOnly) {
      await tx.recruitingCycle.updateMany({ where: { isActive: true }, data: { isActive: false } });
    }
    await tx.recruitingCycle.update({
      where: { id: cycle.id },
      data: { isAdminActive: true, ...(adminOnly ? {} : { isActive: true }) },
    });
  });

  console.log(`\nWas:`);
  before.forEach((c) =>
    console.log(`  ${c.name} — candidates: ${c.isActive ? 'yes' : '-'}, admins: ${c.isAdminActive ? 'yes' : '-'}`)
  );
  console.log(`\nNow: ${cycle.name} is ${adminOnly ? 'the admin cycle' : 'the admin AND candidate cycle'}.`);
  if (adminOnly) {
    console.log('Real candidates still see the previous cycle.');
  } else {
    console.log('Every candidate signing in now sees this cycle.');
  }
  await printStatus();
}

main()
  .catch((error) => {
    console.error('[activate-cycle]', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
