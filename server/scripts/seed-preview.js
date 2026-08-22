#!/usr/bin/env node
/**
 * Seeds a staging/preview database with just enough to be clickable.
 *
 * Render creates preview databases empty, so without this a reviewer opening a
 * PR environment hits the login page with no account to log in with. Wired up
 * as `initialDeployHook` in render.yaml, so it runs once per environment.
 *
 * Safe to re-run by hand: every write is an upsert keyed on a stable field.
 *
 * Deliberately uses obviously-fake candidate data. Preview environments have no
 * Google credentials, so nothing real is ever synced into them.
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Matches the cost factor used by the auth routes.
const BCRYPT_ROUNDS = 12;

// Application.resumeUrl and .headshotUrl are non-nullable, but staging has no
// Google Drive credentials, so there is nothing real to point them at. Seeded
// rows carry a placeholder — document viewers will show a broken/empty file for
// these candidates, which is expected in a preview environment.
const PLACEHOLDER_FILE_URL = 'https://example.invalid/staging-placeholder';

const SAMPLE_CANDIDATES = [
  { firstName: 'Avery', lastName: 'Sample',   email: 'avery.sample@example.edu',   studentId: 'S0000001', major: 'Business Administration', gradYear: '2027', gpa: '3.72' },
  { firstName: 'Blake', lastName: 'Fixture',  email: 'blake.fixture@example.edu',  studentId: 'S0000002', major: 'Computer Science',        gradYear: '2026', gpa: '3.91' },
  { firstName: 'Casey', lastName: 'Mockdata', email: 'casey.mockdata@example.edu', studentId: 'S0000003', major: 'Economics',               gradYear: '2028', gpa: '3.45' },
  { firstName: 'Devon', lastName: 'Testcase', email: 'devon.testcase@example.edu', studentId: 'S0000004', major: 'Cognitive Science',       gradYear: '2027', gpa: '3.60' },
];

async function seedAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    console.warn(
      'SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD are unset — skipping admin creation.\n' +
      'Add them to the uc-ats-staging-secrets environment group, or reviewers ' +
      'will have no way to log in.'
    );
    return null;
  }

  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const admin = await prisma.user.upsert({
    where: { email },
    update: { password: hashedPassword, role: 'ADMIN' },
    create: {
      email,
      password: hashedPassword,
      fullName: 'Staging Admin',
      role: 'ADMIN',
      graduationClass: '2027',
    },
  });

  console.log(`Admin ready: ${admin.email}`);
  return admin;
}

async function seedCycle() {
  const name = 'Staging Cycle';

  const existing = await prisma.recruitingCycle.findFirst({ where: { name } });
  if (existing) {
    console.log('Recruiting cycle already present, reusing it.');
    return existing;
  }

  const now = new Date();
  const cycle = await prisma.recruitingCycle.create({
    data: {
      name,
      // Active so the app's cycle-scoped pages have something selected on load.
      // formUrl is left null on purpose: syncResponses.js skips the Google
      // Forms sync entirely when a cycle has no form URL, which is what keeps
      // real applicant data out of staging.
      isActive: true,
      startDate: now,
      endDate: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
    },
  });

  console.log(`Recruiting cycle created: ${cycle.name}`);
  return cycle;
}

async function seedCandidates(cycle) {
  let created = 0;

  for (const sample of SAMPLE_CANDIDATES) {
    const candidate = await prisma.candidate.upsert({
      where: { email: sample.email },
      update: {},
      create: {
        firstName: sample.firstName,
        lastName: sample.lastName,
        email: sample.email,
        studentId: sample.studentId,
      },
    });

    const hasApplication = await prisma.application.findFirst({
      where: { candidateId: candidate.id, cycleId: cycle.id },
    });
    if (hasApplication) continue;

    await prisma.application.create({
      data: {
        candidateId: candidate.id,
        cycleId: cycle.id,
        // responseID is the natural key the Forms sync dedupes on. Prefixing
        // seeded rows keeps them distinguishable from anything synced later.
        responseID: `seed-${sample.studentId}`,
        firstName: sample.firstName,
        lastName: sample.lastName,
        email: sample.email,
        studentId: sample.studentId,
        phoneNumber: '555-0100',
        major1: sample.major,
        graduationYear: sample.gradYear,
        cumulativeGpa: sample.gpa,
        isTransferStudent: false,
        isFirstGeneration: false,
        resumeUrl: PLACEHOLDER_FILE_URL,
        headshotUrl: PLACEHOLDER_FILE_URL,
        rawResponses: { seeded: true },
        status: 'SUBMITTED',
      },
    });
    created++;
  }

  console.log(`Sample applications created: ${created}`);
}

async function main() {
  console.log('Seeding staging environment...');

  await seedAdmin();
  const cycle = await seedCycle();
  await seedCandidates(cycle);

  console.log('Seed complete.');
}

main()
  .catch((error) => {
    // Fail loudly: a half-seeded environment is more confusing to a
    // non-technical reviewer than a deploy that clearly reports a problem.
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
