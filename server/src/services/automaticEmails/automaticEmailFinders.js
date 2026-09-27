import prisma from '../../prismaClient.js';
import { formatEmailDateTime } from '../../utils/timezoneUtils.js';
import { emailIdentityKey } from '../../utils/mailingListImport.js';
import { resolveAudience } from '../audiences/audiencePeople.js';
import { statusLabel } from './automaticEmailRules.js';

/**
 * Who an automatic email fires for, right now.
 *
 * Each finder returns occurrences - `{ subjectKey, email, values, name }` -
 * and never writes. `subjectKey` names what the email is about, and the
 * runner's unique (email, subjectKey) row is what stops it firing twice, so a
 * key has to change exactly when a second email would be right: a rescheduled
 * event is a new occurrence, a second look at the same RSVP is not.
 *
 * Nothing before `enabledAt` counts, for any trigger. How that is enforced
 * differs by what the data can tell us:
 *
 *   - Created records carry createdAt/submittedAt, so the cut is exact.
 *   - Application status has no "changed at", so enabling a status rule seeds
 *     a SKIPPED row for everyone already in that status (seedExisting), and
 *     only people who arrive later are left without one.
 *   - Time triggers fire at a computed moment, and a moment before enabledAt,
 *     or more than STALE_AFTER ago, never fires. Without the second cut a rule
 *     enabled today would work through every event of the past month.
 */

const HOUR = 60 * 60 * 1000;
export const STALE_AFTER = 48 * HOUR;

const person = (email, firstName, lastName, fullName) => {
  const full = fullName || [firstName, lastName].filter(Boolean).join(' ');
  const [first, ...rest] = (full || '').split(' ');
  return {
    firstName: firstName || first || '',
    lastName: lastName || rest.join(' ') || '',
    fullName: full || email,
    email,
  };
};

/** Whether a computed moment should fire now for a rule enabled at `enabledAt`. */
export const isDue = (fireAt, { now, enabledAt }) =>
  fireAt <= now && fireAt >= enabledAt && now - fireAt <= STALE_AFTER;

// ---------------------------------------------------------------------------

async function applicationStatus(rule, { client }) {
  const apps = await client.application.findMany({
    where: { status: rule.triggerConfig.status },
    select: { id: true, email: true, firstName: true, lastName: true, cycle: { select: { name: true } } },
  });
  return apps.map((a) => ({
    subjectKey: `application:${a.id}:${rule.triggerConfig.status}`,
    email: a.email,
    values: {
      ...person(a.email, a.firstName, a.lastName),
      cycleName: a.cycle?.name ?? '',
      status: statusLabel(rule.triggerConfig.status),
    },
  }));
}

/**
 * Everyone already in the status when the rule was turned on, as SKIPPED
 * rows. Same keys applicationStatus produces, so the runner then leaves them
 * alone. Changing the status a rule watches re-seeds, because the key carries
 * the status.
 */
export async function seedExisting(rule, { client = prisma } = {}) {
  if (rule.trigger !== 'APPLICATION_STATUS') return 0;
  const existing = await applicationStatus(rule, { client });
  if (existing.length === 0) return 0;
  const { count } = await client.automaticEmailSend.createMany({
    data: existing.map((o) => ({
      automaticEmailId: rule.id,
      subjectKey: o.subjectKey,
      email: o.email,
      status: 'SKIPPED',
      reason: 'Already in this status when the email was turned on',
    })),
    skipDuplicates: true,
  });
  return count;
}

async function recordCreated(rule, { client }) {
  const since = rule.enabledAt;
  switch (rule.triggerConfig.record) {
    case 'APPLICATION': {
      const rows = await client.application.findMany({
        where: { submittedAt: { gte: since } },
        select: { id: true, email: true, firstName: true, lastName: true, cycle: { select: { name: true } } },
      });
      return rows.map((a) => ({
        subjectKey: `application-created:${a.id}`,
        email: a.email,
        values: { ...person(a.email, a.firstName, a.lastName), cycleName: a.cycle?.name ?? '' },
      }));
    }
    case 'EVENT_RSVP': {
      const rows = await client.eventRsvp.findMany({
        where: { createdAt: { gte: since } },
        select: {
          id: true,
          candidate: { select: { email: true, firstName: true, lastName: true } },
          event: { select: { eventName: true, eventStartDate: true, eventLocation: true } },
        },
      });
      return rows.map((r) => ({
        subjectKey: `rsvp-created:${r.id}`,
        email: r.candidate.email,
        values: {
          ...person(r.candidate.email, r.candidate.firstName, r.candidate.lastName),
          eventName: r.event.eventName,
          eventDate: formatEmailDateTime(r.event.eventStartDate),
          eventLocation: r.event.eventLocation ?? '',
        },
      }));
    }
    case 'GTKUC_SIGNUP': {
      const rows = await client.meetingSignup.findMany({
        where: { createdAt: { gte: since } },
        select: {
          id: true,
          email: true,
          fullName: true,
          slot: { select: { startTime: true, location: true, member: { select: { fullName: true } } } },
        },
      });
      return rows.map((s) => ({
        subjectKey: `gtkuc-created:${s.id}`,
        email: s.email,
        values: {
          ...person(s.email, null, null, s.fullName),
          memberName: s.slot.member?.fullName ?? '',
          meetingTime: formatEmailDateTime(s.slot.startTime),
          meetingLocation: s.slot.location,
        },
      }));
    }
    case 'ACCOUNT': {
      // Never a Talent Partner Network client: they are buyers, not recruits,
      // and every audience in the app already leaves them out.
      const rows = await client.user.findMany({
        where: { createdAt: { gte: since }, isActive: true, role: { not: 'CLIENT' } },
        select: { id: true, email: true, fullName: true },
      });
      return rows.map((u) => ({
        subjectKey: `account-created:${u.id}`,
        email: u.email,
        values: person(u.email, null, null, u.fullName),
      }));
    }
    default:
      return [];
  }
}

