import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MemberReferrals from './MemberReferrals';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn() }
}));

const pending = {
  id: 'ref-1',
  referredName: 'Karen Filippelli',
  relationship: 'Classmate',
  status: 'PENDING',
  createdAt: '2026-09-01T00:00:00.000Z',
  cycle: { id: 'cycle-1', name: 'Fall 2026' }
};

const attached = {
  id: 'ref-2',
  referredName: 'Michael Scott',
  relationship: 'Teammate',
  status: 'ATTACHED',
  createdAt: '2026-09-02T00:00:00.000Z',
  cycle: { id: 'cycle-1', name: 'Fall 2026' }
};

const fillForm = async (user, { first = 'Karen', last = 'Filippelli', how = 'Classmate' } = {}) => {
  if (first) await user.type(screen.getByLabelText(/first name/i), first);
  if (last) await user.type(screen.getByLabelText(/last name/i), last);
  if (how) await user.type(screen.getByLabelText(/how do you know them/i), how);
};

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.get.mockResolvedValue([]);
  apiClient.post.mockResolvedValue({ id: 'ref-new', candidateId: null });
});

describe('MemberReferrals', () => {
  it('shows a member their own referrals and whether each one landed', async () => {
    apiClient.get.mockResolvedValue([attached, pending]);

    render(<MemberReferrals />);

    expect(await screen.findByText('Michael Scott')).toBeInTheDocument();
    expect(screen.getByText('Karen Filippelli')).toBeInTheDocument();
    expect(screen.getByText('On their profile')).toBeInTheDocument();
    expect(screen.getByText('Waiting on their application')).toBeInTheDocument();
  });

  it('says so plainly when there is nothing yet', async () => {
    render(<MemberReferrals />);
    expect(await screen.findByText(/have not referred anyone yet/i)).toBeInTheDocument();
  });

  it('will not submit without both names and a relationship', async () => {
    const user = userEvent.setup();
    render(<MemberReferrals />);
    await screen.findByText(/have not referred anyone yet/i);

    const submit = screen.getByRole('button', { name: /submit referral/i });
    expect(submit).toBeDisabled();

    await fillForm(user, { how: '' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/how do you know them/i), 'Classmate');
    expect(submit).toBeEnabled();
  });

  it('submits the trimmed name and tells the member it will attach later', async () => {
    const user = userEvent.setup();
    render(<MemberReferrals />);
    await screen.findByText(/have not referred anyone yet/i);

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /submit referral/i }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/member/referrals', {
        referredFirstName: 'Karen',
        referredLastName: 'Filippelli',
        relationship: 'Classmate'
      })
    );
    expect(await screen.findByText(/attach to their profile once they apply/i)).toBeInTheDocument();
  });

  it('says it matched immediately when the person had already applied', async () => {
    apiClient.post.mockResolvedValue({ id: 'ref-new', candidateId: 'cand-7' });
    const user = userEvent.setup();
    render(<MemberReferrals />);
    await screen.findByText(/have not referred anyone yet/i);

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /submit referral/i }));

    expect(await screen.findByText(/matched to their application/i)).toBeInTheDocument();
  });

  it('surfaces the server\'s reason for refusing a duplicate', async () => {
    apiClient.post.mockRejectedValue({
      response: { data: { error: 'You have already referred this person for this cycle' } }
    });
    const user = userEvent.setup();
    render(<MemberReferrals />);
    await screen.findByText(/have not referred anyone yet/i);

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /submit referral/i }));

    expect(await screen.findByText(/already referred this person/i)).toBeInTheDocument();
  });

  it('clears the form after a successful submission so the next one starts clean', async () => {
    const user = userEvent.setup();
    render(<MemberReferrals />);
    await screen.findByText(/have not referred anyone yet/i);

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /submit referral/i }));

    await waitFor(() => expect(screen.getByLabelText(/first name/i)).toHaveValue(''));
    expect(screen.getByLabelText(/last name/i)).toHaveValue('');
  });
});
