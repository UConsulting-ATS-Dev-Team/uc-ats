import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import apiClient from '../utils/api';
import stagingCache from '../utils/stagingCache';
import Staging from './Staging';

vi.mock('../components/AccessControl', () => ({
  default: ({ children }) => children,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'admin-1', role: 'ADMIN', fullName: 'Test Admin' } }),
}));

vi.mock('../context/CelebrationContext', () => ({
  useCelebration: () => ({ triggerCelebration: vi.fn() }),
}));

vi.mock('../components/AuthenticatedImage', () => ({
  default: () => null,
}));

vi.mock('../components/DocumentPreviewModal', () => ({
  default: () => null,
}));

vi.mock('./ApplicationDetail', () => ({
  default: () => null,
}));

vi.mock('../utils/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    setToken: vi.fn(),
    token: '',
  },
}));

function candidate(id, firstName) {
  return {
    id,
    candidateId: id,
    firstName,
    lastName: 'Example',
    email: `${firstName.toLowerCase()}@example.com`,
    status: 'SUBMITTED',
    currentRound: 1,
    attendance: {},
    scores: {},
    decisions: {},
    graduationYear: '2027',
    gender: 'Female',
  };
}

// The page reads two endpoints: a cheap change token, and -- only when that token has
// moved -- one snapshot whose resources all come from a single database transaction
// stamped with `snapshotVersion`. The token defaults to the snapshot version so that
// different data implies a different token, which is what these tests usually want.
function snapshot(options) {
  const { candidates, snapshotVersion } = options;
  // `in`, not `??`: an explicitly null token is a case worth testing and must not be
  // quietly replaced by the default.
  const changeToken = 'changeToken' in options ? options.changeToken : String(snapshotVersion);
  return (endpoint) => {
    if (endpoint === '/admin/staging/version') {
      return Promise.resolve({ changeToken });
    }
    if (endpoint === '/admin/staging/snapshot') {
      return Promise.resolve({
        snapshotVersion,
        candidates,
        activeCycle: { id: 'cycle-1', name: 'Fall 2026' },
        applications: [],
        events: [],
        reviewTeams: [],
        perRoundDecisions: { resume: {}, coffee: {}, firstRound: {}, final: {} },
      });
    }
    return Promise.resolve([]);
  };
}

// Only snapshot reads are interesting to count: token reads happen every tick.
function snapshotCallCount() {
  return apiClient.get.mock.calls.filter(([endpoint]) => endpoint === '/admin/staging/snapshot').length;
}

async function renderStaging() {
  render(
    <MemoryRouter>
      <Staging />
    </MemoryRouter>
  );
}

