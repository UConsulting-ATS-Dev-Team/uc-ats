// The API call itself is not exercised here - what is, is everything around it:
// that a member resume is read off disk, that the skill line is folded into the
// one searchable column, and that the row is keyed to the source it came from.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import prisma from '../src/prismaClient.js';
import { extractOne, EXTRACTOR_VERSION } from './extractResumeText.js';

vi.mock('../src/prismaClient.js', () => ({
  default: { resumeExtraction: { upsert: vi.fn() } }
}));

vi.mock('../src/services/google/drive.js', () => ({ getFileStream: vi.fn() }));

const storageRoot = path.join(import.meta.dirname, '../storage');
const relPath = `member-resumes/test-${process.pid}/resume.pdf`;
const absPath = path.join(storageRoot, relPath);

const fakeClient = (payload) => ({
  messages: {
    create: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(payload) }]
    })
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, '%PDF-1.4 fake');
});

afterAll(() => {
  fs.rmSync(path.dirname(absPath), { recursive: true, force: true });
});

describe('extractOne', () => {
  const source = { kind: 'member', id: 'member-resume-1', storagePath: relPath };

  it('stores prose and skills in one searchable column', async () => {
    const client = fakeClient({
      text: 'Built dashboards in Tableau for a retail client.',
      skills: ['Tableau', 'tableau', ' Data Visualization ', '']
    });

    const result = await extractOne(client, source);

    expect(result.status).toBe('ok');
    const { where, create } = prisma.resumeExtraction.upsert.mock.calls[0][0];
    // Keyed to the resume row, not the person - a re-upload is a new row.
    expect(where).toEqual({ memberResumeId: 'member-resume-1' });
    expect(create.extractorVersion).toBe(EXTRACTOR_VERSION);
    // One column is one search target: prose and tags both live in `text`.
    expect(create.text).toContain('Tableau for a retail client');
    expect(create.text).toContain('SKILLS: tableau, data visualization');
    expect(create.charCount).toBe(create.text.length);
  });

  it('reports a missing file instead of writing an empty row', async () => {
    const client = fakeClient({ text: 'unused', skills: [] });

    const result = await extractOne(client, { ...source, storagePath: 'member-resumes/nope/resume.pdf' });

    expect(result.status).toBe('no-file');
    expect(client.messages.create).not.toHaveBeenCalled();
    expect(prisma.resumeExtraction.upsert).not.toHaveBeenCalled();
  });

  it('skips an unreadable PDF rather than indexing nothing', async () => {
    const client = fakeClient({ text: '   ', skills: [] });

    const result = await extractOne(client, source);

    expect(result.status).toBe('empty');
    expect(prisma.resumeExtraction.upsert).not.toHaveBeenCalled();
  });
});
