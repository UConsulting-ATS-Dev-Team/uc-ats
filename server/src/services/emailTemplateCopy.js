import prisma from '../prismaClient.js';
import { mergeFieldsUsed } from './emailCopyRender.js';

/**
 * The wording of every automatic email, in one place, with an admin able to
 * change it.
 *
 * Until this existed the sentences lived inside the HTML that draws them, which
 * made "can we reword the rejection email?" a pull request. What moved out is
 * the copy only. What deliberately did not move:
 *
 *   - the layout, the coloured banner and the footer
 *   - the cards built from data (When/Where, Offer Details, grading progress) -
 *     an admin cannot hand-write a candidate's interview time
 *   - the call-to-action buttons, whose labels have to match where they point
 *   - attachments
 *
 * So an edit can change what an email says and cannot change whether it works.
 *
 * A template declares its fields with the wording the repo ships. An admin's
 * row overrides field by field: anything they leave blank keeps the shipped
 * wording, and deleting the row restores all of it. That is the same layering
 * decisionGuides.js uses, for the same reason - a half-filled row should read
 * correctly rather than show gaps.
 *
 * Merge fields are `{{likeThis}}`. Each template declares the ones it can
 * supply, and saving validates against that list, so an admin cannot ship a
 * placeholder that renders as literal braces to a candidate.
 */

const line = (name, label, defaultValue, help) => ({ name, label, type: 'line', default: defaultValue, help });
const block = (name, label, defaultValue, help) => ({ name, label, type: 'block', default: defaultValue, help });
const signOff = (defaultValue) => ({
  name: 'signOff',
  label: 'Sign-off',
  type: 'signoff',
  default: defaultValue,
  help: 'One line per line of the sign-off.',
});

const ATS_TEAM = 'Best regards,\nUConsulting ATS Team';
const RECRUITMENT_TEAM = 'Best regards,\nUConsulting Recruitment Team';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const EVENT_FIELDS = ['candidateName', 'eventName', 'eventDate', 'eventLocation'];

const RSVP_CONFIRMATION = {
  mergeFields: EVENT_FIELDS,
  fields: [
    line('subject', 'Subject', 'RSVP Confirmation - {{eventName}}'),
    line('heading', 'Heading', 'RSVP Confirmation'),
    line('greeting', 'Greeting', 'Dear {{candidateName}},'),
    block('intro', 'Before the event details', 'Thank you for your RSVP! We have successfully received your response for the following event:'),
    block(
      'outro',
      'After the event details',
      "We look forward to seeing you at the event! If you have any questions or need to make changes to your RSVP, please don't hesitate to contact us."
    ),
    signOff(ATS_TEAM),
  ],
};

const ATTENDANCE_CONFIRMATION = {
  mergeFields: EVENT_FIELDS,
  fields: [
    line('subject', 'Subject', 'Attendance Confirmation - {{eventName}}'),
    line('heading', 'Heading', 'Attendance Confirmation'),
    line('greeting', 'Greeting', 'Dear {{candidateName}},'),
    block('intro', 'Before the event details', 'Thank you for attending our event! We have successfully recorded your attendance for the following event:'),
    block(
      'outro',
      'After the event details',
      'We appreciate your participation and hope you found the event valuable. If you have any feedback or questions, please feel free to reach out to us.'
    ),
    signOff(ATS_TEAM),
  ],
};

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

const APPLICATION_ACCEPTANCE = {
  mergeFields: ['candidateName', 'cycleName'],
  fields: [
    line('subject', 'Subject', "Congratulations! You've Advanced to Coffee Chats - {{cycleName}}"),
    line('heading', 'Heading', "🎉 Congratulations! You've Advanced!"),
    line('greeting', 'Greeting', 'Dear {{candidateName}},'),
    block(
      'intro',
      'Opening',
      "We're excited to inform you that you have successfully advanced to the **Coffee Chats** round of our recruitment process for the **{{cycleName}}** cycle!"
    ),
    line('highlightsTitle', 'Green box title', 'What This Means'),
    block(
      'highlights',
      'Green box',
      "✅ You've successfully passed the Resume Review round\n\n☕ You'll be invited to participate in Coffee Chats\n\n📅 You'll receive scheduling information soon"
    ),
    block(
      'outro',
      'Closing',
      'This is a significant achievement and demonstrates the quality of your application. We look forward to getting to know you better during the Coffee Chats round.\n\nYou will receive additional information about scheduling and preparation for the Coffee Chats round in the coming days.'
    ),
    signOff(RECRUITMENT_TEAM),
  ],
};

const APPLICATION_REJECTION = {
  mergeFields: ['candidateName', 'cycleName'],
  fields: [
    line('subject', 'Subject', 'Update on Your Application - {{cycleName}}'),
    line('heading', 'Heading', 'Application Update'),
    line('greeting', 'Greeting', 'Dear {{candidateName}},'),
    block(
      'intro',
      'Opening',
      'Thank you for your interest in UConsulting and for taking the time to apply to our **{{cycleName}}** recruitment cycle.\n\nAfter careful review of your application, we regret to inform you that we are unable to move forward with your candidacy at this time.'
    ),
    line('highlightsTitle', 'Red box title', 'Important Information'),
    block(
      'highlights',
      'Red box',
      '📝 Your application has been reviewed thoroughly\n\n💼 We encourage you to apply to future cycles\n\n🌟 Continue developing your skills and experience'
    ),
    block(
      'outro',
      'Closing',
      'We appreciate the time and effort you put into your application. We received many strong applications this cycle, and the decision was not easy.\n\nWe encourage you to continue developing your skills and to consider applying to future recruitment cycles. Your growth and development are important to us.'
    ),
    signOff(RECRUITMENT_TEAM),
  ],
};

