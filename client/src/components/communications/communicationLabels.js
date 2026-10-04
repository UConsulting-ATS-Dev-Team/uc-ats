// Spelling shown to an admin, for the values the communications log records.
// Shared by Master Communications → Logs and the candidate pages. Anything not
// listed is shown as-is rather than hidden, so a category added on the server
// needs no change here.

export const CATEGORY_LABELS = {
  ACCOUNT: 'Account',
  APPLICATION_RECEIVED: 'Application received',
  APPLICATION_DECISION: 'Decision',
  OFFER_LETTER: 'Offer letter',
  EVENT: 'Event',
  MEETING: 'Coffee chat',
  INTERVIEW_SLOT: 'Interview slot',
  REVIEWER_REMINDER: 'Reviewer reminder',
  ACCOUNTABILITY_REMINDER: 'Accountability reminder',
  SIGNUP_REMINDER: 'Signup reminder',
  MASTER_COMMUNICATION: 'Master communication',
  DECISION_BATCH: 'Decision batch',
  TEST: 'Test send',
  OTHER: 'Other',
};

export const CHANNEL_LABELS = { email: 'Email', slack: 'Slack', imessage: 'iMessage' };

export const STATUS_STYLES = {
  // Claimed just before a send and overwritten with the outcome a moment
  // later; see statusStyleFor for one that never was.
  SENDING: { color: 'info', label: 'Sending…' },
  // Sent is SES accepting the message; Delivered is the recipient's server
  // accepting it, reported back later.
  SENT: { color: 'default', label: 'Sent' },
  DELIVERED: { color: 'success', label: 'Delivered' },
  // SES click tracking saw a link followed, so it was delivered and read.
  CLICKED: { color: 'success', label: 'Clicked' },
  DELAYED: { color: 'warning', label: 'Delayed' },
  BOUNCED: { color: 'error', label: 'Bounced' },
  COMPLAINED: { color: 'error', label: 'Marked as spam' },
  FAILED: { color: 'error', label: 'Failed' },
  OPENED: { color: 'warning', label: 'Opened' },
};

export const STATUS_LABELS = Object.fromEntries(Object.entries(STATUS_STYLES).map(([k, v]) => [k, v.label]));

// A send takes seconds. A SENDING row this old was cut off - the server
// stopped between the claim and the send's result. A later attempt, if the
// sender made one, is its own row; this one stays as the record of the try
// that did not finish.
const INTERRUPTED_AFTER_MS = 10 * 60 * 1000;

export function statusStyleFor(row, now = Date.now()) {
  if (row.status === 'SENDING' && now - new Date(row.sentAt).getTime() > INTERRUPTED_AFTER_MS) {
    return { color: 'error', label: 'Interrupted' };
  }
  return STATUS_STYLES[row.status] || { color: 'default', label: row.status };
}

export const labelFor = (map, value) => map[value] || value || '—';
