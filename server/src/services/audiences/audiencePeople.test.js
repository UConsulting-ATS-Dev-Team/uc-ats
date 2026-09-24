// Who an audience reaches. The rules worth pinning down are the ones that
// decide identity - one person is one recipient however many places the ATS
// holds their address - and the people who must never be reached at all.
import { describe, it, expect, vi } from 'vitest';
import { resolveAudience } from './audiencePeople.js';

vi.mock('../../prismaClient.js', () => ({ default: {} }));

const rule = (type, params = {}, negate = false) => ({ kind: 'rule', type, params, negate });
const all = (...children) => ({ version: 2, root: { kind: 'group', op: 'AND', children } });
const any = (...children) => ({ kind: 'group', op: 'OR', children });

const user = (over) => ({
  id: over.email, fullName: 'Someone', role: 'USER', isActive: true, createdAt: new Date('2026-01-01'),
  isExternalTalent: false, emailVerifiedAt: null, graduationClass: null, phoneNumber: null, ...over,
});
const app = (over) => ({
  id: `${over.email}-${over.cycleId}`, firstName: 'App', lastName: 'Licant', phoneNumber: '555', submittedAt: new Date('2026-01-10'),
  cycleId: 'fall', candidateId: null, status: 'SUBMITTED', graduationYear: '2028', major1: 'Economics', major2: null,
  isTransferStudent: false, isFirstGeneration: false, talentPoolOptIn: null, currentRound: '1', approved: null,
  resumeDecision: null, coffeeChatDecision: null, firstRoundDecision: null, finalRoundDecision: null, ...over,
});

function fakeClient(data = {}) {
  const list = (key) => ({ findMany: vi.fn(async () => data[key] || []) });
  return {
    user: list('users'),
    application: list('applications'),
    candidate: list('candidates'),
    mailingListContact: list('contacts'),
    meetingSignup: list('signups'),
    lumaGuest: list('luma'),
    externalResume: list('externalResumes'),
    memberResume: list('memberResumes'),
    recruitingCycle: list('cycles'),
    referral: list('referrals'),
    eventRsvp: list('eventRsvps'),
    memberEventRsvp: list('memberRsvps'),
    eventAttendance: list('attendance'),
    memberEventAttendance: list('memberAttendance'),
    events: list('events'),
    communicationLog: list('logs'),
  };
}

const emails = (result) => result.recipients.map((r) => r.email).sort();

describe('identity', () => {
  it('reaches a person once when they appear in several sources', async () => {
    const client = fakeClient({
      users: [user({ email: 'joe@ucla.edu', fullName: 'Joe Bruin' })],
      applications: [app({ email: 'Joe@UCLA.edu' })],
      contacts: [{ id: 'c1', email: 'joe@ucla.edu', firstName: null, lastName: null, sourceFile: 'list.csv' }],
    });
    const result = await resolveAudience(all(any(rule('mailingList'), rule('applied'))), { client });
    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0]).toMatchObject({ email: 'joe@ucla.edu', fullName: 'Joe Bruin' });
    expect(result.recipients[0].sources.sort()).toEqual(['account', 'applicant', 'mailing-list']);
  });

  it("merges a candidate's addresses and writes to their latest application's", async () => {
    const client = fakeClient({
      candidates: [{ id: 'cand', email: 'old@ucla.edu', firstName: 'A', lastName: 'B', onboarding: null }],
      applications: [
        app({ email: 'old@ucla.edu', candidateId: 'cand', cycleId: 'spring', submittedAt: new Date('2025-04-01') }),
        app({ email: 'new@gmail.com', candidateId: 'cand', cycleId: 'fall', submittedAt: new Date('2026-01-01') }),
      ],
    });
    const result = await resolveAudience(all(rule('applied')), { client });
    expect(emails(result)).toEqual(['new@gmail.com']);
  });

  it("prefers a candidate's account address, so a member is recognised as staff", async () => {
    const client = fakeClient({
      users: [user({ email: 'member@uc.org', role: 'MEMBER' })],
      candidates: [{ id: 'cand', email: 'member@uc.org', firstName: 'M', lastName: 'M', onboarding: null }],
      applications: [app({ email: 'personal@gmail.com', candidateId: 'cand' })],
    });
    const result = await resolveAudience(all(rule('applied')), { client });
    expect(result.recipients).toEqual([expect.objectContaining({ email: 'member@uc.org', isStaff: true })]);
  });
});

describe('who is never reached', () => {
  it('leaves out deactivated accounts and Talent Partner clients, even under NOT', async () => {
    const client = fakeClient({
      users: [
        user({ email: 'gone@uc.org', role: 'MEMBER', isActive: false }),
        user({ email: 'buyer@firm.com', role: 'CLIENT' }),
        user({ email: 'student@ucla.edu' }),
      ],
      applications: [app({ email: 'gone@uc.org' })],
    });
    const everyoneButMembers = all(rule('account'), rule('account', { roles: ['MEMBER'] }, true));
    expect(emails(await resolveAudience(everyoneButMembers, { client }))).toEqual(['student@ucla.edu']);
    expect(emails(await resolveAudience(all(rule('applied')), { client }))).toEqual([]);
  });
});

