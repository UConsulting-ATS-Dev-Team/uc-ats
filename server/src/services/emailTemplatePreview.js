import {
  TEMPLATE_BUILDERS,
  SLOT_EMAIL_TYPES,
  SLOT_NOTIFICATION_SUBJECTS,
  renderInterviewSlotEmail,
} from './emailNotifications.js';
import { defaultDecisionTemplates, renderDecisionEmail } from './decisionTemplates.js';

/**
 * Preview for every message the ATS sends without anyone composing it.
 *
 * Three separate systems write these emails, which is the first thing worth
 * knowing about them:
 *
 *   - `emailNotifications.js` builds 15 one-off emails from hardcoded HTML.
 *   - `renderInterviewSlotEmail` writes the 12 interview-slot notifications
 *     from a shared layout keyed by notification type.
 *   - `decisionTemplates.js` holds the round decision wording as Markdown with
 *     merge fields. Those already have an editor: an admin can rewrite them per
 *     batch in Master Communications before the batch goes out.
 *
 * All three end up at `sendEmail`, and none of them could be read anywhere in
 * the app before this. Rendering is pure in all three, so a preview is the
 * render call with the send left off.
 *
 * Master Communications itself is not catalogued. Nothing there is automatic:
 * an admin writes each message, and it already previews what it will send.
 */

// Fixed instants rather than `new Date()`, so a template previews identically
// every time and the tests can assert on the output. Formatted downstream in
// America/Los_Angeles, these land on Wed Oct 14 2026, 11:30am-12:00pm.
const SAMPLE_START = '2026-10-14T18:30:00.000Z';
const SAMPLE_END = '2026-10-14T19:00:00.000Z';
const SAMPLE_PREVIOUS_START = '2026-10-12T17:00:00.000Z';
const SAMPLE_PREVIOUS_END = '2026-10-12T17:30:00.000Z';

const SAMPLE_CANDIDATE = 'Jordan Rivera';
const SAMPLE_MEMBER = 'Avery Chen';
const SAMPLE_CYCLE = 'Fall 2026 Recruitment';
const SAMPLE_EVENT = 'Fall 2026 Information Session';
const SAMPLE_EVENT_DATE = 'Thursday, October 8, 2026, 6:00 PM';
const SAMPLE_LOCATION = 'Ackerman Union, Room 2408';
const SAMPLE_INTERVIEW_TITLE = 'First Round Interviews';

const SAMPLE_MEETING = {
  startTime: SAMPLE_START,
  endTime: SAMPLE_END,
  location: SAMPLE_LOCATION,
};

const SAMPLE_PREVIOUS_MEETING = {
  startTime: SAMPLE_PREVIOUS_START,
  endTime: SAMPLE_PREVIOUS_END,
  location: 'Kerckhoff Hall, Room 133',
};

// Where a template's wording lives today, which is also where it would have to
// be edited. The preview page shows this, because "can we change this email?"
// was the question that produced the page.
const SOURCE = {
  TRANSACTIONAL: {
    id: 'emailNotifications',
    label: 'Hardcoded in emailNotifications.js',
    editable: false,
  },
  SLOT: {
    id: 'interviewSlot',
    label: 'Hardcoded in renderInterviewSlotEmail',
    editable: false,
  },
  DECISION: {
    id: 'decisionBatch',
    label: 'Editable per batch in Master Communications',
    editable: true,
  },
};

