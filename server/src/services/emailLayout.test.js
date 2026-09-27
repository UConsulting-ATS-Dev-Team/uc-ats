import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../prismaClient.js', () => ({
  default: {
    emailTheme: { findUnique: vi.fn() },
    emailTemplateStyle: { findMany: vi.fn() },
  },
}));

import prisma from '../prismaClient.js';
import { THEME_DEFAULTS } from './emailTheme.js';
import {
  composeEmail,
  htmlToPlainText,
  part,
  renderEmailLayout,
  withDraftPresentation,
} from './emailLayout.js';

const theme = { ...THEME_DEFAULTS };
const designed = { format: 'DESIGNED', banner: 'brand' };
const plain = { format: 'PLAIN', banner: 'brand' };

const sampleParts = [
  part.heading('Hello {{name}}'),
  part.copy('Some **bold** words.'),
  part.card({
    tone: 'success',
    title: 'Details',
    rows: [{ label: 'When', value: 'Tuesday' }, null],
  }),
  part.button('https://example.com/go?a=1&b=2', 'Go'),
  part.link('https://example.com/go?a=1&b=2'),
  part.signOff('Best,\nThe Team'),
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  prisma.emailTheme.findUnique.mockResolvedValue(null);
  prisma.emailTemplateStyle.findMany.mockResolvedValue([]);
});

describe('Designed', () => {
  const html = renderEmailLayout({ parts: sampleParts, values: { name: 'Ana' }, theme, style: designed });

  it('draws a complete document with header, body and footer', () => {
    expect(html).toMatch(/^<!DOCTYPE html/);
    expect(html).toContain('UConsulting ATS</h2>');
    expect(html).toContain('Hello Ana');
    expect(html).toContain(THEME_DEFAULTS.footerText);
  });

  it('colours the header from the theme', () => {
    expect(html).toContain(`background-color: ${THEME_DEFAULTS.headerBackground}; padding: 20px; text-align: center;`);
  });

  it('puts buttons and links in the accent colour, with the URL attribute-escaped', () => {
    expect(html).toContain(`href="https://example.com/go?a=1&amp;b=2" style="background-color: ${THEME_DEFAULTS.accentColor};`);
  });

  it('draws a card in its tone, skipping empty rows', () => {
    expect(html).toContain('border-left: 4px solid #28a745');
    expect(html).toContain('<strong>When:</strong> Tuesday');
  });
});

describe('Plain', () => {
  const html = renderEmailLayout({ parts: sampleParts, values: { name: 'Ana' }, theme, style: plain });

  it('has no header, card box or footer', () => {
    expect(html).not.toContain('<h2');
    expect(html).not.toContain('border-left');
    expect(html).not.toContain(THEME_DEFAULTS.footerText);
  });

  it('keeps every piece of information the Designed version carries', () => {
    expect(html).toContain('<strong>Hello Ana</strong>');
    expect(html).toContain('<strong>Details</strong><br>When: Tuesday');
    expect(html).toContain('>Go</a>');
    expect(html).toContain('Best,<br>The Team');
  });

  it('drops the raw-URL fallback, since the button is already a plain link', () => {
    expect(html.match(/example\.com\/go/g)).toHaveLength(1);
  });
});

describe('what an admin can and cannot inject', () => {
  it('escapes data in card rows', () => {
    const html = renderEmailLayout({
      parts: [part.card({ title: 'Who', rows: [{ label: 'Name', value: '<script>x</script>' }] })],
      theme,
      style: designed,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes the brand name and footer, which are free text', () => {
    const html = renderEmailLayout({
      parts: [],
      theme: { ...theme, brandName: 'A & <b>B</b>', footerText: '<i>hi</i>' },
      style: designed,
    });
    expect(html).toContain('A &amp; &lt;b&gt;B&lt;/b&gt;');
    expect(html).toContain('&lt;i&gt;hi&lt;/i&gt;');
  });

  it('draws no footer at all when the theme has cleared it', () => {
    const html = renderEmailLayout({ parts: [], theme: { ...theme, footerText: '' }, style: designed });
    expect(html).not.toContain(THEME_DEFAULTS.footerText);
    expect(html).not.toContain('font-size: 12px');
  });

  it('shows the logo instead of the brand text when one is set', () => {
    const html = renderEmailLayout({
      parts: [],
      theme: { ...theme, logoUrl: 'https://cdn.example.com/logo.png' },
      style: designed,
      brand: 'UConsulting Talent Network',
    });
    expect(html).toContain('<img src="https://cdn.example.com/logo.png" alt="UConsulting Talent Network"');
    expect(html).not.toContain('</h2>');
  });
});

describe('header colour', () => {
  const header = (banner) =>
    renderEmailLayout({ parts: [], theme, style: { format: 'DESIGNED', banner } }).match(
      /<td style="background-color: (#[0-9a-fA-F]+); padding: 20px; text-align: center;">\s*<h2 style="color: (#[0-9a-fA-F]+)/
    ).slice(1);

  it('uses the status colours the emails always had, with white text', () => {
    expect(header('success')).toEqual(['#28a745', '#ffffff']);
    expect(header('danger')).toEqual(['#dc3545', '#ffffff']);
    expect(header('warning')).toEqual(['#fd7e14', '#ffffff']);
  });

  it('picks readable text for a custom colour', () => {
    expect(header('#fff3b0')[1]).toBe('#042742');
    expect(header('#1a1a40')[1]).toBe('#ffffff');
  });
});

describe('plain-text part', () => {
  it('keeps link addresses and drops markup', () => {
    const text = htmlToPlainText(
      renderEmailLayout({ parts: sampleParts, values: { name: 'Ana' }, theme, style: designed })
    );
    expect(text).toContain('Hello Ana');
    expect(text).toContain('Go [https://example.com/go?a=1&b=2]');
    expect(text).not.toMatch(/<[a-z]/i);
  });
});

describe('composeEmail', () => {
  it('reads the stored theme and the template style', async () => {
    prisma.emailTheme.findUnique.mockResolvedValue({ id: 'default', accentColor: '#123456' });
    prisma.emailTemplateStyle.findMany.mockResolvedValue([{ templateKey: 'password-reset', format: 'PLAIN' }]);

    const email = await composeEmail('password-reset', { subject: 'S', parts: [part.button('https://x.test', 'Go')] });

    expect(email.format).toBe('PLAIN');
    expect(email.html).toContain('color: #123456');
  });

  it('still renders when the tables do not exist yet', async () => {
    prisma.emailTheme.findUnique.mockRejectedValue(new Error('relation "email_theme" does not exist'));
    prisma.emailTemplateStyle.findMany.mockRejectedValue(new Error('relation does not exist'));

    const email = await composeEmail('application-acceptance', { subject: 'S', parts: [part.copy('Hi')] });

    expect(email.format).toBe('DESIGNED');
    expect(email.html).toContain('background-color: #28a745');
  });

  it('renders an unsaved draft without reading the database', async () => {
    const email = await withDraftPresentation(
      { theme: { ...theme, accentColor: '#abcdef' }, styles: { 'password-reset': plain } },
      () => composeEmail('password-reset', { subject: 'S', parts: [part.button('https://x.test', 'Go')] })
    );

    expect(email.format).toBe('PLAIN');
    expect(email.html).toContain('color: #abcdef');
    expect(prisma.emailTheme.findUnique).not.toHaveBeenCalled();
  });
});
