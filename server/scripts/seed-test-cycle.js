#!/usr/bin/env node
//
// Simulate a whole recruiting cycle so interview scheduling can be exercised
// against something that looks like the real thing.
//
//   node scripts/seed-test-cycle.js --dry-run       # show the plan
//   node scripts/seed-test-cycle.js                 # seed it
//   node scripts/seed-test-cycle.js --size 300      # bigger
//   node scripts/seed-test-cycle.js --clear-interviews   # keep people, drop interviews
//   node scripts/seed-test-cycle.js --wipe          # remove everything it made
//
// Defaults to the cycle named "Devin Test Cycle"; pass --cycle "<name>" for
// another. It refuses to touch a cycle holding applications it did not create,
// so it cannot be pointed at Winter 2026 by accident.
//
// Everything it writes is marked and reversible:
//   applications  responseID starts with SIM-
//   users         email ends @ucla.simulated.test
//
// That domain is deliberately non-routable. Scheduling email is off by default,
// but if somebody turns it on while test candidates exist, nothing can reach a
// real person.
//
// The states are seeded on purpose, not left to chance. A cycle where everyone
// simply has a seat proves nothing, so this produces full sessions, waitlisted
// candidates holding a fallback seat, candidates who could not be placed at
// all, and candidates nobody has scheduled yet - every branch the UI has to
// render, present on first load.
//
// Deliberately NOT done here: making the cycle candidate-active. That decides
// which cycle real candidates see when they sign in. Use activate-cycle.js.

import bcrypt from 'bcryptjs';
import prisma from '../src/prismaClient.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const wipe = args.includes('--wipe');
// Candidates are the expensive half to recreate and the boring half to look at.
// Clearing only the interviews leaves a cycle full of people waiting to be
// scheduled, which is the state you want in order to build the sessions
// yourself and watch what happens.
const clearInterviews = args.includes('--clear-interviews');
const cycleName = args.includes('--cycle') ? args[args.indexOf('--cycle') + 1] : 'Devin Test Cycle';
const size = args.includes('--size') ? Number(args[args.indexOf('--size') + 1]) : 180;

const MARKER = 'SIM-';
const EMAIL_DOMAIN = 'ucla.simulated.test';
const PASSWORD = 'TestCandidate123!';

const log = (...parts) => console.log(...parts);

const at = (daysFromNow, hour, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  // Pacific is UTC-7/-8; the app renders whatever is stored in Pacific anyway.
  d.setUTCHours(hour + 7, minute, 0, 0);
  return d;
};

const FIRST = [
  'Ada','Alan','Grace','Katherine','Mary','Dorothy','Barbara','Margaret','Radia','Shafi','Frances','Jean',
  'Karen','Maryam','Emmy','Sofia','Hedy','Annie','Rosalind','Chien-Shiung','Lise','Vera','Jane','Rachel',
  'Mae','Sally','Valentina','Marie','Irene','Gertrude','Esther','Ruth','Dorothy','Anna','Clara','Elena',
  'Priya','Wei','Hana','Yusuf','Omar','Diego','Mateo','Luca','Noah','Ethan','Kai','Idris','Amara','Zara',
];
const LAST = [
  'Lovelace','Turing','Hopper','Johnson','Jackson','Vaughan','Liskov','Hamilton','Perlman','Goldwasser',
  'Allen','Bartik','Uhlenbeck','Mirzakhani','Noether','Kovalevskaya','Lamarr','Easley','Franklin','Wu',
  'Meitner','Rubin','Goodall','Carson','Jemison','Ride','Tereshkova','Curie','Joliot','Elion','Lederberg',
  'Benerito','Chen','Okafor','Nguyen','Patel','Silva','Haddad','Rossi','Novak','Kim','Ahmed','Tanaka',
];
const MAJORS = [
  'Economics','Business Economics','Applied Mathematics','Computer Science','Political Science',
  'Psychology','Statistics and Data Science','Sociology','Global Studies','Mathematics of Computation',
  'Cognitive Science','Communication','Financial Actuarial Mathematics','Biology','Design Media Arts',
];
const YEARS = ['2027', '2028', '2029'];

