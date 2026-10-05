// What an applicant placed in a virtual coffee chat is sent: the confirmation
// carries the meeting link as a button, and does not invite them to change a
// time they cannot change.
import { describe, it, expect, vi } from 'vitest';

vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn(() => ({ sendMail: vi.fn() })) } }));
vi.mock('@aws-sdk/client-sesv2', () => ({ SESv2Client: class {}, SendEmailCommand: class {} }));
vi.mock('../prismaClient.js', () => ({
  default: {
    communicationLog: { create: vi.fn() },
    emailTemplateCopy: { findMany: vi.fn(async () => []) },
    emailTheme: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
    emailTemplateStyle: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    $disconnect: vi.fn(),
  },
}));

const { renderInterviewSlotEmail } = await import('./emailNotifications.js');

const notification = (interview) => ({
  type: 'CONFIRMATION',
  slot: {
    label: null,
    location: null,
    startTime: new Date('2026-10-15T02:00:00Z'),
    endTime: new Date('2026-10-15T02:45:00Z'),
    interview,
  },
  signup: { application: { firstName: 'Alan', lastName: 'Turing' } },
});

const ctaUrl = 'https://ats.example/interview-signup';

describe('the confirmation email for a virtual coffee chat', () => {
  it('has a Join the call button for the meeting link', async () => {
    const html = await renderInterviewSlotEmail(
      notification({ title: 'Virtual Coffee Chat', location: 'https://ucla.zoom.us/j/987', isVirtual: true }),
      { ctaUrl }
    );
    expect(html).toContain('href="https://ucla.zoom.us/j/987"');
    expect(html).toContain('Join the call');
    expect(html).toContain('View your interview');
    expect(html).not.toContain('View or change your time');
  });

  it('has no join button while the link is still to follow', async () => {
    const html = await renderInterviewSlotEmail(
      notification({ title: 'Virtual Coffee Chat', location: 'Video call, link to follow', isVirtual: true }),
      { ctaUrl }
    );
    expect(html).not.toContain('Join the call');
    expect(html).toContain('link to follow');
  });

  it('leaves an in-person confirmation as it was', async () => {
    const html = await renderInterviewSlotEmail(
      notification({ title: 'Coffee Chats', location: 'Ackerman Grand Ballroom', isVirtual: false }),
      { ctaUrl }
    );
    expect(html).not.toContain('Join the call');
    expect(html).toContain('View or change your time');
  });
});

describe('the email for a session whose time or place was edited', () => {
  const inPerson = { title: 'First Round', location: 'Bunche 2150', isVirtual: false };

  it('tells a candidate the session changed, not that they were moved', async () => {
    const html = await renderInterviewSlotEmail(
      { ...notification(inPerson), type: 'MOVED_BY_ADMIN' },
      { ctaUrl, sessionChanged: true }
    );
    expect(html).toContain('Your interview details have changed');
    expect(html).toContain('changed the time or place of your First Round session');
    expect(html).not.toContain('has moved your');
    expect(html).toContain('Bunche 2150');
  });

  it('tells an interviewer the same way', async () => {
    const html = await renderInterviewSlotEmail(
      { ...notification(inPerson), type: 'INTERVIEWER_MOVED' },
      { ctaUrl, sessionChanged: true }
    );
    expect(html).toContain('changed the time or place of the First Round session you are running');
    expect(html).not.toContain('moved which');
  });

  it('leaves an ordinary move worded as a move', async () => {
    const html = await renderInterviewSlotEmail({ ...notification(inPerson), type: 'MOVED_BY_ADMIN' }, { ctaUrl });
    expect(html).toContain('has moved your First Round booking');
  });
});
