import { marked } from 'marked';
import { nextRound } from '../utils/roundProgression.js';

// Default wording for decision emails, and how one is rendered for a recipient.
//
// A DecisionBatch copies these defaults when it is created, so an admin editing
// one batch's wording in Master Communications changes neither the defaults nor
// any other batch. The wording carries over from the fixed HTML emails that
// processing used to send on its own.
//
// Merge fields: {{firstName}} {{lastName}} {{fullName}} {{cycleName}}
// {{nextRoundName}} {{accountSetup}} {{schedulingLink}}. Values are HTML-escaped
// before the Markdown is rendered. accountSetup and schedulingLink are the
// exceptions: they are written here, not typed by a person, and they carry links.

export const DECISION_OUTCOMES = ['ADVANCED', 'ACCEPTED', 'REJECTED'];

export const DECISION_MERGE_FIELDS = [
  'firstName',
  'lastName',
  'fullName',
  'cycleName',
  'nextRoundName',
  'accountSetup',
  'schedulingLink'
];

const SIGN_OFF = 'Best regards,\nUConsulting Recruitment Team';

const REJECTED_SUBJECT = 'Update on your application - {{cycleName}}';

const COPY = {
  '1': {
    ADVANCED: {
      subject: "Congratulations! You've advanced to Coffee Chats - {{cycleName}}",
      body: [
        'Hi {{firstName}},',
        "We're excited to let you know that you've advanced to the **Coffee Chats** round of UConsulting's {{cycleName}} recruitment cycle!",
        "- You've passed the Resume Review round\n- You'll be invited to a Coffee Chat\n- {{schedulingLink}}",
        'This is a real achievement and reflects the quality of your application. We look forward to getting to know you better.',
        SIGN_OFF
      ].join('\n\n')
    },
    REJECTED: {
      subject: REJECTED_SUBJECT,
      body: [
        'Hi {{firstName}},',
        'Thank you for your interest in UConsulting and for taking the time to apply to our {{cycleName}} recruitment cycle.',
        'After careful review of your application, we are unable to move forward with your candidacy at this time. We received many strong applications this cycle, and the decision was not easy.',
        'We encourage you to keep developing your skills and to consider applying in a future recruitment cycle.',
        SIGN_OFF
      ].join('\n\n')
    }
  },
  '2': {
    ADVANCED: {
      subject: "Congratulations! You've advanced to First Round Interviews - {{cycleName}}",
      body: [
        'Hi {{firstName}},',
        "We're thrilled to let you know that you've advanced to **First Round Interviews** in UConsulting's {{cycleName}} recruitment cycle!",
        "- You've passed the Coffee Chat round\n- You'll be invited to a First Round Interview\n- {{schedulingLink}}",
        'First Round Interviews include behavioral questions and a market sizing case. We will send preparation materials along with your scheduling information.',
        SIGN_OFF
      ].join('\n\n')
    },
    REJECTED: {
      subject: REJECTED_SUBJECT,
      body: [
        'Hi {{firstName}},',
        'Thank you for your interest in UConsulting and for taking part in our {{cycleName}} recruitment cycle.',
        'After careful consideration following the Coffee Chat round, we are unable to move forward with your candidacy at this time. We appreciate the time and energy you gave our process, and the decision was not easy.',
        'We encourage you to keep developing your skills and to consider applying in a future recruitment cycle.',
        SIGN_OFF
      ].join('\n\n')
    }
  },
  '3': {
    ADVANCED: {
      subject: "Congratulations! You've advanced to the Final Round - {{cycleName}}",
      body: [
        'Hi {{firstName}},',
        "We're excited to let you know that you've advanced to the **Final Round** of UConsulting's {{cycleName}} recruitment cycle!",
        'Your First Round interview was impressive, and we look forward to learning more about you in the final stage of our process. Scheduling details are on their way.',
        SIGN_OFF
      ].join('\n\n')
    },
    REJECTED: {
      subject: REJECTED_SUBJECT,
      body: [
        'Hi {{firstName}},',
        'Thank you for your interest in joining UConsulting and for taking part in our {{cycleName}} recruitment cycle.',
        'After careful consideration of your First Round interview, we have decided not to advance your application to the Final Round. This decision was not made lightly, and we appreciate the time and effort you invested.',
        'We encourage you to apply again in a future recruitment cycle, and we wish you the best of luck.',
        SIGN_OFF
      ].join('\n\n')
    }
  },
  '4': {
    ACCEPTED: {
      subject: "Congratulations! You've been accepted to UConsulting - {{cycleName}}",
      body: [
        'Hi {{firstName}},',
        "We are thrilled to let you know that you've been **accepted** to UConsulting in our {{cycleName}} recruitment cycle. Welcome to the team!",
        '{{accountSetup}}',
        "You've shown exceptional qualifications throughout a rigorous process. Onboarding details - next steps, orientation and important dates - are coming soon, so keep an eye on your inbox.",
        SIGN_OFF
      ].join('\n\n')
    },
    REJECTED: {
      subject: REJECTED_SUBJECT,
      body: [
        'Hi {{firstName}},',
        'Thank you for your continued interest in UConsulting and for your dedication throughout our {{cycleName}} recruitment process.',
        'After careful consideration following the Final Round, we are unable to offer you a place at this time. We were impressed by your qualifications, and this decision was extremely difficult.',
        'We encourage you to keep developing your skills and to consider applying in a future recruitment cycle.',
        SIGN_OFF
      ].join('\n\n')
    }
  }
};