/** Deterministic pseudo-random, so two runs of the same size look the same. */
function rng(seed) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

async function resolveCycle() {
  const cycle = await prisma.recruitingCycle.findFirst({ where: { name: cycleName } });
  if (!cycle) throw new Error(`No cycle named "${cycleName}". Create it in Cycle Management first.`);
  const foreign = await prisma.application.count({
    where: { cycleId: cycle.id, NOT: { responseID: { startsWith: MARKER } } },
  });
  if (foreign > 0) {
    throw new Error(`"${cycleName}" holds ${foreign} application(s) this script did not create. Refusing to touch it.`);
  }
  return cycle;
}

/** Every interview in the cycle and everything hanging off it. Candidates stay. */
async function removeInterviews(cycle) {
  const interviews = await prisma.interview.findMany({ where: { cycleId: cycle.id }, select: { id: true, title: true } });
  const interviewIds = interviews.map((i) => i.id);
  if (interviewIds.length === 0) {
    log('No interviews in this cycle.');
    return;
  }

  await prisma.interviewSlotNotification.deleteMany({ where: { slot: { interviewId: { in: interviewIds } } } });
  // heldSeatId points from one signup to another, so break the links first.
  await prisma.interviewSlotSignup.updateMany({
    where: { interviewId: { in: interviewIds } },
    data: { heldSeatId: null },
  });
  await prisma.interviewSlotSignup.deleteMany({ where: { interviewId: { in: interviewIds } } });
  await prisma.interviewSlotAssignment.deleteMany({ where: { interviewId: { in: interviewIds } } });
  await prisma.interviewSlot.deleteMany({ where: { interviewId: { in: interviewIds } } });
  await prisma.behavioralQuestion.deleteMany({ where: { interviewId: { in: interviewIds } } });
  await prisma.interviewEvaluation.deleteMany({ where: { interviewId: { in: interviewIds } } });
  await prisma.firstRoundInterviewEvaluation.deleteMany({ where: { interviewId: { in: interviewIds } } });
  await prisma.interviewActionItem.deleteMany({ where: { interviewId: { in: interviewIds } } });
  await prisma.interviewAssignment.deleteMany({ where: { interviewId: { in: interviewIds } } });
  await prisma.interview.deleteMany({ where: { id: { in: interviewIds } } });

  interviews.forEach((i) => log(`  - ${i.title}`));
  log(`Removed ${interviewIds.length} interview(s) and every session, signup and assignment on them.`);
}