/** The 15 one-off emails built from hardcoded HTML. */
const TRANSACTIONAL = [
  {
    key: 'rsvp-confirmation',
    label: 'Event RSVP confirmation',
    description: 'Confirms a candidate is on the list for a recruitment event.',
    audience: 'Candidate',
    category: 'Events',
    trigger: 'Sent when an event RSVP form response syncs.',
    // The real send also attaches an .ics when the caller passes the event row.
    // A builder cannot know that, so the preview says so rather than implying
    // the email arrives bare.
    alsoAttaches: 'A calendar invite (.ics), when the caller supplies the event.',
    args: [SAMPLE_CANDIDATE, SAMPLE_EVENT, SAMPLE_EVENT_DATE, SAMPLE_LOCATION],
  },
  {
    key: 'attendance-confirmation',
    label: 'Event attendance confirmation',
    description: 'Confirms a candidate was marked present at an event.',
    audience: 'Candidate',
    category: 'Events',
    trigger: 'Sent when an event attendance form response syncs.',
    args: [SAMPLE_CANDIDATE, SAMPLE_EVENT, SAMPLE_EVENT_DATE, SAMPLE_LOCATION],
  },
  {
    key: 'application-acceptance',
    label: 'Application advanced',
    description: 'Tells a candidate their written application moved forward.',
    audience: 'Candidate',
    category: 'Applications',
    trigger: 'Sent from the application page in admin.js. The round decision emails are separate.',
    args: [SAMPLE_CANDIDATE, SAMPLE_CYCLE],
  },
  {
    key: 'application-rejection',
    label: 'Application declined',
    description: 'Tells a candidate their written application did not move forward.',
    audience: 'Candidate',
    category: 'Applications',
    trigger: 'Sent from the application page in admin.js. The round decision emails are separate.',
    args: [SAMPLE_CANDIDATE, SAMPLE_CYCLE],
  },
  {
    key: 'offer-letter',
    label: 'Offer letter',
    description: 'Delivers the formal offer, usually with the letter attached as a PDF.',
    audience: 'Candidate',
    category: 'Applications',
    trigger: 'Sent when an admin issues an offer letter.',
    alsoAttaches: 'The offer letter PDF, when one was generated.',
    args: [
      SAMPLE_CANDIDATE,
      SAMPLE_CYCLE,
      {
        position: 'Junior Consultant',
        startDate: 'Monday, January 5, 2027',
        responseDeadline: 'Friday, December 12, 2026',
        additionalNotes: 'Please bring a signed copy of the member agreement to onboarding.',
      },
    ],
  },
  {
    key: 'meeting-signup-confirmation',
    label: 'GTKUC signup confirmation',
    description: 'Confirms a candidate booked a Get to Know UC slot.',
    audience: 'Candidate',
    category: 'Get to Know UC',
    trigger: 'Sent when a candidate books a meeting slot.',
    args: [SAMPLE_CANDIDATE, SAMPLE_MEMBER, SAMPLE_LOCATION, SAMPLE_START, SAMPLE_END],
  },
  {
    key: 'meeting-signup-notification',
    label: 'GTKUC signup notice to member',
    description: 'Tells the hosting member who just booked one of their slots.',
    audience: 'Member',
    category: 'Get to Know UC',
    trigger: 'Sent to the slot owner when a candidate books.',
    args: [
      SAMPLE_MEMBER,
      SAMPLE_CANDIDATE,
      'jordan.rivera@ucla.edu',
      '405123456',
      SAMPLE_LOCATION,
      SAMPLE_START,
      SAMPLE_END,
    ],
  },
  {
    key: 'meeting-cancellation-candidate',
    label: 'GTKUC cancellation to candidate',
    description: 'Tells a candidate their booked meeting was cancelled.',
    audience: 'Candidate',
    category: 'Get to Know UC',
    trigger: 'Sent when a member or admin cancels a booked slot.',
    args: [SAMPLE_CANDIDATE, SAMPLE_MEMBER, SAMPLE_LOCATION, SAMPLE_START, SAMPLE_END],
  },
  {
    key: 'meeting-cancellation-member',
    label: 'GTKUC cancellation to member',
    description: 'Tells the hosting member their slot was cancelled, and who it affected.',
    audience: 'Member',
    category: 'Get to Know UC',
    trigger: 'Sent when a candidate cancels, or when an admin removes the slot.',
    args: [
      SAMPLE_MEMBER,
      SAMPLE_LOCATION,
      SAMPLE_START,
      SAMPLE_END,
      { candidateName: SAMPLE_CANDIDATE, signupCount: 1 },
    ],
  },
  {
    key: 'meeting-reschedule-candidate',
    label: 'GTKUC reschedule to candidate',
    description: 'Tells a candidate their meeting moved, striking through the old details.',
    audience: 'Candidate',
    category: 'Get to Know UC',
    trigger: 'Sent when an admin or member moves a slot that already has signups.',
    args: [SAMPLE_CANDIDATE, SAMPLE_MEMBER, SAMPLE_MEETING, SAMPLE_PREVIOUS_MEETING],
  },
  {
    key: 'meeting-reschedule-member',
    label: 'GTKUC reschedule to member',
    description: 'Tells the hosting member their slot moved and how many candidates were notified.',
    audience: 'Member',
    category: 'Get to Know UC',
    trigger: 'Sent to the slot owner when their slot is moved.',
    args: [SAMPLE_MEMBER, SAMPLE_MEETING, SAMPLE_PREVIOUS_MEETING, { signupCount: 2 }],
  },
  {
    key: 'password-reset',
    label: 'Password reset link',
    description: 'Carries the one-time link that starts a password reset.',
    audience: 'Any account',
    category: 'Account',
    trigger: 'Sent when someone requests a reset from the forgot-password page.',
    args: ['https://uconsultingats.com/reset-password?token=sample-preview-token'],
  },
  {
    key: 'password-reset-confirmation',
    label: 'Password reset confirmed',
    description: 'Confirms a password was changed, so an unexpected change is visible.',
    audience: 'Any account',
    category: 'Account',
    trigger: 'Sent after a password reset completes.',
    args: [SAMPLE_CANDIDATE],
  },
  {
    key: 'reviewer-reminder',
    label: 'Reviewer grading reminder',
    description: 'Nudges a review team member with their outstanding grading counts.',
    audience: 'Member',
    category: 'Review teams',
    trigger: 'Sent when an admin sends reminders from Review Teams.',
    args: [
      SAMPLE_MEMBER,
      'Review Team 3',
      SAMPLE_CYCLE,
      {
        completed: { resume: 8, coverLetter: 6, video: 4 },
        eligible: { resume: 12, coverLetter: 12, video: 12 },
        completedTotal: 18,
        expectedTotal: 36,
        completionPercent: 50,
        gradingUrl: 'https://uconsultingats.com/document-grading',
      },
    ],
  },
  {
    key: 'email-verification',
    label: 'Email verification link',
    description: 'Verifies a self-registered talent portal address.',
    audience: 'Talent portal',
    category: 'Account',
    trigger: 'Sent on external talent registration, before uploads are allowed.',
    args: [SAMPLE_CANDIDATE, 'https://uconsultingats.com/verify-email?token=sample-preview-token'],
  },
].map((entry) => ({
  ...entry,
  source: SOURCE.TRANSACTIONAL,
  render: () => {
    const builder = TEMPLATE_BUILDERS[entry.key];
    if (!builder) throw new Error(`No builder registered for ${entry.key}`);
    return builder(...entry.args);
  },
}));

