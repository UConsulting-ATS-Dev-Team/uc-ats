// Pull searchable text out of resume PDFs so partners can search what a resume
// says, not just the columns beside it.
//
// Claude reads the PDF directly rather than a text-extraction library: these
// resumes are two-column, design-heavy, and sometimes exported as images, all of
// which defeat a text layer. One call returns the prose and an expanded skill
// line - "React" written once yields react, javascript, frontend - which is what
// makes a plain `contains` search find the right people without a taxonomy.
//
// Idempotent and resumable: a source already extracted at the current
// EXTRACTOR_VERSION is skipped, so re-running after a crash costs nothing.
// Bump EXTRACTOR_VERSION when the prompt or output shape changes and re-run.
//
//   node scripts/extractResumeText.js --limit 5     # smoke-test five resumes
//   node scripts/extractResumeText.js               # everything not yet done
//   node scripts/extractResumeText.js --force       # re-extract regardless
//
// Needs ANTHROPIC_API_KEY in the environment (or server/.env).
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import prisma from '../src/prismaClient.js';
import { getFileStream } from '../src/services/google/drive.js';
import { extractDriveFileId } from '../src/utils/clientVisibility.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = path.join(__dirname, '../storage');

export const EXTRACTOR_VERSION = '1';
const MODEL = 'claude-opus-5';
// Room for a long resume's prose plus the skill line; a two-page resume lands
// well under this, and hitting the cap would truncate mid-word.
const MAX_TOKENS = 8000;
const CONCURRENCY = 6;

const SYSTEM = `You extract searchable text from student resumes for a recruiting database.

Return two things:

1. "text" - the resume's full readable content as plain text. Preserve reading
   order across columns. Keep employers, titles, dates, coursework, projects,
   and activities. Drop page furniture and decoration. Do not summarize, do not
   editorialize, do not add anything the resume does not say.

2. "skills" - the skills and tools this person can demonstrably use, as short
   lowercase tags. Include what the resume states outright AND the obvious
   implied neighbours a recruiter would search for: "React" implies react,
   javascript, frontend; "built financial models in Excel" implies excel,
   financial modeling. Expand abbreviations and include the common spellings of
   the same thing (excel, microsoft excel) so a keyword search finds them.
   Include spoken languages. 15-40 tags. Never invent a skill the resume gives
   no evidence for.

The person's own words are the source. If the PDF is unreadable, return empty
values rather than guessing.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    skills: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'skills'],
  additionalProperties: false,
};

const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

// Applications live in Drive, member resumes on local disk. Always the full
// resume - the redacted variant is a separate decision and a separate row.
const loadPdf = async (source) => {
  if (source.kind === 'application') {
    const fileId = extractDriveFileId(source.resumeUrl);
    if (!fileId) return null;
    return streamToBuffer(await getFileStream(fileId));
  }
  const absPath = path.join(STORAGE_DIR, source.storagePath);
  return fs.existsSync(absPath) ? fs.readFileSync(absPath) : null;
};

// One searchable column, because one column is one search target. The skill
// line rides along with the prose so `contains` hits either.
const toSearchableText = ({ text, skills }) => {
  const tags = (skills || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(tags)];
  return [text || '', unique.length ? `\n\nSKILLS: ${unique.join(', ')}` : ''].join('').trim();
};

export const extractOne = async (client, source) => {
  const pdf = await loadPdf(source);
  if (!pdf) return { source, status: 'no-file' };

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
          },
          { type: 'text', text: 'Extract this resume.' },
        ],
      },
    ],
  });

  const block = response.content.find((b) => b.type === 'text');
  const parsed = JSON.parse(block.text);
  const text = toSearchableText(parsed);
  if (!text) return { source, status: 'empty' };

  const where =
    source.kind === 'application'
      ? { applicationId: source.id }
      : { memberResumeId: source.id };
  const data = {
    ...where,
    text,
    extractorVersion: EXTRACTOR_VERSION,
    model: MODEL,
    charCount: text.length,
  };

  await prisma.resumeExtraction.upsert({ where, create: data, update: data });
  return { source, status: 'ok', chars: text.length, skills: parsed.skills?.length || 0 };
};

const loadSources = async ({ force }) => {
  const [applications, memberResumes] = await Promise.all([
    prisma.application.findMany({
      where: { resumeUrl: { not: null } },
      select: { id: true, resumeUrl: true, resumeExtraction: { select: { extractorVersion: true } } },
    }),
    prisma.memberResume.findMany({
      where: { isCurrent: true },
      select: { id: true, storagePath: true, resumeExtraction: { select: { extractorVersion: true } } },
    }),
  ]);

  const done = (row) => !force && row.resumeExtraction?.extractorVersion === EXTRACTOR_VERSION;

  return [
    ...applications.filter((a) => !done(a)).map((a) => ({ kind: 'application', id: a.id, resumeUrl: a.resumeUrl })),
    ...memberResumes.filter((m) => !done(m)).map((m) => ({ kind: 'member', id: m.id, storagePath: m.storagePath })),
  ];
};

// Fixed pool rather than Promise.all over everything: 777 concurrent Drive
// fetches and API calls would rate-limit both ends.
const runPool = async (items, worker, size) => {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
};

const main = async (argv) => {
  const force = argv.includes('--force');
  const limitFlag = argv.indexOf('--limit');
  const limit = limitFlag !== -1 ? Number(argv[limitFlag + 1]) : null;

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set. Export it or add it to server/.env.');
    process.exit(1);
  }

  const client = new Anthropic();
  let sources = await loadSources({ force });
  if (limit) sources = sources.slice(0, limit);

  if (sources.length === 0) {
    console.log('Nothing to extract - every resume is current.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Extracting ${sources.length} resume(s) at concurrency ${CONCURRENCY}...`);
  const started = process.hrtime.bigint();
  let done = 0;

  const results = await runPool(
    sources,
    async (source) => {
      try {
        const result = await extractOne(client, source);
        done += 1;
        if (done % 25 === 0 || done === sources.length) {
          console.log(`  ${done}/${sources.length}`);
        }
        return result;
      } catch (error) {
        done += 1;
        return { source, status: 'error', message: error.message };
      }
    },
    CONCURRENCY
  );

  const by = (status) => results.filter((r) => r?.status === status);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e9;

  console.log(`\nDone in ${Math.round(elapsed)}s`);
  console.log(`  extracted: ${by('ok').length}`);
  console.log(`  no file:   ${by('no-file').length}`);
  console.log(`  empty:     ${by('empty').length}`);
  console.log(`  errored:   ${by('error').length}`);
  for (const failure of by('error').slice(0, 10)) {
    console.log(`    ${failure.source.kind} ${failure.source.id}: ${failure.message}`);
  }
  if (by('error').length > 0) console.log('  (re-run to retry - completed rows are skipped)');

  await prisma.$disconnect();
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
}
