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

// emailNotifications.js logs every send through communicationLog.js, which
// constructs a PrismaClient at import. Rendering never reaches it, but the
// module graph does, so it is stubbed rather than given a database.
vi.mock('../prismaClient.js', () => ({
  default: { communicationLog: { create: vi.fn() }, $disconnect: vi.fn() },
}));

import {
  TEMPLATE_BUILDERS,
  SLOT_EMAIL_TYPES,
  SLOT_NOTIFICATION_SUBJECTS,
} from './emailNotifications.js';
import {
  listEmailTemplates,
  renderEmailTemplatePreview,
  UnknownEmailTemplateError,
  TEMPLATE_CATALOG,
} from './emailTemplatePreview.js';
import config from '../config.js';

beforeEach(() => {
  sendMail.mockClear();
  createTransport.mockClear();
});

// The bug this file exists to prevent: SLOT_EMAIL_COPY had a body for
// INTERVIEWER_MOVED and SLOT_NOTIFICATION_SUBJECTS had no subject for it, so
// queueing one threw inside a catch and the interviewer was never told.
describe('slot notification copy and subjects stay in step', () => {
  it('has a subject for every type the renderer can draw', () => {
    const missing = SLOT_EMAIL_TYPES.filter(
      (type) => typeof SLOT_NOTIFICATION_SUBJECTS[type] !== 'function'
    );
    expect(missing).toEqual([]);
  });

  it('has a renderable type for every subject', () => {
    const known = new Set(SLOT_EMAIL_TYPES);
    const orphans = Object.keys(SLOT_NOTIFICATION_SUBJECTS).filter((t) => !known.has(t));
    expect(orphans).toEqual([]);
  });

  it('previews every one of them', () => {
    const catalogued = new Set(
      TEMPLATE_CATALOG.filter((e) => e.source.id === 'interviewSlot').map((e) => e.key)
    );
    for (const type of SLOT_EMAIL_TYPES) {
      expect(catalogued, type).toContain(`slot-${type.toLowerCase().replace(/_/g, '-')}`);
    }
  });
});

