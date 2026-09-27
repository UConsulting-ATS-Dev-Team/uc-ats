// A GTKUC host reaching everyone booked into their slot at once: one group
// iMessage (see imessage.js) in their Messages app, or one email opened in
// Gmail in the browser.

const firstName = (fullName) => String(fullName || '').trim().split(/\s+/)[0] || '';

const joinNames = (names) => {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

const formatWhen = (startTime) =>
  new Date(startTime).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * The text the dialog opens with. The bracketed parts are for the host to
 * replace: the slot's location is usually a building, and the point of the
 * message is the exact spot and how to recognise them.
 */
export function draftSignupMessage({ hostName, contacts, startTime, location }) {
  const names = joinNames(contacts.map((c) => firstName(c.fullName)).filter(Boolean));
  const host = firstName(hostName) || 'your UConsulting host';
  return [
    `Hi ${names || 'everyone'}! This is ${host} from UConsulting. Looking forward to our Get to Know UC chat on ${formatWhen(startTime)}.`,
    '',
    `Where to meet: ${location}, [exact spot, e.g. the tables by the second-floor windows]`,
    `How to find me: [what you'll be wearing / where you'll be sitting]`,
    '',
    "If you're running late or can't find me, just reply here!",
  ].join('\n');
}

/**
 * One email to everyone, as a Gmail compose window in the browser. A mailto:
 * link would open whatever mail app the machine defaults to (often Outlook,
 * which most hosts never set up). Addressed in To so a reply-all reaches the
 * group the same way the group iMessage does. Gmail opens it in whichever
 * account is signed in.
 */
export function buildGmailComposeUrl(emails, subject, body) {
  const params = new URLSearchParams({ view: 'cm', fs: '1' });
  const to = [...new Set(emails.filter(Boolean))].join(',');
  if (to) params.set('to', to);
  if (subject) params.set('su', subject);
  if (body) params.set('body', body);
  return `https://mail.google.com/mail/?${params.toString()}`;
}
