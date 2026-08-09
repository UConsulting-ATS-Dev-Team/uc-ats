import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import apiClient from '../utils/api';

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

// Each snapshot carries the server's monotonic stamp for the candidate read.
function snapshot({ candidates, snapshotVersion }) {
  return (endpoint) => {
    switch (endpoint) {
      case '/admin/staging/candidates':
        return Promise.resolve({ candidates, snapshotVersion });
      case '/admin/cycles/active':
        return Promise.resolve({ id: 'cycle-1', name: 'Fall 2026' });
      case '/admin/applications':
        return Promise.resolve({ applications: [] });
      case '/admin/events':
        return Promise.resolve([]);
      case '/admin/review-teams':
        return Promise.resolve([]);
      case '/admin/existing-decisions':
        return Promise.resolve({ perRoundDecisions: { resume: {}, coffee: {}, firstRound: {}, final: {} } });
      default:
        return Promise.resolve([]);
    }
  };
}

async function renderStaging() {
  // The page keeps a module-level snapshot cache, so reload it per test.
  vi.resetModules();
  const { default: Staging } = await import('./Staging');
  render(
    <MemoryRouter>
      <Staging />
    </MemoryRouter>
  );
  await screen.findByText('Alice Example');
}

describe('Staging sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockImplementation(snapshot({ candidates: [candidate('c1', 'Alice')], snapshotVersion: 200 }));
  });

  it('keeps the last successful snapshot on screen when a poll fails', async () => {
    await renderStaging();
    expect(screen.getByText(/^Synced /)).toBeInTheDocument();

    apiClient.get.mockImplementation((endpoint) =>
      endpoint === '/admin/staging/candidates'
        ? Promise.reject(new Error('Failed to load staging candidates'))
        : snapshot({ candidates: [], snapshotVersion: 300 })(endpoint)
    );

    fireEvent.click(screen.getByLabelText('Refresh staging data'));

    await waitFor(() => expect(screen.getByText('Sync failing — retrying')).toBeInTheDocument());
    expect(screen.getByText('Alice Example')).toBeInTheDocument();
  });

  it('rejects a snapshot the server read before the one already applied', async () => {
    await renderStaging();

    apiClient.get.mockImplementation(
      snapshot({ candidates: [candidate('c2', 'Bob')], snapshotVersion: 100 })
    );

    fireEvent.click(screen.getByLabelText('Refresh staging data'));

    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith('/admin/staging/candidates', expect.anything())
    );
    await waitFor(() => expect(screen.queryByText('Bob Example')).not.toBeInTheDocument());
    expect(screen.getByText('Alice Example')).toBeInTheDocument();
  });

  it('applies a snapshot the server read after the one already applied', async () => {
    await renderStaging();

    apiClient.get.mockImplementation(
      snapshot({ candidates: [candidate('c2', 'Bob')], snapshotVersion: 300 })
    );

    fireEvent.click(screen.getByLabelText('Refresh staging data'));

    await screen.findByText('Bob Example');
    expect(screen.queryByText('Alice Example')).not.toBeInTheDocument();
  });
});
