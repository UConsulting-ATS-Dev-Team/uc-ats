import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../prismaClient.js', () => ({
  default: {
    automaticEmail: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
    automaticEmailSend: { groupBy: vi.fn(), findMany: vi.fn(), createMany: vi.fn() },
    savedAudience: { findUnique: vi.fn() },
    emailSignature: { findUnique: vi.fn(), findMany: vi.fn() },
    emailTheme: { findUnique: vi.fn() },
    emailTemplateStyle: { findMany: vi.fn() },
    application: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock('../emailNotifications.js', () => ({ sendEmail: vi.fn() }));

import prisma from '../../prismaClient.js';
import { sendEmail } from '../emailNotifications.js';
import {
  createAutomaticEmail,
  dryRunAutomaticEmail,
  normalizeAutomaticEmail,
  previewAutomaticEmail,
  renderAutomaticEmail,
  sendAutomaticEmailTest,
  setAutomaticEmailEnabled,
  updateAutomaticEmail,
} from './automaticEmails.js';

const INPUT = {
  name: 'Waitlist note',
  trigger: 'APPLICATION_STATUS',
  triggerConfig: { status: 'WAITLISTED' },
  subject: 'An update, {{firstName}}',
  body: 'Hi {{firstName}},\n\nYou are on the waitlist for **{{cycleName}}**.',
};

let row;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  row = { id: 'ae1', ...INPUT, marketing: false, format: 'DESIGNED', banner: 'brand', signatureId: null, enabled: false, enabledAt: null };
  prisma.automaticEmail.findUnique.mockImplementation(async () => row);
  prisma.automaticEmail.create.mockImplementation(async ({ data }) => (row = { id: 'ae1', ...data }));
  prisma.automaticEmail.update.mockImplementation(async ({ data }) => (row = { ...row, ...data }));
  prisma.automaticEmailSend.groupBy.mockResolvedValue([]);
  prisma.automaticEmailSend.findMany.mockResolvedValue([]);
  prisma.automaticEmailSend.createMany.mockResolvedValue({ count: 0 });
  prisma.emailSignature.findMany.mockResolvedValue([]);
  prisma.emailTheme.findUnique.mockResolvedValue(null);
  prisma.emailTemplateStyle.findMany.mockResolvedValue([]);
  prisma.application.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
});

describe('what an admin may save', () => {
  it('refuses a merge field the trigger cannot fill', async () => {
    await expect(normalizeAutomaticEmail({ ...INPUT, body: 'See you at {{eventName}}' })).rejects.toMatchObject({
      status: 400,
      code: 'UNKNOWN_MERGE_FIELD',
    });
  });

  it('refuses HTML and unsafe links, like every other email body', async () => {
    await expect(normalizeAutomaticEmail({ ...INPUT, body: '<script>x</script>' })).rejects.toMatchObject({ status: 400 });
    await expect(normalizeAutomaticEmail({ ...INPUT, body: '[x](javascript:alert(1))' })).rejects.toMatchObject({ status: 400 });
  });

  it('always treats a send to a saved audience as marketing', async () => {
    prisma.savedAudience.findUnique.mockResolvedValue({ id: 'aud' });
    const email = await normalizeAutomaticEmail({
      ...INPUT,
      trigger: 'CYCLE_DATE',
      triggerConfig: { field: 'applicationDeadline', offsetHours: -72, savedAudienceId: 'aud' },
      body: 'Hi {{firstName}}, the deadline is {{date}}.',
      marketing: false,
    });
    expect(email.marketing).toBe(true);
  });

  it('refuses a saved audience that no longer exists', async () => {
    prisma.savedAudience.findUnique.mockResolvedValue(null);
    await expect(
      normalizeAutomaticEmail({ ...INPUT, trigger: 'CYCLE_DATE', triggerConfig: { field: 'endDate', offsetHours: 0, savedAudienceId: 'gone' }, body: 'x' })
    ).rejects.toThrow(/audience/);
  });
});

