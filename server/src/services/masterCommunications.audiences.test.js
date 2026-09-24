// A send to a filtered or saved audience: who is held back, who gets an
// unsubscribe footer, and that a saved audience is read fresh at send time.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { sendEmail } from './emailNotifications.js';
import { resolveAudience } from './audiences/audiencePeople.js';
import { getSavedAudience, markSavedAudienceUsed } from './audiences/savedAudiences.js';
import { previewMasterCommunication, sendMasterCommunication, scheduleMessage } from './masterCommunications.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findMany: vi.fn() },
    messageLog: { create: vi.fn() },
    emailSuppression: { findMany: vi.fn() },
    messageSchedule: { create: vi.fn() },
  },
}));
vi.mock('./emailNotifications.js', () => ({ sendEmail: vi.fn() }));
vi.mock('./slackService.js', () => ({ sendSlackMessage: vi.fn() }));
vi.mock('./communicationLog.js', () => ({ recordCommunications: vi.fn() }));
vi.mock('./audiences/audiencePeople.js', () => ({
  resolveAudience: vi.fn(),
  summarizeSources: vi.fn(() => ({ 'mailing-list': 2 })),
}));
vi.mock('./audiences/savedAudiences.js', () => ({
  getSavedAudience: vi.fn(),
  markSavedAudienceUsed: vi.fn(),
}));

const TREE = { version: 2, root: { kind: 'group', op: 'AND', children: [{ kind: 'rule', type: 'mailingList', params: {} }] } };
const person = (email, extra = {}) => ({ id: email, email, firstName: 'Pat', lastName: '', fullName: 'Pat', audience: 'person', sources: ['mailing-list'], ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  resolveAudience.mockResolvedValue({
    recipients: [person('student@ucla.edu'), person('gone@ucla.edu'), person('member@uc.org', { isStaff: true })],
  });
  prisma.emailSuppression.findMany.mockResolvedValue([{ email: 'gone@ucla.edu' }]);
  prisma.user.findMany.mockResolvedValue([{ email: 'member@uc.org' }]);
  prisma.messageLog.create.mockResolvedValue({ id: 'campaign-1' });
  sendEmail.mockResolvedValue({ success: true });
});

const send = (extra = {}) =>
  sendMasterCommunication({ audience: 'custom', channel: 'email', filters: TREE, subject: 'Hi', body: 'Hello {{firstName}}', sentBy: 'admin', ...extra });

describe('a send to a filtered audience', () => {
  it('skips whoever unsubscribed and says how many', async () => {
    const result = await send();
    expect(sendEmail.mock.calls.map((c) => c[0])).toEqual(['student@ucla.edu', 'member@uc.org']);
    expect(result).toMatchObject({ sent: 2, skipped: 1, total: 2 });
  });

  it('gives non-staff an unsubscribe footer and one-click header, and staff neither', async () => {
    await send();
    const [studentCall, memberCall] = sendEmail.mock.calls;
    expect(studentCall[2]).toContain('/unsubscribe?t=');
    expect(studentCall[4].listUnsubscribeUrl).toMatch(/\/api\/unsubscribe\/one-click\?t=/);
    expect(memberCall[2]).not.toContain('Unsubscribe');
    expect(memberCall[4].listUnsubscribeUrl).toBeNull();
  });

  it('refuses Slack', async () => {
    await expect(send({ channel: 'slack' })).rejects.toThrow(/Slack/);
  });
});

describe('a saved audience', () => {
  beforeEach(() => {
    getSavedAudience.mockResolvedValue({ id: 'aud-1', name: 'Kickoff', filters: TREE, lastUsedAt: null, lastUsedCount: null });
  });

  it("is resolved from its own filters, whatever came with the request", async () => {
    await send({ audience: 'members', filters: { roles: ['MEMBER'] }, savedAudienceId: 'aud-1' });
    expect(resolveAudience).toHaveBeenCalledWith(TREE);
    expect(markSavedAudienceUsed).toHaveBeenCalledWith('aud-1', 2);
  });

  it('is kept on a schedule alongside a copy of its filters', async () => {
    prisma.messageSchedule.create.mockResolvedValue({ id: 's1' });
    await scheduleMessage({ channel: 'email', body: 'b', subject: 's', sentBy: 'admin', scheduledAt: '2026-10-01T00:00:00Z', savedAudienceId: 'aud-1' });
    expect(prisma.messageSchedule.create.mock.calls[0][0].data).toMatchObject({
      audience: 'custom',
      savedAudienceId: 'aud-1',
      filters: TREE,
    });
  });
});

describe('preview', () => {
  it('counts deliverable, skipped and footer-bearing recipients', async () => {
    const preview = await previewMasterCommunication({ audience: 'custom', filters: TREE });
    expect(preview).toMatchObject({ count: 2, skipped: 1, marketing: 1, sources: { 'mailing-list': 2 } });
  });

  it('refuses an audience with no filters before touching the database', async () => {
    await expect(previewMasterCommunication({ audience: 'custom', filters: { root: { kind: 'group', children: [] } } }))
      .rejects.toThrow(/at least one filter/);
    expect(resolveAudience).not.toHaveBeenCalled();
  });
});