describe('Staging sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The first-paint cache outlives a render, so every test starts from an empty one.
    stagingCache.invalidate();
    apiClient.get.mockImplementation(snapshot({ candidates: [candidate('c1', 'Alice')], snapshotVersion: 200 }));
  });

  afterEach(() => {
    cleanup();
    stagingCache.invalidate();
  });

  it('keeps the last successful snapshot on screen when a poll fails', async () => {
    await renderStaging();
    await screen.findByText('Alice Example');
    expect(screen.getByText(/^Synced /)).toBeInTheDocument();

    apiClient.get.mockImplementation(() =>
      Promise.reject(new Error('Failed to load staging snapshot'))
    );

    fireEvent.click(screen.getByLabelText('Refresh staging data'));

    await waitFor(() => expect(screen.getByText('Sync failing — retrying')).toBeInTheDocument());
    expect(screen.getByText('Alice Example')).toBeInTheDocument();
  });

  it('does not re-read the snapshot while the change token stands still', async () => {
    await renderStaging();
    await screen.findByText('Alice Example');
    expect(snapshotCallCount()).toBe(1);

    // Same token, different candidates: if the page ignored the token it would fetch
    // this and Bob would appear. The whole point is that it does not.
    apiClient.get.mockImplementation(
      snapshot({ candidates: [candidate('c2', 'Bob')], snapshotVersion: 400, changeToken: '200' })
    );

    fireEvent.click(screen.getByLabelText('Refresh staging data'));

    await waitFor(() => expect(screen.getByText(/^Synced /)).toBeInTheDocument());
    expect(snapshotCallCount()).toBe(1);
    expect(screen.queryByText('Bob Example')).not.toBeInTheDocument();
    expect(screen.getByText('Alice Example')).toBeInTheDocument();
  });

  it('re-reads the snapshot as soon as the change token moves', async () => {
    await renderStaging();
    await screen.findByText('Alice Example');
    expect(snapshotCallCount()).toBe(1);

    apiClient.get.mockImplementation(
      snapshot({ candidates: [candidate('c2', 'Bob')], snapshotVersion: 400, changeToken: '201' })
    );

    fireEvent.click(screen.getByLabelText('Refresh staging data'));

    await screen.findByText('Bob Example');
    expect(snapshotCallCount()).toBe(2);
  });

  it('reads the snapshot when the server cannot report a change token', async () => {
    await renderStaging();
    await screen.findByText('Alice Example');

    // An absent token must not be mistaken for an unchanged one: unknown means fetch,
    // otherwise a token outage would freeze every console on its current snapshot.
    apiClient.get.mockImplementation(
      snapshot({ candidates: [candidate('c2', 'Bob')], snapshotVersion: 400, changeToken: null })
    );

    fireEvent.click(screen.getByLabelText('Refresh staging data'));

    await screen.findByText('Bob Example');
    expect(snapshotCallCount()).toBe(2);
  });

  it('rejects a snapshot the database read before the one already applied', async () => {
    await renderStaging();
    await screen.findByText('Alice Example');

    apiClient.get.mockImplementation(
      snapshot({ candidates: [candidate('c2', 'Bob')], snapshotVersion: 100 })
    );

    fireEvent.click(screen.getByLabelText('Refresh staging data'));

    await waitFor(() => expect(snapshotCallCount()).toBe(2));
    await waitFor(() => expect(screen.queryByText('Bob Example')).not.toBeInTheDocument());
    expect(screen.getByText('Alice Example')).toBeInTheDocument();
  });

  it('applies a snapshot the database read after the one already applied', async () => {
    await renderStaging();
    await screen.findByText('Alice Example');

    apiClient.get.mockImplementation(
      snapshot({ candidates: [candidate('c2', 'Bob')], snapshotVersion: 300 })
    );

    fireEvent.click(screen.getByLabelText('Refresh staging data'));

    await screen.findByText('Bob Example');
    expect(screen.queryByText('Alice Example')).not.toBeInTheDocument();
  });

  it('rejects a snapshot older than the cached one it remounted with', async () => {
    apiClient.get.mockImplementation(
      snapshot({ candidates: [candidate('c1', 'Alice')], snapshotVersion: 300 })
    );
    await renderStaging();
    await screen.findByText('Alice Example');

    // Leave and come back: the page paints from the cache, so version 300 is on screen
    // even though this poller has fetched nothing yet.
    cleanup();
    apiClient.get.mockImplementation(
      snapshot({ candidates: [candidate('c2', 'Bob')], snapshotVersion: 100 })
    );
    await renderStaging();
    await screen.findByText('Alice Example');

    fireEvent.click(screen.getByLabelText('Refresh staging data'));

    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith('/admin/staging/snapshot', expect.anything())
    );
    await waitFor(() => expect(screen.queryByText('Bob Example')).not.toBeInTheDocument());
    expect(screen.getByText('Alice Example')).toBeInTheDocument();
  });
});

describe('Staging table', () => {
  const scored = (id, firstName, overall) => ({ ...candidate(id, firstName), scores: { overall } });

  beforeEach(() => {
    vi.clearAllMocks();
    stagingCache.invalidate();
    apiClient.get.mockImplementation(snapshot({
      candidates: [scored('c1', 'Alice', 18), scored('c2', 'Bob', 20), scored('c3', 'Cara', 18), scored('c4', 'Dan', 0)],
      snapshotVersion: 300,
    }));
  });

  afterEach(() => {
    cleanup();
    stagingCache.invalidate();
  });

  const rankOf = (name) => screen.getByText(name).closest('tr').querySelector('.staging-rank').textContent;

  it('numbers each row by score rank, ties sharing one, unscored left blank', async () => {
    await renderStaging();
    await screen.findByText('Alice Example');

    expect(rankOf('Bob Example')).toBe('1');
    expect(rankOf('Alice Example')).toBe('2');
    expect(rankOf('Cara Example')).toBe('2');
    expect(rankOf('Dan Example')).toBe('—');
  });

  it('keeps the score rank when the list is sorted by name', async () => {
    await renderStaging();
    await screen.findByText('Alice Example');

    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'name' } });

    expect(rankOf('Bob Example')).toBe('1');
    expect(rankOf('Cara Example')).toBe('2');
  });

  it('shows a decision at once and saves it without re-reading the snapshot', async () => {
    apiClient.post.mockResolvedValue({ success: true });
    await renderStaging();
    await screen.findByText('Alice Example');
    const reads = snapshotCallCount();

    const select = screen.getByLabelText('Decision for Alice Example');
    fireEvent.change(select, { target: { value: 'yes' } });

    expect(select.value).toBe('yes');
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/admin/save-decision', {
      candidateId: 'c1', decision: 'yes', phase: 'resume',
    }));
    expect(snapshotCallCount()).toBe(reads);
  });

  it('puts the decision back and says so when the save fails', async () => {
    apiClient.post.mockRejectedValue(new Error('network down'));
    await renderStaging();
    await screen.findByText('Alice Example');

    const select = screen.getByLabelText('Decision for Alice Example');
    fireEvent.change(select, { target: { value: 'no' } });

    await screen.findByText(/Could not save the decision for Alice Example/);
    expect(select.value).toBe('');
  });
});
