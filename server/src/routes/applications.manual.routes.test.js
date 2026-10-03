// Adding an application by hand: uploaded resume, blind resume and video.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import applicationsRoutes from './applications.js';
import { putResume, removeResume } from '../services/resumeStorage.js';
import { documentSize } from '../services/applicationDocuments.js';

const VIDEO_ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b.mp4';

const stored = new Map();
vi.mock('../services/resumeStorage.js', async (importOriginal) => ({
  ...(await importOriginal()),
  putResume: vi.fn(async (key, buffer) => { stored.set(key, buffer); }),
  removeResume: vi.fn(async (key) => { stored.delete(key); }),
}));

vi.mock('../services/applicationDocuments.js', async (importOriginal) => ({
  ...(await importOriginal()),
  documentSize: vi.fn(),
}));

vi.mock('../services/luma/ingestGuests.js', () => ({
  claimLumaGuestsForCandidate: vi.fn(async () => {}),
}));

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    recruitingCycle: { findFirst: vi.fn() },
    candidate: { findUnique: vi.fn(), create: vi.fn() },
    application: { create: vi.fn() },
    resumeUpload: { create: vi.fn() },
    $transaction: vi.fn((ops) => Promise.all(ops)),
  },
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'admin@example.com' };
const memberUser = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'member@example.com' };
const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

const fields = {
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@ucla.edu',
  studentId: '405123456',
  phoneNumber: '3105550100',
  graduationYear: '2028',
  isTransferStudent: 'true',
  isFirstGeneration: 'false',
  cumulativeGpa: '3.8',
  major1: 'Economics',
  headshotUrl: 'https://example.com/headshot.jpg',
  shortAnswer: '  I want to join because...  ',
};

const pdf = (text = 'resume') => new Blob([Buffer.from(`%PDF-1.4\n%${text}\n`)], { type: 'application/pdf' });

let server;
let port;

const post = ({ user = adminUser, overrides = {}, files = { resume: pdf() } } = {}) => {
  const body = new FormData();
  Object.entries({ ...fields, ...overrides }).forEach(([key, value]) => body.append(key, value));
  Object.entries(files).forEach(([key, blob]) => body.append(key, blob, `${key}.pdf`));
  return fetch(`http://localhost:${port}/api/applications/manual`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenFor(user)}` },
    body,
  });
};

const created = () => prisma.application.create.mock.calls[0][0].data;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/applications', applicationsRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  stored.clear();
  prisma.user.findUnique.mockImplementation(({ where: { id } }) =>
    [adminUser, memberUser].find((u) => u.id === id) || null
  );
  prisma.recruitingCycle.findFirst.mockResolvedValue({ id: 'cycle-1', name: 'Fall 2026', isActive: true });
  prisma.candidate.findUnique.mockResolvedValue({ id: 'cand-1' });
  prisma.application.create.mockImplementation(({ data }) => Promise.resolve({ ...data }));
  prisma.resumeUpload.create.mockImplementation(({ data }) => Promise.resolve({ ...data }));
  documentSize.mockResolvedValue(1234);
});

describe('POST /api/applications/manual', () => {
  it('is admin only', async () => {
    expect((await post({ user: memberUser })).status).toBe(403);
    expect(prisma.application.create).not.toHaveBeenCalled();
  });

  it("stores an uploaded resume as the first version of the application's resume", async () => {
    const res = await post();
    expect(res.status).toBe(201);

    const application = created();
    const upload = prisma.resumeUpload.create.mock.calls[0][0].data;
    expect(application.resumeUrl).toBe(`/api/resume-uploads/${upload.id}/file`);
    expect(upload).toMatchObject({
      applicationId: application.id,
      sourceUrl: application.resumeUrl,
      originalName: 'resume.pdf',
      uploadedById: adminUser.id,
    });
    expect(upload.storagePath).toBe(`resumes/${application.id}/${upload.id}.pdf`);
    expect(stored.has(upload.storagePath)).toBe(true);
  });

  it('reads multipart text fields as what they mean', async () => {
    await post();
    expect(created()).toMatchObject({
      isTransferStudent: true,
      isFirstGeneration: false,
      cumulativeGpa: 3.8,
      shortAnswer: 'I want to join because...',
      blindResumeUrl: null,
      rawResponses: {},
      cycleId: 'cycle-1',
      candidateId: 'cand-1',
    });
  });

  it('stores a blind resume as a document the application names', async () => {
    await post({ files: { resume: pdf(), blindResume: pdf('blind') } });
    const { blindResumeUrl } = created();
    expect(blindResumeUrl).toMatch(/^\/api\/application-documents\/[0-9a-f-]{36}\.pdf\/file$/);
    const id = blindResumeUrl.split('/')[3];
    expect(stored.get(`application-documents/${id}`).toString()).toContain('blind');
  });

  it('names an uploaded video by its document id', async () => {
    await post({ overrides: { videoDocumentId: VIDEO_ID } });
    expect(created().videoUrl).toBe(`/api/application-documents/${VIDEO_ID}/file`);
  });

  it('refuses a video that never reached storage', async () => {
    documentSize.mockResolvedValue(null);
    const res = await post({ overrides: { videoDocumentId: VIDEO_ID } });
    expect(res.status).toBe(400);
    expect(prisma.application.create).not.toHaveBeenCalled();
    expect(putResume).not.toHaveBeenCalled();
  });

  it('refuses a video id that names a PDF', async () => {
    const res = await post({ overrides: { videoDocumentId: VIDEO_ID.replace('.mp4', '.pdf') } });
    expect(res.status).toBe(400);
  });

  it('asks for a resume when there is neither a file nor a link', async () => {
    const res = await post({ files: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Missing required fields: resume');
  });

  it('refuses a file that only claims to be a PDF', async () => {
    const res = await post({
      files: { resume: new Blob([Buffer.from('PK\x03\x04 not a pdf')], { type: 'application/pdf' }) },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('The resume is not a readable PDF');
    expect(putResume).not.toHaveBeenCalled();
  });

  it('refuses a blind resume that is not a PDF', async () => {
    const res = await post({
      files: { resume: pdf(), blindResume: new Blob([Buffer.from('hello')], { type: 'image/png' }) },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('The blind resume must be a PDF');
  });

  it('removes the stored files when the application is not created', async () => {
    prisma.application.create.mockRejectedValue(new Error('unique violation'));
    const res = await post({ files: { resume: pdf(), blindResume: pdf('blind') } });
    expect(res.status).toBe(500);
    expect(removeResume).toHaveBeenCalledTimes(2);
    expect(stored.size).toBe(0);
  });

  it('still takes a JSON body with links', async () => {
    const res = await fetch(`http://localhost:${port}/api/applications/manual`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenFor(adminUser)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...fields,
        isTransferStudent: false,
        cumulativeGpa: 3.8,
        resumeUrl: '/api/files/drive-1/pdf',
        videoUrl: '/api/files/drive-2/pdf',
        responseID: 'manual-1',
      }),
    });
    expect(res.status).toBe(201);
    expect(created()).toMatchObject({
      resumeUrl: '/api/files/drive-1/pdf',
      videoUrl: '/api/files/drive-2/pdf',
      responseID: 'manual-1',
      isTransferStudent: false,
    });
    expect(prisma.resumeUpload.create).not.toHaveBeenCalled();
  });
});