describe('turning one on', () => {
  it('saves a new one disabled, however it was submitted', async () => {
    await createAutomaticEmail({ input: { ...INPUT, enabled: true } });
    expect(prisma.automaticEmail.create.mock.calls[0][0].data.enabled).toBe(false);
  });

  it('records the moment and skips everyone already in the status', async () => {
    prisma.application.findMany.mockResolvedValue([{ id: 'a1', email: 'w@ucla.edu', firstName: 'W', lastName: 'X' }]);

    await setAutomaticEmailEnabled({ id: 'ae1', enabled: true });

    expect(prisma.automaticEmail.update.mock.calls[0][0].data.enabledAt).toBeInstanceOf(Date);
    expect(prisma.automaticEmailSend.createMany.mock.calls[0][0].data[0]).toMatchObject({ status: 'SKIPPED', email: 'w@ucla.edu' });
  });

  it('seeds the skipped before turning it on, in one transaction, so no run sees one without the other', async () => {
    const order = [];
    prisma.application.findMany.mockResolvedValue([{ id: 'a1', email: 'w@ucla.edu', firstName: 'W', lastName: 'X' }]);
    prisma.automaticEmailSend.createMany.mockImplementation(async () => {
      order.push('seed');
      return { count: 1 };
    });
    prisma.automaticEmail.update.mockImplementation(async ({ data }) => {
      order.push('enable');
      return (row = { ...row, ...data });
    });

    await setAutomaticEmailEnabled({ id: 'ae1', enabled: true });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['seed', 'enable']);
    // Long enough for a whole cycle's applications, well past Prisma's 5s default.
    expect(prisma.$transaction.mock.calls[0][1].timeout).toBeGreaterThanOrEqual(30_000);
  });

  it('starts over when the trigger of an enabled email changes', async () => {
    row = { ...row, enabled: true, enabledAt: new Date('2026-01-01') };
    await updateAutomaticEmail({ id: 'ae1', input: { ...INPUT, triggerConfig: { status: 'REJECTED' } } });

    expect(prisma.automaticEmail.update.mock.calls[0][0].data.enabledAt.getTime()).toBeGreaterThan(new Date('2026-01-01').getTime());
    expect(prisma.application.findMany).toHaveBeenCalled(); // re-seeded
  });

  it('keeps its moment when only the wording changes', async () => {
    row = { ...row, enabled: true, enabledAt: new Date('2026-01-01') };
    await updateAutomaticEmail({ id: 'ae1', input: { ...INPUT, subject: 'Reworded' } });
    expect(prisma.automaticEmail.update.mock.calls[0][0].data.enabledAt).toBeUndefined();
  });
});

describe('checking one before it goes live', () => {
  it('previews with sample values', async () => {
    const preview = await previewAutomaticEmail({ input: INPUT });
    expect(preview.subject).toBe('An update, Jordan');
    expect(preview.html).toContain('<strong>Fall 2026 Recruitment</strong>');
    expect(preview.text).toContain('You are on the waitlist');
  });

  it('says how many are already in the status and will not be emailed', async () => {
    prisma.application.findMany.mockResolvedValue([{ id: 'a1', email: 'w@ucla.edu' }, { id: 'a2', email: 'v@ucla.edu' }]);
    const result = await dryRunAutomaticEmail({ input: INPUT });
    expect(result).toMatchObject({ kind: 'status', alreadyInStatus: 2 });
  });

  it('shows the scale of a created-record email over the last week', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', email: 'n@ucla.edu', fullName: 'New Person' }]);
    const result = await dryRunAutomaticEmail({
      input: { ...INPUT, trigger: 'RECORD_CREATED', triggerConfig: { record: 'ACCOUNT' }, body: 'Hi {{firstName}}' },
    });
    expect(result).toMatchObject({ kind: 'lookback', count: 1, sample: [{ name: 'New Person', email: 'n@ucla.edu' }] });
  });

  it('sends a test only to the admin asking', async () => {
    sendEmail.mockResolvedValue({ success: true });
    await sendAutomaticEmailTest({ input: INPUT, user: { id: 'u', email: 'admin@example.com' } });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe('admin@example.com');
    expect(sendEmail.mock.calls[0][1]).toMatch(/^\[TEST\] /);
  });
});

describe('rendering', () => {
  it('adds the unsubscribe footer only when asked to', async () => {
    const plain = await renderAutomaticEmail(row, { firstName: 'A', cycleName: 'F' });
    const marketing = await renderAutomaticEmail(row, { firstName: 'A', cycleName: 'F' }, { unsubscribeUrl: 'https://x.test/u' });
    expect(plain.html).not.toContain('Unsubscribe');
    expect(marketing.html).toContain('href="https://x.test/u"');
  });

  it('ends with the default signature when one exists', async () => {
    prisma.emailSignature.findMany.mockResolvedValue([{ id: 's', name: 'Team', body: 'The Team', isDefault: true }]);
    const { html } = await renderAutomaticEmail(row, { firstName: 'A', cycleName: 'F' });
    expect(html).toContain('The Team');
  });

  it('ends with no signature when the admin chose none', async () => {
    prisma.emailSignature.findMany.mockResolvedValue([{ id: 's', name: 'Team', body: 'The Team', isDefault: true }]);
    const { html } = await renderAutomaticEmail({ ...row, signatureId: 'OWN' }, { firstName: 'A', cycleName: 'F' });
    expect(html).not.toContain('The Team');
  });

  it('escapes merge values', async () => {
    const { html } = await renderAutomaticEmail(row, { firstName: '<img src=x>', cycleName: 'F' });
    expect(html).not.toContain('<img src=x>');
  });
});
