// Case page images go to shared storage, not the instance's disk.
//
// Render wipes an instance's disk on deploy and gives each instance its own, so
// a page written there was readable only from the instance that took the
// upload, until the next deploy. These pin that every write and read goes to
// the bucket, which every instance shares and which outlives a deploy.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import routes from './cases.js';

// An in-memory bucket standing in for Supabase Storage.
const bucket = vi.hoisted(() => new Map());

vi.mock('../supabaseClient.js', () => {
  const storage = {
    getBucket: async () => ({ data: { name: 'cases' } }),
    createBucket: async () => ({}),
    from: (name) => ({
      upload: async (key, buffer) => {
        bucket.set(`${name}/${key}`, Buffer.from(buffer));
        return { error: null };
      },
      download: async (key) => {
        const body = bucket.get(`${name}/${key}`);
        return body ? { data: new Blob([body]), error: null } : { data: null, error: { message: 'not found' } };
      },
      remove: async (keys) => {
        keys.forEach((key) => bucket.delete(`${name}/${key}`));
        return { error: null };
      },
    }),
  };
  return { default: { storage }, isSupabaseAvailable: () => true };
});

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    case: { findUnique: vi.fn(), update: vi.fn() },
    casePage: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    $executeRaw: vi.fn(),
  },
}));

const admin = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Admin One' };

let server;
let port;

const auth = () => ({ Authorization: `Bearer ${jwt.sign({ userId: admin.id }, process.env.JWT_SECRET)}` });

const uploadPage = (pageNumber, bytes) => {
  const form = new FormData();
  form.append('pageNumber', String(pageNumber));
  form.append('width', '100');
  form.append('height', '50');
  form.append('image', new Blob([bytes], { type: 'image/webp' }), `page-${pageNumber}.webp`);
  return fetch(`http://localhost:${port}/api/cases/case-1/pages`, { method: 'POST', headers: auth(), body: form });
};

const getImage = (pageId) =>
  fetch(`http://localhost:${port}/api/cases/case-1/pages/${pageId}/image`, { headers: auth() });

// Page rows, keyed by pageNumber, as the upsert leaves them.
let rows;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cases', routes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  bucket.clear();
  rows = new Map();
  prisma.user.findUnique.mockResolvedValue(admin);
  prisma.case.findUnique.mockResolvedValue({ id: 'case-1' });
  prisma.case.update.mockResolvedValue({});
  prisma.casePage.count.mockImplementation(async () => rows.size);
  prisma.casePage.findUnique.mockImplementation(async ({ where }) => rows.get(where.caseId_pageNumber.pageNumber) || null);
  prisma.casePage.upsert.mockImplementation(async ({ where, create, update }) => {
    const n = where.caseId_pageNumber.pageNumber;
    const existing = rows.get(n);
    const row = existing
      ? { ...existing, ...update }
      : { id: `page-${n}`, pageType: 'NORMAL', exhibitLabel: null, ...create };
    rows.set(n, row);
    return row;
  });
  prisma.casePage.findFirst.mockImplementation(async ({ where }) =>
    [...rows.values()].find((r) => r.id === where.id) || null
  );
});

describe('page images', () => {
  it('are stored in the shared bucket, not on the instance disk', async () => {
    const res = await uploadPage(1, 'first page');
    expect(res.status).toBe(201);

    const stored = [...bucket.keys()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/^cases\/cases\/case-1\/pages\/[0-9a-f-]{36}\.webp$/);
    expect(rows.get(1).imageStoragePath).toBe(stored[0].slice('cases/'.length));
  });

  it('are served from the bucket', async () => {
    await uploadPage(1, 'first page');

    const res = await getImage('page-1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(await res.text()).toBe('first page');
  });

  it('can be re-uploaded in place: same row, new image, old object removed', async () => {
    await uploadPage(1, 'lost on a deploy');
    rows.get(1).pageType = 'EXHIBIT';
    const before = rows.get(1).imageStoragePath;

    await uploadPage(1, 'uploaded again');

    expect(rows.get(1).id).toBe('page-1');
    expect(rows.get(1).pageType).toBe('EXHIBIT');
    expect(rows.get(1).imageStoragePath).not.toBe(before);
    expect(bucket.size).toBe(1);
    expect(await (await getImage('page-1')).text()).toBe('uploaded again');
  });

  it('answer 404 with a code when the row outlived its file', async () => {
    rows.set(1, { id: 'page-1', pageNumber: 1, imageStoragePath: 'cases/case-1/page-1.webp' });

    const res = await getImage('page-1');
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('CASE_PAGE_FILE_MISSING');
  });

  it('are removed from the bucket when the page is deleted', async () => {
    await uploadPage(1, 'first page');
    prisma.casePage.delete.mockImplementation(async () => rows.delete(1));

    const res = await fetch(`http://localhost:${port}/api/cases/case-1/pages/page-1`, {
      method: 'DELETE',
      headers: auth(),
    });

    expect(res.status).toBe(200);
    expect(bucket.size).toBe(0);
  });
});
