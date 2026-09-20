// The communications log, as an admin uses it.
//
// The assertions here are about the questions the log is supposed to answer:
// who was written to, when, what about, and did it arrive.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CommunicationsLog from './CommunicationsLog';
import apiClient from '../../utils/api';

const row = (overrides = {}) => ({
  id: 'log-1',
  channel: 'email',
  category: 'APPLICATION_DECISION',
  trigger: 'AUTOMATED',
  status: 'SENT',
  recipient: 'ryan@example.com',
  recipientName: 'Ryan Kleczynski',
  subject: 'You are through to Round Two',
  bodyPreview: 'Congratulations, we would like to see you again.',
  error: null,
  hasAttachments: false,
  messageLogId: null,
  sentAt: '2026-09-19T17:00:00.000Z',
  triggeredBy: null,
  cycle: { id: 'cycle-1', name: 'Fall 2026' },
  ...overrides,
});

const mockApi = ({ rows = [row()], total = rows.length } = {}) => {
  const get = vi.spyOn(apiClient, 'get').mockImplementation((url) => {
    if (url.includes('/facets')) {
      return Promise.resolve({
        known: { channels: ['email'], categories: ['ACCOUNT'], statuses: ['SENT', 'FAILED'] },
        channels: [{ value: 'email', count: total }],
        categories: [],
        statuses: [],
      });
    }
    return Promise.resolve({ rows, total });
  });
  return get;
};

const urlsFor = (get) => get.mock.calls.map(([url]) => url).filter((u) => !u.includes('/facets'));

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('the log', () => {
  it('shows who was written to, when, and what about', async () => {
    mockApi();
    render(<CommunicationsLog />);

    await screen.findByText('Ryan Kleczynski');
    expect(screen.getByText('ryan@example.com')).toBeInTheDocument();
    expect(screen.getByText('You are through to Round Two')).toBeInTheDocument();
    expect(screen.getByText('Sent')).toBeInTheDocument();
    // Nobody pressed send on this one.
    expect(screen.getByText('System')).toBeInTheDocument();
  });

  // The whole reason this exists: an admin asking why somebody never heard back.
  it('shows a failed send and the reason it failed', async () => {
    mockApi({
      rows: [row({ status: 'FAILED', error: '550 mailbox unavailable' })],
    });
    render(<CommunicationsLog />);

    await screen.findByText('Failed');
    await userEvent.click(screen.getByText('You are through to Round Two'));
    expect(await screen.findByText('550 mailbox unavailable')).toBeInTheDocument();
  });

  // Messages is not ours to watch, and the log must not claim otherwise.
  it('does not claim an iMessage was delivered', async () => {
    mockApi({ rows: [row({ channel: 'imessage', status: 'OPENED', subject: null })] });
    render(<CommunicationsLog />);

    await screen.findByText('Opened');
    expect(screen.getByText('opened, not confirmed sent')).toBeInTheDocument();
  });

  it('opens the message body on a row', async () => {
    mockApi();
    render(<CommunicationsLog />);

    await userEvent.click(await screen.findByText('You are through to Round Two'));

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Congratulations, we would like to see you again.')
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Ryan Kleczynski <ryan@example.com>/)).toBeInTheDocument();
  });

  it('says so plainly when nothing has been sent', async () => {
    mockApi({ rows: [], total: 0 });
    render(<CommunicationsLog />);
    expect(await screen.findByText(/Nothing has been sent yet/)).toBeInTheDocument();
  });
});

describe('filtering', () => {
  it('asks for everything, not just the current cycle', async () => {
    const get = mockApi();
    render(<CommunicationsLog cycleId="cycle-1" cycleName="Fall 2026" />);

    await waitFor(() => expect(urlsFor(get).length).toBeGreaterThan(0));
    expect(urlsFor(get)[0]).not.toContain('cycleId');
  });

  it('narrows to the cycle when asked', async () => {
    const get = mockApi();
    render(<CommunicationsLog cycleId="cycle-1" cycleName="Fall 2026" />);

    await screen.findByText('Ryan Kleczynski');
    await userEvent.click(screen.getByRole('button', { name: 'All cycles' }));

    await waitFor(() => expect(urlsFor(get).some((u) => u.includes('cycleId=cycle-1'))).toBe(true));
  });

  it('debounces typing into the search box into one request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const get = mockApi();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CommunicationsLog />);

    await screen.findByText('Ryan Kleczynski');
    const before = urlsFor(get).length;
    await user.type(screen.getByLabelText('Search recipient or subject'), 'ryan');
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => expect(urlsFor(get).some((u) => u.includes('search=ryan'))).toBe(true));
    // One request for the settled term, not one per keystroke.
    expect(urlsFor(get).length - before).toBe(1);
    vi.useRealTimers();
  });

  it('offers a filter for a status nothing has ever had', async () => {
    mockApi();
    render(<CommunicationsLog />);

    await screen.findByText('Ryan Kleczynski');
    await userEvent.click(screen.getByLabelText('Status'));
    expect(await screen.findByRole('option', { name: 'Failed' })).toBeInTheDocument();
  });
});