async function removeEverything(cycle) {
  const apps = await prisma.application.findMany({
    where: { cycleId: cycle.id, responseID: { startsWith: MARKER } },
    select: { id: true },
  });
  const interviews = await prisma.interview.findMany({ where: { cycleId: cycle.id }, select: { id: true } });
  const interviewIds = interviews.map((i) => i.id);

  await prisma.interviewSlotNotification.deleteMany({ where: { slot: { interviewId: { in: interviewIds } } } });
  // heldSeatId is self-referential, so break the links before deleting rows.
  await prisma.interviewSlotSignup.updateMany({
    where: { interviewId: { in: interviewIds } },
    data: { heldSeatId: null },
  });
  await prisma.interviewSlotSignup.deleteMany({ where: { interviewId: { in: interviewIds } } });
  await prisma.interviewSlotAssignment.deleteMany({ where: { interviewId: { in: interviewIds } } });
  await prisma.interviewSlot.deleteMany({ where: { interviewId: { in: interviewIds } } });
  await prisma.behavioralQuestion.deleteMany({ where: { interviewId: { in: interviewIds } } });
  await prisma.interviewAssignment.deleteMany({ where: { interviewId: { in: interviewIds } } });
  await prisma.interview.deleteMany({ where: { id: { in: interviewIds } } });
  await prisma.application.deleteMany({ where: { id: { in: apps.map((a) => a.id) } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
  await prisma.candidate.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });

  log(`Removed ${apps.length} application(s), ${interviewIds.length} interview(s) and their sessions.`);
}

/** A pipeline shaped like a real one: a wide top, a narrow bottom. */
function buildPlan(total) {
  const random = rng(total * 7919);
  const shape = [
    { round: '1', status: 'REJECTED', share: 0.42 },
    { round: '2', status: 'UNDER_REVIEW', share: 0.26 },
    { round: '3', status: 'UNDER_REVIEW', share: 0.16 },
    { round: '4', status: 'UNDER_REVIEW', share: 0.09 },
    { round: '5', status: 'ACCEPTED', share: 0.07 },
  ];

  const people = [];
  let index = 0;
  for (const bucket of shape) {
    const count = Math.max(1, Math.round(total * bucket.share));
    for (let i = 0; i < count; i += 1) {
      const first = FIRST[Math.floor(random() * FIRST.length)];
      const last = LAST[Math.floor(random() * LAST.length)];
      people.push({
        index,
        firstName: first,
        lastName: last,
        round: bucket.round,
        status: bucket.status,
        major: MAJORS[Math.floor(random() * MAJORS.length)],
        year: YEARS[Math.floor(random() * YEARS.length)],
        gpa: (3.0 + random() * 1.0).toFixed(2),
      });
      index += 1;
    }
  }
  return people;
}

async function main() {
  const cycle = await resolveCycle();
  log(`Cycle: ${cycle.name}  (${cycle.id})\n`);

  if (clearInterviews) {
    const counts = await prisma.interview.count({ where: { cycleId: cycle.id } });
    const people = await prisma.application.count({
      where: { cycleId: cycle.id, responseID: { startsWith: MARKER } },
    });
    if (dryRun) {
      log(`DRY RUN: would remove ${counts} interview(s) and keep ${people} candidate(s).`);
      return;
    }
    await removeInterviews(cycle);
    log(`\n${people} candidate(s) left in place, waiting to be scheduled.`);
    log('Build the interviews yourself: Interviews → Manage interviews → New interview.');
    return;
  }

  if (wipe) {
    if (dryRun) {
      const n = await prisma.application.count({
        where: { cycleId: cycle.id, responseID: { startsWith: MARKER } },
      });
      log(`DRY RUN: would remove ${n} simulated application(s) and every interview in this cycle.`);
      return;
    }
    await removeEverything(cycle);
    return;
  }

  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
  if (!admin) throw new Error('No active admin user to own the interviews.');
  const staff = await prisma.user.findMany({
    where: { isActive: true, role: { in: ['MEMBER', 'ADMIN'] } },
    select: { id: true },
    take: 24,
  });

  const people = buildPlan(size);
  const coffeeCount = people.filter((p) => p.round === '2').length;
  const firstRoundCount = people.filter((p) => p.round === '3').length;

  // Capacity deliberately short of demand, so the waitlist and the overflow
  // path are populated on first load rather than needing to be provoked.
  const coffeeSeatsEach = Math.max(2, Math.floor(coffeeCount * 0.35));
  const firstRoundSessions = Math.max(2, Math.ceil((firstRoundCount * 0.8) / 4));

  log(`Candidates: ${people.length}`);
  for (const round of ['1', '2', '3', '4', '5']) {
    const n = people.filter((p) => p.round === round).length;
    if (n) log(`  round ${round}: ${n}`);
  }
  log(`\nInterviews`);
  log(`  Test Coffee Chats - Round 1   Morning Block, ${coffeeSeatsEach} seats`);
  log(`  Test Coffee Chats - Round 2   Afternoon Block, ${coffeeSeatsEach} seats`);
  log(`  Test First Round Interviews   ${firstRoundSessions} sessions of 4`);
  log(`\n${coffeeCount} coffee chat candidates for ${coffeeSeatsEach * 2} seats — the rest waitlist or overflow.`);
  log(`Logins: <first>.<last>NN@${EMAIL_DOMAIN}  password ${PASSWORD}`);

  if (dryRun) {
    log('\n--- DRY RUN, nothing written ---');
    return;
  }

  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const created = [];

  log('\nWriting candidates…');
  for (const person of people) {
    // Names repeat in a list this size, so the index keeps the address unique.
    const email = `${person.firstName}.${person.lastName}${person.index}@${EMAIL_DOMAIN}`.toLowerCase();
    const studentId = `90${String(person.index).padStart(6, '0')}`;

    const candidate = await prisma.candidate.upsert({
      where: { email },
      update: {},
      create: { email, firstName: person.firstName, lastName: person.lastName, studentId },
    });

    const application = await prisma.application.upsert({
      where: { responseID: `${MARKER}${cycle.id}-${person.index}` },
      update: { currentRound: person.round, status: person.status },
      create: {
        responseID: `${MARKER}${cycle.id}-${person.index}`,
        email,
        firstName: person.firstName,
        lastName: person.lastName,
        studentId,
        phoneNumber: '5555550100',
        graduationYear: person.year,
        isTransferStudent: false,
        cumulativeGpa: person.gpa,
        major1: person.major,
        isFirstGeneration: false,
        resumeUrl: 'https://example.invalid/resume.pdf',
        headshotUrl: 'https://example.invalid/headshot.jpg',
        rawResponses: { seeded: true },
        status: person.status,
        currentRound: person.round,
        cycleId: cycle.id,
        candidateId: candidate.id,
      },
    });

    // Logins only for the rounds that have something to look at.
    if (['2', '3'].includes(person.round)) {
      await prisma.user.upsert({
        where: { email },
        update: {},
        create: {
          email,
          password: passwordHash,
          fullName: `${person.firstName} ${person.lastName}`,
          role: 'USER',
          studentId,
          emailVerifiedAt: new Date(),
        },
      });
    }

    created.push({ ...person, applicationId: application.id, email });
  }

  log('Writing interviews and sessions…');
  const coffeeOne = await prisma.interview.create({
    data: {
      title: 'Test Coffee Chats - Round 1',
      interviewType: 'COFFEE_CHAT',
      startDate: at(4, 9),
      endDate: at(4, 11),
      location: 'Covel Commons',
      cycleId: cycle.id,
      createdBy: admin.id,
      slots: { create: [{ label: 'Morning Block', startTime: at(4, 9), endTime: at(4, 11), candidateCapacity: coffeeSeatsEach, interviewerCapacity: 4 }] },
    },
    include: { slots: true },
  });
  const coffeeTwo = await prisma.interview.create({
    data: {
      title: 'Test Coffee Chats - Round 2',
      interviewType: 'COFFEE_CHAT',
      startDate: at(4, 14),
      endDate: at(4, 16),
      location: 'Covel Commons',
      cycleId: cycle.id,
      createdBy: admin.id,
      slots: { create: [{ label: 'Afternoon Block', startTime: at(4, 14), endTime: at(4, 16), candidateCapacity: coffeeSeatsEach, interviewerCapacity: 4 }] },
    },
    include: { slots: true },
  });
  const firstRound = await prisma.interview.create({
    data: {
      title: 'Test First Round Interviews',
      interviewType: 'ROUND_ONE',
      startDate: at(6, 10),
      endDate: at(6, 10 + firstRoundSessions),
      location: 'Anderson 1234',
      cycleId: cycle.id,
      createdBy: admin.id,
      slots: {
        create: Array.from({ length: firstRoundSessions }, (_, i) => ({
          startTime: at(6, 10 + i),
          endTime: at(6, 11 + i),
          candidateCapacity: 4,
          interviewerCapacity: 2,
        })),
      },
    },
    include: { slots: { orderBy: { startTime: 'asc' } } },
  });

  const morning = coffeeOne.slots[0];
  const afternoon = coffeeTwo.slots[0];

  log('Booking candidates…');
  const coffeePeople = created.filter((p) => p.round === '2');
  let cursor = 0;
  const bookings = { confirmed: 0, waitlisted: 0, needsPlacement: 0, unscheduled: 0 };

  // Fill the morning.
  for (let i = 0; i < coffeeSeatsEach && cursor < coffeePeople.length; i += 1, cursor += 1) {
    await prisma.interviewSlotSignup.create({
      data: { slotId: morning.id, interviewId: coffeeOne.id, applicationId: coffeePeople[cursor].applicationId, status: 'CONFIRMED' },
    });
    bookings.confirmed += 1;
  }

  // Fill most of the afternoon, leaving a couple of seats so a promotion has
  // somewhere to land when the tester cancels someone.
  const afternoonFill = Math.max(0, coffeeSeatsEach - 2);
  const heldSeats = [];
  for (let i = 0; i < afternoonFill && cursor < coffeePeople.length; i += 1, cursor += 1) {
    const seat = await prisma.interviewSlotSignup.create({
      data: { slotId: afternoon.id, interviewId: coffeeTwo.id, applicationId: coffeePeople[cursor].applicationId, status: 'CONFIRMED' },
      select: { id: true, applicationId: true },
    });
    heldSeats.push(seat);
    bookings.confirmed += 1;
  }

  // Three of those afternoon people actually wanted the morning: waitlisted
  // there, still holding their afternoon seat. This is the state the gallery's
  // "holding a seat elsewhere" chip exists to explain.
  for (const seat of heldSeats.slice(0, 3)) {
    await prisma.interviewSlotSignup.create({
      data: {
        slotId: morning.id,
        interviewId: coffeeOne.id,
        applicationId: seat.applicationId,
        status: 'WAITLISTED',
        waitlistedAt: new Date(Date.now() - Math.random() * 86400000),
        heldSeatId: seat.id,
      },
    });
    bookings.waitlisted += 1;
  }

  // Two signed up when everything was full and could not be placed.
  for (let i = 0; i < 2 && cursor < coffeePeople.length; i += 1, cursor += 1) {
    await prisma.interviewSlotSignup.create({
      data: { slotId: morning.id, interviewId: coffeeOne.id, applicationId: coffeePeople[cursor].applicationId, status: 'NEEDS_PLACEMENT' },
    });
    bookings.needsPlacement += 1;
  }
  bookings.unscheduled += coffeePeople.length - cursor;

  // First round: fill most sessions, leave a few candidates unscheduled so the
  // "Not scheduled" tray has something in it.
  const firstRoundPeople = created.filter((p) => p.round === '3');
  let frCursor = 0;
  for (const slot of firstRound.slots) {
    for (let seat = 0; seat < 4 && frCursor < firstRoundPeople.length - 3; seat += 1, frCursor += 1) {
      await prisma.interviewSlotSignup.create({
        data: { slotId: slot.id, interviewId: firstRound.id, applicationId: firstRoundPeople[frCursor].applicationId, status: 'CONFIRMED' },
      });
      bookings.confirmed += 1;
    }
  }
  bookings.unscheduled += firstRoundPeople.length - frCursor;

  // Interviewers on sessions, so staffing coverage is visible too.
  let staffCursor = 0;
  for (const slot of [morning, afternoon, ...firstRound.slots]) {
    for (let i = 0; i < 2 && staff.length > 0; i += 1) {
      const user = staff[staffCursor % staff.length];
      staffCursor += 1;
      await prisma.interviewSlotAssignment
        .create({ data: { slotId: slot.id, interviewId: slot.interviewId, userId: user.id } })
        .catch(() => {});
    }
  }

  log('\n--- seeded ---');
  log(`candidates     : ${created.length}`);
  log(`interviews     : 3`);
  log(`sessions       : ${2 + firstRound.slots.length}`);
  log(`confirmed      : ${bookings.confirmed}`);
  log(`waitlisted     : ${bookings.waitlisted}   (holding an afternoon seat)`);
  log(`need placing   : ${bookings.needsPlacement}`);
  log(`not scheduled  : ${bookings.unscheduled}`);
  log(`\nSign in as a candidate who has a spot:`);
  log(`  ${coffeePeople[0]?.email}  /  ${PASSWORD}`);
  log(`Sign in as one nobody has scheduled:`);
  log(`  ${coffeePeople[coffeePeople.length - 1]?.email}  /  ${PASSWORD}`);
  log(`\nThis cycle is NOT the one candidates see. To switch it on:`);
  log(`  node scripts/activate-cycle.js "${cycle.name}"`);
  log(`To undo everything: node scripts/seed-test-cycle.js --wipe`);
}

main()
  .catch((error) => {
    console.error('[seed-test-cycle]', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