const OFFER_LETTER = {
  mergeFields: ['candidateName', 'cycleName', 'position', 'startDate', 'responseDeadline'],
  fields: [
    line('subject', 'Subject', 'Offer Letter - UConsulting {{cycleName}}'),
    line('heading', 'Heading', 'Congratulations, {{candidateName}}!'),
    block('intro', 'Before the offer details', 'We are delighted to offer you a position with **UConsulting** for the **{{cycleName}}** cycle.'),
    block(
      'outro',
      'After the offer details',
      'Please review the attached PDF for the full official offer letter, sign it, and return it before the response deadline. If you have any questions, feel free to reach out.\n\nWe look forward to having you on the team!'
    ),
    signOff(RECRUITMENT_TEAM),
  ],
};

// ---------------------------------------------------------------------------
// Get to Know UC
// ---------------------------------------------------------------------------

const MEETING_SIGNUP_CONFIRMATION = {
  mergeFields: ['candidateName', 'memberName', 'location'],
  fields: [
    line('subject', 'Subject', 'Time Slot Confirmation - Get to Know UC'),
    line('greeting', 'Greeting', 'Dear {{candidateName}},'),
    block('intro', 'Before the meeting details', "Thank you for signing up to meet with a UConsulting member! We're excited to get to know you better."),
    line('highlightsTitle', 'Grey box title', 'What to Expect'),
    block(
      'highlights',
      'Grey box',
      '• This is a casual chat to learn more about UC\n\n• Feel free to ask questions about our organization, projects, and culture\n\n• This is a great opportunity to connect with current members\n\n• No preparation required - just come ready to chat!'
    ),
    block(
      'outro',
      'Closing',
      'Need to cancel or change your time slot? You can manage everything by logging into your [ATS account](https://uconsultingats.com).\n\nWe look forward to meeting you!'
    ),
    signOff('Best,\nUConsulting Recruitment Team'),
  ],
};

const MEETING_SLOT_CREATED = {
  mergeFields: ['memberName', 'location'],
  fields: [
    line('subject', 'Subject', 'Your Get to Know UC slot is open'),
    line('greeting', 'Greeting', 'Hi {{memberName}},'),
    block(
      'intro',
      'Before the slot details',
      "Your Get to Know UC slot is open for candidates to book. It's attached as a calendar invite so the time is held."
    ),
    line('highlightsTitle', 'Grey box title', 'What Happens Next'),
    block(
      'highlights',
      'Grey box',
      "• You'll get an email each time a candidate books this slot, and the calendar entry updates with their name\n\n• If nobody books, the time stays on your calendar as an open slot"
    ),
    block('outro', 'Closing', 'You can edit or cancel the slot any time in the [ATS](https://uconsultingats.com).'),
    signOff(RECRUITMENT_TEAM),
  ],
};

const MEETING_HOST_REMINDER = {
  mergeFields: ['memberName', 'location'],
  fields: [
    line('subject', 'Subject', 'Tomorrow: your Get to Know UC slot'),
    line('greeting', 'Greeting', 'Hi {{memberName}},'),
    block(
      'intro',
      'Before the slot details',
      'Your Get to Know UC slot is in about 24 hours. Here is who signed up.'
    ),
    line('highlightsTitle', 'Grey box title', 'Before you meet, reach out to them'),
    block(
      'highlights',
      'Grey box',
      "• Text or email everyone who signed up today, so they have a way to reach you\n\n" +
        '• Tell them exactly where to meet: the building, the floor and the spot, not just "{{location}}"\n\n' +
        "• Say how to find you: what you'll be wearing, or where you'll be sitting\n\n" +
        '• Share your number in case they are running late or cannot find you'
    ),
    block(
      'outro',
      'Closing',
      'The button below opens your slot in the ATS, where you can start one group iMessage or email with everyone who signed up.'
    ),
    signOff(RECRUITMENT_TEAM),
  ],
};

const MEETING_SIGNUP_NOTIFICATION = {
  mergeFields: ['memberName', 'candidateName', 'candidateEmail', 'location'],
  fields: [
    line('subject', 'Subject', 'New GTKUC Signup - {{candidateName}} signed up for your slot'),
    line('greeting', 'Greeting', 'Hi {{memberName}},'),
    block('intro', 'Before the details', 'Great news! Someone has signed up for one of your GTKUC slots. Here are the details:'),
    line('highlightsTitle', 'Grey box title', 'Next Steps'),
    block(
      'highlights',
      'Grey box',
      '• Mark attendance after the meeting in the ATS system\n\n• Contact the candidate if you need to reschedule'
    ),
    block('outro', 'Closing', 'You can manage everything — your slots, signups, and attendance — in the [ATS](https://uconsultingats.com).'),
    signOff(RECRUITMENT_TEAM),
  ],
};