const SAMPLE_ROSTER = [
  { groupLabel: '1A', application: { firstName: 'Jordan', lastName: 'Rivera' } },
  { groupLabel: '1B', application: { firstName: 'Sam', lastName: 'Okafor' } },
];

/**
 * A stand-in InterviewSlotNotification, loaded the way the flush path loads it.
 *
 * `withSession: false` is the shape a message about the whole interview takes:
 * no slot has been chosen yet, so the interview is the only thing that can name
 * it. AVAILABILITY_REQUEST is the one that actually arrives that way.
 */
function slotNotification(type, { withSession = true, roster = null } = {}) {
  return {
    type,
    slot: withSession
      ? {
          startTime: SAMPLE_START,
          endTime: SAMPLE_END,
          location: SAMPLE_LOCATION,
          label: 'Session 2',
          interview: { title: SAMPLE_INTERVIEW_TITLE, location: SAMPLE_LOCATION },
        }
      : {},
    interview: { title: SAMPLE_INTERVIEW_TITLE },
    signup: { application: { firstName: 'Jordan', lastName: 'Rivera' } },
    candidateRoster: roster,
  };
}

const SLOT_META = {
  CONFIRMATION: {
    label: 'Interview slot confirmed',
    description: 'Confirms the session a candidate picked. This is the interview signup confirmation.',
    audience: 'Candidate',
    trigger: 'Sent when a candidate books an interview slot.',
    alsoAttaches: 'A calendar invite (.ics).',
  },
  WAITLIST_ADDED: {
    label: 'Booked, and waitlisted for a preferred time',
    description: 'Their first choice was full, so they hold a different seat and wait for it.',
    audience: 'Candidate',
    trigger: 'Sent when a candidate books and their preferred slot is full.',
    options: { preferredSlotName: 'Session 1' },
  },
  PROMOTED: {
    label: 'Moved into a preferred time',
    description: 'A seat opened in the slot they wanted and they were moved automatically.',
    audience: 'Candidate',
    trigger: 'Sent when a waitlisted candidate is promoted.',
  },
  FALLBACK_RELEASED: {
    label: 'Fallback booking released',
    description: 'Their earlier holding slot was given up after they got the one they asked for.',
    audience: 'Candidate',
    trigger: 'Sent alongside a promotion, about the seat being released.',
  },
  CANCELLATION: {
    label: 'Interview booking cancelled',
    description: 'Tells a candidate their interview seat is gone.',
    audience: 'Candidate',
    trigger: 'Sent when a booking is cancelled.',
  },
  MOVED_BY_ADMIN: {
    label: 'Interview time changed by recruitment',
    description: 'Recruitment moved the candidate to a different session.',
    audience: 'Candidate',
    trigger: 'Sent when an admin moves a booked candidate.',
  },
  ADMIN_OVERFLOW_ALERT: {
    label: 'Candidate could not be scheduled',
    description: 'Warns recruitment that every slot was full when a candidate tried to book.',
    audience: 'Admin',
    trigger: 'Sent to admins when a signup finds no free slot.',
  },
  AVAILABILITY_REQUEST: {
    label: 'When can you interview?',
    description: 'Asks members for the times they can interview, before the day is cut into sessions.',
    audience: 'Member',
    trigger: 'Sent when an admin requests availability from the interviewers tab.',
    withSession: false,
  },
  INTERVIEWER_ASSIGNED: {
    label: 'You are interviewing',
    description: 'Tells a member which session they are running, and who they will see.',
    audience: 'Member',
    trigger: 'Sent when an interviewer is placed on a session, or signs themselves up.',
    alsoAttaches: 'A calendar invite (.ics).',
    roster: SAMPLE_ROSTER,
  },
  INTERVIEWER_MOVED: {
    label: 'Your session has changed',
    description: 'Tells a member recruitment moved which session they are running.',
    audience: 'Member',
    trigger: 'Sent when an admin moves an interviewer between sessions.',
    options: { fromSlotName: 'Session 1' },
    roster: SAMPLE_ROSTER,
  },
  INTERVIEWER_REMOVED: {
    label: 'Taken off a session',
    description: 'Tells a member they are no longer interviewing at a session.',
    audience: 'Member',
    trigger: 'Sent when an admin removes an interviewer from a session.',
  },
  REMINDER: {
    label: 'Interview reminder',
    description: 'Reminds a candidate about a booking that is coming up.',
    audience: 'Candidate',
    trigger: 'Sent ahead of a booked interview.',
  },
};

