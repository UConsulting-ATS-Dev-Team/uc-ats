// Field rules shared by the forms a candidate fills in themselves.
//
// These deliberately mirror server/src/utils/candidateOnboarding.js rather than
// replacing it - the server stays the authority, and this exists so a typo is
// caught while someone is still looking at the field instead of after a round
// trip that clears their file selection. If the two ever disagree, the server
// wins and the person sees its message.

// Ten digits, or eleven with a leading country code. Everything on file is one
// of those two, so anything else is a typo rather than a format to honour.
const PHONE_DIGITS = /^1?(\d{10})$/;

// One or two digits, then at most two decimals - the shape a Decimal(3, 2)
// column can actually hold. A third decimal would be rounded away silently.
const GPA_PATTERN = /^\d{1,2}(\.\d{1,2})?$/;

// Not 4.00: weighted high-school scales run past it, and first-years are asked
// for their high-school GPA. Six clears any weighted scale while still catching
// a percentage typed into a GPA field.
const GPA_MAX = 6;

export const digitsOf = (value) => String(value ?? '').replace(/\D/g, '');

export const normalizePhone = (value) => {
  const match = PHONE_DIGITS.exec(digitsOf(value));
  return match ? match[1] : null;
};

/**
 * Render digits as a US phone number as they are typed.
 *
 * Formats progressively rather than only when complete, so the shape of the
 * field tells someone how many digits are still expected. What gets submitted
 * is always the digits, never this.
 */
export const formatPhone = (value) => {
  const digits = digitsOf(value).replace(/^1/, '').slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
};

/** @returns {string} the field error, or '' when the value is acceptable */
export const phoneError = (value) => {
  if (!String(value ?? '').trim()) return '';
  return normalizePhone(value) ? '' : 'Enter a 10-digit phone number.';
};

export const normalizeGpa = (value) => {
  const raw = String(value ?? '').trim();
  if (!GPA_PATTERN.test(raw)) return null;
  const gpa = Number.parseFloat(raw);
  if (Number.isNaN(gpa) || gpa < 0 || gpa > GPA_MAX) return null;
  return gpa.toFixed(2);
};

/** @returns {string} the field error, or '' when the value is acceptable */
export const gpaError = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  // Split from the range check because "too many decimals" is the mistake
  // someone can actually act on, and rolling it into one message hides it.
  if (!GPA_PATTERN.test(raw)) return 'Use at most two decimal places, for example 3.85.';
  return normalizeGpa(raw) ? '' : 'Enter a GPA on a 4.0 scale, for example 3.85.';
};
