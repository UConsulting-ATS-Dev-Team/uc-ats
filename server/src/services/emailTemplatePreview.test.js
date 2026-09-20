import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stand in for the mail transport so the whole point of this feature is
// testable: rendering a preview must never reach it. `sendMail` is the single
// call site in emailNotifications.js, so watching it watches every send.
const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});

vi.mock('nodemailer', () => ({
  default: { createTransport },
}));

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {},
  SendEmailCommand: class {},
}));

import { TEMPLATE_BUILDERS } from './emailNotifications.js';
import {
  listEmailTemplates,
  renderEmailTemplatePreview,
  UnknownEmailTemplateError,
  TEMPLATE_CATALOG,
} from './emailTemplatePreview.js';

beforeEach(() => {
  sendMail.mockClear();
  createTransport.mockClear();
});

describe('the catalog and the builders agree', () => {
  it('has a builder for every catalogued template', () => {
    const missing = TEMPLATE_CATALOG.map((e) => e.key).filter((key) => !TEMPLATE_BUILDERS[key]);
    expect(missing).toEqual([]);
  });

  it('has a catalogue entry for every builder', () => {
    const catalogued = new Set(TEMPLATE_CATALOG.map((e) => e.key));
    const uncatalogued = Object.keys(TEMPLATE_BUILDERS).filter((key) => !catalogued.has(key));
    expect(uncatalogued).toEqual([]);
  });

  it('uses each key exactly once', () => {
    const keys = TEMPLATE_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('listEmailTemplates', () => {
  it('describes every template without rendering it', () => {
    const list = listEmailTemplates();

    expect(list).toHaveLength(TEMPLATE_CATALOG.length);
    for (const entry of list) {
      expect(entry.key).toBeTruthy();
      expect(entry.label).toBeTruthy();
      expect(entry.audience).toBeTruthy();
      expect(entry.trigger).toBeTruthy();
    }
  });

  it('does not leak the sample arguments to callers', () => {
    for (const entry of listEmailTemplates()) {
      expect(entry).not.toHaveProperty('args');
    }
  });
});

describe('renderEmailTemplatePreview', () => {
  // The guard against catalog drift: if a builder's signature changes and the
  // catalog is not updated, the render throws or produces empty output here
  // rather than in an admin's face.
  it.each(TEMPLATE_CATALOG.map((e) => e.key))('renders %s', (key) => {
    const preview = renderEmailTemplatePreview(key);

    expect(preview.subject).toBeTruthy();
    expect(typeof preview.subject).toBe('string');
    expect(preview.html).toBeTruthy();
    expect(preview.html.length).toBeGreaterThan(100);
    expect(preview.key).toBe(key);
  });

  it('never leaves an unsubstituted placeholder in the output', () => {
    for (const { key } of TEMPLATE_CATALOG) {
      const { subject, html } = renderEmailTemplatePreview(key);
      expect(subject).not.toContain('undefined');
      expect(html).not.toContain('undefined');
      expect(html).not.toContain('[object Object]');
    }
  });

  it('sends nothing', () => {
    for (const { key } of TEMPLATE_CATALOG) {
      renderEmailTemplatePreview(key);
    }

    expect(sendMail).not.toHaveBeenCalled();
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('is deterministic, so the same template previews identically every time', () => {
    for (const { key } of TEMPLATE_CATALOG) {
      expect(renderEmailTemplatePreview(key)).toEqual(renderEmailTemplatePreview(key));
    }
  });

  it('rejects an unknown key', () => {
    expect(() => renderEmailTemplatePreview('not-a-template')).toThrow(UnknownEmailTemplateError);
  });

  it('rejects a key that would otherwise reach Object.prototype', () => {
    expect(() => renderEmailTemplatePreview('constructor')).toThrow(UnknownEmailTemplateError);
    expect(() => renderEmailTemplatePreview('toString')).toThrow(UnknownEmailTemplateError);
  });
});

describe('what the preview actually shows', () => {
  it('renders the same content the send path would produce', () => {
    // Builder output is what sendEmail is handed verbatim, so comparing the
    // preview against a direct builder call is the whole correctness claim.
    const direct = TEMPLATE_BUILDERS['password-reset'](
      'https://uconsultingats.com/reset-password?token=sample-preview-token'
    );
    const preview = renderEmailTemplatePreview('password-reset');

    expect(preview.subject).toBe(direct.subject);
    expect(preview.html).toBe(direct.html);
  });

  it('formats sample times in the club timezone', () => {
    const { html } = renderEmailTemplatePreview('meeting-signup-confirmation');

    // 2026-10-14T18:30:00Z is 11:30 AM in America/Los_Angeles.
    expect(html).toContain('Wednesday, October 14, 2026, 11:30 AM');
    expect(html).toContain('Ackerman Union, Room 2408');
  });

  it('escapes candidate-controlled text rather than trusting it', () => {
    const { html } = TEMPLATE_BUILDERS['application-acceptance'](
      '<script>alert(1)</script>',
      'Fall 2026'
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
