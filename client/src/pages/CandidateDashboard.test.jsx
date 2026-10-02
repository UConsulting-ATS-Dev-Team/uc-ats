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

  it('shows loading state then the application deadline from the cycle', async () => {
    // The card reads the open cycle now, not this candidate's applications.
    apiClient.get.mockResolvedValue({
      cycle: { id: 'cycle-1', name: 'Fall 2026', applicationDeadline: '2099-10-02T06:59:00.000Z' },
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

  it('shows "No upcoming deadline posted" when the application deadline is malformed', async () => {
    apiClient.get.mockResolvedValue({
      cycle: { id: 'cycle-1', name: 'Fall 2026', applicationDeadline: 'Oct 4th, Morning' },
    });

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
      cycle: { id: 'fall', name: 'Fall 2026', applicationDeadline: '2099-10-02T06:59:00.000Z' },
    });

    renderWithRouter(<CandidateDashboard />);

    await waitFor(() => expect(screen.getByText(/Fall 2026/i)).toBeInTheDocument());
    expect(screen.queryByText(/Winter 2026/i)).not.toBeInTheDocument();
  });

  it('shows when applications close, not when the cycle ends', async () => {
    // Regression: Fall 2026 applications close Oct 1 at 11:59 PM, but the card
    // showed Oct 11, the cycle's endDate.
    apiClient.get.mockResolvedValue({
      cycle: {
        id: 'fall',
        name: 'Fall 2099',
        endDate: '2099-10-11T00:00:00.000Z',
        applicationDeadline: '2099-10-02T06:59:00.000Z',
      },
    });

    renderWithRouter(<CandidateDashboard />);

    await waitFor(() =>
      expect(screen.getByText(/October 1, 2099 at 11:59 PM PDT/)).toBeInTheDocument()
    );
    expect(screen.queryByText(/October 11/)).not.toBeInTheDocument();
  });

  it('never falls back to endDate when no application deadline is set', async () => {
    apiClient.get.mockResolvedValue({
      cycle: { id: 'fall', name: 'Fall 2099', endDate: '2099-10-11T00:00:00.000Z', applicationDeadline: null },
    });

    renderWithRouter(<CandidateDashboard />);

    await waitFor(() =>
      expect(screen.getByText(/No upcoming deadline posted/i)).toBeInTheDocument()
    );
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

  it('links "Apply Here" to the Google Form when the candidate has not applied', async () => {
    apiClient.get.mockImplementation(async (url) => {
      if (url === '/active-cycle') {
        return {
          cycle: {
            id: 'cycle-1',
            name: 'Fall 2026',
            applicationDeadline: '2099-10-02T06:59:00.000Z',
            applyUrl: 'https://docs.google.com/forms/d/abc123/viewform',
          },
        };
      }
      throw new Error('Candidate not found for this user');
    });
    renderWithRouter(<CandidateDashboard />);

    const link = await screen.findByRole('link', { name: /apply here/i });
    expect(link).toHaveAttribute('href', 'https://docs.google.com/forms/d/abc123/viewform');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText(/Opens the application Google Form/)).toBeInTheDocument();
  });

  it('hides "Apply Here" from a candidate who already applied this cycle', async () => {
    apiClient.get.mockImplementation(async (url) => {
      if (url === '/active-cycle') {
        return {
          cycle: {
            id: 'cycle-1',
            name: 'Fall 2026',
            applicationDeadline: '2099-10-02T06:59:00.000Z',
            applyUrl: 'https://docs.google.com/forms/d/abc123/viewform',
          },
        };
      }
      return [{ id: 'app-1', cycle: { id: 'cycle-1', name: 'Fall 2026' } }];
    });
    renderWithRouter(<CandidateDashboard />);

    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith('/applications/my-applications')
    );
    expect(screen.queryByRole('link', { name: /apply here/i })).not.toBeInTheDocument();
  });

  it('hides "Apply Here" when the applications lookup fails for another reason', async () => {
    apiClient.get.mockImplementation(async (url) => {
      if (url === '/active-cycle') {
        return {
          cycle: {
            id: 'cycle-1',
            name: 'Fall 2026',
            applicationDeadline: '2099-10-02T06:59:00.000Z',
            applyUrl: 'https://docs.google.com/forms/d/abc123/viewform',
          },
        };
      }
      throw new Error('Internal server error');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderWithRouter(<CandidateDashboard />);

    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith('/applications/my-applications')
    );
    await waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /apply here/i })).not.toBeInTheDocument();
  });

  it('shows nothing when the open cycle deadline has passed', async () => {
    apiClient.get.mockResolvedValue({
      cycle: { id: 'old', name: 'Fall 2025', applicationDeadline: '2025-10-02T06:59:00.000Z' },
    });
    renderWithRouter(<CandidateDashboard />);
    await waitFor(() =>
      expect(screen.getByText(/No upcoming deadline posted/i)).toBeInTheDocument()
    );
  });
});