describe('the catalog covers all three systems', () => {
  it('previews every registered transactional builder', () => {
    // A catalog entry may point at a builder under another name, which is how
    // the three welcome audiences share one. Compare against what is used.
    const used = new Set(
      TEMPLATE_CATALOG.filter((e) => e.source.id === 'emailNotifications').map(
        (e) => e.builderKey ?? e.key
      )
    );
    const uncatalogued = Object.keys(TEMPLATE_BUILDERS).filter((key) => !used.has(key));
    expect(uncatalogued).toEqual([]);
  });

  it('lists all three welcome audiences, because all three are sent', () => {
    const welcome = TEMPLATE_CATALOG.filter((e) => e.builderKey === 'welcome').map((e) => e.key);
    expect(welcome.sort()).toEqual(['welcome-candidate', 'welcome-member', 'welcome-talent']);
  });

  it('carries the decision defaults for all four rounds', () => {
    const rounds = TEMPLATE_CATALOG.filter((e) => e.source.id === 'decisionBatch').map((e) =>
      e.key.match(/^decision-round-(\d)-/)[1]
    );
    expect([...new Set(rounds)].sort()).toEqual(['1', '2', '3', '4']);
  });

  it('uses each key exactly once', () => {
    const keys = TEMPLATE_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('no longer lists the decision builders that nothing calls', () => {
    // These six were dead HTML in emailNotifications.js: decision emails come
    // from decisionTemplates.js. Showing them implied the ATS sends them.
    for (const gone of [
      'coffee-chat-acceptance',
      'coffee-chat-rejection',
      'first-round-acceptance',
      'first-round-rejection',
      'final-acceptance',
      'final-rejection',
    ]) {
      expect(TEMPLATE_BUILDERS[gone]).toBeUndefined();
      expect(TEMPLATE_CATALOG.find((e) => e.key === gone)).toBeUndefined();
    }
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
      expect(entry.sourceLabel).toBeTruthy();
      expect(typeof entry.editable).toBe('boolean');
    }
  });

  it('does not leak the sample arguments or the render closure', () => {
    for (const entry of listEmailTemplates()) {
      expect(entry).not.toHaveProperty('args');
      expect(entry).not.toHaveProperty('render');
    }
  });

  it('marks the decision emails as already editable and the rest as not', () => {
    const byId = (id) => listEmailTemplates().filter((e) => e.source === id);

    expect(byId('decisionBatch').every((e) => e.editable)).toBe(true);
    expect(byId('emailNotifications').every((e) => !e.editable)).toBe(true);
    expect(byId('interviewSlot').every((e) => !e.editable)).toBe(true);
  });
});

describe('renderEmailTemplatePreview', () => {
  // The guard against drift: if a builder's signature or a notification's shape
  // changes and the catalog is not updated, this fails here rather than in an
  // admin's face.
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
      expect(subject, key).not.toContain('undefined');
      expect(html, key).not.toContain('undefined');
      expect(html, key).not.toContain('[object Object]');
      expect(subject, key).not.toMatch(/\{\{|\}\}/);
      expect(html, key).not.toMatch(/\{\{|\}\}/);
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
      `${config.clientUrl}/reset-password?token=sample-preview-token`
    );
    const preview = renderEmailTemplatePreview('password-reset');

    expect(preview.subject).toBe(direct.subject);
    expect(preview.html).toBe(direct.html);
  });

  it('keeps the three welcome audiences distinct', () => {
    const candidate = renderEmailTemplatePreview('welcome-candidate');
    const talent = renderEmailTemplatePreview('welcome-talent');
    const member = renderEmailTemplatePreview('welcome-member');

    expect(candidate.subject).toBe('Welcome to UConsulting Recruitment');
    expect(talent.subject).toBe('Welcome to the UConsulting Talent Network');
    expect(member.subject).toBe('Welcome to the UConsulting ATS');
    expect(new Set([candidate.html, talent.html, member.html]).size).toBe(3);
  });

  it('points sample links at this environment, not always production', () => {
    const { html } = renderEmailTemplatePreview('password-reset');
    expect(html).toContain(`${config.clientUrl}/reset-password`);
  });

  it('formats sample times in the club timezone', () => {
    const { html } = renderEmailTemplatePreview('meeting-signup-confirmation');

    // 2026-10-14T18:30:00Z is 11:30 AM in America/Los_Angeles.
    expect(html).toContain('Wednesday, October 14, 2026, 11:30 AM');
    expect(html).toContain('Ackerman Union, Room 2408');
  });

  it('shows the interview slot confirmation Senya asked about', () => {
    const preview = renderEmailTemplatePreview('slot-confirmation');

    expect(preview.subject).toContain('First Round Interviews');
    expect(preview.html).toContain('Wednesday, October 14, 2026, 11:30 AM');
    // The location on the slot, which is the other half of that request.
    expect(preview.html).toContain('Ackerman Union, Room 2408');
  });

  // Three send paths pass three different buttons. A preview that showed the
  // candidate button on an interviewer's email would be showing a link that
  // recipient never gets.
  it('gives a candidate the signup link', () => {
    const { html } = renderEmailTemplatePreview('slot-confirmation');

    expect(html).toContain('/interview-signup');
    expect(html).toContain('View or change your time');
  });

  it('gives an interviewer the assigned-interviews link', () => {
    for (const key of [
      'slot-interviewer-assigned',
      'slot-interviewer-moved',
      'slot-interviewer-removed',
    ]) {
      const { html } = renderEmailTemplatePreview(key);
      expect(html, key).toContain('/assigned-interviews');
      expect(html, key).toContain('See my interviews');
      expect(html, key).not.toContain('/interview-signup');
    }
  });

  it('gives an availability request its own button', () => {
    const { html } = renderEmailTemplatePreview('slot-availability-request');

    expect(html).toContain('/assigned-interviews');
    expect(html).toContain('Add my availability');
  });

  it('previews both wordings of the assignment email', () => {
    const placed = renderEmailTemplatePreview('slot-interviewer-assigned');
    const claimed = renderEmailTemplatePreview('slot-interviewer-assigned-self-signup');

    expect(placed.html).toContain('You have been placed in');
    expect(claimed.html).toContain('You signed up to run');
    expect(claimed.html).not.toContain('You have been placed in');
  });

  it('leaves the details card off a message that has no session yet', () => {
    // AVAILABILITY_REQUEST goes out before the day is cut into slots, so there
    // is no time or location to print.
    const { html } = renderEmailTemplatePreview('slot-availability-request');

    expect(html).toContain('When can you interview?');
    expect(html).not.toContain('<strong>When:</strong>');
  });

  it('names the attachment a preview cannot draw', () => {
    expect(renderEmailTemplatePreview('rsvp-confirmation').alsoAttaches).toMatch(/\.ics/);
    expect(renderEmailTemplatePreview('slot-confirmation').alsoAttaches).toMatch(/\.ics/);
    expect(renderEmailTemplatePreview('password-reset').alsoAttaches).toBeNull();
  });

  it('fills the merge fields in a decision email', () => {
    const preview = renderEmailTemplatePreview('decision-round-1-advanced');

    expect(preview.subject).toContain('Fall 2026 Recruitment');
    expect(preview.html).toContain('Jordan');
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
