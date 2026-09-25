// Which candidate a new application belongs to, and what that means for
// somebody's Luma history.
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
// on Luma is usually not the one on their application. The interesting cases are
// the ones where the two identifiers disagree.
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

// findUnique answers both lookups - by studentId and by exact email - so the
// fixtures reply according to which one was asked.
let uidRow;
let emailRow;
const byUid = (row) => { uidRow = row; };
const byEmail = (row) => { emailRow = row; };

// An application with no UID on it, to exercise the address path on its own.
const noUid = () =>
  transformFormResponse.mockReturnValue({ ...applicant, studentId: '', responseID: 'resp-1' });

const filedAgainst = () => {
  const { data } = prisma.application.create.mock.calls[0][0];
  return data.candidateId ?? data.candidate?.connect?.id;
};

const warnedAbout = (text) =>
  console.warn.mock.calls.some(([first]) => typeof first === 'string' && first.includes(text));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  uidRow = null;
  emailRow = null;

  resolveCandidateCycle.mockResolvedValue(activeCycle);
  getResponses.mockResolvedValue([{ responseId: 'resp-1' }]);
  transformFormResponse.mockReturnValue({ ...applicant, responseID: 'resp-1' });

  prisma.application.findMany.mockResolvedValue([]);
  prisma.application.create.mockResolvedValue({ id: 'app-1' });
  prisma.candidate.findUnique.mockImplementation(({ where }) =>
    Promise.resolve(where.studentId !== undefined ? uidRow : emailRow)
  );
  // Only reached as the case-insensitive address fallback.
  prisma.candidate.findMany.mockResolvedValue([]);
  prisma.candidate.create.mockResolvedValue({ id: 'cand-new', ...applicant });
  prisma.candidate.update.mockImplementation(({ where }) => Promise.resolve({ id: where.id }));
  prisma.referral.findMany.mockResolvedValue([]);
  prisma.referral.updateMany.mockResolvedValue({ count: 0 });
  prisma.$executeRaw.mockResolvedValue(1);
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
});

describe('an applicant the Luma sync already created a candidate for', () => {
  it('is looked up by UID', async () => {
    await syncFormResponses();

    expect(prisma.candidate.findUnique).toHaveBeenCalledWith({ where: { studentId: UID } });
  });

  it('reuses that candidate rather than creating a second one', async () => {
    byUid(fromLuma);

    await syncFormResponses();

    expect(prisma.candidate.create).not.toHaveBeenCalled();
    expect(filedAgainst()).toBe(fromLuma.id);
  });

  // The Luma row is built from a Luma profile name and a self-typed UID. An
  // application is corroborated, so it fills the gaps — without overwriting an
  // address somebody may since have been mailed at.
  it('backfills what the Luma row was missing without overwriting it', async () => {
    byUid({ ...fromLuma, lastName: '', email: '' });

    await syncFormResponses();

    const { where, data } = prisma.candidate.update.mock.calls[0][0];
    expect(where).toEqual({ id: fromLuma.id });
    expect(data.lastName).toBe('Chen');
    expect(data.email).toBe('maria@ucla.edu');
    expect(data.studentId).toBeUndefined();
  });

  it('leaves an address the Luma row already had alone', async () => {
    byUid(fromLuma);

    await syncFormResponses();

    const updated = prisma.candidate.update.mock.calls[0]?.[0]?.data ?? {};
    expect(updated.email).toBeUndefined();
  });
});

