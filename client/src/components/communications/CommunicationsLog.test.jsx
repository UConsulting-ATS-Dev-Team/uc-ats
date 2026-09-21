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

// Greptile caught this: "Load more" used to grow `limit`, which the server caps
// at 200, so once the log passed 200 rows the button returned the same first
// 200 forever and older messages could not be reached at all.
describe('paging through a long log', () => {
  const page = (n, size = 2) =>
    Array.from({ length: size }, (_, i) =>
      row({ id: `log-${n}-${i}`, subject: `page ${n} item ${i}` })
    );

  const mockPages = () =>
    vi.spyOn(apiClient, 'get').mockImplementation((url) => {
      if (url.includes('/facets')) {
        return Promise.resolve({
          known: { channels: ['email'], categories: [], statuses: ['SENT', 'FAILED'] },
          channels: [],
          categories: [],
          statuses: [],
        });
      }
      const offset = Number(new URL(url, 'http://x').searchParams.get('offset') || 0);
      return Promise.resolve({ rows: page(offset), total: 6, offset });
    });

  it('asks for the next offset rather than a bigger page', async () => {
    const get = mockPages();
    render(<CommunicationsLog />);

    await screen.findByText('page 0 item 0');
    await userEvent.click(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() => expect(urlsFor(get).some((u) => u.includes('offset=2'))).toBe(true));
    // The page size stays fixed; only the offset moves.
    expect(urlsFor(get).every((u) => u.includes(`limit=50`))).toBe(true);
  });

  it('appends the next page instead of replacing what is shown', async () => {
    mockPages();
    render(<CommunicationsLog />);

    await screen.findByText('page 0 item 0');
    await userEvent.click(screen.getByRole('button', { name: /load more/i }));

    expect(await screen.findByText('page 2 item 0')).toBeInTheDocument();
    // The first page is still there.
    expect(screen.getByText('page 0 item 0')).toBeInTheDocument();
  });

  it('starts again from the top when a filter changes', async () => {
    const get = mockPages();
    render(<CommunicationsLog />);

    await screen.findByText('page 0 item 0');
    await userEvent.click(screen.getByRole('button', { name: /load more/i }));
    await screen.findByText('page 2 item 0');

    await userEvent.click(screen.getByLabelText('Status'));
    await userEvent.click(await screen.findByRole('option', { name: 'Failed' }));

    await waitFor(() => expect(urlsFor(get).some((u) => u.includes('status=FAILED'))).toBe(true));
    const last = urlsFor(get).at(-1);
    expect(last).toContain('offset=0');
  });
});

// Greptile, iteration 2: changing a filter while "Load more" was in flight
// appended that older page to the new query's rows, so the list showed messages
// the filters exclude.
describe('a slow page that lands after the filters moved on', () => {
  it('is discarded rather than mixed into the new results', async () => {
    let releaseSlowPage;
    const slowPage = new Promise((resolve) => {
      releaseSlowPage = resolve;
    });

    vi.spyOn(apiClient, 'get').mockImplementation(async (url) => {
      if (url.includes('/facets')) {
        return {
          known: { channels: [], categories: [], statuses: ['SENT', 'FAILED'] },
          channels: [],
          categories: [],
          statuses: [],
        };
      }
      if (url.includes('offset=1') && !url.includes('status=')) {
        await slowPage;
        return { rows: [row({ id: 'stale', subject: 'stale page' })], total: 2, offset: 1 };
      }
      if (url.includes('status=FAILED')) {
        return { rows: [row({ id: 'fresh', subject: 'fresh page' })], total: 1, offset: 0 };
      }
      return { rows: [row({ id: 'first', subject: 'first page' })], total: 2, offset: 0 };
    });

    render(<CommunicationsLog />);
    await screen.findByText('first page');

    // Start the slow next page, then change a filter before it comes back.
    await userEvent.click(screen.getByRole('button', { name: /load more/i }));
    await userEvent.click(screen.getByLabelText('Status'));
    await userEvent.click(await screen.findByRole('option', { name: 'Failed' }));
    await screen.findByText('fresh page');

    releaseSlowPage();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText('stale page')).not.toBeInTheDocument();
    expect(screen.getByText('fresh page')).toBeInTheDocument();
  });
});
