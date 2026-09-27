import { redactSecrets } from '../communicationLog.js';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A bearer token or JWT pasted into an error message.
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

/**
 * Make free text safe to keep in an analytics table: secrets in query strings
 * (the same rule the communications log uses), JWTs and email addresses are
 * masked, and the result is capped.
 */
export function redactText(value, max = 2000) {
  if (value === null || value === undefined) return null;
  const text = redactSecrets(String(value)).replace(JWT, '[jwt]').replace(EMAIL, '[email]');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