describe('when the UID and the address point at different people', () => {
  const addressOwner = { id: 'cand-address-owner', ...applicant };

  // The UID still wins: it is the row carrying the Luma event history, and
  // nothing re-points those rows afterwards. Resolving to the address instead
  // would strand the RSVPs — and would not buy safety, because the mirror case
  // (own UID, somebody else's address) files the application onto *their* row.
  it('files under the UID owner, keeping the event history attached', async () => {
    byUid(fromLuma);
    byEmail(addressOwner);

    await syncFormResponses();

    expect(filedAgainst()).toBe(fromLuma.id);
  });

  it('says so in the logs rather than resolving it silently', async () => {
    byUid(fromLuma);
    byEmail(addressOwner);

    await syncFormResponses();

    expect(warnedAbout('conflicting identity')).toBe(true);
  });

  it('still records the application', async () => {
    byUid(fromLuma);
    byEmail(addressOwner);

    await syncFormResponses();

    expect(prisma.application.create).toHaveBeenCalled();
  });

  it('is not a conflict when both lookups land on the same row', async () => {
    byUid(fromLuma);
    byEmail(fromLuma);

    await syncFormResponses();

    expect(warnedAbout('conflicting identity')).toBe(false);
    expect(filedAgainst()).toBe(fromLuma.id);
  });

  // Candidate.email is unique and not nullable, so a row can legitimately hold
  // an empty address - and handing it one another candidate owns fails the whole
  // response. With no application row written, the same response is new again on
  // the next run, so it would fail every hour forever.
  it('does not backfill an address another candidate already owns', async () => {
    byUid({ ...fromLuma, email: '' });
    byEmail({ id: 'cand-address-owner', ...applicant });

    await syncFormResponses();

    const updated = prisma.candidate.update.mock.calls[0]?.[0]?.data ?? {};
    expect(updated.email).toBeUndefined();
    expect(prisma.application.create).toHaveBeenCalled();
  });

  it('still backfills the other gaps on that row', async () => {
    byUid({ ...fromLuma, email: '', lastName: '' });
    byEmail({ id: 'cand-address-owner', ...applicant });

    await syncFormResponses();

    expect(prisma.candidate.update.mock.calls[0][0].data.lastName).toBe('Chen');
  });

  it('is not a conflict when only the address matches', async () => {
    byEmail(addressOwner);

    await syncFormResponses();

    expect(warnedAbout('conflicting identity')).toBe(false);
    expect(filedAgainst()).toBe(addressOwner.id);
  });
});

describe('the address lookup', () => {
  // A Google Form answer is stored as typed; a Luma email is lowercased.
  it('falls back to a case-insensitive match when there is no exact row', async () => {
    noUid();
    // The stored row differs from the form answer only in case, which is what
    // the exact lookup above misses and this fallback exists for.
    const storedLowercase = { id: 'cand-lowercase', ...applicant, email: 'maria@ucla.edu' };
    transformFormResponse.mockReturnValue({
      ...applicant, studentId: '', email: 'Maria@UCLA.edu', responseID: 'resp-1'
    });
    prisma.candidate.findMany.mockResolvedValue([storedLowercase]);

    await syncFormResponses();

    const { where } = prisma.candidate.findMany.mock.calls[0][0];
    expect(where.email).toEqual({ equals: 'Maria@UCLA.edu', mode: 'insensitive' });
    expect(prisma.candidate.create).not.toHaveBeenCalled();
    expect(filedAgainst()).toBe(storedLowercase.id);
  });

  // Candidate.email is unique but case-sensitive, so these rows can both exist.
  // Whichever is picked has to be the same one every run.
  it('takes the oldest row when two differ only in case, and says so', async () => {
    noUid();
    // Two rows the unique index allows, because it compares case-sensitively.
    const older = { id: 'cand-older', ...applicant, email: 'maria@ucla.edu' };
    const newer = { id: 'cand-newer', ...applicant, email: 'Maria@ucla.edu' };
    prisma.candidate.findMany.mockResolvedValue([older, newer]);

    await syncFormResponses();

    expect(prisma.candidate.findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'asc' });
    expect(filedAgainst()).toBe(older.id);
    expect(warnedAbout('differing only in case')).toBe(true);
  });

  it('prefers an exact row over the insensitive fallback', async () => {
    noUid();
    byEmail({ id: 'cand-exact', ...applicant });

    await syncFormResponses();

    // findMany is also the referral ambiguity check, so what matters is that
    // nothing asked it for this address.
    const askedForAddress = prisma.candidate.findMany.mock.calls
      .some(([args]) => args?.where?.email !== undefined);
    expect(askedForAddress).toBe(false);
    expect(filedAgainst()).toBe('cand-exact');
  });
});

describe('an applicant nobody has seen before', () => {
  it('still gets a candidate created from the application', async () => {
    await syncFormResponses();

    const { data } = prisma.candidate.create.mock.calls[0][0];
    expect(data).toMatchObject({ studentId: UID, email: 'maria@ucla.edu' });
  });
});