const MEETING_CANCELLATION_CANDIDATE = {
  mergeFields: ['candidateName', 'memberName', 'location'],
  fields: [
    line('subject', 'Subject', 'Meeting Cancelled - Get to Know UC'),
    line('heading', 'Heading', 'Meeting Cancelled'),
    line('greeting', 'Greeting', 'Dear {{candidateName}},'),
    block('intro', 'Before the cancelled details', 'We regret to inform you that your scheduled meeting with UConsulting has been cancelled.'),
    line('highlightsTitle', 'Grey box title', "What's Next?"),
    block(
      'highlights',
      'Grey box',
      '• You can sign up for another available meeting slot\n\n• Manage everything by logging into your [ATS account](https://uconsultingats.com)\n\n• We apologize for any inconvenience this may cause'
    ),
    block('outro', 'Closing', "We appreciate your interest in UConsulting and hope you'll consider signing up for another meeting slot."),
    signOff('Best regards,\nUConsulting Team'),
  ],
};

const MEETING_CANCELLATION_MEMBER = {
  mergeFields: ['memberName', 'candidateName', 'location', 'signupCountLabel'],
  fields: [
    line('subject', 'Subject', 'Get to Know UC - Meeting Cancelled'),
    line('heading', 'Heading', 'Meeting Cancelled'),
    line('greeting', 'Greeting', 'Hi {{memberName}},'),
    // Two openings because the email covers two different events. Which one is
    // used is decided by what happened, never by an admin.
    block(
      'introCandidateCancelled',
      'Opening — a candidate dropped their signup',
      '{{candidateName}} has cancelled their signup for one of your Get to Know UC meeting slots.'
    ),
    block(
      'introSlotCancelled',
      'Opening — an admin cancelled the whole slot',
      'One of your Get to Know UC meeting slots has been cancelled by an administrator.'
    ),
    line('highlightsTitle', 'Grey box title', "What's Next?"),
    block(
      'impactCandidateCancelled',
      'Grey box first line — a candidate dropped their signup',
      '• This spot is now open again for other candidates to sign up'
    ),
    block(
      'impactSlotCancelled',
      'Grey box first line — an admin cancelled the whole slot',
      '• {{signupCountLabel}} have been notified of the cancellation'
    ),
    block(
      'highlights',
      'Grey box remaining lines',
      '• Manage everything — your slots, signups, and attendance — in the [ATS](https://uconsultingats.com)'
    ),
    signOff(RECRUITMENT_TEAM),
  ],
};

const MEETING_RESCHEDULE_CANDIDATE = {
  mergeFields: ['candidateName', 'memberName'],
  fields: [
    line('subject', 'Subject', 'Meeting Rescheduled - Get to Know UC'),
    line('heading', 'Heading', 'Your Meeting Has Moved'),
    line('greeting', 'Greeting', 'Hi {{candidateName}},'),
    block(
      'intro',
      'Before the new details',
      'Your Get to Know UC meeting with {{memberName}} has been rescheduled. Your spot is still held - you do not need to sign up again. Please check the new details below and update your calendar.'
    ),
    line('highlightsTitle', 'Grey box title', "If the new time doesn't work"),
    block(
      'highlights',
      'Grey box',
      '• Cancel or rebook your meeting in the [ATS](https://uconsultingats.com)\n\n• If it is too close to the start time to change it yourself, email recruitment'
    ),
    signOff(RECRUITMENT_TEAM),
  ],
};

const MEETING_RESCHEDULE_MEMBER = {
  mergeFields: ['memberName', 'signupCount'],
  fields: [
    line('subject', 'Subject', 'Get to Know UC - Meeting Rescheduled'),
    line('heading', 'Heading', 'One of Your Slots Has Moved'),
    line('greeting', 'Greeting', 'Hi {{memberName}},'),
    block(
      'intro',
      'Before the new details',
      'An administrator has rescheduled one of your Get to Know UC meeting slots. Please check the new details below and update your calendar.'
    ),
    line('highlightsTitle', 'Grey box title', "What's Next?"),
    block(
      'impactWithSignups',
      'Grey box first line — somebody had signed up',
      '• {{signupCount}} signed-up candidate(s) have been emailed the new time'
    ),
    block(
      'impactWithoutSignups',
      'Grey box first line — nobody had signed up',
      '• Nobody has signed up for this slot yet, so no candidates were emailed'
    ),
    block(
      'highlights',
      'Grey box remaining lines',
      '• Manage everything — your slots, signups, and attendance — in the [ATS](https://uconsultingats.com)'
    ),
    signOff(RECRUITMENT_TEAM),
  ],
};

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

const PASSWORD_RESET = {
  mergeFields: [],
  fields: [
    line('subject', 'Subject', 'Reset Your Password - UConsulting ATS'),
    line('heading', 'Heading', 'Password Reset Request'),
    block(
      'intro',
      'Before the button',
      'You requested a password reset for your UConsulting ATS account.\n\nClick the button below to choose a new password. This link expires in 30 minutes.'
    ),
    block('linkFallback', 'Above the plain link', "If the button doesn't work, copy and paste this link into your browser:"),
    block(
      'ignoreNotice',
      'Below the plain link',
      "If you didn't request this, you can safely ignore this email — your password will not change."
    ),
    signOff(ATS_TEAM),
  ],
};

