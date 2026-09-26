import prisma from '../prismaClient.js';

/**
 * How every automatic email looks, as one set of values an admin can change.
 *
 * The defaults are the look the emails already had, so an admin who never
 * opens the Theme tab sees no change. Each column overrides one default and a
 * null column falls through to it, the same layering emailTemplateCopy.js uses
 * for wording.
 *
 * Everything here ends up inside a style attribute or an <img src>, which is
 * why each value is validated against a narrow shape rather than escaped and
 * hoped for: colours are hex, the font is picked from a list, the logo is an
 * https URL. Free text (brand name, footer) is escaped by the layout.
 */

const ROW_ID = 'default';

// Fonts every mail client has. Anything else silently falls back to the
// client's default, which is how an email ends up in Times New Roman.
export const EMAIL_FONTS = Object.freeze([
  { id: 'arial', label: 'Arial', stack: 'Arial, Helvetica, sans-serif' },
  { id: 'helvetica', label: 'Helvetica', stack: 'Helvetica, Arial, sans-serif' },
  { id: 'verdana', label: 'Verdana', stack: 'Verdana, Geneva, sans-serif' },
  { id: 'tahoma', label: 'Tahoma', stack: 'Tahoma, Geneva, sans-serif' },
  { id: 'trebuchet', label: 'Trebuchet MS', stack: "'Trebuchet MS', Helvetica, sans-serif" },
  { id: 'georgia', label: 'Georgia', stack: 'Georgia, serif' },
  { id: 'times', label: 'Times New Roman', stack: "'Times New Roman', Times, serif" },
]);

export const THEME_DEFAULTS = Object.freeze({
  // Null means each email keeps the name it has always shown ("UConsulting
  // ATS", "UConsulting Talent Network", ...). Set, it replaces all of them.
  brandName: null,
  logoUrl: null,
  headerBackground: '#f8f9fa',
  headerTextColor: '#042742',
  accentColor: '#0C74C1',
  fontFamily: 'arial',
  footerText: 'This is an automated message. Please do not reply to this email.',
});

export const THEME_FIELDS = Object.freeze(Object.keys(THEME_DEFAULTS));

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const COLOUR_FIELDS = ['headerBackground', 'headerTextColor', 'accentColor'];
const LIMITS = { brandName: 80, logoUrl: 500, footerText: 500 };
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/;

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

export const fontStack = (id) =>
  (EMAIL_FONTS.find((font) => font.id === id) ?? EMAIL_FONTS[0]).stack;

export const isHexColour = (value) => typeof value === 'string' && HEX.test(value.trim());

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Validates what an admin submitted and keeps only what differs from the
 * default, so "customized" means somebody changed something and a default
 * reworded in the code still reaches a theme nobody touched.
 */
export function normalizeTheme(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw fail(400, 'Theme must be an object', 'INVALID_THEME');
  }

  const theme = {};
  for (const field of THEME_FIELDS) {
    const value = trimmed(input[field]);

    // The footer is the one field whose default is not empty, so a blank one
    // is a choice ("no footer") rather than "use the default". It is stored as
    // '' to tell the two apart; null still means the shipped footer.
    if (field === 'footerText' && !value && typeof input[field] === 'string') {
      theme.footerText = '';
      continue;
    }

    if (!value || value === THEME_DEFAULTS[field]) continue;

    if (COLOUR_FIELDS.includes(field)) {
      if (!HEX.test(value)) throw fail(400, `${field} must be a hex colour like #0C74C1`, 'INVALID_THEME');
      if (value.toLowerCase() === String(THEME_DEFAULTS[field]).toLowerCase()) continue;
    } else if (field === 'fontFamily') {
      if (!EMAIL_FONTS.some((font) => font.id === value)) throw fail(400, 'Unknown font', 'INVALID_THEME');
    } else if (field === 'logoUrl') {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw fail(400, 'Logo must be a full https:// address', 'INVALID_THEME');
      }
      // http images are blocked or flagged by most clients, and anything that
      // is not a web address has no business in an <img src>.
      if (url.protocol !== 'https:') throw fail(400, 'Logo must be a full https:// address', 'INVALID_THEME');
    } else if (HTML_TAG.test(value)) {
      throw fail(400, `${field} contains HTML. Write plain text.`, 'HTML_NOT_ALLOWED');
    }

    if (LIMITS[field] && value.length > LIMITS[field]) {
      throw fail(400, `${field} is over ${LIMITS[field]} characters`, 'INVALID_THEME');
    }
    theme[field] = value;
  }
  return theme;
}

// Read on the path that sends real mail, where the table may not exist yet
// (migrations are applied by hand). A failed read renders the shipped look and
// says so once, rather than stopping an email.
let warnedAboutStore = false;

async function readRow(client) {
  try {
    return await client.emailTheme.findUnique({ where: { id: ROW_ID } });
  } catch (error) {
    if (!warnedAboutStore) {
      warnedAboutStore = true;
      console.error('[emailTheme] falling back to the shipped look:', error?.message ?? error);
    }
    return null;
  }
}

const storedTheme = (row) => {
  const stored = {};
  for (const field of THEME_FIELDS) {
    if (row?.[field]) stored[field] = row[field];
  }
  // '' is a stored "no footer", which the truthiness check above skips.
  if (row?.footerText === '') stored.footerText = '';
  return stored;
};

/** The theme an email should render with: defaults, then whatever is stored. */
export async function resolveEmailTheme({ client = prisma } = {}) {
  return { ...THEME_DEFAULTS, ...storedTheme(await readRow(client)) };
}

/** Defaults, stored values and the fonts to choose from, for the editor. */
export async function getEmailTheme({ client = prisma } = {}) {
  const row = await readRow(client);
  const stored = storedTheme(row);
  return {
    defaults: THEME_DEFAULTS,
    values: { ...THEME_DEFAULTS, ...stored },
    fonts: EMAIL_FONTS.map(({ id, label }) => ({ id, label })),
    customized: Object.keys(stored).length > 0,
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function saveEmailTheme({ client = prisma, theme, user }) {
  const normalized = normalizeTheme(theme);
  if (Object.keys(normalized).length === 0) return resetEmailTheme({ client });

  // Every column is written, so a field set back to its default is cleared
  // rather than left holding the old override.
  const data = Object.fromEntries(THEME_FIELDS.map((field) => [field, normalized[field] ?? null]));
  await client.emailTheme.upsert({
    where: { id: ROW_ID },
    create: { id: ROW_ID, ...data, updatedById: user?.id ?? null },
    update: { ...data, updatedById: user?.id ?? null },
  });
  return getEmailTheme({ client });
}

export async function resetEmailTheme({ client = prisma } = {}) {
  await client.emailTheme.deleteMany({ where: { id: ROW_ID } });
  return getEmailTheme({ client });
}
