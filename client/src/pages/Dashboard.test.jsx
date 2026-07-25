import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';
import apiClient from '../utils/api';

vi.mock('../components/AccessControl', () => ({
  default: ({ children }) => children,
}));

vi.mock('../context/AuthContext', () => {
  const mockUser = { id: 'admin-1', role: 'ADMIN' };
  return { useAuth: () => ({ user: mockUser }) };
});

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }) => <div data-testid="chart">{children}</div>,
  BarChart: ({ children }) => <div data-testid="bar-chart">{children}</div>,
  Bar: ({ children }) => <>{children}</>,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  PieChart: ({ children }) => <div data-testid="pie-chart">{children}</div>,
  Pie: ({ children }) => <>{children}</>,
  Cell: () => null,
  LabelList: () => null,
}));

function renderWithRouter(element) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

describe('Dashboard demographics UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.token = 'test-token';

    apiClient.get = vi.fn((endpoint) => {
      if (endpoint === '/admin/stats') {
        return Promise.resolve({ totalApplicants: 3, tasks: 0, candidates: 2, currentRound: 'SUBMITTED' });
      }
      if (endpoint === '/admin/cycles/active') {
        return Promise.resolve({ id: 'cycle-1', name: 'Fall 2026', startDate: '2026-08-01', endDate: '2026-12-01' });
      }
      if (endpoint === '/admin/applications') {
        return Promise.resolve([
          { major: 'Computer Science', gender: 'Woman', gpa: '3.85', year: '2027', isTransferStudent: false, isFirstGeneration: true },
          { major: 'Economics', gender: 'Man', gpa: '3.20', year: '2026', isTransferStudent: true, isFirstGeneration: false },
          { major: 'Computer Science', gender: 'Non-binary', gpa: '3.60', year: '2027', isTransferStudent: false, isFirstGeneration: false },
        ]);
      }
      return Promise.resolve([]);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders demographic headings and breakdown chips', async () => {
    renderWithRouter(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Application Demographics' })).toBeInTheDocument();
    });

    expect(await screen.findByText(/3 applications analyzed/i)).toBeInTheDocument();

    // Major chips
    expect(await screen.findByText(/Computer Science: 2/i)).toBeInTheDocument();
    expect(await screen.findByText(/Economics: 1/i)).toBeInTheDocument();

    // GPA chips
    expect(await screen.findByText(/3.5-4.0: 2/i)).toBeInTheDocument();
    expect(await screen.findByText(/3.0-3.4: 1/i)).toBeInTheDocument();

    // Gender chips
    expect(await screen.findByText(/^Woman: 1/i)).toBeInTheDocument();
    expect(await screen.findByText(/^Man: 1/i)).toBeInTheDocument();

    // Year chips
    expect(await screen.findByText(/2027: 2/i)).toBeInTheDocument();
    expect(await screen.findByText(/2026: 1/i)).toBeInTheDocument();

    // Transfer / first gen chips
    expect(await screen.findByText(/^Transfer: 1/i)).toBeInTheDocument();
    expect(await screen.findByText(/^Non-Transfer: 2/i)).toBeInTheDocument();
    expect(await screen.findByText(/^First Generation: 1/i)).toBeInTheDocument();
    expect(await screen.findByText(/^Not First Generation: 2/i)).toBeInTheDocument();
  });

  it('shows empty states when demographic data is not available', async () => {
    apiClient.get = vi.fn((endpoint) => {
      if (endpoint === '/admin/stats') {
        return Promise.resolve({ totalApplicants: 0, tasks: 0, candidates: 0, currentRound: 'SUBMITTED' });
      }
      if (endpoint === '/admin/cycles/active') {
        return Promise.resolve(null);
      }
      if (endpoint === '/admin/applications') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    renderWithRouter(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText('No applications to analyze')).toBeInTheDocument();
    });

    const emptyMessages = [
      'No major data available',
      'No GPA data available',
      'No gender data available',
      'No graduation year data available',
      'No transfer student data available',
      'No first generation data available',
    ];

    for (const message of emptyMessages) {
      expect(await screen.findByText(message)).toBeInTheDocument();
    }
  });

  it('displays a warning when demographic data fails to load', async () => {
    apiClient.get = vi.fn((endpoint) => {
      if (endpoint === '/admin/stats') {
        return Promise.resolve({ totalApplicants: 0, tasks: 0, candidates: 0, currentRound: 'SUBMITTED' });
      }
      if (endpoint === '/admin/cycles/active') {
        return Promise.resolve(null);
      }
      if (endpoint === '/admin/applications') {
        return Promise.reject(new Error('Network error'));
      }
      return Promise.resolve([]);
    });

    renderWithRouter(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load demographic data/i)).toBeInTheDocument();
    });
  });

  it('refetches data when the refresh button is clicked', async () => {
    renderWithRouter(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Application Demographics' })).toBeInTheDocument();
    });

    const refreshButton = screen.getByRole('button', { name: /refresh/i });
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith('/admin/applications');
      expect(apiClient.get).toHaveBeenCalledWith('/admin/stats');
      expect(apiClient.get).toHaveBeenCalledWith('/admin/cycles/active');
    });

    // Each endpoint should be called twice (mount + click)
    expect(apiClient.get).toHaveBeenCalledTimes(6);
  });

  it('aggregates majors beyond the display limit into an Other chip', async () => {
    const applications = Array.from({ length: 10 }, (_, i) => ({
      major: `Major ${i}`,
      gender: 'Woman',
      gpa: '3.50',
      year: '2027',
      isTransferStudent: false,
      isFirstGeneration: false,
    }));

    apiClient.get = vi.fn((endpoint) => {
      if (endpoint === '/admin/stats') {
        return Promise.resolve({ totalApplicants: 10, tasks: 0, candidates: 10, currentRound: 'SUBMITTED' });
      }
      if (endpoint === '/admin/cycles/active') {
        return Promise.resolve(null);
      }
      if (endpoint === '/admin/applications') {
        return Promise.resolve(applications);
      }
      return Promise.resolve([]);
    });

    renderWithRouter(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText('10 applications analyzed')).toBeInTheDocument();
    });

    // Top 7 majors displayed individually (10% each)
    for (let i = 0; i < 7; i++) {
      expect(await screen.findByText(new RegExp(`^Major ${i}: 1`, 'i'))).toBeInTheDocument();
    }

    // Remaining 3 majors are aggregated as Other (30%)
    expect(await screen.findByText(/^Other: 3 \(30%\)/i)).toBeInTheDocument();

    // Hidden majors should not appear as separate chips
    expect(screen.queryByText(/^Major 7: 1/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Major 9: 1/i)).not.toBeInTheDocument();
  });
});