async function eventTime(rule, { client, now }) {
  const offset = rule.triggerConfig.offsetHours * HOUR;
  // Events whose computed moment could be due: start = fireAt - offset.
  const events = await client.events.findMany({
    where: {
      eventStartDate: {
        gte: new Date(Math.max(rule.enabledAt.getTime(), now.getTime() - STALE_AFTER) - offset),
        lte: new Date(now.getTime() - offset),
      },
    },
    select: {
      id: true,
      eventName: true,
      eventStartDate: true,
      eventLocation: true,
      eventRsvp: { select: { id: true, candidate: { select: { email: true, firstName: true, lastName: true } } } },
    },
  });

  const out = [];
  for (const e of events) {
    const fireAt = new Date(e.eventStartDate.getTime() + offset);
    if (!isDue(fireAt, { now, enabledAt: rule.enabledAt })) continue;
    // A reminder before an event is pointless once it has started.
    if (offset < 0 && now >= e.eventStartDate) continue;
    for (const r of e.eventRsvp) {
      out.push({
        subjectKey: `event:${r.id}:${e.eventStartDate.toISOString()}`,
        email: r.candidate.email,
        values: {
          ...person(r.candidate.email, r.candidate.firstName, r.candidate.lastName),
          eventName: e.eventName,
          eventDate: formatEmailDateTime(e.eventStartDate),
          eventLocation: e.eventLocation ?? '',
        },
      });
    }
  }
  return out;
}

async function interviewTime(rule, { client, now }) {
  const offset = rule.triggerConfig.offsetHours * HOUR;
  const slots = await client.interviewSlot.findMany({
    where: {
      startTime: {
        gte: new Date(Math.max(rule.enabledAt.getTime(), now.getTime() - STALE_AFTER) - offset),
        lte: new Date(now.getTime() - offset),
      },
    },
    select: {
      id: true,
      startTime: true,
      location: true,
      interview: { select: { title: true, location: true } },
      signups: {
        where: { status: 'CONFIRMED' },
        select: { id: true, application: { select: { email: true, firstName: true, lastName: true } } },
      },
    },
  });

  const out = [];
  for (const s of slots) {
    const fireAt = new Date(s.startTime.getTime() + offset);
    if (!isDue(fireAt, { now, enabledAt: rule.enabledAt })) continue;
    if (offset < 0 && now >= s.startTime) continue;
    for (const signup of s.signups) {
      const a = signup.application;
      out.push({
        // Slot and time in the key: someone moved to another sitting, or a
        // sitting moved, gets the reminder for the new time.
        subjectKey: `interview:${signup.id}:${s.id}:${s.startTime.toISOString()}`,
        email: a.email,
        values: {
          ...person(a.email, a.firstName, a.lastName),
          interviewTitle: s.interview?.title ?? '',
          interviewTime: formatEmailDateTime(s.startTime),
          interviewLocation: s.location || s.interview?.location || '',
        },
      });
    }
  }
  return out;
}

async function cycleDate(rule, { client, now }) {
  const { field, savedAudienceId } = rule.triggerConfig;
  const offset = rule.triggerConfig.offsetHours * HOUR;
  const cycles = await client.recruitingCycle.findMany({
    where: {
      [field]: {
        gte: new Date(Math.max(rule.enabledAt.getTime(), now.getTime() - STALE_AFTER) - offset),
        lte: new Date(now.getTime() - offset),
      },
    },
    select: { id: true, name: true, [field]: true },
  });
  const due = cycles.filter((c) => isDue(new Date(c[field].getTime() + offset), { now, enabledAt: rule.enabledAt }));
  if (due.length === 0) return [];

  // Resolved at fire time, never snapshotted: the audience is whoever matches
  // on the day, which is what "3 days before the deadline, to people who have
  // not applied" means.
  const audience = await client.savedAudience.findUnique({ where: { id: savedAudienceId }, select: { filters: true } });
  if (!audience) return [];
  const { recipients } = await resolveAudience(audience.filters, { client });

  return due.flatMap((c) =>
    recipients.map((r) => ({
      subjectKey: `cycle:${c.id}:${field}:${c[field].toISOString()}:${emailIdentityKey(r.email)}`,
      email: r.email,
      values: {
        ...person(r.email, r.firstName, r.lastName, r.fullName),
        cycleName: c.name,
        date: formatEmailDateTime(c[field]),
      },
    }))
  );
}

const FINDERS = {
  APPLICATION_STATUS: applicationStatus,
  RECORD_CREATED: recordCreated,
  EVENT_TIME: eventTime,
  INTERVIEW_TIME: interviewTime,
  CYCLE_DATE: cycleDate,
};

/** Every occurrence the rule fires for at `now`, sent or not. */
export async function findOccurrences(rule, { client = prisma, now = new Date() } = {}) {
  if (!rule.enabledAt) return [];
  const finder = FINDERS[rule.trigger];
  if (!finder) return [];
  const occurrences = await finder(rule, { client, now });
  return occurrences.filter((o) => o.email);
}
