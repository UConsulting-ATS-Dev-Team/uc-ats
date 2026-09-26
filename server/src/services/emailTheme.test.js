import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../prismaClient.js', () => ({
  default: {
    emailTheme: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    emailTemplateStyle: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  },
}));

import prisma from '../prismaClient.js';
import { THEME_DEFAULTS, normalizeTheme, resolveEmailTheme, saveEmailTheme } from './emailTheme.js';
import { defaultStyle, normalizeStyle, resolveEmailStyle } from './emailTemplateStyle.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  prisma.emailTheme.findUnique.mockResolvedValue(null);
  prisma.emailTemplateStyle.findMany.mockResolvedValue([]);
});

describe('normalizeTheme', () => {
  it('keeps only what differs from the default', () => {
    expect(normalizeTheme({ ...THEME_DEFAULTS, accentColor: '#112233' })).toEqual({ accentColor: '#112233' });
  });

  it('treats a default typed in another case as unchanged', () => {
    expect(normalizeTheme({ accentColor: THEME_DEFAULTS.accentColor.toLowerCase() })).toEqual({});
  });

  it.each([
    [{ accentColor: 'red; background: url(x)' }, 'INVALID_THEME'],
    [{ headerBackground: 'rgb(0,0,0)' }, 'INVALID_THEME'],
    [{ logoUrl: 'http://example.com/logo.png' }, 'INVALID_THEME'],
    [{ logoUrl: 'javascript:alert(1)' }, 'INVALID_THEME'],
    [{ fontFamily: 'Comic Sans' }, 'INVALID_THEME'],
    [{ footerText: 'Hi <a href="x">there</a>' }, 'HTML_NOT_ALLOWED'],
    [{ brandName: 'x'.repeat(81) }, 'INVALID_THEME'],
  ])('refuses %j', (input, code) => {
    expect(() => normalizeTheme(input)).toThrow(expect.objectContaining({ status: 400, code }));
  });
});

describe('saving the theme', () => {
  it('clears a column set back to its default rather than leaving the old value', async () => {
    await saveEmailTheme({ theme: { accentColor: '#112233', footerText: THEME_DEFAULTS.footerText }, user: { id: 'u1' } });

    const { update } = prisma.emailTheme.upsert.mock.calls[0][0];
    expect(update.accentColor).toBe('#112233');
    expect(update.footerText).toBeNull();
    expect(update.updatedById).toBe('u1');
  });

  it('deletes the row when nothing differs, so "customized" stays honest', async () => {
    await saveEmailTheme({ theme: { ...THEME_DEFAULTS } });

    expect(prisma.emailTheme.upsert).not.toHaveBeenCalled();
    expect(prisma.emailTheme.deleteMany).toHaveBeenCalled();
  });

  it('resolves to the defaults when the table is missing', async () => {
    prisma.emailTheme.findUnique.mockRejectedValue(new Error('does not exist'));
    expect(await resolveEmailTheme()).toEqual(THEME_DEFAULTS);
  });
});

describe('per-email style', () => {
  it('starts decision letters Plain and everything else Designed', () => {
    expect(defaultStyle('decision-round-2-advanced').format).toBe('PLAIN');
    expect(defaultStyle('password-reset').format).toBe('DESIGNED');
  });

  it('starts each email on the header colour it always had', () => {
    expect(defaultStyle('application-rejection').banner).toBe('danger');
    expect(defaultStyle('meeting-reschedule-member').banner).toBe('warning');
    expect(defaultStyle('rsvp-confirmation').banner).toBe('brand');
  });

  it('stores only the difference from the shipped style', () => {
    expect(normalizeStyle('application-rejection', { format: 'DESIGNED', banner: 'danger' })).toEqual({});
    expect(normalizeStyle('application-rejection', { format: 'plain', banner: '#123456' })).toEqual({
      format: 'PLAIN',
      banner: '#123456',
    });
  });

  it('refuses an unknown format, colour or template', () => {
    expect(() => normalizeStyle('password-reset', { format: 'FANCY' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => normalizeStyle('password-reset', { banner: 'blue' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => normalizeStyle('not-a-template', {})).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('ignores a stored value it cannot draw', async () => {
    prisma.emailTemplateStyle.findMany.mockResolvedValue([
      { templateKey: 'password-reset', format: 'SPARKLY', banner: 'not a colour' },
    ]);
    expect(await resolveEmailStyle('password-reset')).toEqual(defaultStyle('password-reset'));
  });
});