const PASSWORD_RESET_CONFIRMATION = {
  mergeFields: ['firstName'],
  fields: [
    line('subject', 'Subject', 'Your UConsulting ATS password has been reset'),
    line('heading', 'Heading', 'Password Reset Successful'),
    line('greeting', 'Greeting', 'Hi {{firstName}},'),
    block(
      'intro',
      'Body',
      'The password for your UConsulting ATS account was just changed.\n\nIf you made this change, you can safely ignore this email. If you did not reset your password, please contact the UConsulting ATS team immediately so we can help secure your account.'
    ),
    signOff(ATS_TEAM),
  ],
};

const EMAIL_VERIFICATION = {
  mergeFields: ['fullName'],
  fields: [
    line('subject', 'Subject', 'Verify Your Email - UConsulting Talent Network'),
    line('heading', 'Heading', 'Confirm your UCLA email'),
    line('greeting', 'Greeting', 'Hi {{fullName}},'),
    // Registration does not require a name, and "Hi ," is worse than no name at
    // all, so the nameless case gets its own line rather than an empty {{fullName}}.
    line('greetingNoName', 'Greeting when we have no name', 'Hi,'),
    block(
      'intro',
      'Before the button',
      'Thanks for joining the UConsulting Talent Network. Confirm this address to finish setting up your profile and upload your resume. This link expires in 24 hours.'
    ),
    block('linkFallback', 'Above the plain link', "If the button doesn't work, copy and paste this link into your browser:"),
    block('ignoreNotice', 'Below the plain link', "If you didn't sign up, you can safely ignore this email — no profile will be created."),
    signOff('Best regards,\nUConsulting Talent Network'),
  ],
};

const welcomeTemplate = ({ subject, heading, intro, bullets, signature }) => ({
  mergeFields: ['fullName'],
  fields: [
    line('subject', 'Subject', subject),
    line('heading', 'Heading', heading),
    line('greeting', 'Greeting', 'Hi {{fullName}},'),
    line('greetingNoName', 'Greeting when we have no name', 'Hi,'),
    block('intro', 'Opening', intro),
    block('bullets', 'What they can do', bullets, 'One line each, written as a Markdown list.'),
    signOff(`Best regards,\n${signature}`),
  ],
});

const WELCOME_CANDIDATE = welcomeTemplate({
  subject: 'Welcome to UConsulting Recruitment',
  heading: 'Your account is ready',
  intro: 'Your email is confirmed, so your UConsulting recruitment account is live. This is where you track everything from here on.',
  bullets: [
    '- Follow your application status as it moves through each round',
    '- RSVP to recruitment events and coffee chats',
    '- Get interview prep materials before each round',
  ].join('\n'),
  signature: 'UConsulting Recruitment',
});

const WELCOME_TALENT = welcomeTemplate({
  subject: 'Welcome to the UConsulting Talent Network',
  heading: 'Your profile is ready',
  intro: 'Your email is confirmed, so your Talent Network profile is live. Finishing it is what puts you in front of our partner companies.',
  bullets: [
    '- Upload your resume and keep the latest version on file',
    '- Fill in your profile so partners can find you',
    '- Choose whether to share your profile with the Talent Partner Network',
  ].join('\n'),
  signature: 'UConsulting Talent Network',
});

const WELCOME_MEMBER = welcomeTemplate({
  subject: 'Welcome to the UConsulting ATS',
  heading: 'Your member account is ready',
  intro: 'Your UConsulting ATS member account is set up. This is the tool we run recruitment out of.',
  bullets: [
    '- See the interviews you have been assigned to',
    '- Grade resumes, cover letters and videos for your review team',
    '- Submit evaluations after each interview',
  ].join('\n'),
  signature: 'UConsulting',
});

// ---------------------------------------------------------------------------
// Review teams
// ---------------------------------------------------------------------------

const REVIEWER_REMINDER = {
  mergeFields: ['reviewerName', 'teamName', 'cycleName'],
  fields: [
    line('subject', 'Subject', 'Reminder: Submit your review grades - {{cycleName}}'),
    line('heading', 'Heading', 'Review Reminder'),
    line('greeting', 'Greeting', 'Hi {{reviewerName}},'),
    block(
      'intro',
      'Before the progress box',
      'This is a friendly reminder to submit your remaining grades for **{{teamName}}** in the **{{cycleName}}** recruiting cycle.'
    ),
    block('outro', 'Above the button', 'Please complete your evaluations in the ATS:'),
    signOff(RECRUITMENT_TEAM),
  ],
};

// ---------------------------------------------------------------------------
// Interview scheduling
// ---------------------------------------------------------------------------

/**
 * The twelve slot notifications, which share one renderer and therefore one
 * shape: a subject, a heading and a body. The details card underneath is built
 * from the booking and is not copy.
 *
 * `subject` is stamped onto the notification row when it is queued, not when it
 * is sent, so editing one changes the notifications queued after the edit and
 * leaves anything already waiting to go out alone.
 */
const SLOT_MERGE_FIELDS = ['interviewTitle', 'slotName', 'preferredName', 'candidateName', 'fromName'];

const slotTemplate = (subject, heading, body, extra = []) => ({
  mergeFields: SLOT_MERGE_FIELDS,
  fields: [
    line('subject', 'Subject', subject),
    line('heading', 'Heading', heading),
    block('body', 'Body', body),
    ...extra,
  ],
});

