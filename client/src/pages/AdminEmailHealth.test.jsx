// The deliverability page lays out a report the server already judged, so the
// tests check that it shows each verdict and its reason, reruns for a new
// window, sends a test to the address typed, and stays admin-only.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminEmailHealth from './AdminEmailHealth';
import apiClient from '../utils/api';

const mockUseAuth = vi.fn();
vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

const REPORT = {
  checkedAt: '2026-09-26T12:00:00Z',
  overall: 'fail',
  fromAddress: 'noreply@uc.org',
  sections: [
    {
      key: 'ses',
      title: 'Amazon SES',
      checks: [
        { key: 'production', label: 'Production access', status: 'fail', detail: 'The account is in the SES sandbox.' },
        { key: 'dkim', label: 'DKIM signing', status: 'ok', detail: 'Mail is DKIM-signed.' },
      ],
    },
  ],
  delivery: {
    days: 7,
    totals: { attempted: 120, delivered: 110, delayed: 0, bounced: 4, complained: 0, failed: 1, awaiting: 6 },
    problems: [
      {
        id: 'log-1',
        recipient: 'gone@example.com',
        recipientName: 'Gone Person',
        subject: 'Your interview',
        status: 'BOUNCED',
        error: 'Permanent bounce (General): 550 5.1.1 user unknown',
        sentAt: '2026-09-25T12:00:00Z',
      },
    ],
    suppressions: { BOUNCED: 3 },
    lastDeliveredAt: '2026-09-26T11:00:00Z',
  },
  recentTests: [],
};

beforeEach(() => {
  vi.restoreAllMocks();
  mockUseAuth.mockReturnValue({ user: { id: 'admin-1', role: 'ADMIN', email: 'admin@uc.org' } });
  vi.spyOn(apiClient, 'get').mockResolvedValue(REPORT);
});

describe('AdminEmailHealth', () => {
  it('shows each verdict with its reason, the totals and recent problems', async () => {
    render(<AdminEmailHealth />);

    expect(await screen.findByText('Production access')).toBeInTheDocument();
    expect(screen.getByText('The account is in the SES sandbox.')).toBeInTheDocument();
    expect(screen.getByText('Failing')).toBeInTheDocument();
    expect(screen.getByText('110')).toBeInTheDocument();
    expect(screen.getByText(/550 5\.1\.1 user unknown/)).toBeInTheDocument();
    expect(screen.getByText('Hard bounced')).toBeInTheDocument();
  });

  it('reruns the check for another window', async () => {
    render(<AdminEmailHealth />);
    await screen.findByText('Production access');

    await userEvent.click(screen.getByRole('button', { name: '30d' }));

    await waitFor(() => expect(apiClient.get).toHaveBeenLastCalledWith('/admin/email-health?days=30'));
  });

  it('ignores an older check that finishes after a newer one', async () => {
    let finishWeek;
    vi.spyOn(apiClient, 'get').mockImplementation((path) =>
      path.endsWith('days=7')
        ? new Promise((resolve) => {
            finishWeek = resolve;
          })
        : Promise.resolve({ ...REPORT, delivery: { ...REPORT.delivery, totals: { ...REPORT.delivery.totals, delivered: 999 } } })
    );
    render(<AdminEmailHealth />);

    await userEvent.click(screen.getByRole('button', { name: '30d' }));
    expect(await screen.findByText('999')).toBeInTheDocument();

    finishWeek(REPORT);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText('999')).toBeInTheDocument();
    expect(screen.queryByText('110')).not.toBeInTheDocument();
  });

  it('sends a test to the address typed', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ sent: true, to: 'check@mail-tester.com' });
    render(<AdminEmailHealth />);
    await screen.findByText('Production access');

    const field = screen.getByLabelText('Send to');
    expect(field).toHaveValue('admin@uc.org');
    await userEvent.clear(field);
    await userEvent.type(field, 'check@mail-tester.com');
    await userEvent.click(screen.getByRole('button', { name: /send test/i }));

    expect(post).toHaveBeenCalledWith('/admin/email-health/test', { to: 'check@mail-tester.com' });
    expect(await screen.findByText(/Sent to check@mail-tester.com/)).toBeInTheDocument();
  });

  it('keeps members out', async () => {
    mockUseAuth.mockReturnValue({ user: { id: 'member-1', role: 'MEMBER' } });
    render(<AdminEmailHealth />);
    expect(await screen.findByText('Access Denied')).toBeInTheDocument();
  });
});
