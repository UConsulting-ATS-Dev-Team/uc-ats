import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminReferrals from './AdminReferrals';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), patch: vi.fn() }
}));

const karen = { id: 'cand-7', firstName: 'Karen', lastName: 'Filippelli', email: 'karen@ucla.edu' };

const pendingReferral = {
  id: 'ref-1',
  referredName: 'Karen Filippelli',
  relationship: 'Classmate',
  referrerName: 'Pam Beesly',
  referredBy: { id: 'u1', fullName: 'Pam Beesly' },
  source: 'PRE_APPLICATION',
  status: 'PENDING',
  candidateId: null,
  createdAt: '2026-09-01T00:00:00.000Z'
};

const mockApi = ({ referrals = [], candidates = [] } = {}) => {
  apiClient.get.mockImplementation((url) => {
    if (url.startsWith('/admin/referral-candidates')) return Promise.resolve(candidates);
    return Promise.resolve(referrals);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi();
  apiClient.patch.mockResolvedValue({ id: 'ref-1', candidateId: 'cand-7' });
});

describe('AdminReferrals', () => {
  it('opens on the queue that needs work', async () => {
    mockApi({ referrals: [pendingReferral] });
    render(<AdminReferrals />);

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/admin/referrals?status=PENDING'));
    expect(await screen.findByText('Karen Filippelli')).toBeInTheDocument();
    expect(screen.getByText(/Referred by Pam Beesly/)).toBeInTheDocument();
  });

  it('says so plainly when nothing is waiting', async () => {
    render(<AdminReferrals />);
    expect(await screen.findByText(/nothing is waiting/i)).toBeInTheDocument();
  });

  it('matches a pending referral to the candidate an admin picks', async () => {
    mockApi({ referrals: [pendingReferral], candidates: [karen] });
    const user = userEvent.setup();
    render(<AdminReferrals />);
    await screen.findByText('Karen Filippelli');

    const search = screen.getByLabelText(/match to candidate/i);
    await user.click(search);
    await user.type(search, 'kar');

    await user.click(await screen.findByRole('option', { name: /Karen Filippelli/ }));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith('/admin/referrals/ref-1', { candidateId: 'cand-7' })
    );
    expect(await screen.findByText(/matched to/i)).toBeInTheDocument();
  });

  it('reloads the queue after a match, so the row leaves it', async () => {
    mockApi({ referrals: [pendingReferral], candidates: [karen] });
    const user = userEvent.setup();
    render(<AdminReferrals />);
    await screen.findByText('Karen Filippelli');

    const before = apiClient.get.mock.calls.filter(([url]) => url.startsWith('/admin/referrals')).length;

    const search = screen.getByLabelText(/match to candidate/i);
    await user.click(search);
    await user.type(search, 'kar');
    await user.click(await screen.findByRole('option', { name: /Karen Filippelli/ }));

    await waitFor(() => {
      const after = apiClient.get.mock.calls.filter(([url]) => url.startsWith('/admin/referrals')).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('switches to the matched tab', async () => {
    mockApi({ referrals: [pendingReferral] });
    const user = userEvent.setup();
    render(<AdminReferrals />);
    await screen.findByText('Karen Filippelli');

    await user.click(screen.getByRole('tab', { name: /matched/i }));

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/admin/referrals?status=ATTACHED'));
  });

  it('surfaces a failed match instead of pretending it worked', async () => {
    mockApi({ referrals: [pendingReferral], candidates: [karen] });
    apiClient.patch.mockRejectedValue({ response: { data: { error: 'Candidate not found' } } });
    const user = userEvent.setup();
    render(<AdminReferrals />);
    await screen.findByText('Karen Filippelli');

    const search = screen.getByLabelText(/match to candidate/i);
    await user.click(search);
    await user.type(search, 'kar');
    await user.click(await screen.findByRole('option', { name: /Karen Filippelli/ }));

    expect(await screen.findByText('Candidate not found')).toBeInTheDocument();
  });
});
