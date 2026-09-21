// What the welcome email actually renders.
//
// The routes decide when it sends; this decides what lands in the mailbox. The
// case that matters is escaping: fullName is whatever a stranger typed into a
// public signup form, and it is interpolated straight into an HTML body that
// gets mailed to them. The rest pins down that each audience gets its own copy
// and that the CTA points where the caller said.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMail = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail }) }
}));

const { sendWelcomeEmail } = await import('./emailNotifications.js');

/** The one message handed to the transport. */
const sent = () => sendMail.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  sendMail.mockResolvedValue({ messageId: 'test-message-id' });
});

describe('the welcome email', () => {
  it('escapes a name carrying markup instead of rendering it', async () => {
    await sendWelcomeEmail('joski@g.ucla.edu', '<script>alert(1)</script>', {
      audience: 'candidate',
      ctaUrl: 'https://uconsultingats.com'
    });

    const { html } = sent();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('greets without a name rather than printing an empty one', async () => {
    await sendWelcomeEmail('joski@g.ucla.edu', null, { audience: 'candidate' });

    expect(sent().html).toContain('Hi,');
  });

  it('gives each audience its own subject and call to action', async () => {
    const subjects = {};
    for (const audience of ['candidate', 'talent', 'member']) {
      sendMail.mockClear();
      await sendWelcomeEmail('joski@g.ucla.edu', 'Joski Bruin', {
        audience,
        ctaUrl: 'https://uconsultingats.com'
      });
      const { subject, html } = sent();
      subjects[audience] = subject;
      expect(html).toContain('href="https://uconsultingats.com"');
    }

    expect(subjects.candidate).toBe('Welcome to UConsulting Recruitment');
    expect(subjects.talent).toBe('Welcome to the UConsulting Talent Network');
    expect(subjects.member).toBe('Welcome to the UConsulting ATS');
    // Three audiences, three bodies - the whole reason this is not one generic
    // email. A talent account has no application to hear about.
    expect(new Set(Object.values(subjects)).size).toBe(3);
  });

  it('renders without a CTA when the caller has no link to give', async () => {
    await sendWelcomeEmail('joski@g.ucla.edu', 'Joski Bruin', { audience: 'member' });

    const { html } = sent();
    expect(html).not.toContain('<a href');
    expect(html).toContain('Your member account is ready');
  });

  it('falls back to the candidate copy for an audience it does not know', async () => {
    await sendWelcomeEmail('joski@g.ucla.edu', 'Joski Bruin', { audience: 'nonsense' });

    expect(sent().subject).toBe('Welcome to UConsulting Recruitment');
  });

  it('reports a send failure instead of throwing, so no caller can fail on it', async () => {
    sendMail.mockRejectedValue(new Error('SES refused'));

    await expect(
      sendWelcomeEmail('joski@g.ucla.edu', 'Joski Bruin', { audience: 'candidate' })
    ).resolves.toMatchObject({ success: false });
  });

  it('refuses an empty recipient without calling the transport', async () => {
    const result = await sendWelcomeEmail('', 'Joski Bruin', { audience: 'candidate' });

    expect(result).toMatchObject({ success: false });
    expect(sendMail).not.toHaveBeenCalled();
  });
});
