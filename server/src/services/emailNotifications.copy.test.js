import { describe, it, expect, vi, beforeEach } from 'vitest';

// The claim this file exists to check: an edit made on the email templates page
// reaches the message a real recipient is handed, not only the preview beside
// the editor. Watching the transport is how you tell those two apart.
const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn(async () => ({ messageId: 'test-message-id' }));
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});

vi.mock('nodemailer', () => ({ default: { createTransport } }));
vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {},
  SendEmailCommand: class {},
}));

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn(async () => []) }));

vi.mock('../prismaClient.js', () => ({
  default: {
    communicationLog: { create: vi.fn() },
    emailTemplateCopy: { findMany },
    $disconnect: vi.fn(),
  },
}));

import {
  sendAcceptanceEmail,
  sendRSVPConfirmation,
  sendWelcomeEmail,
  slotNotificationSubject,
} from './emailNotifications.js';

const edited = (templateKey, copy) => {
  findMany.mockImplementation(async ({ where } = {}) => {
    const key = where?.templateKey;
    const matches = typeof key === 'string' ? key === templateKey : key?.in?.includes(templateKey);
    return matches ? [{ templateKey, copy, updatedAt: new Date() }] : [];
  });
};

/** The { subject, html } handed to the transport by the last send. */
const lastSend = () => sendMail.mock.calls.at(-1)[0];

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
});

describe('an edit reaches what is actually sent', () => {
  it('sends the shipped wording when nobody has edited anything', async () => {
    await sendRSVPConfirmation('jordan@example.com', 'Jordan Rivera', 'Info Session', 'Oct 8', 'Ackerman 2408');

    expect(lastSend().subject).toBe('RSVP Confirmation - Info Session');
    expect(lastSend().html).toContain('Thank you for your RSVP!');
  });

  it('sends an edited body', async () => {
    edited('rsvp-confirmation', { intro: 'You are on the list. Here is where to go:' });

    await sendRSVPConfirmation('jordan@example.com', 'Jordan Rivera', 'Info Session', 'Oct 8', 'Ackerman 2408');

    expect(lastSend().html).toContain('You are on the list. Here is where to go:');
    expect(lastSend().html).not.toContain('Thank you for your RSVP!');
  });

  it('sends an edited subject', async () => {
    edited('rsvp-confirmation', { subject: "You're going to {{eventName}}" });

    await sendRSVPConfirmation('jordan@example.com', 'Jordan Rivera', 'Info Session', 'Oct 8', 'Ackerman 2408');

    expect(lastSend().subject).toBe("You're going to Info Session");
  });

  it('keeps the fields nobody edited at the shipped wording', async () => {
    edited('application-acceptance', { heading: 'You are through to Coffee Chats' });

    await sendAcceptanceEmail('jordan@example.com', 'Jordan Rivera', 'Fall 2026');

    expect(lastSend().html).toContain('You are through to Coffee Chats');
    // Untouched, so still the sentence this repo ships.
    expect(lastSend().html).toContain('What This Means');
    expect(lastSend().subject).toContain('Fall 2026');
  });

  it('keeps the card built from the candidate out of an admin edit', async () => {
    edited('rsvp-confirmation', { intro: 'Changed.' });

    await sendRSVPConfirmation('jordan@example.com', 'Jordan Rivera', 'Info Session', 'Oct 8', 'Ackerman 2408');

    // The details card and the footer are drawn by the ATS, whatever was typed.
    expect(lastSend().html).toContain('Event Details');
    expect(lastSend().html).toContain('Ackerman 2408');
    expect(lastSend().html).toContain('This is an automated message');
  });

  it('escapes a name inside edited wording, as it does inside the shipped wording', async () => {
    edited('application-acceptance', { greeting: 'Hello {{candidateName}},' });

    await sendAcceptanceEmail('x@example.com', '<script>alert(1)</script>', 'Fall 2026');

    expect(lastSend().html).not.toContain('<script>');
    expect(lastSend().html).toContain('&lt;script&gt;');
  });

  it('edits each welcome audience separately, though they share a builder', async () => {
    edited('welcome-member', { heading: 'Welcome aboard' });

    await sendWelcomeEmail('member@example.com', 'Avery Chen', { audience: 'member' });
    expect(lastSend().html).toContain('Welcome aboard');

    await sendWelcomeEmail('jordan@example.com', 'Jordan Rivera', { audience: 'candidate' });
    expect(lastSend().html).toContain('Your account is ready');
    expect(lastSend().html).not.toContain('Welcome aboard');
  });

  it('applies an edited slot subject at the point a notification is queued', async () => {
    edited('slot-confirmation', { subject: 'Locked in - {{interviewTitle}}' });

    expect(await slotNotificationSubject('CONFIRMATION', 'First Round Interviews')).toBe(
      'Locked in - First Round Interviews'
    );
  });

  it('still sends when the wording cannot be read at all', async () => {
    // Migrations here are applied by hand. A deploy that reaches a send before
    // anybody has run the SQL must send the shipped wording, not nothing.
    findMany.mockRejectedValue(new Error('relation "email_template_copy" does not exist'));

    const result = await sendRSVPConfirmation('jordan@example.com', 'Jordan Rivera', 'Info Session', 'Oct 8', 'Ackerman 2408');

    expect(result.success).toBe(true);
    expect(lastSend().html).toContain('Thank you for your RSVP!');
  });
});