/** The 12 interview-slot notifications, all drawn by one renderer. */
const SLOT = SLOT_EMAIL_TYPES.map((type) => {
  const meta = SLOT_META[type];
  if (!meta) throw new Error(`No preview metadata for slot notification ${type}`);

  const notification = slotNotification(type, {
    withSession: meta.withSession !== false,
    roster: meta.roster ?? null,
  });

  return {
    key: `slot-${type.toLowerCase().replace(/_/g, '-')}`,
    label: meta.label,
    description: meta.description,
    audience: meta.audience,
    category: 'Interview scheduling',
    trigger: meta.trigger,
    alsoAttaches: meta.alsoAttaches,
    source: SOURCE.SLOT,
    render: () => ({
      subject: SLOT_NOTIFICATION_SUBJECTS[type](SAMPLE_INTERVIEW_TITLE),
      html: renderInterviewSlotEmail(notification, {
        ctaUrl: 'https://uconsultingats.com/interview-signup',
        ...(meta.options ?? {}),
      }),
    }),
  };
});

const DECISION_ROUNDS = [
  { round: 1, name: 'Application' },
  { round: 2, name: 'Coffee chat' },
  { round: 3, name: 'First round' },
  { round: 4, name: 'Final round' },
];

const DECISION_OUTCOME_LABELS = {
  ADVANCED: 'advanced',
  ACCEPTED: 'accepted',
  REJECTED: 'declined',
};

