// What happens to somebody's Luma RSVPs when they finally apply.
//
// Someone can turn up to an event months before applying. The Luma sync creates
// a Candidate for them keyed on the UID they typed at registration, and their
// event_rsvp / event_attendance rows point at it. When their application comes
// through form sync, it has to land on *that* candidate rather than a second
// one — nothing re-points event rows afterwards, so a new candidate would leave
// the RSVPs and the check-ins stranded on a record no application, and no
// candidate account, ever reaches.
//
// The UID is what carries that across, because the address they register with
// on Luma is usually not the one on their application. This is the seam the two
// halves meet at, so it is asserted here rather than assumed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { getResponses } from './google/forms.js';
import { transformFormResponse } from '../utils/dataMapper.js';
import { resolveCandidateCycle } from './activeCycle.js';
import syncFormResponses from './syncResponses.js';

vi.mock('../prismaClient.js', () => {
  const client = {
    application: { findMany: vi.fn(), create: vi.fn() },
    candidate: {
      findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn()
    },
    referral: { findMany: vi.fn(), updateMany: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn((fn) => fn(client))
  };
  return { default: client };
});
vi.mock('./google/forms.js', () => ({ getResponses: vi.fn() }));
vi.mock('../utils/dataMapper.js', () => ({ transformFormResponse: vi.fn() }));
vi.mock('./activeCycle.js', () => ({ resolveCandidateCycle: vi.fn() }));
vi.mock('../utils/formUtils.js', () => ({ extractFormIdFromUrl: vi.fn(() => 'form-1') }));

const UID = '405123456';
const activeCycle = { id: 'cycle-1', name: 'Fall 2026', formUrl: 'https://docs.google.com/forms/d/form-1/edit' };

// What they put on the application: their UCLA address.
const applicant = { studentId: UID, firstName: 'Maria', lastName: 'Chen', email: 'maria@ucla.edu' };

// What the Luma sync already created from the same UID, under the personal
// address they registered with. No application has ever mentioned this row.
const fromLuma = {
  id: 'cand-from-luma',
  studentId: UID,
  firstName: 'Maria',
  lastName: 'Chen',
  email: 'mariachen99@gmail.com'
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  resolveCandidateCycle.mockResolvedValue(activeCycle);
  getResponses.mockResolvedValue([{ responseId: 'resp-1' }]);
  transformFormResponse.mockReturnValue({ ...applicant, responseID: 'resp-1' });

  prisma.application.findMany.mockResolvedValue([]);
  prisma.application.create.mockResolvedValue({ id: 'app-1' });
  prisma.candidate.findUnique.mockResolvedValue(null);
  prisma.candidate.findFirst.mockResolvedValue(null);
  prisma.candidate.create.mockResolvedValue({ id: 'cand-new', ...applicant });
  prisma.candidate.findMany.mockResolvedValue([]);
  prisma.candidate.update.mockResolvedValue(fromLuma);
  prisma.referral.findMany.mockResolvedValue([]);
  prisma.referral.updateMany.mockResolvedValue({ count: 0 });
  prisma.$executeRaw.mockResolvedValue(1);
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
});

describe('an applicant the Luma sync already created a candidate for', () => {
  // The lookup is what decides this. If it only asked by email, the personal
  // address on the Luma row would not be found and the RSVPs would be orphaned.
  it('is looked for by UID before anything else', async () => {
    await syncFormResponses();

    expect(prisma.candidate.findUnique).toHaveBeenCalledWith({ where: { studentId: UID } });
  });

  // The two columns can point at different people, so the order has to be fixed
  // rather than left to whichever row the database returns first.
  it('takes the UID owner over the address owner, every time', async () => {
    prisma.candidate.findUnique.mockResolvedValue(fromLuma);
    prisma.candidate.findFirst.mockResolvedValue({ id: 'cand-other', ...applicant });

    await syncFormResponses();

    const { data } = prisma.application.create.mock.calls[0][0];
    expect(data.candidateId ?? data.candidate?.connect?.id).toBe(fromLuma.id);
    // No reason to have asked at all once the UID answered.
    expect(prisma.candidate.findFirst).not.toHaveBeenCalled();
  });

  // A Google Form answer is stored as typed; a Luma email is lowercased.
  it('still finds them when the form carries a differently-cased address', async () => {
    transformFormResponse.mockReturnValue({
      ...applicant, studentId: '', email: 'Maria@UCLA.edu', responseID: 'resp-1'
    });
    prisma.candidate.findFirst.mockResolvedValue(fromLuma);

    await syncFormResponses();

    const { where } = prisma.candidate.findFirst.mock.calls[0][0];
    expect(where.email).toEqual({ equals: 'Maria@UCLA.edu', mode: 'insensitive' });
    expect(prisma.candidate.create).not.toHaveBeenCalled();
  });

  it('reuses that candidate rather than creating a second one', async () => {
    prisma.candidate.findUnique.mockResolvedValue(fromLuma);

    await syncFormResponses();

    expect(prisma.candidate.create).not.toHaveBeenCalled();
    expect(prisma.application.create).toHaveBeenCalled();
  });

  // The application has to hang off the same candidate the event rows do, or
  // the two halves of the person's history never meet.
  it('files the application against the candidate holding the event rows', async () => {
    prisma.candidate.findUnique.mockResolvedValue(fromLuma);

    await syncFormResponses();

    const { data } = prisma.application.create.mock.calls[0][0];
    expect(data.candidateId ?? data.candidate?.connect?.id).toBe(fromLuma.id);
  });

  // The Luma row is built from a Luma profile name and a self-typed UID. An
  // application is corroborated, so it fills the gaps — without overwriting an
  // address somebody may since have been mailed at.
  it('backfills what the Luma row was missing without overwriting it', async () => {
    prisma.candidate.findUnique.mockResolvedValue({ ...fromLuma, lastName: '', email: '' });

    await syncFormResponses();

    const { where, data } = prisma.candidate.update.mock.calls[0][0];
    expect(where).toEqual({ id: fromLuma.id });
    expect(data.lastName).toBe('Chen');
    expect(data.email).toBe('maria@ucla.edu');
    expect(data.studentId).toBeUndefined();
  });

  it('leaves an address the Luma row already had alone', async () => {
    prisma.candidate.findUnique.mockResolvedValue(fromLuma);

    await syncFormResponses();

    const updated = prisma.candidate.update.mock.calls[0]?.[0]?.data ?? {};
    expect(updated.email).toBeUndefined();
  });
});

describe('an applicant nobody has seen before', () => {
  it('still gets a candidate created from the application', async () => {
    await syncFormResponses();

    const { data } = prisma.candidate.create.mock.calls[0][0];
    expect(data).toMatchObject({ studentId: UID, email: 'maria@ucla.edu' });
  });
});
