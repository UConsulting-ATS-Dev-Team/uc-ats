// Cycle-portable admin event copy service.
// This module documents and implements the mapping used to copy event records
// from a source recruiting cycle into a target recruiting cycle. It copies
// event metadata only and never copies registrations, candidate data,
// calendar provider events, attachments, or source event records.

import { localInputToUTC } from '../utils/timezoneUtils.js';

// Approved portable event fields. Fields marked `required` are validated on
// commit. `editable` fields are shown in the preview table for explicit edits.
export const PORTABLE_EVENT_FIELDS = [
  { name: 'eventName', label: 'Event Name', required: true, editable: true },
  { name: 'eventStartDate', label: 'Start Date', required: true, editable: true, type: 'datetime' },
  { name: 'eventEndDate', label: 'End Date', required: true, editable: true, type: 'datetime' },
  { name: 'eventLocation', label: 'Location', required: false, editable: true },
  { name: 'showToCandidates', label: 'Show to Candidates', required: false, editable: true, type: 'boolean' },
  // Form links are cycle-specific; we preserve the source value in the preview
  // but require the admin to review and edit them before committing.
  { name: 'rsvpForm', label: 'RSVP Form URL', required: false, editable: true, type: 'url' },
  { name: 'attendanceForm', label: 'Attendance Form URL', required: false, editable: true, type: 'url' },
  { name: 'memberRsvpUrl', label: 'Member RSVP Form URL', required: false, editable: true, type: 'url' },
  { name: 'memberAttendanceForm', label: 'Member Attendance Form URL', required: false, editable: true, type: 'url' },
];

