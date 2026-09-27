import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import AdminAnalytics from './AdminAnalytics';
import apiClient from '../utils/api';

// recharts measures its container, which jsdom cannot do.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ResponsiveContainer: ({ children }) => <div style={{ width: 800, height: 260 }}>{children}</div> };
});

const mockUseAuth = vi.fn();
vi.mock('../context/AuthContext', () => ({ useAuth: () => mockUseAuth() }));

const metrics = (n) => ({
  activeUsers: n,
  sessions: n,
  pageViews: n * 10,
  clicks: n,
  apiRequests: n * 100,
  apiP50Ms: 80,
  apiP95Ms: 400,
  errors5xx: 1,
  errorRate: 0.01,
  jsErrors: 0,
  serverErrors: 0,
  securityFlags: 0,
});

const OVERVIEW = {
  days: 30,
  today: '2026-09-27',
  dataThrough: '2026-09-26',
  tiles: {
    ALL: { today: metrics(3), yesterday: metrics(12), previous: metrics(10) },
    MEMBER: { today: metrics(2), yesterday: metrics(8), previous: metrics(7) },
  },
  series: [
    { day: '2026-09-26', partial: false, activeUsers: { MEMBER: 8 }, errors5xx: 1, serverErrors: 0, jsErrors: 0 },
    { day: '2026-09-27', partial: true, activeUsers: { MEMBER: 2 }, errors5xx: 0, serverErrors: 0, jsErrors: 0 },
  ],
  attention: [{ type: 'new_error', severity: 'error', tab: 'errors', label: 'New server error (3×): connection refused', detail: 'Route /api/x' }],
};

const ERRORS = {
  days: 30,
  today: '2026-09-27',
  dataThrough: '2026-09-26',
  retentionDays: { server: 30, requests: 14, client: 30 },
  perDay: [],
  server: [
    {
      fingerprint: 'fp1',
      count: 3,
      firstSeen: '2026-09-27T10:00:00Z',
      lastSeen: '2026-09-27T12:00:00Z',
      sample: { message: '[GET /api/x] connection refused', stack: 'Error: connection refused\n    at x.js:1', route: '/api/x', status: 500, source: 'console' },
    },
  ],
  failingRoutes: [],
  client: [],
  api: [],
  slowApi: [],
};

const renderAt = (url) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <AdminAnalytics />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.restoreAllMocks();
  mockUseAuth.mockReturnValue({ user: { id: 'a1', role: 'ADMIN' } });
  vi.spyOn(apiClient, 'get').mockImplementation((url) => {
    if (url.startsWith('/admin/analytics/overview')) return Promise.resolve(OVERVIEW);
    if (url.startsWith('/admin/analytics/errors')) return Promise.resolve(ERRORS);
    return Promise.reject(new Error(`unexpected ${url}`));
  });
});

describe('AdminAnalytics', () => {
  it('opens on the overview with what needs attention', async () => {
    renderAt('/admin/analytics');
    expect(await screen.findByText('New server error (3×): connection refused')).toBeInTheDocument();
    expect(screen.getByText('Rolled up through Sep 26; today is live.', { exact: false })).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith('/admin/analytics/overview?days=30');
  });

  it('deep-links to a tab and range', async () => {
    renderAt('/admin/analytics?tab=errors&days=7');
    // Once in the accordion's summary, once in its body.
    expect((await screen.findAllByText('[GET /api/x] connection refused')).length).toBeGreaterThan(0);
    expect(apiClient.get).toHaveBeenCalledWith('/admin/analytics/errors?days=7');
  });

  it('jumps from an attention item to its tab', async () => {
    renderAt('/admin/analytics');
    await userEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/admin/analytics/errors?days=30'));
  });

  it('runs a rollup on demand and says what it did', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValue({ days: ['2026-09-26', '2026-09-25'], ms: 42 });
    renderAt('/admin/analytics');
    await screen.findByText('New server error (3×): connection refused');
    await userEvent.click(screen.getByRole('button', { name: 'Run rollup now' }));
    expect(apiClient.post).toHaveBeenCalledWith('/admin/analytics/rollup', {});
    expect(await screen.findByText('Rolled up Sep 26 and Sep 25 in 42 ms.')).toBeInTheDocument();
  });

  it('shows the load error instead of an empty page', async () => {
    apiClient.get.mockRejectedValue(Object.assign(new Error('x'), { serverMessage: 'Could not load analytics' }));
    renderAt('/admin/analytics');
    expect(await screen.findByText('Could not load analytics')).toBeInTheDocument();
  });

  it('turns members away', () => {
    mockUseAuth.mockReturnValue({ user: { id: 'm1', role: 'MEMBER' } });
    renderAt('/admin/analytics');
    expect(screen.getByText('Access Denied')).toBeInTheDocument();
    expect(apiClient.get).not.toHaveBeenCalled();
  });
});