const SAMPLE_DECISION_RECIPIENT = {
  firstName: 'Jordan',
  lastName: 'Rivera',
  needsInvite: true,
  userId: null,
};

/**
 * The round decision emails, shown at their defaults.
 *
 * An admin can already rewrite any of these for a specific batch before sending
 * it, so what a candidate receives may differ from what is here. The defaults
 * are still worth showing: they are what every new batch starts from.
 */
const DECISION = DECISION_ROUNDS.flatMap(({ round, name }) => {
  const templates = defaultDecisionTemplates(round);

  return Object.entries(templates).map(([outcome, template]) => ({
    key: `decision-round-${round}-${outcome.toLowerCase()}`,
    label: `${name} ${DECISION_OUTCOME_LABELS[outcome] ?? outcome.toLowerCase()}`,
    description: `Default wording for a ${name.toLowerCase()} decision of ${outcome}.`,
    audience: 'Candidate',
    category: 'Round decisions',
    trigger: 'Queued by decision processing, reviewed and sent in Master Communications.',
    source: SOURCE.DECISION,
    render: () =>
      renderDecisionEmail(template, SAMPLE_DECISION_RECIPIENT, {
        cycleName: SAMPLE_CYCLE,
        round,
        preview: true,
        loginUrl: 'https://uconsultingats.com/login',
      }),
  }));
});

const TEMPLATE_CATALOG = [...TRANSACTIONAL, ...SLOT, ...DECISION];

const CATALOG_BY_KEY = new Map(TEMPLATE_CATALOG.map((entry) => [entry.key, entry]));

export class UnknownEmailTemplateError extends Error {
  constructor(key) {
    super(`Unknown email template: ${key}`);
    this.name = 'UnknownEmailTemplateError';
    this.key = key;
  }
}

function describe(entry) {
  return {
    key: entry.key,
    label: entry.label,
    description: entry.description,
    audience: entry.audience,
    category: entry.category,
    trigger: entry.trigger,
    alsoAttaches: entry.alsoAttaches ?? null,
    source: entry.source.id,
    sourceLabel: entry.source.label,
    editable: entry.source.editable,
  };
}

/** Every previewable template, without rendering any of them. */
export function listEmailTemplates() {
  return TEMPLATE_CATALOG.map(describe);
}

/**
 * Render one template with its sample arguments.
 *
 * Returns the same { subject, html } the send path would hand the transporter.
 * Attachments are the one thing a preview cannot show, so a template that
 * carries one says so in `alsoAttaches`.
 */
export function renderEmailTemplatePreview(key) {
  const entry = CATALOG_BY_KEY.get(key);
  if (!entry) throw new UnknownEmailTemplateError(key);

  const { subject, html } = entry.render();

  return { ...describe(entry), subject, html };
}

export { TEMPLATE_CATALOG };
