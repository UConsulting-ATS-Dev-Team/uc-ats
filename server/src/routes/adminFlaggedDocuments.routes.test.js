// The flagged-documents list carries each flag's application documents and
// short answer, so a sealed candidate's flag has to come back as identity only.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import adminRoutes from './admin.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    recruitingCycle: { findFirst: vi.fn() },
    candidate: { findMany: vi.fn() },
    flaggedDocument: { findMany: vi.fn() }
  }
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Admin' };
const activeCycle = { id: 'cycle-1', name: 'Fall 2026', isActive: true };

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

let server;
let port;

const getFlags = () => fetch(`http://localhost:${port}/api/admin/flagged-documents?resolved=false`, {
  headers: { Authorization: `Bearer ${tokenFor(adminUser)}` }
});

const flagFor = (candidateId, shortAnswer) => ({
  id: `flag-${candidateId}`,
  documentType: 'coverLetter',
  isResolved: false,
  application: {
    id: `app-${candidateId}`,
    candidateId,
    cycleId: activeCycle.id,
    firstName: 'Joe',
    lastName: 'Bruin',
    email: `${candidateId}@g.ucla.edu`,
    major1: 'Economics',
    resumeUrl: '/api/files/abc/pdf',
    coverLetterUrl: null,
    shortAnswer,
    videoUrl: null
  }
});

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue(adminUser);
  prisma.recruitingCycle.findFirst.mockResolvedValue(activeCycle);
  prisma.candidate.findMany.mockResolvedValue([]);
});

describe('GET /api/admin/flagged-documents', () => {
  it("cuts a sealed candidate's flag down to identity and leaves the rest whole", async () => {
    prisma.flaggedDocument.findMany.mockResolvedValue([
      flagFor('sealed', 'Why I want to join'),
      flagFor('open', 'Why I also want to join')
    ]);
    prisma.candidate.findMany.mockResolvedValue([
      { id: 'sealed', studentId: '1', email: 'sealed@g.ucla.edu' }
    ]);

    const res = await getFlags();
    expect(res.status).toBe(200);
    const [sealed, open] = await res.json();

    expect(sealed.application.locked).toBe(true);
    expect(sealed.application.firstName).toBe('Joe');
    expect(sealed.application.shortAnswer).toBeUndefined();
    expect(sealed.application.resumeUrl).toBeUndefined();
    expect(sealed.documentType).toBe('coverLetter');

    expect(open.application.shortAnswer).toBe('Why I also want to join');
    expect(open.application.locked).toBeUndefined();
  });
});
