// Everyone Master Communications can reach, and what each audience rule
// matches among them.
//
// A person is one email address. The ATS holds addresses in several places -
// accounts, candidates and their applications, the imported mailing list,
// coffee chat signups, Luma guests - and one human can appear in all of them.
// They are merged here so a send reaches each person once.
//
// A candidate's addresses are merged into one person too: someone who applied
// twice with two addresses is one candidate, and emailing both would mail them
// twice. The address that represents them is their active account's if they
// have one (so staff are recognised as staff), otherwise their latest
// application's, otherwise the candidate record's.
//
// Nobody deactivated, and no Talent Partner Network client account, is ever in
// the universe - deactivation is how this app records that someone has left,
// and clients are companies, not students.
//
// Rules answer with sets of person keys; audienceFilters.js combines them.

import prisma from '../../prismaClient.js';
import { normalizeEmail } from '../../utils/mailingListImport.js';
import { getRound } from '../../utils/roundProgression.js';
import { evaluateAudienceTree, normalizeAudienceTree } from './audienceFilters.js';

const STAFF_ROLES = ['MEMBER', 'ADMIN'];
const EXCLUDED_ROLES = ['CLIENT'];
const LUMA_GOING = 'approved';
const FAILED_STATUSES = ['FAILED', 'BOUNCED'];

const toYear = (value) => {
  const match = /\b(19|20)\d{2}\b/.exec(String(value ?? ''));
  return match ? Number(match[0]) : null;
};

const byNewest = (field) => (a, b) => new Date(b[field]) - new Date(a[field]);

// Small union-find over addresses, for merging a candidate's addresses.
function makeAliases() {
  const parent = new Map();
  const find = (x) => {
    let root = x;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root);
    let cur = x;
    while (parent.has(cur) && parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  return {
    find,
    union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    },
    // Make `x` the representative of its group.
    promote(x) {
      const root = find(x);
      if (root === x) return;
      parent.set(root, x);
      parent.set(x, x);
    },
  };
}

/**
 * Read every source once and build the people. Returns a context that the rule
 * matchers query; nothing here is specific to one audience, so one context
 * answers a whole tree.
 */
