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

function validateLink(link, linkIndex) {
  if (!link || typeof link !== 'object') {
    return `link at index ${linkIndex} is not an object`;
  }
  if (!isNonEmptyString(link.label)) {
    return `link at index ${linkIndex} has an empty or missing 'label'`;
  }
  if (!isNonEmptyString(link.url)) {
    return `link at index ${linkIndex} has an empty or missing 'url'`;
  }
  try {
    // eslint-disable-next-line no-new
    new URL(link.url);
  } catch {
    return `link at index ${linkIndex} has an invalid URL '${link.url}'`;
  }
  return null;
}

/**
 * Returns an actionable error string for a release-note entry, or `null` if valid.
 */
export function getEntryValidationError(entry, index, seenIds = new Set()) {
  const prefix =
    entry && typeof entry === 'object' && isNonEmptyString(entry.id)
      ? `entry '${entry.id}' (index ${index})`
      : `entry at index ${index}`;

  if (!entry || typeof entry !== 'object') {
    return `Entry at index ${index} is not an object`;
  }
  if (!isNonEmptyString(entry.id)) {
    return `${prefix} is missing a non-empty 'id'`;
  }
  if (seenIds.has(entry.id)) {
    return `Duplicate release note id '${entry.id}' at index ${index}`;
  }
  if (!isValidDateString(entry.releaseDate)) {
    return `${prefix} has an invalid 'releaseDate' (expected YYYY-MM-DD)`;
  }
  if (isFutureDate(entry.releaseDate)) {
    return `${prefix} has a future 'releaseDate' (${entry.releaseDate})`;
  }
  if (!isNonEmptyString(entry.title)) {
    return `${prefix} is missing a non-empty 'title'`;
  }
  if (!isNonEmptyString(entry.summary)) {
    return `${prefix} is missing a non-empty 'summary'`;
  }
  if (!isNonEmptyString(entry.category) || !VALID_CATEGORIES.has(entry.category)) {
    return `${prefix} has an invalid or missing 'category'`;
  }
  if (!isNonEmptyString(entry.affectedArea)) {
    return `${prefix} is missing a non-empty 'affectedArea'`;
  }
  if (
    entry.status !== undefined &&
    (typeof entry.status !== 'string' || !VALID_STATUSES.has(entry.status))
  ) {
    return `${prefix} has an invalid 'status'`;
  }
  if (entry.details !== undefined && typeof entry.details !== 'string') {
    return `${prefix} has an invalid 'details' (must be a string)`;
  }
  if (entry.links !== undefined) {
    if (!Array.isArray(entry.links)) {
      return `${prefix} has an invalid 'links' (must be an array)`;
    }
    for (let i = 0; i < entry.links.length; i++) {
      const linkError = validateLink(entry.links[i], i);
      if (linkError) {
        return `${prefix} has an invalid ${linkError}`;
      }
    }
  }
  return null;
}

/**
 * Returns `true` if the entry is valid, `false` otherwise.
 * Kept for convenient unit assertions; use `getEntryValidationError` for diagnostics.
 */
export function validateEntry(entry, seenIds = new Set()) {
  return getEntryValidationError(entry, 0, seenIds) === null;
}

export function loadReleaseNotes(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error('Release notes must be a JSON array');
  }

  const seenIds = new Set();
  for (let i = 0; i < parsed.length; i++) {
    const error = getEntryValidationError(parsed[i], i, seenIds);
    if (error) {
      throw new Error(`Invalid release notes data: ${error}`);
    }
    seenIds.add(parsed[i].id);
  }

  return parsed
    .map((entry) => ({
      ...entry,
      links: Array.isArray(entry.links) ? entry.links : [],
    }))
    .sort((a, b) => new Date(b.releaseDate) - new Date(a.releaseDate));
}

export function getReleaseNotes() {
  return loadReleaseNotes(releaseNotesPath);
}
