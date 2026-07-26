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

describe('CandidateDashboard deadline card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.token = 'test-token';
    apiClient.get = vi.fn();
  });

  it('shows loading state then the next deadline from applications', async () => {
    apiClient.get.mockResolvedValue([
      {
        id: 'app-1',
        cycle: {
          id: 'cycle-1',
          name: 'Fall 2026',
          resumeDeadline: '2026-10-10',
          coverLetterDeadline: '2026-10-05',
          videoDeadline: '2026-10-15',
        },
      },
    ]);

    renderWithRouter(<CandidateDashboard />);

    expect(screen.getByText(/loading deadline/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/October 5, 2026/)).toBeInTheDocument();
    });

    expect(screen.getByText(/Cover Letter/)).toBeInTheDocument();
    expect(screen.getByText(/Fall 2026/)).toBeInTheDocument();
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

  it('shows "No upcoming deadline posted" when all deadlines are malformed or past', async () => {
    apiClient.get.mockResolvedValue([
      {
        id: 'app-1',
        cycle: {
          id: 'cycle-1',
          name: 'Fall 2026',
          resumeDeadline: 'Oct 4th, Morning',
          coverLetterDeadline: '2020-01-01',
          videoDeadline: null,
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