export async function loadAudienceContext(client = prisma) {
  const [users, applications, candidates, contacts, signups, lumaGuests, externalResumes, memberResumes, cycles] =
    await Promise.all([
      client.user.findMany({
        select: {
          id: true, email: true, fullName: true, role: true, isActive: true, createdAt: true,
          isExternalTalent: true, emailVerifiedAt: true, graduationClass: true, phoneNumber: true,
        },
      }),
      client.application.findMany({
        select: {
          id: true, email: true, firstName: true, lastName: true, phoneNumber: true, submittedAt: true,
          cycleId: true, candidateId: true, status: true, graduationYear: true, major1: true, major2: true,
          isTransferStudent: true, isFirstGeneration: true, talentPoolOptIn: true, currentRound: true,
          approved: true, resumeDecision: true, coffeeChatDecision: true, firstRoundDecision: true,
          finalRoundDecision: true,
        },
      }),
      client.candidate.findMany({
        select: {
          id: true, email: true, firstName: true, lastName: true,
          onboarding: {
            select: {
              graduationYear: true, major1: true, major2: true, isTransferStudent: true,
              isFirstGeneration: true, phoneNumber: true,
            },
          },
        },
      }),
      client.mailingListContact.findMany({
        select: { id: true, email: true, firstName: true, lastName: true, sourceFile: true },
      }),
      client.meetingSignup.findMany({ select: { email: true, fullName: true, attended: true } }),
      client.lumaGuest.findMany({
        select: { email: true, name: true, firstName: true, lastName: true, eventId: true, approvalStatus: true, checkedInAt: true },
      }),
      client.externalResume.findMany({
        where: { isCurrent: true },
        select: { userId: true, graduationYear: true, major1: true, major2: true, shareConsent: true, consentRevokedAt: true },
      }),
      client.memberResume.findMany({
        where: { isCurrent: true },
        select: { memberId: true, graduationYear: true, major1: true, major2: true, shareConsent: true, consentRevokedAt: true },
      }),
      client.recruitingCycle.findMany({ select: { id: true, isActive: true } }),
    ]);

  // 1. Merge a candidate's addresses into one group.
  const aliases = makeAliases();
  const appsByCandidate = new Map();
  for (const a of applications) {
    if (!a.candidateId) continue;
    if (!appsByCandidate.has(a.candidateId)) appsByCandidate.set(a.candidateId, []);
    appsByCandidate.get(a.candidateId).push(a);
  }
  const activeUserEmails = new Set(
    users.filter((u) => u.isActive && !EXCLUDED_ROLES.includes(u.role)).map((u) => normalizeEmail(u.email))
  );
  for (const c of candidates) {
    const addresses = [c.email, ...(appsByCandidate.get(c.id) || []).map((a) => a.email)]
      .map(normalizeEmail)
      .filter(Boolean);
    if (addresses.length === 0) continue;
    for (const addr of addresses.slice(1)) aliases.union(addresses[0], addr);
    const latest = [...(appsByCandidate.get(c.id) || [])].sort(byNewest('submittedAt'))[0];
    const representative =
      addresses.find((addr) => activeUserEmails.has(addr)) || normalizeEmail(latest?.email) || addresses[0];
    aliases.promote(representative);
  }
  const keyOf = (email) => {
    const addr = normalizeEmail(email);
    return addr ? aliases.find(addr) : null;
  };

  // 2. Build the people.
  const people = new Map();
  const person = (email) => {
    const key = keyOf(email);
    if (!key) return null;
    if (!people.has(key)) {
      people.set(key, {
        key,
        email: key,
        sources: new Set(),
        users: [],
        applications: [],
        candidates: [],
        contact: null,
        signups: [],
        lumaGuests: [],
        resumes: [],
      });
    }
    return people.get(key);
  };

  const userKeys = new Map();
  for (const u of users) {
    const p = person(u.email);
    if (!p) continue;
    p.users.push(u);
    p.sources.add('account');
    userKeys.set(u.id, p.key);
  }
  for (const a of applications) {
    const p = person(a.email);
    if (!p) continue;
    p.applications.push(a);
    p.sources.add('applicant');
  }
  const candidateKeys = new Map();
  for (const c of candidates) {
    const p = person(c.email);
    if (!p) continue;
    p.candidates.push(c);
    candidateKeys.set(c.id, p.key);
  }
  for (const m of contacts) {
    const p = person(m.email);
    if (!p) continue;
    p.contact = m;
    p.sources.add('mailing-list');
  }
  for (const s of signups) {
    const p = person(s.email);
    if (!p) continue;
    p.signups.push(s);
    p.sources.add('meeting');
  }
  for (const g of lumaGuests) {
    const p = person(g.email);
    if (!p) continue;
    p.lumaGuests.push(g);
    p.sources.add('luma');
  }
  for (const r of externalResumes) {
    const key = userKeys.get(r.userId);
    if (key) people.get(key).resumes.push(r);
  }
  for (const r of memberResumes) {
    const key = userKeys.get(r.memberId);
    if (key) people.get(key).resumes.push(r);
  }

  // 3. Who may never be reached, and the attributes rules read.
  const universe = new Set();
  for (const p of people.values()) {
    p.applications.sort(byNewest('submittedAt'));
    const excluded = p.users.some((u) => !u.isActive || EXCLUDED_ROLES.includes(u.role));
    if (excluded) continue;
    p.user = p.users.find((u) => u.email && normalizeEmail(u.email) === p.key) || p.users[0] || null;
    p.isStaff = Boolean(p.user && STAFF_ROLES.includes(p.user.role));
    describePerson(p);
    universe.add(p.key);
  }

  return {
    client,
    people,
    universe,
    keyOf,
    userKeys,
    candidateKeys,
    cycles,
    activeCycleIds: new Set(cycles.filter((c) => c.isActive).map((c) => c.id)),
  };
}