const SLOT_TEMPLATES = {
  CONFIRMATION: slotTemplate(
    "You're confirmed - {{interviewTitle}}",
    'Your time is confirmed',
    "You're booked for {{interviewTitle}}. The details are below - add them to your calendar now so they don't get lost."
  ),
  WAITLIST_ADDED: slotTemplate(
    "Your spot is booked, and you're on the waitlist - {{interviewTitle}}",
    "You have a spot, and you're on the waitlist",
    "Your first choice was full, so we've booked you into {{slotName}} and added you to the waitlist for {{preferredName}}. You have a confirmed spot either way - if the one you wanted opens up, we move you automatically and email you."
  ),
  PROMOTED: slotTemplate(
    'Good news - you got your preferred time for {{interviewTitle}}',
    'You got your preferred time',
    "A spot opened up in {{slotName}}, so we've moved you. Your previous time has been released - the details below are the ones that count."
  ),
  FALLBACK_RELEASED: slotTemplate(
    'Your time has changed - {{interviewTitle}}',
    'Your time has changed',
    'You have been moved to the time you originally asked for. Your earlier booking has been released.'
  ),
  CANCELLATION: slotTemplate(
    'Your booking is cancelled - {{interviewTitle}}',
    'Your booking is cancelled',
    'Your spot for {{interviewTitle}} has been cancelled. If this was not you, contact recruitment as soon as you can.'
  ),
  MOVED_BY_ADMIN: slotTemplate(
    'Your time has been updated - {{interviewTitle}}',
    'Your time has been updated',
    'Recruitment has moved your {{interviewTitle}} booking. Your new time is below - please check it carefully.'
  ),
  ADMIN_OVERFLOW_ALERT: slotTemplate(
    'Action needed: a candidate could not be scheduled for {{interviewTitle}}',
    'A candidate could not be scheduled',
    '{{candidateName}} tried to sign up for {{interviewTitle}} and every slot was full, so no spot could be given automatically. They have been told recruitment will reach out. Place them from the interview roster - you can book over capacity if you need to.'
  ),
  AVAILABILITY_REQUEST: slotTemplate(
    'When can you interview? - {{interviewTitle}}',
    'When can you interview?',
    'Recruitment is putting together the schedule for {{interviewTitle}} and needs to know when you are free. Add your availability and they will build the day around it - including how many interviews run at once, which is decided by how many of us can be there.'
  ),
  INTERVIEWER_ASSIGNED: slotTemplate(
    "You're interviewing - {{interviewTitle}}",
    "You're interviewing",
    'You have been placed in {{interviewTitle}}. The details are below - add them to your calendar.',
    [
      block(
        'bodySelfSignup',
        'Body when they signed themselves up',
        'You signed up to run a {{interviewTitle}} session. The details are below, and the invite attached goes straight on your calendar.',
        'Somebody who claimed a session themselves should not read that they "have been placed" in it.'
      ),
    ]
  ),
  INTERVIEWER_MOVED: slotTemplate(
    'Your session has changed - {{interviewTitle}}',
    'Your interview session has changed',
    'Recruitment has moved which {{interviewTitle}} session you are running - you were on {{fromName}}. Your new session is below. Please check it and update your calendar.',
    [
      block(
        'bodyNoPrevious',
        "Body when we can't name the old session",
        'Recruitment has moved which {{interviewTitle}} session you are running. Your new session is below. Please check it and update your calendar.'
      ),
    ]
  ),
  INTERVIEWER_REMOVED: slotTemplate(
    "You've been taken off a session - {{interviewTitle}}",
    'You have been taken off a session',
    'You are no longer down to interview at this session for {{interviewTitle}}.'
  ),
  REMINDER: slotTemplate(
    'Reminder - {{interviewTitle}}',
    'A reminder about your upcoming interview',
    'This is a reminder about your {{interviewTitle}} booking.'
  ),
};

/** `slot-confirmation` from `CONFIRMATION`. Used by the catalog and the renderer. */
export const slotCopyKey = (type) => `slot-${String(type).toLowerCase().replace(/_/g, '-')}`;

/**
 * Every notification type the slot renderer can draw, in the order they are
 * listed above. Derived, never hand-written, so a type added here cannot be
 * left out of the preview catalog or the subject map without a test failing.
 */
export const SLOT_EMAIL_TYPES = Object.freeze(Object.keys(SLOT_TEMPLATES));

// ---------------------------------------------------------------------------
// Round decisions
// ---------------------------------------------------------------------------

/**
 * The defaults every new decision batch starts from.
 *
 * These are the one family that already had an editor: an admin can rewrite a
 * batch's wording in Master Communications before it goes out. Editing here
 * changes what the *next* batch starts from and leaves batches already created
 * alone, which is what makes the two editors safe to have at once.
 *
 * The wording moved here from decisionTemplates.js, which now reads it back.
 * It could not stay there and be editable: this module has to be the one that
 * talks to the store, and a module that imports it cannot also be imported by
 * it.
 *
 * `accountSetup` and `schedulingLink` are merge fields an admin may place but
 * not write - they carry server-built links, and decisionTemplates.js composes
 * them per recipient.
 */
export const DECISION_COPY_KEY = (round, outcome) => `decision-round-${round}-${String(outcome).toLowerCase()}`;

export const DECISION_MERGE_FIELDS = [
  'firstName',
  'lastName',
  'fullName',
  'cycleName',
  'nextRoundName',
  'accountSetup',
  'schedulingLink',
];

const decisionTemplate = (subject, body) => ({
  mergeFields: DECISION_MERGE_FIELDS,
  fields: [
    line('subject', 'Subject', subject),
    block('body', 'Body', body, 'Markdown. This is the wording a new batch starts from.'),
  ],
});

