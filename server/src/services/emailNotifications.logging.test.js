// The log is only worth having if it is complete. sendEmail is the one place
// mail leaves this server, so these tests pin it there: every send is recorded,
// including the ones that fail, and recording never changes what a caller sees.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMail = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {},
  SendEmailCommand: class {},
}));

const recordCommunication = vi.fn();
vi.mock('./communicationLog.js', () => ({
  recordCommunication: (...args) => recordCommunication(...args),
}));

const {
  sendEmail,
  sendPasswordResetEmail,
  sendAcceptanceEmail,
  sendOfferLetter,
} = await import('./emailNotifications.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sendMail.mockResolvedValue({ messageId: 'ses-1' });
  recordCommunication.mockResolvedValue('row-1');
});

const rowOf = (i = 0) => recordCommunication.mock.calls[i][0];

describe('every send is recorded', () => {
  it('records a successful send with the provider id', async () => {
    const result = await sendEmail('ryan@example.com', 'Subject', '<p>Body</p>');

    expect(result).toEqual({ success: true, messageId: 'ses-1' });
    expect(rowOf()).toMatchObject({
      channel: 'email',
      recipient: 'ryan@example.com',
      subject: 'Subject',
      body: '<p>Body</p>',
      status: 'SENT',
      providerMessageId: 'ses-1',
      hasAttachments: false,
    });
  });

  // The row an admin most wants to find is the one that explains why somebody
  // never heard from us.
  it('records a failed send with the error, and still answers the caller', async () => {
    sendMail.mockRejectedValue(new Error('550 mailbox unavailable'));

    const result = await sendEmail('ryan@example.com', 'Subject', '<p>Body</p>');

    expect(result).toEqual({ success: false, error: '550 mailbox unavailable' });
    expect(rowOf()).toMatchObject({
      status: 'FAILED',
      error: '550 mailbox unavailable',
    });
  });

  it('writes one row per address when a send goes to several', async () => {
    await sendEmail('a@example.com, b@example.com', 'Subject', '<p>Body</p>');

    expect(recordCommunication).toHaveBeenCalledTimes(2);
    expect(rowOf(0).recipient).toBe('a@example.com');
    expect(rowOf(1).recipient).toBe('b@example.com');
  });

  it('takes an array of addresses the same way', async () => {
    await sendEmail(['a@example.com', 'b@example.com'], 'Subject', '<p>Body</p>');
    expect(recordCommunication).toHaveBeenCalledTimes(2);
  });

  it('records an unlabelled send as an automated OTHER rather than skipping it', async () => {
    await sendEmail('ryan@example.com', 'Subject', '<p>Body</p>');
    const row = rowOf();
    expect(row.category).toBeUndefined(); // left to the service default
    expect(row.trigger).toBeUndefined();
  });

  // Logging is best-effort. The mail is already gone by the time the row is
  // written, so a logging failure reported as a send failure would get the
  // message sent twice.
  it('still reports success when recording throws', async () => {
    recordCommunication.mockRejectedValue(new Error('db down'));
    await expect(sendEmail('ryan@example.com', 'Subject', '<p>Body</p>')).resolves.toEqual({
      success: true,
      messageId: 'ses-1',
    });
  });

  it('still reports the real error when recording throws on a failed send', async () => {
    sendMail.mockRejectedValue(new Error('550 mailbox unavailable'));
    recordCommunication.mockRejectedValue(new Error('db down'));
    await expect(sendEmail('ryan@example.com', 'Subject', '<p>Body</p>')).resolves.toEqual({
      success: false,
      error: '550 mailbox unavailable',
    });
  });

  it('notes that a send carried an attachment', async () => {
    await sendEmail('ryan@example.com', 'Offer', '<p>Body</p>', [{ filename: 'offer.pdf' }]);
    expect(rowOf().hasAttachments).toBe(true);
  });
});

describe('the wrappers say what kind of message they are', () => {
  it('labels a password reset as an account email', async () => {
    await sendPasswordResetEmail('ryan@example.com', 'https://app/reset?token=x');
    expect(rowOf()).toMatchObject({ category: 'ACCOUNT', recipient: 'ryan@example.com' });
  });

  // Was sendFinalAcceptanceEmail, which had no callers and is gone. The round
  // decisions come from decisionTemplates.js; sendAcceptanceEmail is the live
  // one, and carries the same category and name.
  it('labels an application decision, and carries the candidate name', async () => {
    await sendAcceptanceEmail('ryan@example.com', 'Ryan Kleczynski', 'Fall 2026');
    expect(rowOf()).toMatchObject({
      category: 'APPLICATION_DECISION',
      recipientName: 'Ryan Kleczynski',
    });
  });

  it('labels an offer letter and keeps its attachment', async () => {
    await sendOfferLetter(
      'ryan@example.com',
      'Ryan Kleczynski',
      'Fall 2026',
      {},
      Buffer.from('pdf'),
      'offer.pdf'
    );
    expect(rowOf()).toMatchObject({ category: 'OFFER_LETTER', hasAttachments: true });
  });
});