// Name, grad year, majors and flags, each from the most trustworthy source that
// has one. The onboarding form is the newest thing a candidate told us; an
// application is next; a resume upload after that; the free-text graduation
// class on an account last.
function describePerson(p) {
  const latestApp = p.applications[0] || null;
  const candidate = p.candidates[0] || null;
  const onboarding = p.candidates.map((c) => c.onboarding).find(Boolean) || null;
  const luma = p.lumaGuests[0] || null;

  const nameParts =
    (latestApp && [latestApp.firstName, latestApp.lastName]) ||
    (candidate && [candidate.firstName, candidate.lastName]) ||
    (p.contact && (p.contact.firstName || p.contact.lastName) && [p.contact.firstName, p.contact.lastName]) ||
    null;
  const fullNameText =
    p.user?.fullName ||
    (nameParts && nameParts.filter(Boolean).join(' ')) ||
    p.signups[0]?.fullName ||
    luma?.name ||
    '';
  const [first, ...rest] = fullNameText.trim().split(/\s+/);
  p.firstName = (nameParts?.[0] || first || '').trim();
  p.lastName = (nameParts?.[1] || rest.join(' ') || '').trim();
  p.fullName = fullNameText.trim();
  p.phoneNumber = latestApp?.phoneNumber || onboarding?.phoneNumber || p.user?.phoneNumber || '';

  p.gradYear =
    toYear(onboarding?.graduationYear) ??
    toYear(latestApp?.graduationYear) ??
    p.resumes.map((r) => toYear(r.graduationYear)).find((y) => y !== null) ??
    toYear(p.user?.graduationClass) ??
    null;

  p.majors = [
    onboarding?.major1, onboarding?.major2,
    ...p.applications.flatMap((a) => [a.major1, a.major2]),
    ...p.resumes.flatMap((r) => [r.major1, r.major2]),
  ].filter(Boolean).map((m) => String(m).toLowerCase());

  p.isTransfer = Boolean(onboarding?.isTransferStudent ?? latestApp?.isTransferStudent);
  p.isFirstGen = Boolean(onboarding?.isFirstGeneration ?? latestApp?.isFirstGeneration);
}

// ---------------------------------------------------------------------------
// Rule matchers
// ---------------------------------------------------------------------------

const within = (date, from, to) => {
  const t = new Date(date).getTime();
  if (from && t < new Date(from).getTime()) return false;
  if (to && t > new Date(to).getTime()) return false;
  return true;
};

const inCycles = (cycleIds) => (a) => cycleIds.length === 0 || cycleIds.includes(a.cycleId);

const roundNumber = (a) => {
  if (a.status === 'ACCEPTED') return 5;
  const n = Number(a.currentRound);
  return Number.isInteger(n) && n > 0 ? n : 1;
};

// Mirrors decisionFor in decisionProcessing.js: the round's own column, and for
// resume review only, the older `approved` flag.
const decisionOf = (a, round) => {
  const recorded = a[getRound(round).decisionField];
  if (recorded) return String(recorded).toLowerCase();
  if (String(round) === '1') {
    if (a.approved === true) return 'yes';
    if (a.approved === false) return 'no';
  }
  return 'undecided';
};

function wherePeople(ctx, test) {
  const out = new Set();
  for (const key of ctx.universe) if (test(ctx.people.get(key))) out.add(key);
  return out;
}

const addKey = (set, key) => {
  if (key) set.add(key);
};

