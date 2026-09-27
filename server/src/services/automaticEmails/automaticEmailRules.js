import { APPLICATION_STATUSES } from '../audiences/audienceFilters.js';

/**
 * What can send an admin-written automatic email, and what each trigger can
 * say in it.
 *
 * Every trigger answers the same three questions for the runner: which
 * configuration it takes (validated here), which merge fields it can fill in
 * (so a save can refuse `{{eventNme}}` before a candidate reads it), and what
 * sample values stand in for a preview. Finding who it fires for is
 * automaticEmailFinders.js; this file is only the contract.
 *
 * One rule governs all of them: nothing that happened before an email was
 * enabled triggers it. Turning on "when an application is rejected" must not
 * email everyone rejected last cycle.
 */

const PERSON_FIELDS = ['firstName', 'lastName', 'fullName', 'email'];

// A trigger whose moment is relative to a date: how far before or after, in
// hours, and a cap so a typo cannot schedule something for next year.
const MAX_OFFSET_HOURS = 24 * 60;

export const RECORD_KINDS = {
  APPLICATION: { label: 'An application is submitted', fields: ['cycleName'] },
  EVENT_RSVP: { label: 'A candidate RSVPs to an event', fields: ['eventName', 'eventDate', 'eventLocation'] },
  GTKUC_SIGNUP: { label: 'Someone books a Get to Know UC slot', fields: ['memberName', 'meetingTime', 'meetingLocation'] },
  ACCOUNT: { label: 'An account is created', fields: [] },
};

export const CYCLE_DATE_FIELDS = {
  applicationDeadline: 'Application deadline',
  startDate: 'Cycle start',
  endDate: 'Cycle end',
};

export const TRIGGERS = {
  APPLICATION_STATUS: {
    label: 'An application reaches a status',
    fields: ['cycleName', 'status'],
  },
  RECORD_CREATED: {
    label: 'Something is created',
  },
  EVENT_TIME: {
    label: 'Before or after an event a candidate RSVPed to',
    fields: ['eventName', 'eventDate', 'eventLocation'],
  },
  INTERVIEW_TIME: {
    label: 'Before or after a candidate\'s interview',
    fields: ['interviewTitle', 'interviewTime', 'interviewLocation'],
  },
  CYCLE_DATE: {
    label: 'Before or after a cycle date, to a saved audience',
    fields: ['cycleName', 'date'],
  },
};

export const TRIGGER_TYPES = Object.keys(TRIGGERS);

const fail = (message) => Object.assign(new Error(message), { status: 400, code: 'INVALID_TRIGGER' });

function offsetHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw fail('The offset must be a whole number of hours');
  if (Math.abs(n) > MAX_OFFSET_HOURS) throw fail(`The offset can be at most ${MAX_OFFSET_HOURS / 24} days`);
  return n;
}

/** Validates a trigger's configuration. Returns the cleaned copy. */
export function normalizeTrigger(trigger, config = {}) {
  if (!TRIGGERS[trigger]) throw fail('Unknown trigger');
  const c = config && typeof config === 'object' && !Array.isArray(config) ? config : {};

  switch (trigger) {
    case 'APPLICATION_STATUS':
      if (!APPLICATION_STATUSES.includes(c.status)) throw fail('Pick a status');
      return { status: c.status };
    case 'RECORD_CREATED':
      if (!RECORD_KINDS[c.record]) throw fail('Pick what is created');
      return { record: c.record };
    case 'EVENT_TIME':
    case 'INTERVIEW_TIME':
      return { offsetHours: offsetHours(c.offsetHours) };
    case 'CYCLE_DATE': {
      if (!CYCLE_DATE_FIELDS[c.field]) throw fail('Pick a cycle date');
      if (!c.savedAudienceId || typeof c.savedAudienceId !== 'string') throw fail('Pick a saved audience to send to');
      return { field: c.field, offsetHours: offsetHours(c.offsetHours), savedAudienceId: c.savedAudienceId };
    }
    default:
      throw fail('Unknown trigger');
  }
}

/** The merge fields an email with this trigger may use. */
export function mergeFieldsFor(trigger, config = {}) {
  const extra = trigger === 'RECORD_CREATED' ? RECORD_KINDS[config.record]?.fields ?? [] : TRIGGERS[trigger]?.fields ?? [];
  return [...PERSON_FIELDS, ...extra];
}

/** Stand-ins for previews and tests. Never sent to anyone but the admin asking. */
export const SAMPLE_VALUES = {
  firstName: 'Jordan',
  lastName: 'Rivera',
  fullName: 'Jordan Rivera',
  email: 'jordan.rivera@g.ucla.edu',
  cycleName: 'Fall 2026 Recruitment',
  status: 'Under review',
  eventName: 'Info Session',
  eventDate: 'Wednesday, October 14, 2026, 6:00 PM',
  eventLocation: 'Ackerman Union, Room 2408',
  memberName: 'Avery Chen',
  meetingTime: 'Wednesday, October 14, 2026, 11:30 AM',
  meetingLocation: 'Kerckhoff Coffee House',
  interviewTitle: 'First Round Interviews',
  interviewTime: 'Friday, October 16, 2026, 2:00 PM',
  interviewLocation: 'Bunche Hall 3150',
  date: 'Sunday, October 11, 2026, 11:59 PM',
};

const STATUS_LABELS = {
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  WAITLISTED: 'Waitlisted',
};

export const statusLabel = (status) => STATUS_LABELS[status] ?? status;

const hoursPhrase = (hours) => {
  const abs = Math.abs(hours);
  const unit = abs % 24 === 0 && abs >= 24 ? `${abs / 24} day${abs === 24 ? '' : 's'}` : `${abs} hour${abs === 1 ? '' : 's'}`;
  if (hours === 0) return 'at';
  return `${unit} ${hours < 0 ? 'before' : 'after'}`;
};

/** One line an admin can read in the list, e.g. "2 days before an event they RSVPed to". */
export function describeTrigger(trigger, config = {}) {
  switch (trigger) {
    case 'APPLICATION_STATUS':
      return `When an application becomes ${statusLabel(config.status)}`;
    case 'RECORD_CREATED':
      return RECORD_KINDS[config.record]?.label ?? 'When something is created';
    case 'EVENT_TIME':
      return `${hoursPhrase(config.offsetHours)} the start of an event they RSVPed to`;
    case 'INTERVIEW_TIME':
      return `${hoursPhrase(config.offsetHours)} the start of their interview`;
    case 'CYCLE_DATE':
      return `${hoursPhrase(config.offsetHours)} the ${CYCLE_DATE_FIELDS[config.field]?.toLowerCase() ?? 'cycle date'}, to a saved audience`;
    default:
      return trigger;
  }
}
