import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import AccountabilityTracker from './AccountabilityTracker';
import apiClient from '../utils/api';
import { useAuth } from '../context/AuthContext';

// Four requests stand between render and the chat; the default 1s is too
// tight when the whole suite is running.
const slow = { timeout: 5000 };

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

const cycle = { id: 'cycle-1', name: 'Fall 2026', isActive: true };

const event = (overrides) => ({
  id: 'event-1',
  eventName: 'Info Night',
  eventStartDate: '2026-10-01T02:00:00.000Z',
  memberRsvpCount: 2,
  memberAttendanceCount: 0,
  pointType: null,
  memberAttendanceForm: null,
  ...overrides,
});

const accountability = (events) => ({
  cycle,
  config: { targetPoints: 3, types: [], eventPointTypes: [] },
  reminderDefaults: { subject: '', message: '', mergeFields: [] },
  leaderboard: [],
  events,
});

const members = [
  { id: 'm1', fullName: 'Alice Smith', email: 'alice@example.com', rsvpd: true, attended: false },
  { id: 'm2', fullName: 'Bob Jones', email: 'bob@example.com', rsvpd: true, attended: true },
  { id: 'm3', fullName: 'Carol White', email: 'carol@example.com', rsvpd: false, attended: false },
];

function mockApiClient(events) {
  apiClient.get = vi.fn((endpoint) => {
    if (endpoint === '/admin/cycles') return Promise.resolve([cycle]);
    if (endpoint.startsWith('/admin/accountability?')) return Promise.resolve(accountability(events));
    if (endpoint === '/admin/accountability/events/event-1/members') return Promise.resolve({ members });
    if (endpoint === '/master-communications/imessage/members') {
      return Promise.resolve({ members: members.map((m) => ({ ...m, phoneNumber: '+13105551234' })) });
    }
    return Promise.resolve([]);
  });
}

describe('AccountabilityTracker event iMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuth.mockReturnValue({ user: { id: 'admin-1', role: 'ADMIN' } });
  });

  afterEach(cleanup);

  it("opens an iMessage with only the event's RSVP'd members in the chat", async () => {
    mockApiClient([event()]);
    render(<AccountabilityTracker />);

    fireEvent.click(await screen.findByRole('button', { name: 'iMessage RSVPs' }, slow));

    const dialog = within(await screen.findByRole('dialog', {}, slow));
    expect(dialog.getByText("Send iMessage to RSVP'd members")).toBeInTheDocument();
    expect(await dialog.findByText('Alice Smith', {}, slow)).toBeInTheDocument();
    expect(dialog.getByText('Bob Jones')).toBeInTheDocument();
    expect(dialog.queryByText('Carol White')).not.toBeInTheDocument();
    expect(dialog.getByText('2 recipients')).toBeInTheDocument();
  });

  it('is disabled for an event nobody has RSVP’d to', async () => {
    mockApiClient([event({ memberRsvpCount: 0 })]);
    render(<AccountabilityTracker />);

    expect(await screen.findByRole('button', { name: 'iMessage RSVPs' }, slow)).toBeDisabled();
  });
});
