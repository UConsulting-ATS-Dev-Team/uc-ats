// Whether the Google Form event sync sends confirmation emails, and nothing
// else about the sync.
//
// The switch (eventEmailSettings.js) is off while sign-ups run through Luma,
// because Luma emails its own confirmation the moment somebody registers. The
// rows have to be written either way — a sync that stopped recording RSVPs when
// the emails were turned off would be a far worse bug than a duplicate email,
// and nothing else in the suite would catch it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../prismaClient.js', () => ({
  default: {
    events: { findUnique: vi.fn() },
    candidate: { findUnique: vi.fn(), create: vi.fn() },
    eventRsvp: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    eventAttendance: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() }
  }
}));
vi.mock('./google/forms.js', () => ({ getResponses: vi.fn() }));
vi.mock('./emailNotifications.js', () => ({
  sendRSVPConfirmation: vi.fn(() => Promise.resolve({ success: true })),
  sendAttendanceConfirmation: vi.fn(() => Promise.resolve({ success: true })),
  formatEventDate: vi.fn(() => 'Oct 8')
}));
vi.mock('./eventEmailSettings.js', () => ({ sendSignupConfirmations: vi.fn() }));
vi.mock('../utils/eventDataMapper.js', () => ({
  transformEventFormResponse: vi.fn(),
  createDynamicEventMapping: vi.fn()
}));

const prisma = (await import('../prismaClient.js')).default;
const { getResponses } = await import('./google/forms.js');
const { sendRSVPConfirmation, sendAttendanceConfirmation } = await import('./emailNotifications.js');
const { sendSignupConfirmations } = await import('./eventEmailSettings.js');
const { transformEventFormResponse } = await import('../utils/eventDataMapper.js');
const { syncEventRSVP, syncEventAttendance } = await import('./syncEventResponses.js');

const EVENT = {
  id: 'event-1',
  eventName: 'Info Session',
  eventStartDate: new Date('2026-10-08T18:00:00.000Z'),
  eventLocation: 'Ackerman 2408',
  rsvpForm: 'https://docs.google.com/forms/d/FORMID/viewform',
  attendanceForm: 'https://docs.google.com/forms/d/FORMID/viewform'
};

const CANDIDATE = {
  id: 'cand-1',
  firstName: 'Jordan',
  lastName: 'Rivera',
  email: 'jordan@example.com',
  studentId: '405123456'
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  prisma.events.findUnique.mockResolvedValue(EVENT);
  getResponses.mockResolvedValue([{ responseId: 'resp-1' }]);
  transformEventFormResponse.mockReturnValue({
    responseId: 'resp-1',
    email: CANDIDATE.email,
    firstName: CANDIDATE.firstName,
    lastName: CANDIDATE.lastName,
    studentId: CANDIDATE.studentId
  });
  prisma.candidate.findUnique.mockResolvedValue(CANDIDATE);
  // Nothing recorded yet, so this response is new work.
  prisma.eventRsvp.findMany.mockResolvedValue([]);
  prisma.eventAttendance.findMany.mockResolvedValue([]);
  prisma.eventRsvp.findUnique.mockResolvedValue(null);
  prisma.eventAttendance.findUnique.mockResolvedValue(null);
  prisma.eventRsvp.create.mockResolvedValue({ id: 'rsvp-1' });
  prisma.eventAttendance.create.mockResolvedValue({ id: 'att-1' });
});

describe('with the switch off (Luma is sending them)', () => {
  beforeEach(() => sendSignupConfirmations.mockResolvedValue(false));

  it('records the RSVP and sends nothing', async () => {
    const result = await syncEventRSVP(EVENT.id);

    expect(prisma.eventRsvp.create).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(1);
    expect(sendRSVPConfirmation).not.toHaveBeenCalled();
  });

  it('records the attendance and sends nothing', async () => {
    await syncEventAttendance(EVENT.id);

    expect(prisma.eventAttendance.create).toHaveBeenCalledTimes(1);
    expect(sendAttendanceConfirmation).not.toHaveBeenCalled();
  });
});

describe('with the switch on (back on Google Forms)', () => {
  beforeEach(() => sendSignupConfirmations.mockResolvedValue(true));

  it('sends the RSVP confirmation, with the event so it carries the calendar invite', async () => {
    await syncEventRSVP(EVENT.id);

    expect(sendRSVPConfirmation).toHaveBeenCalledTimes(1);
    const args = sendRSVPConfirmation.mock.calls[0];
    expect(args[0]).toBe(CANDIDATE.email);
    expect(args[1]).toBe('Jordan Rivera');
    expect(args[5]).toBe(EVENT);
  });

  it('sends the attendance confirmation', async () => {
    await syncEventAttendance(EVENT.id);

    expect(sendAttendanceConfirmation).toHaveBeenCalledTimes(1);
    expect(sendAttendanceConfirmation.mock.calls[0][0]).toBe(CANDIDATE.email);
  });

  it('still records the row when the email fails', async () => {
    sendRSVPConfirmation.mockRejectedValue(new Error('SES refused'));

    const result = await syncEventRSVP(EVENT.id);

    expect(prisma.eventRsvp.create).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);
  });

  it('reads the switch once for the run, not once per response', async () => {
    getResponses.mockResolvedValue([{ responseId: 'resp-1' }, { responseId: 'resp-2' }]);

    await syncEventRSVP(EVENT.id);

    expect(sendSignupConfirmations).toHaveBeenCalledTimes(1);
  });
});

describe('a response that was already recorded', () => {
  it('is skipped without a second email, however the switch is set', async () => {
    sendSignupConfirmations.mockResolvedValue(true);
    prisma.eventRsvp.findUnique.mockResolvedValue({ id: 'rsvp-existing' });

    const result = await syncEventRSVP(EVENT.id);

    expect(prisma.eventRsvp.create).not.toHaveBeenCalled();
    expect(sendRSVPConfirmation).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });
});
