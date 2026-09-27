import { describe, it, expect, vi, beforeEach } from 'vitest';

const tx = {
  emailSignature: { updateMany: vi.fn(), update: vi.fn(), create: vi.fn() },
};

vi.mock('../prismaClient.js', () => ({
  default: {
    emailSignature: { findMany: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn() },
    emailTheme: { findUnique: vi.fn() },
    emailTemplateStyle: { findMany: vi.fn() },
    $transaction: vi.fn((fn) => fn(tx)),
  },
}));

import prisma from '../prismaClient.js';
import {
  OWN_SIGN_OFF,
  createEmailSignature,
  deleteEmailSignature,
  normalizeSignature,
  resolveSignature,
  updateEmailSignature,
} from './emailSignatures.js';
import { composeEmail, part } from './emailLayout.js';
import { withEmailDraft } from './emailDrafts.js';

const RYAN = { id: 'sig-1', name: 'External VP', body: 'Best,\n**Ryan**', imageUrl: null, isDefault: false };
const TEAM = { id: 'sig-2', name: 'Recruitment', body: 'The Recruitment Team', imageUrl: null, isDefault: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  prisma.emailSignature.findMany.mockResolvedValue([]);
  prisma.emailTheme.findUnique.mockResolvedValue(null);
  prisma.emailTemplateStyle.findMany.mockResolvedValue([]);
  tx.emailSignature.create.mockImplementation(({ data }) => ({ id: 'new', ...data }));
  tx.emailSignature.update.mockImplementation(({ where, data }) => ({ id: where.id, ...data }));
});

describe('normalizeSignature', () => {
  it('accepts Markdown and an https image', () => {
    expect(
      normalizeSignature({ name: ' VP ', body: 'Best,\n[Ryan](https://uc.example)', imageUrl: 'https://x.test/a.png' })
    ).toEqual({ name: 'VP', body: 'Best,\n[Ryan](https://uc.example)', imageUrl: 'https://x.test/a.png', isDefault: false });
  });

  it.each([
    [{ name: '', body: 'x' }, 'name'],
    [{ name: 'A', body: '  ' }, 'empty'],
    [{ name: 'A', body: '<b>hi</b>' }, 'HTML'],
    [{ name: 'A', body: '[x](javascript:alert(1))' }, 'web address'],
    [{ name: 'A', body: 'x', imageUrl: 'http://x.test/a.png' }, 'https'],
    [{ name: 'A'.repeat(61), body: 'x' }, 'over'],
  ])('refuses %j', (input, message) => {
    expect(() => normalizeSignature(input)).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining(message) }));
  });
});

describe('which signature an email ends with', () => {
  // Braces matter: a function returned from beforeEach is run as teardown,
  // and mockResolvedValue returns the mock itself.
  beforeEach(() => {
    prisma.emailSignature.findMany.mockResolvedValue([TEAM, RYAN]);
  });

  it('uses the one chosen for it', async () => {
    expect(await resolveSignature('sig-1')).toEqual({ body: RYAN.body, imageUrl: null });
  });

  it('uses the default when none is chosen', async () => {
    expect(await resolveSignature(null)).toEqual({ body: TEAM.body, imageUrl: null });
  });

  it('falls back to the default when the chosen one was deleted', async () => {
    expect(await resolveSignature('gone')).toEqual({ body: TEAM.body, imageUrl: null });
  });

  it('keeps the email\'s own sign-off when asked to', async () => {
    expect(await resolveSignature(OWN_SIGN_OFF)).toBeNull();
  });

  it('keeps every email\'s own sign-off while no signatures exist', async () => {
    prisma.emailSignature.findMany.mockResolvedValue([]);
    expect(await resolveSignature(null)).toBeNull();
  });

  it('keeps every email\'s own sign-off when the table is missing', async () => {
    prisma.emailSignature.findMany.mockRejectedValue(new Error('relation does not exist'));
    expect(await resolveSignature(null)).toBeNull();
  });
});

describe('in an email', () => {
  const parts = [part.copy('Hello'), part.signOff('Cheers,\nThe old sign-off')];

  it('replaces the sign-off, never adds beside it', async () => {
    prisma.emailSignature.findMany.mockResolvedValue([TEAM]);
    const { html } = await composeEmail('password-reset', { subject: 'S', parts });

    expect(html).toContain('The Recruitment Team');
    expect(html).not.toContain('The old sign-off');
  });

  it('leaves an email with no sign-off part alone', async () => {
    prisma.emailSignature.findMany.mockResolvedValue([TEAM]);
    const { html } = await composeEmail('decision-round-1-rejected', {
      subject: 'S',
      parts: [part.html('<p>Best,<br>Recruitment</p>')],
    });

    expect(html).not.toContain('The Recruitment Team');
    expect(prisma.emailSignature.findMany).not.toHaveBeenCalled();
  });

  it('shows an unsaved signature in a preview', async () => {
    const { html } = await withEmailDraft({ signature: { body: 'Draft sign-off', imageUrl: null } }, () =>
      composeEmail('password-reset', { subject: 'S', parts })
    );
    expect(html).toContain('Draft sign-off');
  });
});

describe('saving', () => {
  it('clears the old default in the same transaction as setting a new one', async () => {
    await createEmailSignature({ signature: { name: 'New', body: 'x', isDefault: true }, user: { id: 'u1' } });

    expect(tx.emailSignature.updateMany).toHaveBeenCalledWith({ where: { isDefault: true }, data: { isDefault: false } });
    expect(tx.emailSignature.create.mock.calls[0][0].data).toMatchObject({ isDefault: true, updatedById: 'u1' });
  });

  it('does not clear the default it is itself editing', async () => {
    await updateEmailSignature({ id: 'sig-2', signature: { name: 'Recruitment', body: 'y', isDefault: true } });

    expect(tx.emailSignature.updateMany.mock.calls[0][0].where).toEqual({ isDefault: true, NOT: { id: 'sig-2' } });
  });

  it('answers 409 for a duplicate name', async () => {
    tx.emailSignature.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(createEmailSignature({ signature: { name: 'Dup', body: 'x' } })).rejects.toMatchObject({ status: 409 });
  });

  it('answers 404 when deleting one that is already gone', async () => {
    prisma.emailSignature.deleteMany.mockResolvedValue({ count: 0 });
    await expect(deleteEmailSignature({ id: 'gone' })).rejects.toMatchObject({ status: 404 });
  });
});