/** A fresh copy of the default { outcome: { subject, body } } for a round. */
export function defaultDecisionTemplates(round) {
  const copy = COPY[String(round)];
  if (!copy) throw new Error(`No decision email wording for round ${round}`);
  return JSON.parse(JSON.stringify(copy));
}

export function outcomeLabel(outcome, round) {
  if (outcome === 'ADVANCED') return `Advancing to ${nextRound(round)?.label ?? 'the next round'}`;
  if (outcome === 'ACCEPTED') return 'Accepted into UConsulting';
  return 'Not moving forward';
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

function accountSetup(recipient, { preview = false, setPasswordLink = null, loginUrl = '' }) {
  if (recipient.needsInvite) {
    // A preview has no real link to show; the send mints one per recipient.
    const link = setPasswordLink || (preview ? '#set-password-link-created-when-sent' : null);
    return link
      ? `We've created your UConsulting member account. [Set your password](${link}) to sign in to the ATS - the link works for 7 days.`
      : "We've created your UConsulting member account. You'll receive a link to set your password shortly.";
  }
  if (recipient.userId) {
    return `Your ATS account now has member access. [Sign in](${loginUrl}) with your usual email and password.`;
  }
  return "We'll follow up shortly about setting up your member account.";
}

/**
 * "Pick your time" - or the old promise, when there is nothing to pick yet.
 *
 * `schedulingLinksByRound` is keyed by the round the recipient is moving *to*
 * (DecisionMessage.toRound), built once per batch in decisionBatches.renderContext.
 * A round with no interview configured, or one whose interviews have no
 * candidate-bookable slots, has no entry - and then this falls back to the
 * sentence this feature replaced, so a batch sent before slots exist still reads
 * correctly rather than linking somewhere empty.
 */
function schedulingLink(recipient, { preview = false, schedulingLinksByRound = {} } = {}) {
  const url = schedulingLinksByRound[String(recipient.toRound)] ?? null;
  // A preview has no batch context to mint from; the placeholder keeps admins
  // from seeing a dead link and reporting it as a bug. Same trick as accountSetup.
  const href = url || (preview ? '#scheduling-link-shown-when-sent' : null);
  if (!href) return 'Scheduling details are on their way.';
  return `[Choose your time now](${href}) - times are first come, first served.`;
}

function fillMergeFields(text, values, { escape }) {
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (token, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return token;
    const { value, trusted = false } = values[key];
    return escape && !trusted ? escapeHtml(value) : String(value);
  });
}

/**
 * Render one decision email. `recipient` is a DecisionMessage (or anything with
 * firstName, lastName, needsInvite and userId); `context` carries cycleName,
 * round, loginUrl, and either setPasswordLink (a real send) or preview: true.
 */
export function renderDecisionEmail(template, recipient, context = {}) {
  const values = {
    firstName: { value: recipient.firstName || '' },
    lastName: { value: recipient.lastName || '' },
    fullName: { value: [recipient.firstName, recipient.lastName].filter(Boolean).join(' ') },
    cycleName: { value: context.cycleName || '' },
    nextRoundName: { value: nextRound(context.round)?.label || '' },
    accountSetup: { value: accountSetup(recipient, context), trusted: true },
    // trusted for the same reason accountSetup is: the Markdown link is composed
    // here from a server-built URL, and escaping it would print the syntax.
    schedulingLink: { value: schedulingLink(recipient, context), trusted: true }
  };

  // A subject is a plain-text header: nothing to escape, and no line breaks.
  const subject = fillMergeFields(template.subject, values, { escape: false }).replace(/[\r\n]+/g, ' ').trim();
  const html = marked.parse(fillMergeFields(template.body, values, { escape: true }), { breaks: true });
  return { subject, html };
}
