import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { sendMasterCommunication } from './masterCommunications.js';
import { sendEmail } from './emailNotifications.js';
import {
  RECAP_SENDER,
  RECAP_STATUS,
  STUCK_SENDING_MS,
  markRecapFailed,
  nextRecapWeek,
  processDueRecaps,
  recapFields,
  renderRecapHtml,
  scheduleRecap,
  sendRecapTest,
  updateRecap,
} from './gmRecaps.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    gmRecap: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    user: { findMany: vi.fn() },
  },
}));

vi.mock('./emailTheme.js', () => ({
  resolveEmailTheme: vi.fn(async () => ({ accentColor: '#0C74C1', logoUrl: null })),
}));

vi.mock('./emailNotifications.js', () => ({
  sendEmail: vi.fn(async () => ({ success: true })),
}));

vi.mock('./masterCommunications.js', async () => {
  const actual = await vi.importActual('./masterCommunications.js');
  return {
    markdownToHtml: actual.markdownToHtml,
    renderMessage: actual.renderMessage,
    previewMasterCommunication: vi.fn(async () => ({ count: 42 })),
    sendMasterCommunication: vi.fn(),
  };
});

const NOW = new Date('2026-10-06T18:00:00Z');

const recapRow = (overrides = {}) => ({
  id: 'recap-1',
  subject: 'GM Recap: Fall Week 2',
  title: 'RECAP: FALL WEEK 2',
  body: 'Hi {{firstName}}, here are the updates.',
  headerImageUrl: 'https://cdn.example.com/logo.png',
  photoUrl: 'https://cdn.example.com/photo.jpg',
  status: RECAP_STATUS.DRAFT,
  scheduledAt: null,
  createdById: 'exec-1',
  updatedById: 'exec-1',
  scheduledById: null,
  updatedAt: NOW,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findMany.mockResolvedValue([]);
});

describe('nextRecapWeek', () => {
  it('starts a season at week 1', () => {
    expect(nextRecapWeek([], NOW)).toEqual({ season: 'Fall', week: 1 });
  });

  it('follows the latest week of the same season, however the title was edited', () => {
    const titles = ['RECAP: FALL WEEK 2', 'Recap - fall week 4!', 'RECAP: SPRING WEEK 9'];
    expect(nextRecapWeek(titles, NOW)).toEqual({ season: 'Fall', week: 5 });
  });

  it('ignores last season', () => {
    expect(nextRecapWeek(['RECAP: SPRING WEEK 9'], NOW).week).toBe(1);
  });
});

describe('renderRecapHtml', () => {
  it('carries the banner title, body, logo, photo and address', () => {
    const html = renderRecapHtml({
      title: 'RECAP: FALL WEEK 2',
      bodyHtml: '<p>Updates</p>',
      headerImageUrl: 'https://cdn.example.com/logo.png',
      photoUrl: 'https://cdn.example.com/photo.jpg',
    });
    expect(html).toContain('RECAP: FALL WEEK 2');
    expect(html).toContain('Updates</p>');
    expect(html).toContain('src="https://cdn.example.com/logo.png"');
    expect(html).toContain('src="https://cdn.example.com/photo.jpg"');
    expect(html).toContain('330 De Neve Dr');
  });

  it('escapes the title and leaves out images that are not https', () => {
    const html = renderRecapHtml({
      title: '<script>x</script>',
      bodyHtml: '',
      headerImageUrl: 'javascript:alert(1)',
      photoUrl: 'http://insecure.example.com/a.jpg',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img');
  });
});

describe('recapFields', () => {
  it('refuses an image link that is not https', () => {
    expect(() => recapFields({ photoUrl: 'http://example.com/a.jpg' })).toThrow(/https/);
  });

  it('clears an image with an empty string and leaves absent fields alone', () => {
    expect(recapFields({ photoUrl: '' })).toEqual({ photoUrl: null });
  });
});

describe('updateRecap', () => {
  it('refuses once the recap has been sent', async () => {
    prisma.gmRecap.updateMany.mockResolvedValue({ count: 0 });
    prisma.gmRecap.findUnique.mockResolvedValue(recapRow({ status: RECAP_STATUS.SENT }));
    await expect(updateRecap({ id: 'recap-1', userId: 'exec-1', input: { subject: 'x' } }))
      .rejects.toMatchObject({ status: 409 });
    expect(prisma.gmRecap.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'recap-1', status: { in: [RECAP_STATUS.DRAFT, RECAP_STATUS.SCHEDULED] } },
    }));
  });
});