const DECISION_SIGN_OFF = 'Best regards,\nUConsulting Recruitment Team';
const DECISION_REJECTED_SUBJECT = 'Update on your application - {{cycleName}}';

const decisionBody = (...paragraphs) => paragraphs.concat(DECISION_SIGN_OFF).join('\n\n');

const DECISION_TEMPLATES = {
  '1': {
    ADVANCED: decisionTemplate(
      "Congratulations! You've advanced to Coffee Chats - {{cycleName}}",
      decisionBody(
        'Hi {{firstName}},',
        "We're excited to let you know that you've advanced to the **Coffee Chats** round of UConsulting's {{cycleName}} recruitment cycle!",
        "- You've passed the Resume Review round\n- You'll be invited to a Coffee Chat\n- {{schedulingLink}}",
        'This is a real achievement and reflects the quality of your application. We look forward to getting to know you better.'
      )
    ),
    REJECTED: decisionTemplate(
      DECISION_REJECTED_SUBJECT,
      decisionBody(
        'Hi {{firstName}},',
        'Thank you for your interest in UConsulting and for taking the time to apply to our {{cycleName}} recruitment cycle.',
        'After careful review of your application, we are unable to move forward with your candidacy at this time. We received many strong applications this cycle, and the decision was not easy.',
        'We encourage you to keep developing your skills and to consider applying in a future recruitment cycle.'
      )
    ),
  },
  '2': {
    ADVANCED: decisionTemplate(
      "Congratulations! You've advanced to First Round Interviews - {{cycleName}}",
      decisionBody(
        'Hi {{firstName}},',
        "We're thrilled to let you know that you've advanced to **First Round Interviews** in UConsulting's {{cycleName}} recruitment cycle!",
        "- You've passed the Coffee Chat round\n- You'll be invited to a First Round Interview\n- {{schedulingLink}}",
        'First Round Interviews include behavioral questions and a market sizing case. We will send preparation materials along with your scheduling information.'
      )
    ),
    REJECTED: decisionTemplate(
      DECISION_REJECTED_SUBJECT,
      decisionBody(
        'Hi {{firstName}},',
        'Thank you for your interest in UConsulting and for taking part in our {{cycleName}} recruitment cycle.',
        'After careful consideration following the Coffee Chat round, we are unable to move forward with your candidacy at this time. We appreciate the time and energy you gave our process, and the decision was not easy.',
        'We encourage you to keep developing your skills and to consider applying in a future recruitment cycle.'
      )
    ),
  },
  '3': {
    ADVANCED: decisionTemplate(
      "Congratulations! You've advanced to the Final Round - {{cycleName}}",
      decisionBody(
        'Hi {{firstName}},',
        "We're excited to let you know that you've advanced to the **Final Round** of UConsulting's {{cycleName}} recruitment cycle!",
        'Your First Round interview was impressive, and we look forward to learning more about you in the final stage of our process. Scheduling details are on their way.'
      )
    ),
    REJECTED: decisionTemplate(
      DECISION_REJECTED_SUBJECT,
      decisionBody(
        'Hi {{firstName}},',
        'Thank you for your interest in joining UConsulting and for taking part in our {{cycleName}} recruitment cycle.',
        'After careful consideration of your First Round interview, we have decided not to advance your application to the Final Round. This decision was not made lightly, and we appreciate the time and effort you invested.',
        'We encourage you to apply again in a future recruitment cycle, and we wish you the best of luck.'
      )
    ),
  },
  '4': {
    ACCEPTED: decisionTemplate(
      "Congratulations! You've been accepted to UConsulting - {{cycleName}}",
      decisionBody(
        'Hi {{firstName}},',
        "We are thrilled to let you know that you've been **accepted** to UConsulting in our {{cycleName}} recruitment cycle. Welcome to the team!",
        '{{accountSetup}}',
        "You've shown exceptional qualifications throughout a rigorous process. Onboarding details - next steps, orientation and important dates - are coming soon, so keep an eye on your inbox."
      )
    ),
    REJECTED: decisionTemplate(
      DECISION_REJECTED_SUBJECT,
      decisionBody(
        'Hi {{firstName}},',
        'Thank you for your continued interest in UConsulting and for your dedication throughout our {{cycleName}} recruitment process.',
        'After careful consideration following the Final Round, we are unable to offer you a place at this time. We were impressed by your qualifications, and this decision was extremely difficult.',
        'We encourage you to keep developing your skills and to consider applying in a future recruitment cycle.'
      )
    ),
  },
};

/** Which outcomes a round actually decides. Round 4 accepts; the rest advance. */
export const DECISION_ROUND_OUTCOMES = Object.freeze(
  Object.fromEntries(Object.entries(DECISION_TEMPLATES).map(([round, outcomes]) => [round, Object.keys(outcomes)]))
);

const DECISION_TEMPLATE_ENTRIES = Object.fromEntries(
  Object.entries(DECISION_TEMPLATES).flatMap(([round, outcomes]) =>
    Object.entries(outcomes).map(([outcome, template]) => [DECISION_COPY_KEY(round, outcome), template])
  )
);

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

