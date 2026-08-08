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

import { localInputToUTC } from '../utils/timezoneUtils.js';
import {
  CYCLE_TIMELINE_STAGES,
  STAGE_BY_KEY,
  MILESTONE_EVENT_DURATION_MINUTES
} from './cycleTimelineTemplate.js';

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

// Seed the timeline form from a prior cycle by shifting its stored snapshot
// forward a whole number of days. Form URLs are never carried over — stale form
// IDs are exactly the failure mode this avoids.
export async function timelineFromPriorCycle({ prisma, sourceCycleId, shiftDays = 365 }) {
  const source = await prisma.recruitingCycle.findUnique({ where: { id: sourceCycleId } });
  if (!source) throw new Error('Source recruiting cycle not found');
  if (!source.timelineSnapshot?.stages) {
    throw new Error('Source cycle has no stored timeline to clone');
  }

  const shiftMs = shiftDays * 24 * 60 * 60 * 1000;
  const shift = (value) => (value ? new Date(new Date(value).getTime() + shiftMs).toISOString() : null);

  return {
    sourceCycle: { id: source.id, name: source.name },
    shiftDays,
    stages: Object.fromEntries(
      Object.entries(source.timelineSnapshot.stages).map(([key, value]) => [
        key,
        { start: shift(value.start), end: shift(value.end) }
      ])
    )
  };
}

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

  const result = await prisma.$transaction(async (tx) => {
    const cycle = await tx.recruitingCycle.create({
      data: {
        name: name.trim(),
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
          select: {
            id: true,
            eventName: true,
            eventStartDate: true,
            eventEndDate: true,
            showToCandidates: true,
            generatedFromStage: true,
            formStatus: true
          }
        })
      );
    }

    return { cycle, created };
  });

  // Activation is never implicit: it deactivates every other cycle and resets
  // cycle-scoped screens, so it only happens when the admin asks for it.
  if (activate) {
    await prisma.recruitingCycle.updateMany({
      where: { id: { not: result.cycle.id }, isActive: true },
      data: { isActive: false }
    });
    result.cycle = await prisma.recruitingCycle.update({
      where: { id: result.cycle.id },
      data: { isActive: true }
    });
  }

  return {
    cycle: result.cycle,
    events: result.created,
    pendingFormCount: result.created.filter((event) => event.formStatus === 'PENDING_FORM').length,
    publishChangeSet
  };
}
