// Normalizes a US-style phone number to E.164 (+13105551234).
//
// Returns null for anything that is not plausibly a number rather than guessing:
// a wrong digit here puts an org message in a stranger's Messages app.
export function normalizePhoneNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;

  const digits = text.replace(/\D/g, '');
  if (text.startsWith('+')) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}
