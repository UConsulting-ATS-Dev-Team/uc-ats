import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateEntry, loadReleaseNotes, getReleaseNotes } from './releaseNotes.js';

function validEntry(overrides = {}) {
  return {
    id: 'test-entry',
    releaseDate: '2026-07-28',
    title: 'A shipped feature',
    summary: 'It does things',
    category: 'feature',
    status: 'resolved',
    affectedArea: 'Admin',
    links: [{ label: 'Issue #1', url: 'https://github.com/example/repo/issues/1' }],
    ...overrides,
  };
}

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

  it('rejects unknown category or status', () => {
    expect(validateEntry(validEntry({ category: 'magic' }))).toBe(false);
    expect(validateEntry(validEntry({ status: 'almost' }))).toBe(false);
  });

  it('rejects duplicate ids within the same batch', () => {
    const seen = new Set(['test-entry']);
    expect(validateEntry(validEntry(), seen)).toBe(false);
  });

  it('rejects malformed links', () => {
    expect(validateEntry(validEntry({ links: [{ label: '', url: '' }] }))).toBe(false);
    expect(validateEntry(validEntry({ links: [{ label: 'Bad URL', url: 'not-a-url' }] }))).toBe(false);
  });

  it('rejects an invalid affectedArea', () => {
    expect(validateEntry(validEntry({ affectedArea: '   ' }))).toBe(false);
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

  it('skips invalid entries and returns the rest', () => {
    const filePath = writeFile([
      validEntry({ id: 'good', title: 'Good' }),
      validEntry({ id: 'bad', title: '', summary: '' }),
    ]);

    const notes = loadReleaseNotes(filePath);
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe('good');
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
  it('loads the tracked release notes without fabricated entries', () => {
    const notes = getReleaseNotes();
    expect(notes.length).toBeGreaterThan(0);

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    for (const note of notes) {
      expect(note.id).toBeTruthy();
      expect(note.title).toBeTruthy();
      expect(note.summary).toBeTruthy();
      const noteDate = new Date(note.releaseDate).getTime();
      expect(noteDate).not.toBeNaN();
      expect(noteDate).toBeLessThanOrEqual(today.getTime());
    }
  });
});
