// Read-only: what is actually available to assign right now, across all cycles?
import prisma from '../src/prismaClient.js';

const cycles = await prisma.recruitingCycle.findMany({
  select: { id: true, name: true, isActive: true, _count: { select: { applications: true } } },
  orderBy: { createdAt: 'desc' },
});

console.log('\n=== Cycles ===');
for (const c of cycles) {
  console.log(`  ${c.isActive ? '*' : ' '} ${c.name.padEnd(24)} ${c._count.applications} applications  ${c.id}`);
}

const optIn = await prisma.application.groupBy({
  by: ['cycleId', 'talentPoolOptIn'],
  _count: { _all: true },
});

const nameById = new Map(cycles.map((c) => [c.id, c.name]));

console.log('\n=== talentPoolOptIn by cycle ===');
for (const row of optIn) {
  const label = row.talentPoolOptIn === null ? 'never asked' : row.talentPoolOptIn ? 'YES' : 'no';
  console.log(`  ${(nameById.get(row.cycleId) || row.cycleId || 'no cycle').padEnd(24)} ${label.padEnd(12)} ${row._count._all}`);
}

const assignable = await prisma.application.count({
  where: { talentPoolOptIn: true, resumeUrl: { not: '' } },
});
const assignableBlind = await prisma.application.count({
  where: { talentPoolOptIn: true, resumeUrl: { not: '' }, blindResumeUrl: { not: null } },
});

console.log('\n=== Assignable across ALL cycles ===');
console.log(`  BASIC/FULL client: ${assignable}`);
console.log(`  BLIND client:      ${assignableBlind}`);

const years = await prisma.application.groupBy({
  by: ['graduationYear'],
  where: { talentPoolOptIn: true },
  _count: { _all: true },
});
const genders = await prisma.application.groupBy({
  by: ['gender'],
  where: { talentPoolOptIn: true },
  _count: { _all: true },
});

console.log('\n=== Filter values that will match (opted-in only) ===');
console.log('  graduationYear:', years.map((y) => `${y.graduationYear}(${y._count._all})`).join(' ') || 'none');
console.log('  gender:', genders.map((g) => `${g.gender}(${g._count._all})`).join(' ') || 'none');

await prisma.$disconnect();
