// The switch that decides whether the Google Form event sync sends its own
// confirmation emails. What matters is the direction it fails in: every way of
// not knowing the answer has to read as "off", because an unexpected duplicate
// email to everyone who signs up is worse than an expected missing one.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../prismaClient.js', () => ({
  default: { eventEmailSetting: { findUnique: vi.fn(), upsert: vi.fn() } }
}));

const prisma = (await import('../prismaClient.js')).default;
const {
  sendSignupConfirmations,
  getEventEmailSetting,
  setSendSignupConfirmations,
  DEFAULT_SEND_SIGNUP_CONFIRMATIONS
} = await import('./eventEmailSettings.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('reading the switch', () => {
  it('is off by default, which is what the column and the migration also say', () => {
    expect(DEFAULT_SEND_SIGNUP_CONFIRMATIONS).toBe(false);
  });

  it('reports what the row says', async () => {
    prisma.eventEmailSetting.findUnique.mockResolvedValue({ sendSignupConfirmations: true });
    expect(await sendSignupConfirmations()).toBe(true);

    prisma.eventEmailSetting.findUnique.mockResolvedValue({ sendSignupConfirmations: false });
    expect(await sendSignupConfirmations()).toBe(false);
  });

  it('reads as off when the row has never been written', async () => {
    prisma.eventEmailSetting.findUnique.mockResolvedValue(null);
    expect(await sendSignupConfirmations()).toBe(false);
  });

  it('reads as off, loudly, when the migration has not been applied', async () => {
    prisma.eventEmailSetting.findUnique.mockRejectedValue(Object.assign(new Error('no table'), { code: 'P2021' }));

    expect(await sendSignupConfirmations()).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('event_email_settings is missing'));
  });

  it('does not swallow a failure that is not a missing table', async () => {
    prisma.eventEmailSetting.findUnique.mockRejectedValue(Object.assign(new Error('down'), { code: 'P1001' }));
    await expect(sendSignupConfirmations()).rejects.toThrow('down');
  });

  it('reports who last changed it, for the admin page', async () => {
    const updatedAt = new Date('2026-09-23T12:00:00.000Z');
    prisma.eventEmailSetting.findUnique.mockResolvedValue({
      sendSignupConfirmations: true,
      updatedAt,
      updatedById: 'admin-1'
    });

    expect(await getEventEmailSetting()).toEqual({
      sendSignupConfirmations: true,
      updatedAt,
      updatedById: 'admin-1'
    });
  });
});

describe('setting the switch', () => {
  it('upserts, so the first change works with no row there', async () => {
    prisma.eventEmailSetting.upsert.mockResolvedValue({ sendSignupConfirmations: true });

    await setSendSignupConfirmations(true, 'admin-1');

    const call = prisma.eventEmailSetting.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'singleton' });
    expect(call.update).toMatchObject({ sendSignupConfirmations: true, updatedById: 'admin-1' });
    expect(call.create).toMatchObject({ id: 'singleton', sendSignupConfirmations: true });
  });

  it('refuses anything that is not a boolean, rather than coercing it', async () => {
    for (const value of ['true', 1, null, undefined, {}]) {
      await expect(setSendSignupConfirmations(value, 'admin-1')).rejects.toMatchObject({
        code: 'INVALID_EVENT_EMAIL_SETTING'
      });
    }
    expect(prisma.eventEmailSetting.upsert).not.toHaveBeenCalled();
  });

  it('lets a missing table fail the write, so a setting that cannot save never looks saved', async () => {
    prisma.eventEmailSetting.upsert.mockRejectedValue(Object.assign(new Error('no table'), { code: 'P2021' }));
    await expect(setSendSignupConfirmations(true, 'admin-1')).rejects.toThrow('no table');
  });
});
