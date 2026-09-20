import { TEMPLATE_BUILDERS } from './emailNotifications.js';

/**
 * Preview for the transactional emails the ATS sends on its own.
 *
 * These are the emails nobody composes: they fire from a decision, a signup, a
 * password reset. Until now the only way to see one was to trigger it and read
 * your inbox. Each `create*Email` builder is pure, so rendering one with stand-in
 * arguments produces exactly the markup a real send would produce.
 *
 * Admin-composed blasts are a different system and are previewed elsewhere —
 * see `masterCommunications.js`, which renders `MessageTemplate` rows with merge
 * fields and can send a test copy to the author.
 */

// Fixed instants, not `new Date()`, so a preview of a given template is
// byte-identical every time it is rendered. Times are formatted in America/
// Los_Angeles downstream, so these land on Wed Oct 14 2026, 11:30am-12:00pm.
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

/**
 * Every previewable template: what it is, who receives it, what fires it, and
 * the arguments its builder is called with.
 *
 * `args` is positional and must match the builder's signature in
 * `emailNotifications.js`. A mismatch surfaces as a render failure in
 * `renderEmailTemplatePreview`, and the catalog test below renders all of them.
 */
const TEMPLATE_CATALOG = [
  {
    key: 'rsvp-confirmation',
    label: 'Event RSVP confirmation',
    description: 'Confirms a candidate is on the list for a recruitment event.',
    audience: 'Candidate',
    category: 'Events',
    trigger: 'Sent when an event RSVP form response syncs.',
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
    category: 'Decisions',
    trigger: 'Queued by Process Application Decisions, sent from Master Communications.',
    args: [SAMPLE_CANDIDATE, SAMPLE_CYCLE],
  },
  {
    key: 'application-rejection',
    label: 'Application declined',
    description: 'Tells a candidate their written application did not move forward.',
    audience: 'Candidate',
    category: 'Decisions',
    trigger: 'Queued by Process Application Decisions, sent from Master Communications.',
    args: [SAMPLE_CANDIDATE, SAMPLE_CYCLE],
  },
  {
    key: 'coffee-chat-acceptance',
    label: 'Coffee chat advanced',
    description: 'Tells a candidate they advanced past the coffee chat round.',
    audience: 'Candidate',
    category: 'Decisions',
    trigger: 'Queued by Process Coffee Chat Decisions, sent from Master Communications.',
    args: [SAMPLE_CANDIDATE, SAMPLE_CYCLE],
  },
  {
    key: 'coffee-chat-rejection',
    label: 'Coffee chat declined',
    description: 'Tells a candidate they did not advance past the coffee chat round.',
    audience: 'Candidate',
    category: 'Decisions',
    trigger: 'Queued by Process Coffee Chat Decisions, sent from Master Communications.',
    args: [SAMPLE_CANDIDATE, SAMPLE_CYCLE],
  },
  {
    key: 'first-round-acceptance',
    label: 'First round advanced',
    description: 'Tells a candidate they advanced past the first-round interview.',
    audience: 'Candidate',
    category: 'Decisions',
    trigger: 'Queued by Process First Round Decisions, sent from Master Communications.',
    args: [SAMPLE_CANDIDATE, SAMPLE_CYCLE],
  },
  {
    key: 'first-round-rejection',
    label: 'First round declined',
    description: 'Tells a candidate they did not advance past the first-round interview.',
    audience: 'Candidate',
    category: 'Decisions',
    trigger: 'Queued by Process First Round Decisions, sent from Master Communications.',
    args: [SAMPLE_CANDIDATE, SAMPLE_CYCLE],
  },
  {
    key: 'final-acceptance',
    label: 'Final round accepted',
    description: 'Tells a candidate they have been offered membership.',
    audience: 'Candidate',
    category: 'Decisions',
    trigger: 'Queued by Process Final Round Decisions, sent from Master Communications.',
    args: [SAMPLE_CANDIDATE, SAMPLE_CYCLE],
  },
  {
    key: 'final-rejection',
    label: 'Final round declined',
    description: 'Tells a candidate they were not offered membership.',
    audience: 'Candidate',
    category: 'Decisions',
    trigger: 'Queued by Process Final Round Decisions, sent from Master Communications.',
    args: [SAMPLE_CANDIDATE, SAMPLE_CYCLE],
  },
  {
    key: 'offer-letter',
    label: 'Offer letter',
    description: 'Delivers the formal offer, usually with the letter attached as a PDF.',
    audience: 'Candidate',
    category: 'Decisions',
    trigger: 'Sent when an admin issues an offer letter from the application page.',
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
];

const CATALOG_BY_KEY = new Map(TEMPLATE_CATALOG.map((entry) => [entry.key, entry]));

export class UnknownEmailTemplateError extends Error {
  constructor(key) {
    super(`Unknown email template: ${key}`);
    this.name = 'UnknownEmailTemplateError';
    this.key = key;
  }
}

/** Every previewable template, without rendering any of them. */
export function listEmailTemplates() {
  return TEMPLATE_CATALOG.map(({ args, ...meta }) => meta);
}

/**
 * Render one template with its sample arguments.
 *
 * Returns the same { subject, html } the send path would hand the transporter,
 * so what an admin sees here is what a recipient gets.
 */
export function renderEmailTemplatePreview(key) {
  const entry = CATALOG_BY_KEY.get(key);
  const builder = TEMPLATE_BUILDERS[key];

  if (!entry || !builder) {
    throw new UnknownEmailTemplateError(key);
  }

  const { subject, html } = builder(...entry.args);

  return {
    key: entry.key,
    label: entry.label,
    description: entry.description,
    audience: entry.audience,
    category: entry.category,
    trigger: entry.trigger,
    subject,
    html,
  };
}

export { TEMPLATE_CATALOG };
