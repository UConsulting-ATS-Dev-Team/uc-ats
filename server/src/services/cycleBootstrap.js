// Cycle bootstrap: turn a full recruitment timeline into a recruiting cycle plus
// its generated event shells in one pass.
//
// Follows the same preview -> explicit commit shape as `eventCopy.js`: the admin
// sees exactly which events will be created (and may edit them) before anything
// is written, and the commit is a single transaction so a partial timeline can
// never leave orphan events behind.
//
// Google Forms are NOT auto-created. The service account is read-only for the
// Forms API (`forms.body.readonly`), so generated events that are expected to
// have forms are committed with `formStatus = 'PENDING_FORM'` and surfaced as
// "needs form link" in Event Management — an explicit gap, never a silent one.

import { createHash } from 'node:crypto';

import { localInputToUTC, utcToLocalInput } from '../utils/timezoneUtils.js';
import {
  CYCLE_TIMELINE_STAGES,
  STAGE_BY_KEY,
  MILESTONE_EVENT_DURATION_MINUTES
} from './cycleTimelineTemplate.js';
import {
  activateCycleExclusively,
  isActiveCycleConflict,
  ActiveCycleConflictError
} from './activeCycle.js';

// Timeline inputs are LA-local `YYYY-MM-DDTHH:mm` strings, matching every other
// datetime the admin UI submits. Date-only values are anchored at 09:00 LA so
// they never shift a day when stored as UTC.
const parseTimelineInput = (value) => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T09:00` : raw;
  return localInputToUTC(normalized);
};

const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60000);

const isoDate = (date) => date.toISOString().slice(0, 10);

// Normalize the submitted timeline into `{ stageKey: { start, end } }`, keeping
// per-stage parse errors so the client can mark individual fields.
const normalizeTimeline = (timeline = {}) => {
  const stages = {};
  const errors = [];

  for (const stage of CYCLE_TIMELINE_STAGES) {
    const submitted = timeline[stage.key];
    if (!submitted) continue;

    const rawStart = typeof submitted === 'string' ? submitted : submitted.start;
    const rawEnd = typeof submitted === 'string' ? null : submitted.end;
    // A blank field is an unfilled optional stage, not an invalid date.
    if (!rawStart || !String(rawStart).trim()) continue;

    const start = parseTimelineInput(rawStart);
    const end = stage.type === 'window' ? parseTimelineInput(rawEnd) : null;

    if (!start) {
      errors.push({ stage: stage.key, field: 'start', message: `${stage.label} start date is invalid` });
      continue;
    }

    if (stage.type === 'window') {
      if (!end) {
        errors.push({ stage: stage.key, field: 'end', message: `${stage.label} end date is required` });
        continue;
      }
      if (end <= start) {
        errors.push({ stage: stage.key, field: 'end', message: `${stage.label} must end after it starts` });
        continue;
      }
    }

    stages[stage.key] = { start, end };
  }

  return { stages, errors };
};

// Stage order in the template is the required chronological order; each stage
// start must not precede the previous stage's start.
const validateTimeline = (stages) => {
  const errors = [];

  for (const stage of CYCLE_TIMELINE_STAGES) {
    if (stage.required && !stages[stage.key]) {
      errors.push({ stage: stage.key, field: 'start', message: `${stage.label} is required` });
    }
  }

  let previous = null;
  for (const stage of CYCLE_TIMELINE_STAGES) {
    const current = stages[stage.key];
    if (!current) continue;
    if (previous && current.start < previous.stages.start) {
      errors.push({
        stage: stage.key,
        field: 'start',
        message: `${stage.label} cannot start before ${previous.stage.label}`
      });
    }
    previous = { stage, stages: current };
  }

  return errors;
};

// Event shells derived from the timeline. Milestones that generate an event get
// a fixed default duration so `Events.eventEndDate` is never guessed downstream.
const deriveEvents = (stages) =>
  CYCLE_TIMELINE_STAGES.filter((stage) => stage.generatesEvent && stages[stage.key]).map((stage) => {
    const { start, end } = stages[stage.key];
    return {
      stageKey: stage.key,
      eventName: stage.eventName,
      eventStartDate: start.toISOString(),
      eventEndDate: (end || addMinutes(start, MILESTONE_EVENT_DURATION_MINUTES)).toISOString(),
      eventLocation: '',
      showToCandidates: Boolean(stage.publicFacing),
      needsForms: Boolean(stage.needsForms)
    };
  });

// Public dates an admin still has to publish by hand on the website / Linktree.
// Emitted for review and download only — nothing here is published anywhere.
const derivePublishChangeSet = (cycleName, stages) => ({
  cycleName,
  generatedAt: new Date().toISOString(),
  entries: CYCLE_TIMELINE_STAGES.filter((stage) => stage.publicFacing && stages[stage.key]).map((stage) => ({
    stage: stage.key,
    label: stage.label,
    start: stages[stage.key].start.toISOString(),
    end: stages[stage.key].end ? stages[stage.key].end.toISOString() : null
  }))
});

const timelineSnapshot = (stages) => ({
  version: 1,
  stages: Object.fromEntries(
    Object.entries(stages).map(([key, value]) => [
      key,
      { start: value.start.toISOString(), end: value.end ? value.end.toISOString() : null }
    ])
  )
});

const validationError = (errors) => {
  const error = new Error('Timeline validation failed');
  error.name = 'ValidationError';
  error.validationErrors = errors;
  return error;
};

// Shift a stored UTC instant by whole calendar years, keeping the LA wall
// date/time it was entered as. A fixed 365-day offset would slide the date by a
// day across every leap year, so the shift is done on the LA-local fields.
// Feb 29 has no counterpart in a common year and clamps to Feb 28.
// Returned as an LA-local `YYYY-MM-DDTHH:mm` string so the admin form can use it
// verbatim; slicing a UTC ISO string client-side is what drops a day.
const shiftLocalYears = (value, years) => {
  if (!value) return null;
  const local = utcToLocalInput(value);
  if (!local) return null;

  const [date, time] = local.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const targetYear = year + years;
  const daysInMonth = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  const targetDay = Math.min(day, daysInMonth);

  return `${targetYear}-${String(month).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}T${time}`;
};

// Seed the timeline form from a prior cycle by shifting its stored snapshot
// forward whole calendar years. Form URLs are never carried over — stale form
// IDs are exactly the failure mode this avoids.
export async function timelineFromPriorCycle({ prisma, sourceCycleId, shiftYears = 1 }) {
  const source = await prisma.recruitingCycle.findUnique({ where: { id: sourceCycleId } });
  if (!source) throw new Error('Source recruiting cycle not found');
  if (!source.timelineSnapshot?.stages) {
    throw new Error('Source cycle has no stored timeline to clone');
  }

  return {
    sourceCycle: { id: source.id, name: source.name },
    shiftYears,
    stages: Object.fromEntries(
      Object.entries(source.timelineSnapshot.stages).map(([key, value]) => [
        key,
        {
          start: shiftLocalYears(value.start, shiftYears),
          end: shiftLocalYears(value.end, shiftYears)
        }
      ])
    )
  };
}

const GENERATED_EVENT_SELECT = {
  id: true,
  eventName: true,
  eventStartDate: true,
  eventEndDate: true,
  showToCandidates: true,
  generatedFromStage: true,
  formStatus: true
};

// Key order in stored JSON follows insertion order, so compare canonically.
const canonicalJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
};

// Identity of a bootstrap request, not just of its timeline: two requests that
// differ in `activate` or in any per-event override are different operations, so
// the second must not be answered with the first one's result.
const bootstrapFingerprint = ({ name, snapshot, activate, events }) =>
  createHash('sha256')
    .update(
      canonicalJson({
        version: 1,
        name,
        activate: Boolean(activate),
        timeline: snapshot,
        events: events.map((event) => ({
          stageKey: event.stageKey,
          eventName: event.eventName,
          eventLocation: event.eventLocation || '',
          showToCandidates: event.showToCandidates,
          eventStartDate: event.eventStartDate,
          eventEndDate: event.eventEndDate
        }))
      })
    )
    .digest('hex');

const bootstrapResult = ({ cycle, created }, publishChangeSet) => ({
  cycle,
  events: created,
  pendingFormCount: created.filter((event) => event.formStatus === 'PENDING_FORM').length,
  publishChangeSet
});

// Cycle names are unique, so an exact retry of a commit whose response was lost
// finds the cycle it already created. Only a byte-identical request (same stored
// fingerprint) is treated as that retry and answered with the original result;
// anything else reusing the name — a changed timeline, a flipped `activate`, an
// edited event name/location/visibility — is a conflict, because returning the
// first commit's result would report a success that never happened.
const recoverExistingBootstrap = async (prisma, name, fingerprint) => {
  const existing = await prisma.recruitingCycle.findFirst({ where: { name } });
  if (!existing) return null;

  const sameRequest =
    Boolean(existing.timelineCommittedAt) &&
    Boolean(existing.bootstrapFingerprint) &&
    existing.bootstrapFingerprint === fingerprint;

  if (!sameRequest) {
    throw validationError([
      { stage: null, field: 'name', message: 'A cycle with this name already exists' }
    ]);
  }

  const events = await prisma.events.findMany({
    where: { cycleId: existing.id, generatedFromStage: { not: null } },
    select: GENERATED_EVENT_SELECT
  });

  return { cycle: existing, created: events };
};

export async function previewCycleBootstrap({ prisma, name, timeline }) {
  const { stages, errors: parseErrors } = normalizeTimeline(timeline);
  const errors = [...parseErrors, ...validateTimeline(stages)];

  const existing = name?.trim()
    ? await prisma.recruitingCycle.findFirst({ where: { name: name.trim() } })
    : null;
  if (!name || !name.trim()) {
    errors.push({ stage: null, field: 'name', message: 'Cycle name is required' });
  } else if (existing) {
    errors.push({ stage: null, field: 'name', message: 'A cycle with this name already exists' });
  }

  const events = deriveEvents(stages);

  return {
    name: name?.trim() || '',
    valid: errors.length === 0,
    validationErrors: errors,
    stages: timelineSnapshot(stages).stages,
    startDate: stages.applications_open ? stages.applications_open.start.toISOString() : null,
    endDate: stages.offers_released
      ? stages.offers_released.start.toISOString()
      : stages.deliberations?.end?.toISOString() || null,
    events,
    // Every generated event that expects a form starts life without one.
    pendingFormCount: events.filter((event) => event.needsForms).length,
    publishChangeSet: derivePublishChangeSet(name?.trim() || '', stages)
  };
}

export async function commitCycleBootstrap({
  prisma,
  name,
  timeline,
  events: submittedEvents,
  actorId,
  activate = false
}) {
  const { stages, errors: parseErrors } = normalizeTimeline(timeline);
  const errors = [...parseErrors, ...validateTimeline(stages)];

  if (!name || !name.trim()) {
    errors.push({ stage: null, field: 'name', message: 'Cycle name is required' });
  }
  if (errors.length > 0) throw validationError(errors);

  // Derive the events from the timeline server-side; the client may only edit
  // the name / location / visibility of a stage it actually submitted.
  const derived = deriveEvents(stages);
  const overridesByStage = new Map(
    (Array.isArray(submittedEvents) ? submittedEvents : [])
      .filter((event) => event?.stageKey && STAGE_BY_KEY.has(event.stageKey))
      .map((event) => [event.stageKey, event])
  );

  const eventsToCreate = derived.map((event) => {
    const override = overridesByStage.get(event.stageKey) || {};
    return {
      ...event,
      eventName: override.eventName?.trim() || event.eventName,
      eventLocation: override.eventLocation?.trim() || '',
      showToCandidates:
        override.showToCandidates === undefined
          ? event.showToCandidates
          : Boolean(override.showToCandidates)
    };
  });

  const snapshot = timelineSnapshot(stages);
  const publishChangeSet = derivePublishChangeSet(name.trim(), stages);
  const fingerprint = bootstrapFingerprint({
    name: name.trim(),
    snapshot,
    activate,
    events: eventsToCreate
  });

  const recovered = await recoverExistingBootstrap(prisma, name.trim(), fingerprint);
  if (recovered) return bootstrapResult(recovered, publishChangeSet);

  const runCommit = () => prisma.$transaction(async (tx) => {
    let cycle = await tx.recruitingCycle.create({
      data: {
        name: name.trim(),
        // Activation is a separate, ordered step below; creating the row already
        // active would trip the single-active index before others are cleared.
        isActive: false,
        startDate: stages.applications_open ? stages.applications_open.start : null,
        endDate: stages.offers_released
          ? stages.offers_released.start
          : stages.deliberations?.end || null,
        // Legacy free-text deadline columns stay populated so existing screens
        // keep working; the timeline snapshot is the structured source.
        resumeDeadline: stages.resume_deadline ? isoDate(stages.resume_deadline.start) : null,
        coverLetterDeadline: stages.cover_letter_deadline
          ? isoDate(stages.cover_letter_deadline.start)
          : null,
        videoDeadline: stages.video_deadline ? isoDate(stages.video_deadline.start) : null,
        createdById: actorId || null,
        timelineSnapshot: snapshot,
        timelineCommittedAt: new Date(),
        bootstrapFingerprint: fingerprint,
        publishChangeSet
      }
    });

    const created = [];
    for (const event of eventsToCreate) {
      created.push(
        await tx.events.create({
          data: {
            cycleId: cycle.id,
            eventName: event.eventName,
            eventStartDate: new Date(event.eventStartDate),
            eventEndDate: new Date(event.eventEndDate),
            eventLocation: event.eventLocation || null,
            showToCandidates: event.showToCandidates,
            generatedFromStage: event.stageKey,
            // No Forms write scope today, so the gap is recorded explicitly.
            formStatus: event.needsForms ? 'PENDING_FORM' : null
          },
          select: GENERATED_EVENT_SELECT
        })
      );
    }

    // Activation is never implicit, but when it is asked for it belongs in this
    // transaction: a failure here must not leave a committed cycle behind, and
    // must never leave two cycles active.
    if (activate) {
      cycle = await activateCycleExclusively(tx, cycle.id);
    }

    return { cycle, created };
  });

  let result;
  try {
    result = await runCommit();
  } catch (error) {
    // A concurrent activation that would have produced a second active cycle
    // must fail rather than resolve to someone else's cycle.
    if (isActiveCycleConflict(error)) throw new ActiveCycleConflictError();
    // Lost the race with a concurrent identical commit (unique cycle name).
    if (error.code === 'P2002') {
      const raced = await recoverExistingBootstrap(prisma, name.trim(), fingerprint);
      if (raced) return bootstrapResult(raced, publishChangeSet);
    }
    throw error;
  }

  return bootstrapResult(result, publishChangeSet);
}
