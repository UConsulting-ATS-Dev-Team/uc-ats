import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AdminInterviews from './AdminInterviews';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('../components/AccessControl', () => ({
  default: ({ children }) => <>{children}</>,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'a1', role: 'ADMIN', fullName: 'Ryan K' } }),
}));

const stats = (overrides = {}) => ({
  eligible: 0,
  sessions: 0,
  bookableSessions: 0,
  seats: 0,
  confirmed: 0,
  waitlisted: 0,
  needsPlacement: 0,
  unassigned: 0,
  interviewers: 0,
  ...overrides,
});

const round = (overrides = {}) => ({
  round: 1,
  label: 'Coffee Chats',
  interviewType: 'COFFEE_CHAT',
  interviews: [],
  slots: [],
  unassigned: [],
  stats: stats(),
  ...overrides,
});

const withOverview = (rounds) =>
  apiClient.get.mockImplementation((endpoint) => {
    if (endpoint === '/admin/scheduling/overview') {
      return Promise.resolve({ cycle: { id: 'c1', name: 'Fall 2026' }, rounds, notifications: {}, emailsEnabled: true });
    }
    return Promise.resolve([]);
  });

const renderPage = () =>
  render(
    <MemoryRouter>
      <AdminInterviews />
    </MemoryRouter>
  );

describe('AdminInterviews round setup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows one empty state, and no tabs, for a round with no interview', async () => {
    withOverview([round()]);
    renderPage();

    expect(await screen.findByText('No coffee chats yet')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Sessions' })).not.toBeInTheDocument();
    expect(screen.queryByText(/no sessions yet/i)).not.toBeInTheDocument();
  });

  it('opens the create dialog on the round of the tab it came from', async () => {
    withOverview([round(), round({ round: 2, label: 'First Round Interviews', interviewType: 'ROUND_ONE' })]);
    renderPage();

    await userEvent.click(await screen.findByRole('tab', { name: /first round interviews/i }));
    await userEvent.click(screen.getByRole('button', { name: /create the interview/i }));

    expect(await screen.findByLabelText(/^round/i)).toHaveTextContent('First Round');
  });

  it('reads readiness as one line and hides booking counts that are zero', async () => {
    withOverview([
      round({
        interviews: [{ id: 'iv1', title: 'W27 Coffee Chats' }],
        stats: stats({ eligible: 12, sessions: 2, bookableSessions: 2, seats: 40, interviewers: 3, confirmed: 5 }),
      }),
    ]);
    renderPage();

    expect(await screen.findByTestId('round-readiness')).toHaveTextContent(
      '12 in this round · 40 seats in 2 open sessions · 3 interviewers'
    );
    expect(screen.getByText('Everyone fits')).toBeInTheDocument();
    expect(screen.getByText('5 scheduled')).toBeInTheDocument();
    expect(screen.queryByText('0 waitlisted')).not.toBeInTheDocument();
    expect(screen.queryByText('0 not scheduled')).not.toBeInTheDocument();
    // Setup lives in the panel now; there is no separate tab for it.
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Coffee Chats', 'Sessions', 'Interviewers', 'Signups']);
  });

  it('says how many seats short a round is', async () => {
    withOverview([
      round({
        interviews: [{ id: 'iv1', title: 'W27 Coffee Chats' }],
        stats: stats({ eligible: 12, sessions: 1, bookableSessions: 1, seats: 10 }),
      }),
    ]);
    renderPage();

    expect(await screen.findByText('2 short')).toBeInTheDocument();
    expect(screen.getByText('Not enough seats for this round')).toBeInTheDocument();
  });
});
