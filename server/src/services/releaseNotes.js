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

const defaultPath = path.resolve(
  import.meta.dirname,
  '../../data/release-notes.json'
);

export const releaseNotesPath =
  process.env.RELEASE_NOTES_PATH || defaultPath;

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!entry.id || typeof entry.id !== 'string') return false;
  if (!entry.releaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(entry.releaseDate)) return false;
  if (!entry.title || typeof entry.title !== 'string') return false;
  if (!entry.summary || typeof entry.summary !== 'string') return false;
  if (entry.category && !VALID_CATEGORIES.has(entry.category)) return false;
  if (entry.status && !VALID_STATUSES.has(entry.status)) return false;
  if (entry.links && !Array.isArray(entry.links)) return false;
  return true;
}

export function getReleaseNotes() {
  const raw = fs.readFileSync(releaseNotesPath, 'utf8');
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error('Release notes must be a JSON array');
  }

  const valid = parsed.filter(validateEntry);

  return valid
    .map((entry) => ({
      ...entry,
      links: Array.isArray(entry.links) ? entry.links : [],
    }))
    .sort((a, b) => new Date(b.releaseDate) - new Date(a.releaseDate));
}
