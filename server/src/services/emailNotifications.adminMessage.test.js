// "Message an Admin" emails the shared exec inbox. What matters: it reaches
// that inbox, a reply goes back to the person who wrote, and the message they
// typed cannot inject markup into the email.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMail = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {},
  SendEmailCommand: class {},
}));

vi.mock('../prismaClient.js', () => ({
  default: new Proxy({}, {
    get: () => new Proxy({}, {
      get: (_, method) => async () => (String(method).startsWith('findMany') ? [] : null),
    }),
  }),
}));

vi.mock('./communicationLog.js', () => ({ recordCommunication: vi.fn() }));

const { sendAdminMessageEmail } = await import('./emailNotifications.js');

const sent = () => sendMail.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sendMail.mockResolvedValue({ messageId: 'ses-1' });
});

const input = {
  fromName: 'Pam Beesly',
  fromEmail: 'pam@g.ucla.edu',
  role: 'MEMBER',
  message: 'First line\n<script>alert(1)</script>',
  triggeredById: 'member-1',
};

describe('sendAdminMessageEmail', () => {
  it('goes to the exec inbox with the sender as reply-to', async () => {
    const result = await sendAdminMessageEmail(input);

    expect(result.success).toBe(true);
    expect(sent().to).toBe('uconsultingla@gmail.com');
    expect(sent().replyTo).toBe('pam@g.ucla.edu');
    expect(sent().subject).toBe('Message from Pam Beesly');
  });

  it('carries who sent it and what they wrote, escaped', async () => {
    await sendAdminMessageEmail(input);

    const { html, text } = sent();
    expect(html).toContain('Pam Beesly');
    expect(html).toContain('pam@g.ucla.edu');
    expect(html).toContain('First line');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(text).toContain('First line');
  });

  it('reports a failed send instead of throwing', async () => {
    sendMail.mockRejectedValue(new Error('SES down'));

    const result = await sendAdminMessageEmail(input);

    expect(result).toEqual({ success: false, error: 'SES down' });
  });
});