const TRANSACTIONAL_TEMPLATES = {
  'rsvp-confirmation': RSVP_CONFIRMATION,
  'attendance-confirmation': ATTENDANCE_CONFIRMATION,
  'application-acceptance': APPLICATION_ACCEPTANCE,
  'application-rejection': APPLICATION_REJECTION,
  'offer-letter': OFFER_LETTER,
  'meeting-signup-confirmation': MEETING_SIGNUP_CONFIRMATION,
  'meeting-slot-created': MEETING_SLOT_CREATED,
  'meeting-host-reminder': MEETING_HOST_REMINDER,
  'meeting-signup-notification': MEETING_SIGNUP_NOTIFICATION,
  'meeting-cancellation-candidate': MEETING_CANCELLATION_CANDIDATE,
  'meeting-cancellation-member': MEETING_CANCELLATION_MEMBER,
  'meeting-reschedule-candidate': MEETING_RESCHEDULE_CANDIDATE,
  'meeting-reschedule-member': MEETING_RESCHEDULE_MEMBER,
  'password-reset': PASSWORD_RESET,
  'password-reset-confirmation': PASSWORD_RESET_CONFIRMATION,
  'email-verification': EMAIL_VERIFICATION,
  'reviewer-reminder': REVIEWER_REMINDER,
  'welcome-candidate': WELCOME_CANDIDATE,
  'welcome-talent': WELCOME_TALENT,
  'welcome-member': WELCOME_MEMBER,
};

const SLOT_TEMPLATE_ENTRIES = Object.fromEntries(
  Object.entries(SLOT_TEMPLATES).map(([type, template]) => [slotCopyKey(type), template])
);

/** Every editable template, keyed the way the preview page keys them. */
export const EMAIL_COPY_SCHEMA = Object.freeze({
  ...TRANSACTIONAL_TEMPLATES,
  ...SLOT_TEMPLATE_ENTRIES,
  ...DECISION_TEMPLATE_ENTRIES,
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

export const isEditableTemplate = (key) => Object.prototype.hasOwnProperty.call(EMAIL_COPY_SCHEMA, key);

// Every lookup goes through this, and this goes through `isEditableTemplate`.
// A plain `EMAIL_COPY_SCHEMA[key]` finds Object.prototype's own members, so a
// request for `constructor` or `toString` would answer 500 from somewhere deep
// instead of 404 - the keys arrive from a URL.
const templateOrThrow = (key) => {
  if (!isEditableTemplate(key)) throw fail(404, `Unknown email template: ${key}`, 'UNKNOWN_TEMPLATE');
  return EMAIL_COPY_SCHEMA[key];
};

/** The wording this repo ships for `key`, with nothing an admin wrote mixed in. */
export function defaultCopy(key) {
  const template = templateOrThrow(key);
  return Object.fromEntries(template.fields.map((field) => [field.name, field.default]));
}

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/** A stored row reduced to the fields its template still declares, blanks dropped. */
function storedCopy(key, row) {
  const stored = row?.copy;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};

  const kept = {};
  for (const field of (isEditableTemplate(key) ? EMAIL_COPY_SCHEMA[key].fields : [])) {
    const text = trimmed(stored[field.name]);
    if (text) kept[field.name] = text;
  }
  return kept;
}

// The table is read on the path that sends real mail, and it may not exist yet:
// migrations here are applied by hand, so a deploy can reach a send before
// anybody has run the SQL. A missing table must not stop an email going out, so
// a failed read falls back to the shipped wording and says so once.
let warnedAboutStore = false;

async function readRows(client, where) {
  try {
    return await client.emailTemplateCopy.findMany({ where });
  } catch (error) {
    if (!warnedAboutStore) {
      warnedAboutStore = true;
      console.error('[emailTemplateCopy] falling back to the shipped wording:', error?.message ?? error);
    }
    return null;
  }
}

/**
 * The wording an email should actually use: the shipped defaults with whatever
 * an admin has written on top, field by field.
 */
export async function resolveEmailCopy(key, { client = prisma } = {}) {
  templateOrThrow(key);
  const rows = await readRows(client, { templateKey: key });
  return { ...defaultCopy(key), ...storedCopy(key, rows?.[0]) };
}

/**
 * The same, for several templates in one query.
 *
 * Bulk paths - a round of decision emails, a flush of slot notifications - run
 * one render per recipient, and a query each would turn one send into hundreds.
 */
export async function resolveEmailCopyMany(keys, { client = prisma } = {}) {
  const wanted = [...new Set(keys)].filter(isEditableTemplate);
  const rows = await readRows(client, { templateKey: { in: wanted } });
  const byKey = new Map((rows ?? []).map((row) => [row.templateKey, row]));
  return new Map(wanted.map((key) => [key, { ...defaultCopy(key), ...storedCopy(key, byKey.get(key)) }]));
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

const FIELD_MAX = 4000;

// "Looks like an HTML tag", which "5 < 10" and "<3" deliberately do not.
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/;

// Every way Markdown lets somebody write a destination: inline `](url)`,
// a reference definition `[label]: url`, and an autolink `<url>`.
//
// Both renderers defuse an unsafe link on the way out, which is the check that
// cannot be evaded. This one is on the way in, so an admin who pastes a
// `javascript:` link is told, rather than saving something that silently
// renders as a dead link.
const MARKDOWN_LINKS = [
  /\]\(\s*<?([^)\s>]+)/g,
  /^[ \t]*\[[^\]]+\]:[ \t]*<?([^\s>]+)/gm,
  /<((?:[a-zA-Z][a-zA-Z0-9+.-]*:)[^>\s]*)>/g,
];
const SAFE_LINK = /^(https?:\/\/|mailto:|tel:|#|\{\{)/i;

/**
 * Validates and trims what an admin submitted.
 *
 * Unknown fields are dropped rather than refused, so a client left open across
 * a deploy that renamed a field cannot lock an admin out of saving. Unknown
 * merge fields *are* refused: `{{canddiateName}}` would reach a candidate as
 * literal braces, and there is no reading of that which is not a mistake.
 *
 * A field submitted at exactly the shipped wording is dropped too. The editor
 * fills its boxes with the words an admin is actually reading, so a save after
 * changing one sentence arrives carrying every other sentence unchanged, and
 * storing those would freeze this template at today's wording: a later change
 * in the code would never reach it, and the page would call it customized.
 */
export function normalizeCopy(key, input) {
  const template = templateOrThrow(key);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw fail(400, 'Email copy must be an object keyed by field', 'INVALID_COPY');
  }

  const known = new Set(template.mergeFields);
  const copy = {};

  for (const field of template.fields) {
    const text = trimmed(input[field.name]);
    if (!text || text === field.default.trim()) continue;

    if (text.length > FIELD_MAX) {
      throw fail(400, `${field.label} is over ${FIELD_MAX} characters`, 'INVALID_COPY');
    }

    const unknown = mergeFieldsUsed(text).filter((name) => !known.has(name));
    if (unknown.length) {
      throw fail(
        400,
        `${field.label} uses ${unknown.map((name) => `{{${name}}}`).join(', ')}, which this email cannot fill in`,
        'UNKNOWN_MERGE_FIELD'
      );
    }

    // The editor promises that an edit changes the words and not the layout.
    // HTML in a field would make that false, so it is refused here rather than
    // quietly escaped - somebody who typed a <div> meant it, and should be told
    // it is not going to work.
    if (HTML_TAG.test(text)) {
      throw fail(
        400,
        `${field.label} contains HTML. Write plain text, or Markdown for bold and links.`,
        'HTML_NOT_ALLOWED'
      );
    }

    for (const pattern of MARKDOWN_LINKS) {
      for (const [, href] of text.matchAll(pattern)) {
        if (!SAFE_LINK.test(href)) {
          throw fail(400, `${field.label} links to "${href}", which is not a web address`, 'UNSAFE_LINK');
        }
      }
    }

    copy[field.name] = text;
  }

  return copy;
}

