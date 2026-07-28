import fs from 'node:fs';
import path from 'node:path';

const VALID_CATEGORIES = new Set([
  'feature',
  'enhancement',
  'fix',
  'policy/operations',
  'breaking change',
]);

const VALID_STATUSES = new Set(['new', 'updated', 'resolved']);

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const defaultPath = path.resolve(
  import.meta.dirname,
  '../../data/release-notes.json'
);

export const releaseNotesPath =
  process.env.RELEASE_NOTES_PATH || defaultPath;

function isValidDateString(dateString) {
  if (!dateString || !ISO_DATE_REGEX.test(dateString)) return false;
  const parsed = new Date(dateString);
  return !Number.isNaN(parsed.getTime());
}

function isFutureDate(dateString) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return new Date(dateString) > today;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateLink(link) {
  if (!link || typeof link !== 'object') return false;
  if (!isNonEmptyString(link.label)) return false;
  if (!isNonEmptyString(link.url)) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(link.url);
  } catch {
    return false;
  }
  return true;
}

export function validateEntry(entry, seenIds = new Set()) {
  if (!entry || typeof entry !== 'object') return false;
  if (!isNonEmptyString(entry.id)) return false;
  if (seenIds.has(entry.id)) return false;
  if (!isValidDateString(entry.releaseDate)) return false;
  if (isFutureDate(entry.releaseDate)) return false;
  if (!isNonEmptyString(entry.title)) return false;
  if (!isNonEmptyString(entry.summary)) return false;
  if (entry.category && !VALID_CATEGORIES.has(entry.category)) return false;
  if (entry.status && !VALID_STATUSES.has(entry.status)) return false;
  if (
    entry.affectedArea !== undefined &&
    (typeof entry.affectedArea !== 'string' || entry.affectedArea.trim() === '')
  ) {
    return false;
  }
  if (entry.details !== undefined && typeof entry.details !== 'string') {
    return false;
  }
  if (entry.links !== undefined) {
    if (!Array.isArray(entry.links)) return false;
    if (!entry.links.every(validateLink)) return false;
  }
  return true;
}

export function loadReleaseNotes(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error('Release notes must be a JSON array');
  }

  const seenIds = new Set();
  const valid = parsed.filter((entry) => {
    const isValid = validateEntry(entry, seenIds);
    if (isValid) seenIds.add(entry.id);
    return isValid;
  });

  return valid
    .map((entry) => ({
      ...entry,
      links: Array.isArray(entry.links) ? entry.links : [],
    }))
    .sort((a, b) => new Date(b.releaseDate) - new Date(a.releaseDate));
}

export function getReleaseNotes() {
  return loadReleaseNotes(releaseNotesPath);
}
