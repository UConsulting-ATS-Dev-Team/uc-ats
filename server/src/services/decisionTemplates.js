import { marked } from 'marked';
import { nextRound } from '../utils/roundProgression.js';
import {
  DECISION_COPY_KEY,
  DECISION_MERGE_FIELDS,
  DECISION_ROUND_OUTCOMES,
  resolveEmailCopyMany,
} from './emailTemplateCopy.js';

// How a decision email is rendered for one recipient.
//
// The wording itself lives in emailTemplateCopy.js, with the rest of the
// automatic emails, so that an admin can edit it from the email templates page.
// It used to be a constant here; what stayed is the part a person should not be
// editing - which merge fields exist, and what each one resolves to.
//
// A DecisionBatch copies the defaults when it is created, so an admin editing
// one batch's wording in Master Communications changes neither the defaults nor
// any other batch. Editing the defaults changes what the next batch starts from
// and leaves existing batches alone.
//
// Merge fields: {{firstName}} {{lastName}} {{fullName}} {{cycleName}}
// {{nextRoundName}} {{accountSetup}} {{schedulingLink}}. Values are HTML-escaped
// before the Markdown is rendered. accountSetup and schedulingLink are the
// exceptions: they are written here, not typed by a person, and they carry links.

export const DECISION_OUTCOMES = ['ADVANCED', 'ACCEPTED', 'REJECTED'];

export { DECISION_MERGE_FIELDS };

/**
 * The { outcome: { subject, body } } a new batch for `round` starts from.
 *
 * Reads the admin-editable wording, falling back field by field to what the
 * repo ships. Async where it used to be synchronous: the wording is in the
 * database now, and a batch created before the edit must keep the words it was
 * created with.
 */
export async function decisionTemplatesForRound(round, { client } = {}) {
  const outcomes = DECISION_ROUND_OUTCOMES[String(round)];
  if (!outcomes) throw new Error(`No decision email wording for round ${round}`);

  const copies = await resolveEmailCopyMany(
    outcomes.map((outcome) => DECISION_COPY_KEY(round, outcome)),
    client ? { client } : {}
  );

  return Object.fromEntries(
    outcomes.map((outcome) => {
      const copy = copies.get(DECISION_COPY_KEY(round, outcome));
      return [outcome, { subject: copy.subject, body: copy.body }];
    })
  );
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