/**
 * The keys somebody has actually written wording for, in one query.
 *
 * What the list on the templates page badges as edited. A row holding only
 * blanks does not count: `storedCopy` drops those, and so should this, or the
 * badge would outlive the edit it is reporting.
 */
export async function customizedTemplateKeys({ client = prisma } = {}) {
  const rows = await readRows(client, {});
  const edited = new Set();
  for (const row of rows ?? []) {
    if (Object.keys(storedCopy(row.templateKey, row)).length > 0) edited.add(row.templateKey);
  }
  return edited;
}

/** The whole catalog as the editor needs it: fields, defaults, and what is stored. */
export async function listEmailCopy({ client = prisma } = {}) {
  const rows = await readRows(client, {});
  const byKey = new Map((rows ?? []).map((row) => [row.templateKey, row]));

  const templates = {};
  for (const [key, template] of Object.entries(EMAIL_COPY_SCHEMA)) {
    const stored = storedCopy(key, byKey.get(key));
    templates[key] = {
      mergeFields: template.mergeFields,
      fields: template.fields.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        help: field.help ?? null,
        default: field.default,
        value: stored[field.name] ?? '',
      })),
      customized: Object.keys(stored).length > 0,
      updatedAt: byKey.get(key)?.updatedAt ?? null,
    };
  }
  return templates;
}

/** One template, for the editor. */
export async function getEmailCopy(key, { client = prisma } = {}) {
  const template = templateOrThrow(key);
  const rows = await readRows(client, { templateKey: key });
  const stored = storedCopy(key, rows?.[0]);

  return {
    key,
    mergeFields: template.mergeFields,
    fields: template.fields.map((field) => ({
      name: field.name,
      label: field.label,
      type: field.type,
      help: field.help ?? null,
      default: field.default,
      value: stored[field.name] ?? '',
    })),
    customized: Object.keys(stored).length > 0,
    updatedAt: rows?.[0]?.updatedAt ?? null,
  };
}

export async function saveEmailCopy({ client = prisma, key, copy, user }) {
  const normalized = normalizeCopy(key, copy);

  // Nothing left after normalizing means every field is back at its default,
  // which is Reset by another name. Storing an empty row instead would report
  // the template as customized forever.
  if (Object.keys(normalized).length === 0) return resetEmailCopy({ client, key });

  await client.emailTemplateCopy.upsert({
    where: { templateKey: key },
    create: { templateKey: key, copy: normalized, updatedById: user?.id ?? null },
    update: { copy: normalized, updatedById: user?.id ?? null },
  });

  return getEmailCopy(key, { client });
}

/** Drops the row so the template reads the way the code ships it again. */
export async function resetEmailCopy({ client = prisma, key }) {
  templateOrThrow(key);
  await client.emailTemplateCopy.deleteMany({ where: { templateKey: key } });
  return getEmailCopy(key, { client });
}
