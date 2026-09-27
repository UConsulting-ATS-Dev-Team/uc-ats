// What sendEmail hands SES for click tracking: the category tag on every
// message, and ses:no-track on every credential link.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendMail = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail }) },
}));
vi.mock('@aws-sdk/client-sesv2', () => ({ SESv2Client: class {}, SendEmailCommand: class {} }));
vi.mock('./communicationLog.js', async (importOriginal) => ({
  ...(await importOriginal()),
  recordCommunication: vi.fn(async () => 'row-1'),
}));

const { sendEmail } = await import('./emailNotifications.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  sendMail.mockResolvedValue({ messageId: '<ses-1@us-west-2.amazonses.com>' });
  process.env.SES_CONFIGURATION_SET = 'ats-events';
});

afterEach(() => {
  delete process.env.SES_CONFIGURATION_SET;
});

describe('sendEmail and SES click tracking', () => {
  it('tags the message with its category', async () => {
    await sendEmail('a@b.test', 'S', '<p>x</p>', [], { category: 'INTERVIEW_SLOT' });
    expect(sendMail.mock.calls[0][0].ses).toEqual({
      ConfigurationSetName: 'ats-events',
      EmailTags: [{ Name: 'category', Value: 'INTERVIEW_SLOT' }],
    });
  });

  it('tags an uncategorised message OTHER', async () => {
    await sendEmail('a@b.test', 'S', '<p>x</p>');
    expect(sendMail.mock.calls[0][0].ses.EmailTags).toEqual([{ Name: 'category', Value: 'OTHER' }]);
  });

  it('keeps a reset link out of tracking and leaves an ordinary link tracked', async () => {
    await sendEmail(
      'a@b.test',
      'S',
      '<a href="https://ats.test/reset-password?token=abc">Reset</a><a href="https://ats.test/dashboard">Open</a>'
    );
    const { html } = sendMail.mock.calls[0][0];
    expect(html).toContain('<a ses:no-track href="https://ats.test/reset-password?token=abc">');
    expect(html).toContain('<a href="https://ats.test/dashboard">');
  });

  it('sends no SES options without a configuration set', async () => {
    delete process.env.SES_CONFIGURATION_SET;
    await sendEmail('a@b.test', 'S', '<p>x</p>');
    expect(sendMail.mock.calls[0][0].ses).toBeUndefined();
  });
});
