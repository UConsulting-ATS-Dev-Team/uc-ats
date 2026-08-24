import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getEntryValidationError,
  validateEntry,
  loadReleaseNotes,
  getReleaseNotes,
  getMemberReleaseNotes,
  getCandidateReleaseNotes,
} from './releaseNotes.js';

function validEntry(overrides = {}) {
  return {
    id: 'test-entry',
    releaseDate: '2026-07-28',
    title: 'A shipped feature',
    summary: 'It does things',
    category: 'feature',
    affectedArea: 'Admin',
    status: 'resolved',
    details: 'More context',
    links: [{ label: 'Issue #1', url: 'https://github.com/example/repo/issues/1' }],
    ...overrides,
  };
}

describe('getEntryValidationError', () => {
  it('returns null for a valid entry', () => {
    expect(getEntryValidationError(validEntry(), 0)).toBeNull();
  });

  it('returns actionable errors for missing or invalid fields', () => {
    expect(getEntryValidationError(null, 0)).toContain('index 0');
    expect(getEntryValidationError(validEntry({ id: '' }), 0)).toContain("'id'");
    expect(getEntryValidationError(validEntry({ releaseDate: 'bad' }), 0)).toContain(
      'releaseDate'
    );
    expect(getEntryValidationError(validEntry({ title: '' }), 0)).toContain('title');
    expect(getEntryValidationError(validEntry({ summary: '   ' }), 0)).toContain('summary');
    expect(getEntryValidationError(validEntry({ category: 'magic' }), 0)).toContain('category');
    expect(getEntryValidationError(validEntry({ category: '' }), 0)).toContain('category');
    expect(getEntryValidationError(validEntry({ affectedArea: '' }), 0)).toContain(
      'affectedArea'
    );
    expect(getEntryValidationError(validEntry({ status: 'almost' }), 0)).toContain('status');
    expect(getEntryValidationError(validEntry({ details: 123 }), 0)).toContain('details');
  });

  it('reports a future releaseDate', () => {
    const future = new Date();
    future.setDate(future.getDate() + 7);
    const releaseDate = future.toISOString().split('T')[0];
    expect(getEntryValidationError(validEntry({ releaseDate }), 0)).toContain('future');
  });

  it('reports duplicate ids within the same batch', () => {
    const seen = new Set(['test-entry']);
    expect(getEntryValidationError(validEntry(), 1, seen)).toContain('Duplicate');
  });

  it('reports malformed links', () => {
    expect(getEntryValidationError(validEntry({ links: [{ label: '', url: '' }] }), 0)).toContain(
      'link'
    );
    expect(
      getEntryValidationError(
        validEntry({ links: [{ label: 'Bad URL', url: 'not-a-url' }] }),
        0
      )
    ).toContain('invalid URL');
  });
});

describe('validateEntry', () => {
  it('accepts a valid entry', () => {
    expect(validateEntry(validEntry())).toBe(true);
  });

  it('rejects a missing id', () => {
    expect(validateEntry(validEntry({ id: '' }))).toBe(false);
  });

  it('rejects an invalid releaseDate', () => {
    expect(validateEntry(validEntry({ releaseDate: '07-28-2026' }))).toBe(false);
    expect(validateEntry(validEntry({ releaseDate: 'not-a-date' }))).toBe(false);
  });

  it('rejects a future releaseDate', () => {
    const future = new Date();
    future.setDate(future.getDate() + 7);
    const releaseDate = future.toISOString().split('T')[0];
    expect(validateEntry(validEntry({ releaseDate }))).toBe(false);
  });

  it('rejects empty title or summary', () => {
    expect(validateEntry(validEntry({ title: '   ' }))).toBe(false);
    expect(validateEntry(validEntry({ summary: '' }))).toBe(false);
  });

  it('rejects missing or unknown category', () => {
    expect(validateEntry(validEntry({ category: 'magic' }))).toBe(false);
    expect(validateEntry(validEntry({ category: '' }))).toBe(false);
  });

  it('rejects missing affectedArea', () => {
    expect(validateEntry(validEntry({ affectedArea: '   ' }))).toBe(false);
  });

  it('rejects unknown status', () => {
    expect(validateEntry(validEntry({ status: 'almost' }))).toBe(false);
  });

  it('rejects duplicate ids within the same batch', () => {
    const seen = new Set(['test-entry']);
    expect(validateEntry(validEntry(), seen)).toBe(false);
  });

  it('rejects malformed links', () => {
    expect(validateEntry(validEntry({ links: [{ label: '', url: '' }] }))).toBe(false);
    expect(
      validateEntry(validEntry({ links: [{ label: 'Bad URL', url: 'not-a-url' }] }))
    ).toBe(false);
  });
});

