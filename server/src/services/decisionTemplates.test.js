import { describe, it, expect, beforeAll } from 'vitest';
import {
  DECISION_MERGE_FIELDS,
  decisionTemplatesForRound,
  outcomeLabel,
  renderDecisionEmail
} from './decisionTemplates.js';

// The wording is admin-editable now, so reading it is a query. Nobody has
// edited anything in these tests, which is what an empty result means.
const shipped = { emailTemplateCopy: { findMany: async () => [] } };
const templatesFor = (round) => decisionTemplatesForRound(round, { client: shipped });

const recipient = (overrides = {}) => ({
  firstName: 'Sam',
  lastName: 'Lee',
  needsInvite: false,
  userId: 'user-1',
  ...overrides
});

const context = { cycleName: 'Fall 2026', round: '1', loginUrl: 'https://ats.example/login' };

describe('default wording', () => {
  it('covers exactly the outcomes each round can produce', async () => {
    expect(Object.keys(await templatesFor('1')).sort()).toEqual(['ADVANCED', 'REJECTED']);
    expect(Object.keys(await templatesFor('3')).sort()).toEqual(['ADVANCED', 'REJECTED']);
    expect(Object.keys(await templatesFor('4')).sort()).toEqual(['ACCEPTED', 'REJECTED']);
  });

  it('refuses a round it has no wording for', async () => {
    await expect(templatesFor('9')).rejects.toThrow(/round 9/);
  });

  it('only uses merge fields the renderer knows', async () => {
    for (const round of ['1', '2', '3', '4']) {
      for (const { subject, body } of Object.values(await templatesFor(round))) {
        const used = [...`${subject} ${body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(([, key]) => key);
        expect(DECISION_MERGE_FIELDS).toEqual(expect.arrayContaining(used));
      }
    }
  });

  it('hands out a copy, so editing one batch cannot change the defaults', async () => {
    (await templatesFor('1')).ADVANCED.subject = 'edited';
    expect((await templatesFor('1')).ADVANCED.subject).not.toBe('edited');
  });

  it('prefers an admin edit over the shipped wording, field by field', async () => {
    const edited = {
      emailTemplateCopy: {
        findMany: async () => [
          { templateKey: 'decision-round-1-advanced', copy: { subject: 'You are in - {{cycleName}}' } }
        ]
      }
    };
    const templates = await decisionTemplatesForRound('1', { client: edited });
    expect(templates.ADVANCED.subject).toBe('You are in - {{cycleName}}');
    // The body was not edited, so it is still the one this repo ships.
    expect(templates.ADVANCED.body).toContain('Coffee Chats');
  });

  it('labels each outcome for the reviewer', () => {
    expect(outcomeLabel('ADVANCED', '2')).toBe('Advancing to First Round Interviews');
    expect(outcomeLabel('REJECTED', '4')).toBe('Not moving forward');
  });
});

describe('rendering', () => {
  it('fills merge fields in the subject and body', () => {
    const { subject, html } = renderDecisionEmail(
      { subject: 'Hi {{firstName}} - {{cycleName}}', body: '{{fullName}}, next up: {{nextRoundName}}' },
      recipient(),
      context
    );
    expect(subject).toBe('Hi Sam - Fall 2026');
    expect(html).toContain('Sam Lee, next up: Coffee Chats');
  });

  it('escapes what applicants typed in the body, and leaves the subject readable', () => {
    const { subject, html } = renderDecisionEmail(
      { subject: 'Hi {{lastName}}', body: 'Hi {{firstName}}' },
      recipient({ firstName: '<img src=x onerror=alert(1)>', lastName: "O'Brien" }),
      context
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(subject).toBe("Hi O'Brien");
  });

  it('keeps a subject on one line', () => {
    const { subject } = renderDecisionEmail({ subject: 'Hi {{firstName}}', body: 'x' }, recipient({ firstName: 'Sam\nBcc: someone' }), context);
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it('points an unsafe link at nothing, however it was written', () => {
    // A decision body is written by an admin, here or per batch in Master
    // Communications. Checked on the rendered HTML, so reference-style links
    // and autolinks are covered along with inline ones.
    for (const body of [
      '[click](javascript:alert(1))',
      '[click][x]\n\n[x]: javascript:alert(1)',
      '<javascript:alert(1)>'
    ]) {
      const { html } = renderDecisionEmail({ subject: 's', body }, recipient(), context);
      // The scheme may survive as the link's visible text, which is harmless.
      // What must not survive is a link that goes there.
      expect(html, body).not.toMatch(/href="javascript:/);
      expect(html, body).toContain('href="#"');
    }
  });

  it('keeps the links a decision email actually carries', () => {
    const { html } = renderDecisionEmail(
      { subject: 's', body: '[the ATS](https://ats.example) and [us](mailto:r@example.com)' },
      recipient(),
      context
    );
    expect(html).toContain('href="https://ats.example"');
    expect(html).toContain('href="mailto:r@example.com"');
  });

  it('leaves unknown tokens alone rather than blanking them', () => {
    const { html } = renderDecisionEmail({ subject: 's', body: 'Hello {{nickname}}' }, recipient(), context);
    expect(html).toContain('{{nickname}}');
  });

  describe('account setup', () => {
    const template = { subject: 'Welcome', body: '{{accountSetup}}' };
    const finalRound = { ...context, round: '4' };

    it('gives a new member the set-password link minted for this send', () => {
      const { html } = renderDecisionEmail(template, recipient({ needsInvite: true }), {
        ...finalRound,
        setPasswordLink: 'https://ats.example/reset-password?token=abc'
      });
      expect(html).toContain('href="https://ats.example/reset-password?token=abc"');
    });

    it('shows a placeholder link in a preview, never a real token', () => {
      const { html } = renderDecisionEmail(template, recipient({ needsInvite: true }), { ...finalRound, preview: true });
      expect(html).toContain('#set-password-link-created-when-sent');
    });

    it('points an existing account at sign-in', () => {
      const { html } = renderDecisionEmail(template, recipient(), finalRound);
      expect(html).toContain('href="https://ats.example/login"');
    });

    it('promises a follow-up when no account could be linked', () => {
      const { html } = renderDecisionEmail(template, recipient({ userId: null }), finalRound);
      expect(html).toContain('follow up');
    });
  });

  describe('scheduling link', () => {
    let advanced;
    beforeAll(async () => {
      advanced = (await templatesFor('1')).ADVANCED;
    });

    it('links a candidate to the round they are moving to', () => {
      const { html } = renderDecisionEmail(advanced, recipient({ toRound: '2' }), {
        ...context,
        schedulingLinksByRound: { 2: 'https://ats.example/interview-signup' }
      });
      expect(html).toContain('href="https://ats.example/interview-signup"');
      expect(html).toContain('first come, first served');
    });

    it('keeps the old promise when that round has no bookable times yet', () => {
      // The fallback is what makes this safe to ship before any slots exist -
      // and what stops an email linking to an empty page mid-cycle.
      const { html } = renderDecisionEmail(advanced, recipient({ toRound: '2' }), {
        ...context,
        schedulingLinksByRound: {}
      });
      expect(html).toContain('Scheduling details are on their way');
      expect(html).not.toContain('interview-signup');
    });

    it('shows a placeholder in a preview rather than a dead link', () => {
      const { html } = renderDecisionEmail(advanced, recipient({ toRound: '2' }), {
        ...context,
        preview: true
      });
      expect(html).toContain('#scheduling-link-shown-when-sent');
    });

    it('does not link a round the candidate is not moving to', () => {
      const { html } = renderDecisionEmail(advanced, recipient({ toRound: '3' }), {
        ...context,
        schedulingLinksByRound: { 2: 'https://ats.example/interview-signup' }
      });
      expect(html).toContain('Scheduling details are on their way');
    });
  });
});