describe('scheduleRecap', () => {
  it('queues for now when no time is given', async () => {
    prisma.gmRecap.findUnique.mockResolvedValue(recapRow());
    prisma.gmRecap.updateMany.mockResolvedValue({ count: 1 });
    await scheduleRecap({ id: 'recap-1', userId: 'exec-2', now: NOW });
    expect(prisma.gmRecap.updateMany).toHaveBeenCalledWith({
      where: { id: 'recap-1', status: { in: [RECAP_STATUS.DRAFT, RECAP_STATUS.SCHEDULED] } },
      data: { status: RECAP_STATUS.SCHEDULED, scheduledAt: NOW, scheduledById: 'exec-2' },
    });
  });

  it('refuses a time that has already passed', async () => {
    prisma.gmRecap.findUnique.mockResolvedValue(recapRow());
    await expect(scheduleRecap({ id: 'recap-1', userId: 'exec-1', scheduledAt: '2026-10-05T18:00:00Z', now: NOW }))
      .rejects.toMatchObject({ status: 400, code: 'IN_THE_PAST' });
    expect(prisma.gmRecap.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a recap with no body', async () => {
    prisma.gmRecap.findUnique.mockResolvedValue(recapRow({ body: '   ' }));
    await expect(scheduleRecap({ id: 'recap-1', userId: 'exec-1', now: NOW }))
      .rejects.toMatchObject({ status: 400, code: 'INCOMPLETE' });
  });
});

describe('processDueRecaps', () => {
  const due = recapRow({ status: RECAP_STATUS.SENDING, scheduledById: 'exec-2' });

  beforeEach(() => {
    prisma.gmRecap.findMany.mockResolvedValue([{ id: 'recap-1' }]);
    prisma.gmRecap.findUnique.mockResolvedValue(due);
    prisma.gmRecap.update.mockResolvedValue({});
  });

  it('claims, sends to every member and admin as the executive team, and records the result', async () => {
    prisma.gmRecap.updateMany.mockResolvedValue({ count: 1 });
    sendMasterCommunication.mockResolvedValue({ sent: 40, failed: 2, total: 42, logId: 'log-1' });

    expect(await processDueRecaps()).toBe(1);

    expect(prisma.gmRecap.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ id: 'recap-1', status: RECAP_STATUS.SCHEDULED }),
      data: { status: RECAP_STATUS.SENDING },
    }));
    const send = sendMasterCommunication.mock.calls[0][0];
    expect(send).toMatchObject({
      audience: 'members',
      filters: { roles: ['MEMBER', 'ADMIN'] },
      channel: 'email',
      subject: due.subject,
      body: due.body,
      sentBy: 'exec-2',
      sender: RECAP_SENDER,
    });
    expect(send.wrapHtml('<p>x</p>')).toContain('RECAP: FALL WEEK 2');
    expect(prisma.gmRecap.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'recap-1', status: RECAP_STATUS.SENDING },
      data: expect.objectContaining({
        status: RECAP_STATUS.SENT,
        sentCount: 40,
        failedCount: 2,
        recipientCount: 42,
        messageLogId: 'log-1',
      }),
    });
  });

  it('sends nothing when another server claimed it first', async () => {
    prisma.gmRecap.updateMany.mockResolvedValue({ count: 0 });
    expect(await processDueRecaps()).toBe(0);
    expect(sendMasterCommunication).not.toHaveBeenCalled();
  });

  it('does not run twice side by side in one process', async () => {
    prisma.gmRecap.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
    let finish;
    sendMasterCommunication.mockReturnValue(new Promise((resolve) => { finish = resolve; }));

    const first = processDueRecaps();
    const second = processDueRecaps();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(sendMasterCommunication).toHaveBeenCalledTimes(1));
    finish({ sent: 1, failed: 0, total: 1, logId: 'log-1' });
    await first;
    expect(sendMasterCommunication).toHaveBeenCalledTimes(1);
  });

  it('marks it failed when nobody got it', async () => {
    prisma.gmRecap.updateMany.mockResolvedValue({ count: 1 });
    sendMasterCommunication.mockResolvedValue({ sent: 0, failed: 42, total: 42, logId: 'log-1' });
    await processDueRecaps();
    expect(prisma.gmRecap.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: RECAP_STATUS.FAILED }),
    }));
  });
});

describe('markRecapFailed', () => {
  it('only settles a send whose heartbeat has stopped', async () => {
    prisma.gmRecap.updateMany.mockResolvedValue({ count: 0 });
    prisma.gmRecap.findUnique.mockResolvedValue(recapRow({ status: RECAP_STATUS.SENDING }));
    await expect(markRecapFailed({ id: 'recap-1' })).rejects.toMatchObject({ status: 409 });
    const { where } = prisma.gmRecap.updateMany.mock.calls[0][0];
    expect(where.status).toBe(RECAP_STATUS.SENDING);
    expect(Date.now() - where.updatedAt.lt.getTime()).toBeGreaterThanOrEqual(STUCK_SENDING_MS - 1000);
  });
});

describe('sendRecapTest', () => {
  it('mails only the person asking, as the executive team, with merge fields filled', async () => {
    prisma.gmRecap.findUnique.mockResolvedValue(recapRow());
    await sendRecapTest({ id: 'recap-1', user: { id: 'exec-1', email: 'pres@ucla.edu', fullName: 'Ana Ruiz' } });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, html, , meta] = sendEmail.mock.calls[0];
    expect(to).toBe('pres@ucla.edu');
    expect(subject).toBe('[TEST] GM Recap: Fall Week 2');
    expect(html).toContain('Hi Ana,');
    expect(meta).toMatchObject({ category: 'TEST', ...RECAP_SENDER });
  });
});
