import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TalentUidLink from './TalentUidLink';
import apiClient from '../utils/api';

const refreshUser = vi.fn();
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ refreshUser }) }));
vi.mock('../utils/api', () => ({ default: { post: vi.fn() } }));

const renderCard = (props = {}) =>
  render(
    <MemoryRouter initialEntries={['/talent/profile']}>
      <Routes>
        <Route path="/talent/profile" element={<TalentUidLink {...props} />} />
        <Route path="/" element={<div>applicant dashboard</div>} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => vi.clearAllMocks());

describe('TalentUidLink', () => {
  it('sends the UID, then takes the code and lands on the applicant dashboard', async () => {
    apiClient.post
      .mockResolvedValueOnce({ status: 'CODE_SENT', sentTo: 'd***@g.ucla.edu' })
      .mockResolvedValueOnce({ status: 'LINKED' });
    renderCard();

    await userEvent.type(screen.getByLabelText('UCLA UID'), '306917258');
    await userEvent.click(screen.getByRole('button', { name: 'Find my application' }));
    expect(apiClient.post).toHaveBeenCalledWith('/talent/uid', { uid: '306917258' });
    expect(await screen.findByText(/d\*\*\*@g\.ucla\.edu/)).toBeInTheDocument();

    const link = screen.getByRole('button', { name: 'Link my application' });
    expect(link).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Code'), '1234-5678');
    await userEvent.click(link);

    expect(apiClient.post).toHaveBeenLastCalledWith('/talent/uid/confirm', { code: '12345678' });
    expect(refreshUser).toHaveBeenCalled();
    expect(await screen.findByText('applicant dashboard')).toBeInTheDocument();
  });

  it('shows the server\'s reason when the UID cannot be linked', async () => {
    apiClient.post.mockRejectedValue(new Error('This UID already has an account. Sign in with that account instead.'));
    renderCard();

    await userEvent.type(screen.getByLabelText('UCLA UID'), '306917258');
    await userEvent.click(screen.getByRole('button', { name: 'Find my application' }));

    expect(await screen.findByText(/already has an account/)).toBeInTheDocument();
  });

  it('opens on the code step when a code is already out', () => {
    renderCard({ claimedUid: '306917258', codePending: true });
    expect(screen.getByLabelText('Code')).toBeInTheDocument();
  });
});