const MATCHERS = {
  mailingList: (ctx, { sourceFiles }) =>
    wherePeople(ctx, (p) => p.contact && (sourceFiles.length === 0 || sourceFiles.includes(p.contact.sourceFile))),

  account: (ctx, { roles, createdFrom, createdTo }) =>
    wherePeople(ctx, (p) =>
      p.user &&
      (roles.length === 0 || roles.includes(p.user.role)) &&
      within(p.user.createdAt, createdFrom, createdTo)),

  externalTalent: (ctx) => wherePeople(ctx, (p) => p.users.some((u) => u.isExternalTalent)),

  emailVerified: (ctx) => wherePeople(ctx, (p) => p.users.some((u) => u.emailVerifiedAt)),

  meetingSignup: (ctx, { attended }) =>
    wherePeople(ctx, (p) => p.signups.some((s) => attended === undefined || s.attended === attended)),

  lumaGuest: (ctx, { eventIds, checkedIn }) =>
    wherePeople(ctx, (p) => p.lumaGuests.some((g) =>
      g.approvalStatus === LUMA_GOING &&
      (eventIds.length === 0 || eventIds.includes(g.eventId)) &&
      (checkedIn === undefined || Boolean(g.checkedInAt) === checkedIn))),

  applied: (ctx, { scope, cycleIds, statuses, submittedFrom, submittedTo }) =>
    wherePeople(ctx, (p) => p.applications.some((a) =>
      (scope !== 'cycles' || cycleIds.includes(a.cycleId)) &&
      (scope !== 'previous' || (a.cycleId && !ctx.activeCycleIds.has(a.cycleId))) &&
      (statuses.length === 0 || statuses.includes(a.status)) &&
      within(a.submittedAt, submittedFrom, submittedTo))),

  appliedCount: (ctx, { min }) =>
    wherePeople(ctx, (p) => new Set(p.applications.map((a) => a.cycleId || a.id)).size >= min),

  reachedRound: (ctx, { round, cycleIds }) =>
    wherePeople(ctx, (p) => p.applications.some((a) => inCycles(cycleIds)(a) && roundNumber(a) >= Number(round))),

  decision: (ctx, { round, decisions, cycleIds }) =>
    wherePeople(ctx, (p) => p.applications.some((a) => inCycles(cycleIds)(a) && decisions.includes(decisionOf(a, round)))),

  talentPoolOptIn: (ctx) =>
    wherePeople(ctx, (p) =>
      p.applications.some((a) => a.talentPoolOptIn === true) ||
      p.resumes.some((r) => r.shareConsent && !r.consentRevokedAt)),

  referred: async (ctx, { cycleIds }) => {
    const referrals = await ctx.client.referral.findMany({
      where: { candidateId: { not: null }, ...(cycleIds.length ? { cycleId: { in: cycleIds } } : {}) },
      select: { candidateId: true },
    });
    const out = new Set();
    for (const r of referrals) addKey(out, ctx.candidateKeys.get(r.candidateId));
    return out;
  },

  gradYear: (ctx, { years, min, max }) =>
    wherePeople(ctx, (p) =>
      p.gradYear !== null &&
      (years.length === 0 || years.includes(p.gradYear)) &&
      (min === undefined || p.gradYear >= min) &&
      (max === undefined || p.gradYear <= max)),

  major: (ctx, { terms }) => {
    const needles = terms.map((t) => t.toLowerCase());
    return wherePeople(ctx, (p) => p.majors.some((m) => needles.some((n) => m.includes(n))));
  },

  transfer: (ctx) => wherePeople(ctx, (p) => p.isTransfer),

  firstGen: (ctx) => wherePeople(ctx, (p) => p.isFirstGen),

  eventRsvp: async (ctx, { eventIds }) => {
    const pairs = await loadRsvps(ctx, eventIds);
    return new Set(pairs.map(([key]) => key));
  },

  eventAttended: async (ctx, { eventIds, minCount }) => {
    const counts = new Map();
    for (const [key, eventId] of await loadAttendance(ctx, eventIds)) {
      if (!counts.has(key)) counts.set(key, new Set());
      counts.get(key).add(eventId);
    }
    return new Set([...counts].filter(([, events]) => events.size >= minCount).map(([key]) => key));
  },

  // Only events that are over: an RSVP to next week's event is not a no-show.
  rsvpNoShow: async (ctx, { eventIds }) => {
    const ended = await ctx.client.events.findMany({
      where: { eventEndDate: { lt: new Date() }, ...(eventIds.length ? { id: { in: eventIds } } : {}) },
      select: { id: true },
    });
    const endedIds = ended.map((e) => e.id);
    if (endedIds.length === 0) return new Set();
    const [rsvps, attended] = await Promise.all([loadRsvps(ctx, endedIds), loadAttendance(ctx, endedIds)]);
    const came = new Set(attended.map(([key, eventId]) => `${key}|${eventId}`));
    return new Set(rsvps.filter(([key, eventId]) => !came.has(`${key}|${eventId}`)).map(([key]) => key));
  },

  receivedCampaign: async (ctx, { messageLogIds, outcome }) => {
    const status =
      outcome === 'failed' ? { in: FAILED_STATUSES } : outcome === 'delivered' ? { notIn: FAILED_STATUSES } : undefined;
    const rows = await ctx.client.communicationLog.findMany({
      where: { channel: 'email', messageLogId: { in: messageLogIds }, ...(status ? { status } : {}) },
      select: { recipient: true },
    });
    const out = new Set();
    for (const r of rows) addKey(out, ctx.keyOf(r.recipient));
    return out;
  },

  emailedWithin: async (ctx, { days }) => {
    const rows = await ctx.client.communicationLog.findMany({
      where: {
        channel: 'email',
        category: 'MASTER_COMMUNICATION',
        status: { notIn: FAILED_STATUSES },
        sentAt: { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
      },
      select: { recipient: true },
      distinct: ['recipient'],
    });
    const out = new Set();
    for (const r of rows) addKey(out, ctx.keyOf(r.recipient));
    return out;
  },
};

// [personKey, eventId] for every RSVP: applicants' (form or Luma-matched),
// members', and Luma guests the sync could not match to anyone yet.
async function loadRsvps(ctx, eventIds) {
  const where = eventIds.length ? { eventId: { in: eventIds } } : {};
  const [candidateRsvps, memberRsvps] = await Promise.all([
    ctx.client.eventRsvp.findMany({ where, select: { candidateId: true, eventId: true } }),
    ctx.client.memberEventRsvp.findMany({ where, select: { memberId: true, eventId: true } }),
  ]);
  const pairs = [
    ...candidateRsvps.map((r) => [ctx.candidateKeys.get(r.candidateId), r.eventId]),
    ...memberRsvps.map((r) => [ctx.userKeys.get(r.memberId), r.eventId]),
  ];
  for (const key of ctx.universe) {
    for (const g of ctx.people.get(key).lumaGuests) {
      if (g.approvalStatus === LUMA_GOING && (eventIds.length === 0 || eventIds.includes(g.eventId))) {
        pairs.push([key, g.eventId]);
      }
    }
  }
  return pairs.filter(([key]) => key);
}

async function loadAttendance(ctx, eventIds) {
  const where = eventIds.length ? { eventId: { in: eventIds } } : {};
  const [candidateAttendance, memberAttendance] = await Promise.all([
    ctx.client.eventAttendance.findMany({ where, select: { candidateId: true, eventId: true } }),
    ctx.client.memberEventAttendance.findMany({ where, select: { memberId: true, eventId: true } }),
  ]);
  const pairs = [
    ...candidateAttendance.map((r) => [ctx.candidateKeys.get(r.candidateId), r.eventId]),
    ...memberAttendance.map((r) => [ctx.userKeys.get(r.memberId), r.eventId]),
  ];
  for (const key of ctx.universe) {
    for (const g of ctx.people.get(key).lumaGuests) {
      if (g.checkedInAt && (eventIds.length === 0 || eventIds.includes(g.eventId))) pairs.push([key, g.eventId]);
    }
  }
  return pairs.filter(([key]) => key);
}

export function matchRule(ctx, rule) {
  const matcher = MATCHERS[rule.type];
  if (!matcher) throw new Error(`No matcher for audience rule ${rule.type}`);
  return Promise.resolve(matcher(ctx, rule.params));
}

export const MATCHER_TYPES = Object.keys(MATCHERS);

/**
 * Everyone a tree matches, as send-ready recipients, plus where they came from
 * so the preview can say what the audience is made of.
 */
export async function resolveAudience(filters, { client = prisma, context = null } = {}) {
  const tree = normalizeAudienceTree(filters);
  const ctx = context || (await loadAudienceContext(client));
  const keys = await evaluateAudienceTree(tree, { universe: ctx.universe, matchRule: (rule) => matchRule(ctx, rule) });

  const recipients = [...keys]
    .map((key) => ctx.people.get(key))
    .sort((a, b) => (a.fullName || a.email).localeCompare(b.fullName || b.email))
    .map((p) => ({
      id: p.key,
      email: p.email,
      firstName: p.firstName,
      lastName: p.lastName,
      fullName: p.fullName,
      phoneNumber: p.phoneNumber,
      audience: 'person',
      isStaff: p.isStaff,
      sources: [...p.sources],
    }));

  return { tree, recipients };
}

/** How many recipients came from each source. One person can count in several. */
export function summarizeSources(recipients) {
  const counts = {};
  for (const r of recipients) for (const s of r.sources || []) counts[s] = (counts[s] || 0) + 1;
  return counts;
}
