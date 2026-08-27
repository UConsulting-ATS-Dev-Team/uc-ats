import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CandidateDashboard from './CandidateDashboard';
import apiClient from '../utils/api';

vi.mock('../components/AccessControl', () => ({
  default: ({ children }) => children,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user-1', role: 'USER', fullName: 'Test Candidate' } }),
}));

function renderWithRouter(element) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

describe('CandidateDashboard application deadline card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.token = 'test-token';
    apiClient.get = vi.fn();
  });

  it('shows loading state then the application deadline from the cycle endDate', async () => {
    apiClient.get.mockResolvedValue([
      {
        id: 'app-1',
        cycle: {
          id: 'cycle-1',
          name: 'Fall 2026',
          endDate: '2026-10-05T00:00:00.000Z',
        },
      },
    ]);
    // The card reads the open cycle now, not this candidate's applications.
    apiClient.get.mockResolvedValue({
      cycle: { id: 'cycle-1', name: 'Fall 2026', endDate: '2026-10-05T00:00:00.000Z' },
    });

    renderWithRouter(<CandidateDashboard />);

    expect(screen.getByText(/loading deadline/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/Application deadline/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Fall 2026/i)).toBeInTheDocument();
    expect(screen.getByText(/PDT|PST/)).toBeInTheDocument();
  });

  it('shows "No upcoming deadline posted" when the API returns no applications', async () => {
    apiClient.get.mockRejectedValue(new Error('Not found'));

    renderWithRouter(<CandidateDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/No upcoming deadline posted/i)).toBeInTheDocument();
    });

    // Dashboard quick actions remain visible
    expect(screen.getByText(/Quick Actions/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'View Events' })).toBeInTheDocument();
  });

  it('shows "No upcoming deadline posted" when the cycle endDate is malformed or past', async () => {
    apiClient.get.mockResolvedValue([
      {
        id: 'app-1',
        cycle: {
          id: 'cycle-1',
          name: 'Fall 2026',
          endDate: 'Oct 4th, Morning',
        },
      },
      {
        id: 'app-2',
        cycle: {
          id: 'cycle-2',
          name: 'Old Cycle',
          endDate: '2020-01-01T00:00:00.000Z',
        },
      },
    ]);

    renderWithRouter(<CandidateDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/No upcoming deadline posted/i)).toBeInTheDocument();
    });
  });

  it('preserves the rest of the dashboard while the deadline is loading', async () => {
    apiClient.get.mockResolvedValue([]);

    renderWithRouter(<CandidateDashboard />);

    expect(screen.getByText(/Welcome, Test Candidate!/i)).toBeInTheDocument();
    expect(screen.getByText(/Quick Actions/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/No upcoming deadline posted/i)).toBeInTheDocument();
    });
  });
});

describe('which deadline the card shows', () => {
  it('shows the cycle open to candidates, not one they already applied to', async () => {
    // Regression: a candidate with a Winter 2026 application saw that cycle's
    // deadline even after Fall 2026 was made the candidate-active cycle,
    // because the card scanned their own applications.
    apiClient.get.mockResolvedValue({
      cycle: { id: 'fall', name: 'Fall 2026', endDate: '2026-10-10T00:00:00.000Z' },
    });

    renderWithRouter(<CandidateDashboard />);

    await waitFor(() => expect(screen.getByText(/Fall 2026/i)).toBeInTheDocument());
    expect(screen.queryByText(/Winter 2026/i)).not.toBeInTheDocument();
  });

  it('asks for the open cycle rather than the applications list', async () => {
    apiClient.get.mockResolvedValue({ cycle: null });
    renderWithRouter(<CandidateDashboard />);

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/active-cycle'));
    expect(apiClient.get.mock.calls.some(([url]) => url.includes('my-applications'))).toBe(false);
  });

  it('shows nothing when no cycle is open', async () => {
    apiClient.get.mockResolvedValue({ cycle: null });
    renderWithRouter(<CandidateDashboard />);
    await waitFor(() =>
      expect(screen.getByText(/No upcoming deadline posted/i)).toBeInTheDocument()
    );
  });

  it('shows nothing when the open cycle deadline has passed', async () => {
    apiClient.get.mockResolvedValue({
      cycle: { id: 'old', name: 'Fall 2025', endDate: '2025-10-11T00:00:00.000Z' },
    });
    renderWithRouter(<CandidateDashboard />);
    await waitFor(() =>
      expect(screen.getByText(/No upcoming deadline posted/i)).toBeInTheDocument()
    );
  });
});
