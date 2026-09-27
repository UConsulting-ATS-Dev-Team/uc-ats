import prisma from '../prismaClient.js';
import { isEditableTemplate } from './emailTemplateCopy.js';
import { isHexColour } from './emailTheme.js';
import { OWN_SIGN_OFF, signatureExists } from './emailSignatures.js';

/**
 * Per-email presentation on top of the theme: Designed or Plain, and the
 * header colour.
 *
 * Kept in its own table rather than beside the wording, so "Restore the
 * original wording" does not also undo a colour, and the reverse.
 *
 * Keys are the same as emailTemplateCopy.js, which already covers every
 * automatic email - including the interview-slot and decision emails.
 */

export const EMAIL_FORMATS = Object.freeze(['DESIGNED', 'PLAIN']);

// Header colours an admin can pick by name. 'brand' is the theme's own header;
// the rest are the status colours these emails have always used.
export const BANNER_TONES = Object.freeze(['brand', 'success', 'danger', 'warning', 'info']);

// What each email looked like before any of this was editable. Anything not
// listed here is Designed with the theme's header.
const SHIPPED_BANNERS = {
  'application-acceptance': 'success',
  'application-rejection': 'danger',
  'offer-letter': 'success',
  'meeting-cancellation-candidate': 'danger',
  'meeting-cancellation-member': 'danger',
  'meeting-reschedule-candidate': 'warning',
  'meeting-reschedule-member': 'warning',
};

// Decision letters have always gone out as bare text with no header or
// footer. Plain is that look, so they start there.
const shippedFormat = (key) => (key.startsWith('decision-') ? 'PLAIN' : 'DESIGNED');

export const defaultStyle = (key) => ({
  format: shippedFormat(key),
  banner: SHIPPED_BANNERS[key] ?? 'brand',
  // Null follows the default signature, which does not exist until an admin
  // makes one - so every email starts on its own sign-off.
  signatureId: null,
});

// Decision letters end inside the letter an admin writes, with no separate
// sign-off for a signature to replace.
export const takesSignature = (key) => !key.startsWith('decision-');

const SIGNATURE_ID = /^[0-9a-f-]{36}$/i;

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

const templateOrThrow = (key) => {
  if (!isEditableTemplate(key)) throw fail(404, `Unknown email template: ${key}`, 'UNKNOWN_TEMPLATE');
};

/** Keeps only what differs from the template's shipped style. */
export function normalizeStyle(key, input) {
  templateOrThrow(key);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw fail(400, 'Style must be an object', 'INVALID_STYLE');
  }
  const shipped = defaultStyle(key);
  const style = {};

  if (input.format != null && input.format !== '') {
    const format = String(input.format).toUpperCase();
    if (!EMAIL_FORMATS.includes(format)) throw fail(400, 'Format must be DESIGNED or PLAIN', 'INVALID_STYLE');
    if (format !== shipped.format) style.format = format;
  }

  if (input.banner != null && input.banner !== '') {
    const banner = String(input.banner).trim();
    if (!BANNER_TONES.includes(banner) && !isHexColour(banner)) {
      throw fail(400, 'Header colour must be a named tone or a hex colour', 'INVALID_STYLE');
    }
    if (banner.toLowerCase() !== shipped.banner) style.banner = banner;
  }

  if (input.signatureId != null && input.signatureId !== '') {
    const id = String(input.signatureId);
    if (id !== OWN_SIGN_OFF && !SIGNATURE_ID.test(id)) {
      throw fail(400, 'Unknown signature', 'INVALID_STYLE');
    }
    if (!takesSignature(key)) {
      throw fail(400, 'This email has no separate sign-off; its closing is part of the letter', 'INVALID_STYLE');
    }
    style.signatureId = id;
  }

  return style;
}

let warnedAboutStore = false;

async function readRows(client, where) {
  try {
    return await client.emailTemplateStyle.findMany({ where });
  } catch (error) {
    if (!warnedAboutStore) {
      warnedAboutStore = true;
      console.error('[emailTemplateStyle] falling back to the shipped style:', error?.message ?? error);
    }
    return null;
  }
}

const storedStyle = (row) => {
  const stored = {};
  if (row?.format && EMAIL_FORMATS.includes(row.format)) stored.format = row.format;
  if (row?.banner && (BANNER_TONES.includes(row.banner) || isHexColour(row.banner))) stored.banner = row.banner;
  if (row?.signatureId) stored.signatureId = row.signatureId;
  return stored;
};

/** The style an email should render with. Never throws on the send path. */
export async function resolveEmailStyle(key, { client = prisma } = {}) {
  const shipped = defaultStyle(key);
  if (!isEditableTemplate(key)) return shipped;
  const rows = await readRows(client, { templateKey: key });
  return { ...shipped, ...storedStyle(rows?.[0]) };
}

/** The keys whose style somebody changed, for the "Edited" badge. */
export async function styledTemplateKeys({ client = prisma } = {}) {
  const rows = await readRows(client, {});
  return new Set((rows ?? []).filter((row) => Object.keys(storedStyle(row)).length).map((row) => row.templateKey));
}

export async function getEmailStyle(key, { client = prisma } = {}) {
  templateOrThrow(key);
  const rows = await readRows(client, { templateKey: key });
  const stored = storedStyle(rows?.[0]);
  return {
    key,
    defaults: defaultStyle(key),
    values: { ...defaultStyle(key), ...stored },
    formats: EMAIL_FORMATS,
    tones: BANNER_TONES,
    takesSignature: takesSignature(key),
    customized: Object.keys(stored).length > 0,
    updatedAt: rows?.[0]?.updatedAt ?? null,
  };
}

export async function saveEmailStyle({ client = prisma, key, style, user }) {
  const normalized = normalizeStyle(key, style);
  if (!(await signatureExists(normalized.signatureId, { client }))) {
    throw fail(400, 'That signature no longer exists', 'INVALID_STYLE');
  }
  if (Object.keys(normalized).length === 0) return resetEmailStyle({ client, key });

  const data = {
    format: normalized.format ?? null,
    banner: normalized.banner ?? null,
    signatureId: normalized.signatureId ?? null,
    updatedById: user?.id ?? null,
  };
  await client.emailTemplateStyle.upsert({
    where: { templateKey: key },
    create: { templateKey: key, ...data },
    update: data,
  });
  return getEmailStyle(key, { client });
}

export async function resetEmailStyle({ client = prisma, key }) {
  templateOrThrow(key);
  await client.emailTemplateStyle.deleteMany({ where: { templateKey: key } });
  return getEmailStyle(key, { client });
}
