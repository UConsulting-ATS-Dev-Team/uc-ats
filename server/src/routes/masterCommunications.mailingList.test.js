// The Mailing List tab in Master Communications.
//
// An admin uploads the retiring recruiting-interest export and gets back what
// survives dedup against the ATS. The server stores nothing, so what these
// tests pin down is the response: the survivors, and a full account of every
// row that was dropped and why.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import routes from './masterCommunications.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    candidate: { findMany: vi.fn() },
    application: { findMany: vi.fn() },
    meetingSignup: { findMany: vi.fn() },
  },
}));

const admin = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Admin One' };
const member = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org', fullName: 'Member One' };
const ALL = [admin, member];

let server;
let port;

const upload = (csv, { user = admin, emailColumn, fileName = 'list.csv' } = {}) => {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), fileName);
  if (emailColumn) form.append('emailColumn', emailColumn);
  return fetch(`http://localhost:${port}/api/master-communications/mailing-list/dedupe`, {
    method: 'POST',
    headers: user ? { Authorization: `Bearer ${jwt.sign({ userId: user.id }, process.env.JWT_SECRET)}` } : {},
    body: form,
  });
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/master-communications', routes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockImplementation(({ where: { id } }) => ALL.find((u) => u.id === id) || null);
  // The ATS already knows these four, one per table.
  prisma.user.findMany.mockResolvedValue([{ email: 'known-user@ucla.edu' }]);
  prisma.candidate.findMany.mockResolvedValue([{ email: 'known-candidate@ucla.edu' }]);
  prisma.application.findMany.mockResolvedValue([{ email: 'known-applicant@ucla.edu' }]);
  prisma.meetingSignup.findMany.mockResolvedValue([{ email: 'known-signup@ucla.edu' }]);
});

describe('access', () => {
  it('is admin-only', async () => {
    expect((await upload('Email\na@ucla.edu\n', { user: member })).status).toBe(403);
  });

  it('refuses an anonymous upload', async () => {
    expect((await upload('Email\na@ucla.edu\n', { user: null })).status).toBe(401);
  });
});

describe('dedup', () => {
  it('keeps only the addresses the ATS has never seen', async () => {
    const csv = [
      'Name,Email',
      'New Person,new@ucla.edu',
      'Known User,known-user@ucla.edu',
      'Known Candidate,known-candidate@ucla.edu',
      'Known Applicant,known-applicant@ucla.edu',
      'Known Signup,known-signup@ucla.edu',
      'Also New,another@ucla.edu',
    ].join('\n');

    const body = await (await upload(csv)).json();

    expect(body.emailColumn).toBe('Email');
    expect(body.rows).toBe(6);
    expect(body.knownAddresses).toBe(4);
    expect(body.keptCount).toBe(2);
    expect(body.summary.counts.kept).toBe(2);
    expect(body.summary.counts['already-in-system']).toBe(4);
    // The survivors keep the source file's columns, untouched.
    expect(body.csv).toContain('Name,Email');
    expect(body.csv).toContain('New Person,new@ucla.edu');
    expect(body.csv).not.toContain('known-user@ucla.edu');
  });

  it('matches case-insensitively, because the ATS stores addresses lowercased', async () => {
    const body = await (await upload('Email\nKNOWN-User@UCLA.edu\n')).json();
    expect(body.keptCount).toBe(0);
    expect(body.summary.counts['already-in-system']).toBe(1);
  });

  it('accounts for every dropped row with a line number and a reason', async () => {
    const csv = [
      'Email',
      'new@ucla.edu',
      'known-user@ucla.edu',
      'new@ucla.edu',
      'not-an-address',
      '',
      ' ',
    ].join('\n');

    const body = await (await upload(csv)).json();

    const byOutcome = Object.fromEntries(body.dropped.map((d) => [d.outcome, d]));
    expect(byOutcome['already-in-system'].line).toBe(3);
    expect(byOutcome['already-in-system'].sources).toEqual(['user']);
    expect(byOutcome['duplicate-in-file'].line).toBe(4);
    expect(byOutcome['duplicate-in-file'].firstSeenAt).toBe(2);
    expect(byOutcome['invalid-email'].line).toBe(5);
    expect(byOutcome['invalid-email'].raw).toBe('not-an-address');
    // Blank rows are dropped by the CSV reader, so they never reach the dedup.
    expect(body.summary.counts['missing-email']).toBe(0);
  });

  it('reports which table each known address matched', async () => {
    prisma.user.findMany.mockResolvedValue([{ email: 'both@ucla.edu' }]);
    prisma.candidate.findMany.mockResolvedValue([{ email: 'both@ucla.edu' }]);

    const body = await (await upload('Email\nboth@ucla.edu\n')).json();

    expect(body.dropped[0].sources).toEqual(['candidate', 'user']);
    expect(body.summary.bySource).toEqual({ candidate: 1, user: 1 });
  });
});

describe('the email column', () => {
  it('hands back the headers when it cannot find one, rather than failing', async () => {
    const body = await (await upload('Name,Contact\nJoe,joe@ucla.edu\n')).json();

    expect(body.emailColumn).toBeNull();
    expect(body.headers).toEqual(['Name', 'Contact']);
    expect(body.overrideMissed).toBe(false);
    // Nothing was deduped, so the ATS was never read.
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('uses the column the admin picked', async () => {
    const body = await (await upload('Name,Contact\nJoe,joe@ucla.edu\n', { emailColumn: 'Contact' })).json();

    expect(body.emailColumn).toBe('Contact');
    expect(body.keptCount).toBe(1);
  });

  it('says so when the picked column is not in the file, instead of dropping every row', async () => {
    const body = await (await upload('Name,Contact\nJoe,joe@ucla.edu\n', { emailColumn: 'Nope' })).json();

    expect(body.emailColumn).toBeNull();
    expect(body.overrideMissed).toBe(true);
    expect(body.keptCount).toBeUndefined();
  });

  it('prefers an exact "Email" over a column that merely contains it', async () => {
    const body = await (await upload('Email Verified,Email\nyes,new@ucla.edu\n')).json();
    expect(body.emailColumn).toBe('Email');
  });
});

describe('bad uploads', () => {
  it('refuses a request with no file', async () => {
    const res = await fetch(`http://localhost:${port}/api/master-communications/mailing-list/dedupe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt.sign({ userId: admin.id }, process.env.JWT_SECRET)}` },
      body: new FormData(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no file/i);
  });

  it('refuses a file that is not a CSV', async () => {
    const res = await upload('%PDF-1.4', { fileName: 'list.pdf' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/\.csv/i);
  });

  it('refuses an empty file as JSON, not as an HTML 500', async () => {
    const res = await upload('');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no rows/i);
  });
});
