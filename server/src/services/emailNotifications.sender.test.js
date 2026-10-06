// `fromName` changes only the display name a message is from (GM recaps go out
// as "UConsulting Executive Team"); the address stays the one SES verified.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMail = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {},
  SendEmailCommand: class {},
}));

vi.mock('./communicationLog.js', () => ({
  recordCommunication: vi.fn(),
}));

const { sendEmail } = await import('./emailNotifications.js');

const sent = () => sendMail.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  sendMail.mockResolvedValue({ messageId: 'ses-1' });
  process.env.EMAIL_FROM = 'no-reply@uconsultingats.com';
});

describe('sendEmail sender', () => {
  it('is "UConsulting ATS" by default', async () => {
    await sendEmail('a@ucla.edu', 'Hi', '<p>Hi</p>');
    expect(sent().from).toBe('"UConsulting ATS" <no-reply@uconsultingats.com>');
  });

  it('takes a display name and reply-to, keeping the From address', async () => {
    await sendEmail('a@ucla.edu', 'Hi', '<p>Hi</p>', [], {
      fromName: 'UConsulting Executive Team',
      replyTo: 'uconsultingla@gmail.com',
    });
    expect(sent().from).toBe('"UConsulting Executive Team" <no-reply@uconsultingats.com>');
    expect(sent().replyTo).toBe('uconsultingla@gmail.com');
  });

  it('cannot break out of the header', async () => {
    await sendEmail('a@ucla.edu', 'Hi', '<p>Hi</p>', [], { fromName: 'Exec"\r\nBcc: x@evil.com' });
    expect(sent().from).toBe('"ExecBcc: x@evil.com" <no-reply@uconsultingats.com>');
  });
});
