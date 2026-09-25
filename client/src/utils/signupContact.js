// A GTKUC host reaching everyone booked into their slot at once: one group
// iMessage (see imessage.js) or one email, both opened in the host's own app.

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
  const host = firstName(hostName) || 'your UC Consulting host';
  return [
    `Hi ${names || 'everyone'}! This is ${host} from UC Consulting. Looking forward to our Get to Know UC chat on ${formatWhen(startTime)}.`,
    '',
    `Where to meet: ${location}, [exact spot, e.g. the tables by the second-floor windows]`,
    `How to find me: [what you'll be wearing / where you'll be sitting]`,
    '',
    "If you're running late or can't find me, just reply here!",
  ].join('\n');
}

/**
 * One email to everyone, addressed in To so a reply-all reaches the group the
 * same way the group iMessage does.
 */
export function buildMailtoUrl(emails, subject, body) {
  // Encoded so a + or & in an address cannot break the link, but with the @
  // left as is: some mail apps do not decode %40 in the address list.
  const to = [...new Set(emails.filter(Boolean))]
    .map((e) => encodeURIComponent(e).replace(/%40/g, '@'))
    .join(',');
  const params = [];
  if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
  if (body) params.push(`body=${encodeURIComponent(body)}`);
  return `mailto:${to}${params.length ? `?${params.join('&')}` : ''}`;
}
