import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MemberReferrals from './MemberReferrals';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn() }
}));

const karen = { id: 'cand-7', firstName: 'Karen', lastName: 'Filippelli', email: 'karen@ucla.edu' };

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

// The page calls two endpoints: its own list, and the candidate search.
const mockApi = ({ referrals = [], candidates = [] } = {}) => {
  apiClient.get.mockImplementation((url) => {
    if (url.startsWith('/member/referral-candidates')) return Promise.resolve(candidates);
    return Promise.resolve(referrals);
  });
};

const openPicker = async (user, text) => {
  const input = screen.getByLabelText(/who are you referring/i);
  await user.click(input);
  await user.type(input, text);
  return input;
};

const chooseOption = async (user, name) => {
  const option = await screen.findByRole('option', { name });
  await user.click(option);
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi();
  apiClient.post.mockResolvedValue({ id: 'ref-new', candidateId: null });
});

describe('MemberReferrals', () => {
  it('shows a member their own referrals and whether each one landed', async () => {
    mockApi({ referrals: [attached, pending] });

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

  it('waits for two letters before searching', async () => {
    const user = userEvent.setup();
    render(<MemberReferrals />);
    await screen.findByText(/have not referred anyone yet/i);

    await openPicker(user, 'k');

    await waitFor(() =>
      expect(
        apiClient.get.mock.calls.filter(([url]) => url.startsWith('/member/referral-candidates'))
      ).toHaveLength(0)
    );
  });

  it('submits the picked candidate by id, with no typed name', async () => {
    mockApi({ candidates: [karen] });
    apiClient.post.mockResolvedValue({ id: 'ref-new', candidateId: 'cand-7' });
    const user = userEvent.setup();
    render(<MemberReferrals />);
    await screen.findByText(/have not referred anyone yet/i);

    await openPicker(user, 'kar');
    await chooseOption(user, /Karen Filippelli/);
    await user.type(screen.getByLabelText(/how do you know them/i), 'Classmate');
    await user.click(screen.getByRole('button', { name: /submit referral/i }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/member/referrals', {
        relationship: 'Classmate',
        candidateId: 'cand-7'
      })
    );
    expect(await screen.findByText(/added to their profile/i)).toBeInTheDocument();
  });

  it('asks for a name only after Other is chosen', async () => {
    mockApi({ candidates: [karen] });
    const user = userEvent.setup();
    render(<MemberReferrals />);
    await screen.findByText(/have not referred anyone yet/i);

    // Nothing picked yet, so there is nothing to type a name into.
    expect(screen.queryByLabelText(/first name/i)).not.toBeInTheDocument();

    await openPicker(user, 'kar');
    await chooseOption(user, /Other/);

    expect(await screen.findByLabelText(/first name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/last name/i)).toBeInTheDocument();
  });

  it('submits a typed name under Other and says it will attach later', async () => {
    mockApi({ candidates: [] });
    const user = userEvent.setup();
    render(<MemberReferrals />);
    await screen.findByText(/have not referred anyone yet/i);

    await openPicker(user, 'kar');
    await chooseOption(user, /Other/);
    await user.type(await screen.findByLabelText(/first name/i), '  Karen ');
    await user.type(screen.getByLabelText(/last name/i), ' Filippelli ');
    await user.type(screen.getByLabelText(/how do you know them/i), 'Classmate');
    await user.click(screen.getByRole('button', { name: /submit referral/i }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/member/referrals', {
        relationship: 'Classmate',
        referredFirstName: 'Karen',
        referredLastName: 'Filippelli'
      })
    );
    expect(await screen.findByText(/attach to their profile once they apply/i)).toBeInTheDocument();
  });

  it('will not submit until there is both a person and a relationship', async () => {
    mockApi({ candidates: [karen] });
    const user = userEvent.setup();
    render(<MemberReferrals />);
    await screen.findByText(/have not referred anyone yet/i);

    const submit = screen.getByRole('button', { name: /submit referral/i });
    expect(submit).toBeDisabled();

    await openPicker(user, 'kar');
    await chooseOption(user, /Karen Filippelli/);
    expect(submit).toBeDisabled(); // person, but no relationship

    await user.type(screen.getByLabelText(/how do you know them/i), 'Classmate');
    expect(submit).toBeEnabled();
  });

  it('will not submit Other with only half a name', async () => {
    mockApi({ candidates: [] });
    const user = userEvent.setup();
    render(<MemberReferrals />);
    await screen.findByText(/have not referred anyone yet/i);

    await openPicker(user, 'kar');
    await chooseOption(user, /Other/);
    await user.type(await screen.findByLabelText(/first name/i), 'Karen');
    await user.type(screen.getByLabelText(/how do you know them/i), 'Classmate');

    expect(screen.getByRole('button', { name: /submit referral/i })).toBeDisabled();
  });

  it("surfaces the server's reason for refusing a duplicate", async () => {
    mockApi({ candidates: [karen] });
    apiClient.post.mockRejectedValue({
      response: { data: { error: 'You have already referred this person for this cycle' } }
    });
    const user = userEvent.setup();
    render(<MemberReferrals />);
    await screen.findByText(/have not referred anyone yet/i);

    await openPicker(user, 'kar');
    await chooseOption(user, /Karen Filippelli/);
    await user.type(screen.getByLabelText(/how do you know them/i), 'Classmate');
    await user.click(screen.getByRole('button', { name: /submit referral/i }));

    expect(await screen.findByText(/already referred this person/i)).toBeInTheDocument();
  });

  it('clears the form after a successful submission so the next one starts clean', async () => {
    mockApi({ candidates: [karen] });
    const user = userEvent.setup();
    render(<MemberReferrals />);
    await screen.findByText(/have not referred anyone yet/i);

    await openPicker(user, 'kar');
    await chooseOption(user, /Karen Filippelli/);
    await user.type(screen.getByLabelText(/how do you know them/i), 'Classmate');
    await user.click(screen.getByRole('button', { name: /submit referral/i }));

    await waitFor(() => expect(screen.getByLabelText(/how do you know them/i)).toHaveValue(''));
    expect(screen.getByLabelText(/who are you referring/i)).toHaveValue('');
  });
});
