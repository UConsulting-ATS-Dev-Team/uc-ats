import apiClient from './api';
import { formatTimeRange } from './scheduleFormat';

/**
 * Place each application into one session, one request per person.
 *
 * Sequential rather than parallel: every placement takes the round lock on the
 * server, so firing them together only queues them there instead of here. One
 * failure does not stop the rest; the caller gets both lists and says which
 * names did not go through.
 */
export async function placeCandidates({ applications, slot, interviewId, force = false }) {
  const placed = [];
  const failed = [];
  // Seated, but the confirmation email could not be queued, so nobody told them.
  const unnotified = [];
  for (const application of applications) {
    try {
      const result = await apiClient.post(`/admin/interviews/${slot.interviewId ?? interviewId}/slot-signups`, {
        slotId: slot.id,
        applicationId: application.id,
        force,
      });
      placed.push(application);
      if (result?.emailQueued === false) unnotified.push(application);
    } catch (error) {
      failed.push({ application, message: error?.message || 'Failed' });
    }
  }
  return { placed, failed, unnotified };
}

/** "Added 3 to Morning Block." plus who did not make it, for a toast or an error line. */
export function describePlacement({ placed, failed, unnotified = [] }, slot) {
  const name = (a) => `${a.firstName ?? ''} ${a.lastName ?? ''}`.trim() || 'Unknown';
  const slotName = slot.label || formatTimeRange(slot.startTime, slot.endTime);
  const ok = placed.length ? `Added ${placed.length} to ${slotName}.` : '';
  const bad = [
    failed.length ? `Could not add ${failed.map((f) => `${name(f.application)} (${f.message})`).join(', ')}.` : '',
    unnotified.length
      ? `Added, but no confirmation email went out to ${unnotified.map(name).join(', ')}. Tell them their time directly.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { ok, bad };
}