describe('rules', () => {
  it('finds accounts that never applied', async () => {
    const client = fakeClient({
      users: [user({ email: 'applied@ucla.edu' }), user({ email: 'lurker@ucla.edu' })],
      applications: [app({ email: 'applied@ucla.edu' })],
    });
    const tree = all(rule('account', { roles: ['USER'] }), rule('applied', {}, true));
    expect(emails(await resolveAudience(tree, { client }))).toEqual(['lurker@ucla.edu']);
  });

  it('reads "previous" as any cycle that is not active', async () => {
    const client = fakeClient({
      cycles: [{ id: 'fall', isActive: true }, { id: 'spring', isActive: false }],
      applications: [app({ email: 'now@ucla.edu', cycleId: 'fall' }), app({ email: 'before@ucla.edu', cycleId: 'spring' })],
    });
    expect(emails(await resolveAudience(all(rule('applied', { scope: 'previous' })), { client }))).toEqual(['before@ucla.edu']);
  });

  it('takes grad year from onboarding over the application', async () => {
    const client = fakeClient({
      candidates: [{ id: 'cand', email: 'x@ucla.edu', firstName: 'X', lastName: 'Y', onboarding: { graduationYear: '2029' } }],
      applications: [app({ email: 'x@ucla.edu', candidateId: 'cand', graduationYear: '2027' })],
      users: [user({ email: 'member@uc.org', role: 'MEMBER', graduationClass: 'Class of 2027' })],
    });
    expect(emails(await resolveAudience(all(rule('gradYear', { years: [2029] })), { client }))).toEqual(['x@ucla.edu']);
    // Free-text graduation class on an account still yields a year.
    expect(emails(await resolveAudience(all(rule('gradYear', { max: 2027 })), { client }))).toEqual(['member@uc.org']);
  });

  it('reads a resume-round decision from the older approved flag', async () => {
    const client = fakeClient({
      applications: [
        app({ email: 'no@ucla.edu', approved: false }),
        app({ email: 'yes@ucla.edu', resumeDecision: 'yes' }),
        app({ email: 'pending@ucla.edu' }),
      ],
    });
    const decided = (decisions) => resolveAudience(all(rule('decision', { round: '1', decisions })), { client });
    expect(emails(await decided(['no']))).toEqual(['no@ucla.edu']);
    expect(emails(await decided(['undecided']))).toEqual(['pending@ucla.edu']);
  });

  it("counts RSVPs from applicants, members and unmatched Luma guests", async () => {
    const client = fakeClient({
      candidates: [{ id: 'cand', email: 'applicant@ucla.edu', firstName: 'A', lastName: 'A', onboarding: null }],
      users: [user({ id: 'm1', email: 'member@uc.org', role: 'MEMBER' })],
      luma: [
        { email: 'guest@ucla.edu', name: 'Guest', eventId: 'e1', approvalStatus: 'approved', checkedInAt: null },
        { email: 'declined@ucla.edu', name: 'No', eventId: 'e1', approvalStatus: 'declined', checkedInAt: null },
      ],
      eventRsvps: [{ candidateId: 'cand', eventId: 'e1' }],
      memberRsvps: [{ memberId: 'm1', eventId: 'e1' }],
    });
    expect(emails(await resolveAudience(all(rule('eventRsvp', { eventIds: ['e1'] })), { client })))
      .toEqual(['applicant@ucla.edu', 'guest@ucla.edu', 'member@uc.org']);
  });

  it("finds no-shows only among events that are over", async () => {
    const client = fakeClient({
      candidates: [
        { id: 'c1', email: 'came@ucla.edu', firstName: 'C', lastName: 'C', onboarding: null },
        { id: 'c2', email: 'flaked@ucla.edu', firstName: 'F', lastName: 'F', onboarding: null },
      ],
      events: [{ id: 'past' }],
      eventRsvps: [{ candidateId: 'c1', eventId: 'past' }, { candidateId: 'c2', eventId: 'past' }],
      attendance: [{ candidateId: 'c1', eventId: 'past' }],
    });
    expect(emails(await resolveAudience(all(rule('rsvpNoShow')), { client }))).toEqual(['flaked@ucla.edu']);
    expect(client.events.findMany.mock.calls[0][0].where.eventEndDate.lt).toBeInstanceOf(Date);
  });

  it('finds who a past send reached, by address', async () => {
    const client = fakeClient({
      users: [user({ email: 'a@ucla.edu' })],
      logs: [{ recipient: 'A@ucla.edu' }, { recipient: 'stranger@elsewhere.com' }],
    });
    const result = await resolveAudience(all(rule('receivedCampaign', { messageLogIds: ['log1'], outcome: 'delivered' })), { client });
    expect(emails(result)).toEqual(['a@ucla.edu']);
    expect(client.communicationLog.findMany.mock.calls[0][0].where).toMatchObject({
      messageLogId: { in: ['log1'] },
      status: { notIn: ['FAILED', 'BOUNCED'] },
    });
  });
});