describe('loadReleaseNotes', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeFile(data) {
    const filePath = path.join(tempDir, 'release-notes.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return filePath;
  }

  it('sorts valid entries newest-first', () => {
    const filePath = writeFile([
      validEntry({ id: 'old', releaseDate: '2025-01-15', title: 'Old' }),
      validEntry({ id: 'new', releaseDate: '2026-07-28', title: 'New' }),
    ]);

    const notes = loadReleaseNotes(filePath);
    expect(notes).toHaveLength(2);
    expect(notes[0].id).toBe('new');
    expect(notes[1].id).toBe('old');
  });

  it('throws on the first invalid entry with an actionable message', () => {
    const filePath = writeFile([
      validEntry({ id: 'good', title: 'Good' }),
      validEntry({ id: 'bad', title: '', summary: '' }),
    ]);

    expect(() => loadReleaseNotes(filePath)).toThrow(/Invalid release notes data.*bad/);
  });

  it('throws on a future releaseDate', () => {
    const future = new Date();
    future.setDate(future.getDate() + 365);
    const releaseDate = future.toISOString().split('T')[0];
    const filePath = writeFile([validEntry({ releaseDate })]);

    expect(() => loadReleaseNotes(filePath)).toThrow(/future/);
  });

  it('throws on a duplicate id', () => {
    const filePath = writeFile([validEntry(), validEntry()]);
    expect(() => loadReleaseNotes(filePath)).toThrow(/Duplicate/);
  });

  it('throws when the file is not a JSON array', () => {
    const filePath = writeFile({ not: 'an array' });
    expect(() => loadReleaseNotes(filePath)).toThrow('Release notes must be a JSON array');
  });

  it('throws when the file contains malformed JSON', () => {
    const filePath = path.join(tempDir, 'release-notes.json');
    fs.writeFileSync(filePath, '{ not valid');
    expect(() => loadReleaseNotes(filePath)).toThrow();
  });
});

describe('getReleaseNotes (production file)', () => {
  it('loads the complete tracked release notes file without filtering', () => {
    const notes = getReleaseNotes();
    expect(notes.length).toBeGreaterThan(0);

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    for (const note of notes) {
      expect(note.id).toBeTruthy();
      expect(note.title).toBeTruthy();
      expect(note.summary).toBeTruthy();
      expect(note.category).toBeTruthy();
      expect(note.affectedArea).toBeTruthy();
      const noteDate = new Date(note.releaseDate).getTime();
      expect(noteDate).not.toBeNaN();
      expect(noteDate).toBeLessThanOrEqual(today.getTime());
    }
  });
});

describe('getMemberReleaseNotes (production file)', () => {
  it('loads the member release notes file', () => {
    const notes = getMemberReleaseNotes();
    expect(Array.isArray(notes)).toBe(true);

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    for (const note of notes) {
      expect(note.id).toBeTruthy();
      expect(note.title).toBeTruthy();
      expect(note.summary).toBeTruthy();
      expect(note.category).toBeTruthy();
      expect(note.affectedArea).toBeTruthy();
      const noteDate = new Date(note.releaseDate).getTime();
      expect(noteDate).not.toBeNaN();
      expect(noteDate).toBeLessThanOrEqual(today.getTime());
    }
  });
});

describe('getCandidateReleaseNotes (production file)', () => {
  it('loads the candidate release notes file', () => {
    const notes = getCandidateReleaseNotes();
    expect(Array.isArray(notes)).toBe(true);

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    for (const note of notes) {
      expect(note.id).toBeTruthy();
      expect(note.title).toBeTruthy();
      expect(note.summary).toBeTruthy();
      expect(note.category).toBeTruthy();
      expect(note.affectedArea).toBeTruthy();
      const noteDate = new Date(note.releaseDate).getTime();
      expect(noteDate).not.toBeNaN();
      expect(noteDate).toBeLessThanOrEqual(today.getTime());
    }
  });
});