function toIsoString(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function isValidUrl(value) {
  if (!value) return true;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export async function previewCycleEventCopy({ prisma, sourceCycleId, targetCycleId }) {
  if (!sourceCycleId || !targetCycleId) {
    throw new Error('Source and target cycle IDs are required');
  }

  if (sourceCycleId === targetCycleId) {
    throw new Error('Source and target cycles must be different');
  }

  const [sourceCycle, targetCycle] = await Promise.all([
    prisma.recruitingCycle.findUnique({ where: { id: sourceCycleId } }),
    prisma.recruitingCycle.findUnique({ where: { id: targetCycleId } }),
  ]);

  if (!sourceCycle) throw new Error('Source recruiting cycle not found');
  if (!targetCycle) throw new Error('Target recruiting cycle not found');

  const [sourceEvents, targetEvents] = await Promise.all([
    prisma.events.findMany({
      where: { cycleId: sourceCycleId },
      orderBy: { eventStartDate: 'asc' },
    }),
    prisma.events.findMany({
      where: { cycleId: targetCycleId },
      select: { id: true, eventName: true, eventStartDate: true, copiedFromEventId: true },
    }),
  ]);

  // Idempotent copy check uses the durable source-cycle/source-event/target-cycle
  // provenance key, not the mutable event name.
  const targetBySource = new Map(
    targetEvents.filter((e) => e.copiedFromEventId).map((e) => [e.copiedFromEventId, e])
  );

  const events = sourceEvents.map((source) => ({
    sourceEventId: source.id,
    eventName: source.eventName,
    eventStartDate: toIsoString(source.eventStartDate),
    eventEndDate: toIsoString(source.eventEndDate),
    eventLocation: source.eventLocation || '',
    showToCandidates: Boolean(source.showToCandidates),
    rsvpForm: source.rsvpForm || '',
    attendanceForm: source.attendanceForm || '',
    memberRsvpUrl: source.memberRsvpUrl || '',
    memberAttendanceForm: source.memberAttendanceForm || '',
    alreadyExists: targetBySource.has(source.id),
  }));

  return {
    sourceCycle: { id: sourceCycle.id, name: sourceCycle.name },
    targetCycle: { id: targetCycle.id, name: targetCycle.name },
    events,
  };
}

export async function commitCycleEventCopy({ prisma, sourceCycleId, targetCycleId, events, actorId, force = false }) {
  if (!sourceCycleId || !targetCycleId) {
    throw new Error('Source and target cycle IDs are required');
  }

  if (sourceCycleId === targetCycleId) {
    throw new Error('Source and target cycles must be different');
  }

  const [sourceCycle, targetCycle] = await Promise.all([
    prisma.recruitingCycle.findUnique({ where: { id: sourceCycleId } }),
    prisma.recruitingCycle.findUnique({ where: { id: targetCycleId } }),
  ]);

  if (!sourceCycle) throw new Error('Source recruiting cycle not found');
  if (!targetCycle) throw new Error('Target recruiting cycle not found');

  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('At least one event must be selected to copy');
  }

  // Load source events once for tamper/cross-cycle validation. Each committed
  // row must reference an event that actually exists in the selected source
  // cycle. The server never trusts arbitrary client-shaped payloads.
  const sourceEvents = await prisma.events.findMany({
    where: { cycleId: sourceCycleId },
    orderBy: { eventStartDate: 'asc' },
  });
  const sourceById = new Map(sourceEvents.map((e) => [e.id, e]));

  const validationErrors = [];

  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    const index = i + 1;

    if (!evt.sourceEventId) {
      validationErrors.push({ index, field: 'sourceEventId', message: 'Source event reference is required' });
      continue;
    }

    if (!sourceById.has(evt.sourceEventId)) {
      validationErrors.push({
        index,
        field: 'sourceEventId',
        message: 'Source event does not exist in the selected source cycle',
      });
      continue;
    }

    if (!evt.eventName || !evt.eventName.trim()) {
      validationErrors.push({ index, field: 'eventName', message: 'Event name is required' });
      continue;
    }

    const start = toIsoString(evt.eventStartDate);
    const end = toIsoString(evt.eventEndDate);

    if (!start) {
      validationErrors.push({ index, field: 'eventStartDate', message: 'Start date is required and must be valid' });
      continue;
    }
    if (!end) {
      validationErrors.push({ index, field: 'eventEndDate', message: 'End date is required and must be valid' });
      continue;
    }
    if (new Date(start) >= new Date(end)) {
      validationErrors.push({ index, field: 'eventEndDate', message: 'End date must be after start date' });
      continue;
    }

    if (evt.rsvpForm && !isValidUrl(evt.rsvpForm)) {
      validationErrors.push({ index, field: 'rsvpForm', message: 'RSVP form must be a valid URL' });
      continue;
    }
    if (evt.attendanceForm && !isValidUrl(evt.attendanceForm)) {
      validationErrors.push({ index, field: 'attendanceForm', message: 'Attendance form must be a valid URL' });
      continue;
    }
    if (evt.memberRsvpUrl && !isValidUrl(evt.memberRsvpUrl)) {
      validationErrors.push({ index, field: 'memberRsvpUrl', message: 'Member RSVP form must be a valid URL' });
      continue;
    }
    if (evt.memberAttendanceForm && !isValidUrl(evt.memberAttendanceForm)) {
      validationErrors.push({ index, field: 'memberAttendanceForm', message: 'Member attendance form must be a valid URL' });
      continue;
    }
  }

  if (validationErrors.length > 0) {
    const error = new Error('Validation failed for one or more events');
    error.name = 'ValidationError';
    error.validationErrors = validationErrors;
    throw error;
  }

  let created = [];
  let skipped = [];

  if (events.length > 0) {
    try {
      await prisma.$transaction(async (tx) => {
        // Serialize copy commits for this target cycle to prevent concurrent
        // duplicate inserts. The durable unique key (cycleId, copiedFromCycleId,
        // copiedFromEventId) makes reruns idempotent even when the target event
        // is later renamed.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('event_copy_' || ${targetCycleId})::bigint)`;

        const targetEvents = await tx.events.findMany({
          where: { cycleId: targetCycleId },
          select: {
            id: true,
            eventName: true,
            copiedFromEventId: true,
          },
        });
        const targetBySource = new Map(
          targetEvents.filter((e) => e.copiedFromEventId).map((e) => [e.copiedFromEventId, e])
        );
        const targetByName = new Map(targetEvents.map((e) => [e.eventName.toLowerCase(), e]));

        const eventsToCreate = [];

        for (let i = 0; i < events.length; i++) {
          const evt = events[i];
          const source = sourceById.get(evt.sourceEventId);
          const start = toIsoString(evt.eventStartDate);
          const end = toIsoString(evt.eventEndDate);

          // 1. Idempotent source→target provenance check.
          const existingBySource = targetBySource.get(evt.sourceEventId);
          if (existingBySource) {
            if (force) {
              skipped.push({
                sourceEventId: evt.sourceEventId,
                eventName: existingBySource.eventName,
                targetEventId: existingBySource.id,
                reason: 'copied_from_source_exists',
              });
              continue;
            }
            throw new Error(
              `Source event already copied to the target cycle as "${existingBySource.eventName}". Pass force=true to re-run.`
            );
          }

          // 2. Mutable name check against existing target events that were not
          // created by a copy (or where provenance was cleared), preserving the
          // pre-existing guard without depending on it for idempotency.
          const existingByName = targetByName.get(evt.eventName.toLowerCase());
          if (existingByName) {
            if (force) {
              skipped.push({
                sourceEventId: evt.sourceEventId,
                eventName: evt.eventName,
                targetEventId: existingByName.id,
                reason: 'name_conflict',
              });
              continue;
            }
            throw new Error(
              `An event named "${evt.eventName}" already exists in the target cycle. Pass force=true to re-run.`
            );
          }

          eventsToCreate.push({
            cycleId: targetCycleId,
            eventName: evt.eventName.trim(),
            eventStartDate: new Date(start),
            eventEndDate: new Date(end),
            eventLocation: evt.eventLocation ? evt.eventLocation.trim() : null,
            showToCandidates: Boolean(evt.showToCandidates),
            rsvpForm: evt.rsvpForm ? evt.rsvpForm.trim() : null,
            attendanceForm: evt.attendanceForm ? evt.attendanceForm.trim() : null,
            memberRsvpUrl: evt.memberRsvpUrl ? evt.memberRsvpUrl.trim() : null,
            memberAttendanceForm: evt.memberAttendanceForm ? evt.memberAttendanceForm.trim() : null,
            copiedFromCycleId: sourceCycleId,
            copiedFromEventId: evt.sourceEventId,
            copiedByUserId: actorId || null,
            copiedAt: new Date(),
            _sourceEventId: evt.sourceEventId,
            _sourceCycleId: sourceCycleId,
            _actorId: actorId,
          });
        }

        const inserted = eventsToCreate.length > 0
          ? await Promise.all(
              eventsToCreate.map((data) => {
                const { _sourceEventId, _sourceCycleId, _actorId, ...createData } = data;
                return tx.events.create({
                  data: createData,
                  select: {
                    id: true,
                    eventName: true,
                    eventStartDate: true,
                    eventEndDate: true,
                    eventLocation: true,
                    cycleId: true,
                    showToCandidates: true,
                    rsvpForm: true,
                    attendanceForm: true,
                    memberRsvpUrl: true,
                    memberAttendanceForm: true,
                    createdAt: true,
                    copiedFromCycleId: true,
                    copiedFromEventId: true,
                    copiedByUserId: true,
                    copiedAt: true,
                  },
                });
              })
            )
          : [];

        created = inserted.map((c) => ({
          ...c,
          sourceEventId: c.copiedFromEventId,
          sourceCycleId: c.copiedFromCycleId,
          actorId: c.copiedByUserId,
        }));
      });
    } catch (error) {
      // Surface a Prisma unique-constraint violation on the provenance key as a
      // deterministic conflict rather than a raw database error.
      if (error.code === 'P2002') {
        const target = error.meta?.target?.join('_');
        if (target && target.includes('events_cycleId_copiedFromCycleId_copiedFromEventId_key')) {
          throw new Error(
            'A source event was already copied to the target cycle by a concurrent request. Pass force=true to re-run.'
          );
        }
      }
      throw error;
    }
  }

  return {
    sourceCycle: { id: sourceCycle.id, name: sourceCycle.name },
    targetCycle: { id: targetCycle.id, name: targetCycle.name },
    created,
    skipped,
    copiedCount: created.length,
    skippedCount: skipped.length,
  };
}
