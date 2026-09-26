import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminMeetingSlots from './AdminMeetingSlots';
import api from '../utils/api';
import { useAuth } from '../context/AuthContext';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), setToken: vi.fn() }
}));

vi.mock('../context/AuthContext', () => ({ useAuth: vi.fn() }));

const signup = (id, fullName, overrides = {}) => ({
  id,
  fullName,
  email: `${id}@ucla.edu`,
  studentId: null,
  attended: false,
  createdAt: '2026-09-20T00:00:00.000Z',
  ...overrides
});

// Slots as GET /admin/meeting-slots answers them: newest-created first.
const slots = [
  {
    id: 'slot-late',
    memberId: 'm2',
    member: { id: 'm2', fullName: 'Sam Patel' },
    location: 'Bruin Cafe',
    startTime: '2026-11-05T18:00:00.000Z',
    capacity: 3,
    createdAt: '2026-09-10T00:00:00.000Z',
    signups: [signup('s1', 'Zoe Park', { attended: true, createdAt: '2026-09-22T00:00:00.000Z' })]
  },
  {
    id: 'slot-early',
    memberId: 'm1',
    member: { id: 'm1', fullName: 'Avery Chen' },
    location: 'Kerckhoff Patio',
    startTime: '2026-10-28T16:30:00.000Z',
    capacity: 2,
    createdAt: '2026-09-05T00:00:00.000Z',
    signups: [
      signup('s2', 'Ben Ortiz', { createdAt: '2026-09-21T00:00:00.000Z' }),
      signup('s3', 'amy Liu', { attended: true, createdAt: '2026-09-23T00:00:00.000Z' })
    ]
  }
];

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({ token: 't', user: { id: 'admin', role: 'ADMIN', fullName: 'Admin' } });
  api.get.mockImplementation((url) => {
    if (url === '/admin/meeting-slots') return Promise.resolve({ slots });
    if (url === '/active-cycle') return Promise.resolve({ cycle: null });
    if (url === '/member/gtkuc-profile') return Promise.resolve({ confirmationRequired: false });
    return Promise.resolve([]);
  });
});

// First text cell of each body row, in the order the table shows them.
const columnValues = (columnIndex) =>
  within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[columnIndex].textContent);

describe('AdminMeetingSlots time slots sorting', () => {
  it('lists slots by start time by default, not by creation order', async () => {
    render(<AdminMeetingSlots />);
    await screen.findByText('Kerckhoff Patio');
    expect(columnValues(1)).toEqual(['Kerckhoff Patio', 'Bruin Cafe']);
  });

  it('sorts by a column when its header is clicked, and flips on a second click', async () => {
    const user = userEvent.setup();
    render(<AdminMeetingSlots />);
    await screen.findByText('Kerckhoff Patio');

    // The host cell also holds the avatar's initials, so read the location.
    await user.click(screen.getByRole('button', { name: 'Host' }));
    expect(columnValues(1)).toEqual(['Kerckhoff Patio', 'Bruin Cafe']);
    await user.click(screen.getByRole('button', { name: 'Host' }));
    expect(columnValues(1)).toEqual(['Bruin Cafe', 'Kerckhoff Patio']);
  });

  it('sorts counts biggest-first on the first click', async () => {
    const user = userEvent.setup();
    render(<AdminMeetingSlots />);
    await screen.findByText('Kerckhoff Patio');

    await user.click(screen.getByRole('button', { name: 'Open spots' }));
    expect(columnValues(1)).toEqual(['Bruin Cafe', 'Kerckhoff Patio']);
  });
});

describe('AdminMeetingSlots status sorting over time', () => {
  afterEach(() => vi.useRealTimers());

  it('re-sorts by status when a slot ends while the page is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Both slots upcoming, so the status sort falls back to start time.
    vi.setSystemTime(new Date('2026-10-28T16:00:00.000Z'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<AdminMeetingSlots />);
    await screen.findByText('Kerckhoff Patio');

    await user.click(screen.getByRole('button', { name: 'Status' }));
    expect(columnValues(1)).toEqual(['Kerckhoff Patio', 'Bruin Cafe']);

    // Kerckhoff has no end time, so it is past an hour after it starts.
    vi.setSystemTime(new Date('2026-10-28T17:31:00.000Z'));
    await act(async () => { vi.advanceTimersByTime(60 * 1000); });

    expect(columnValues(1)).toEqual(['Bruin Cafe', 'Kerckhoff Patio']);
    expect(within(screen.getAllByRole('row')[2]).getByText('Past')).toBeTruthy();
  });
});

describe('AdminMeetingSlots attendance sorting', () => {
  const openAttendance = async (user) => {
    render(<AdminMeetingSlots />);
    await screen.findByText('Kerckhoff Patio');
    await user.click(screen.getByRole('tab', { name: /Attendance/ }));
  };

  it('sorts by candidate name, case-insensitively', async () => {
    const user = userEvent.setup();
    await openAttendance(user);

    await user.click(screen.getByRole('button', { name: 'Candidate' }));
    expect(columnValues(1)).toEqual(['amy Liu', 'Ben Ortiz', 'Zoe Park']);
  });

  it('puts attendees first when sorting by present', async () => {
    const user = userEvent.setup();
    await openAttendance(user);

    await user.click(screen.getByRole('button', { name: 'Present' }));
    // Attendees first, each group in slot-time order.
    expect(columnValues(1)).toEqual(['amy Liu', 'Zoe Park', 'Ben Ortiz']);
  });

  it('sorts by when each candidate signed up', async () => {
    const user = userEvent.setup();
    await openAttendance(user);

    await user.click(screen.getByRole('button', { name: 'Signed up' }));
    expect(columnValues(1)).toEqual(['Ben Ortiz', 'Zoe Park', 'amy Liu']);
  });
});
