import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InterviewerCoverage from './InterviewerCoverage';
import apiClient from '../../utils/api';
import { useAuth } from '../../context/AuthContext';

vi.mock('../../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

vi.mock('../../context/AuthContext', () => ({ useAuth: vi.fn() }));

const ada = { id: 'u1', fullName: 'Ada Reyes', email: 'ada@test.local', role: 'MEMBER' };
const ben = { id: 'u2', fullName: 'Ben Ortiz', email: 'ben@test.local', role: 'MEMBER' };
const cy = { id: 'u3', fullName: 'Cy Park', email: 'cy@test.local', role: 'MEMBER' };

const finalRound = (staff) => ({
  interview: {
    id: 'f1',
    title: 'Final Round',
    interviewType: 'FINAL_ROUND',
    startDate: '2026-10-10T16:00:00.000Z',
    endDate: '2026-10-10T18:00:00.000Z',
    inviteOnly: true,
  },
  cadence: { minutes: 60, interviewersPerSession: 2 },
  coverage: [],
  interviewers: [],
  sessions: [],
  placements: [],
  staff,
});

describe('InterviewerCoverage on an invite-only final round', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuth.mockReturnValue({ user: { id: 'admin-1', role: 'ADMIN' } });
  });

  it('asks only the members picked, not the whole roster', async () => {
    apiClient.get.mockResolvedValue(
      finalRound([
        { ...ada, responded: false, invited: false },
        { ...ben, responded: false, invited: false },
        { ...cy, responded: false, invited: false },
      ])
    );
    apiClient.post.mockResolvedValue({ queued: 2 });
    const user = userEvent.setup();
    render(<InterviewerCoverage interviewId="f1" />);

    expect(await screen.findByText(/Nobody sees this round on My Interviews/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ask members for availability' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Choose members to ask' }));
    const input = await screen.findByLabelText('Members to ask');
    await user.click(input);
    await user.click(await screen.findByText('Ada Reyes'));
    await user.click(await screen.findByText('Cy Park'));
    await user.click(screen.getByRole('button', { name: 'Ask 2 members' }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/admin/interviews/f1/request-availability', {
        userIds: ['u1', 'u3'],
      })
    );
    expect(await screen.findByText('Asked 2 people.')).toBeInTheDocument();
  });

  it('lists who was asked, reminds the silent ones and can take someone off', async () => {
    apiClient.get.mockResolvedValue(
      finalRound([
        { ...ada, responded: true, invited: true },
        { ...ben, responded: false, invited: true },
        { ...cy, responded: false, invited: false },
      ])
    );
    apiClient.post.mockResolvedValue({ queued: 1 });
    apiClient.delete.mockResolvedValue({ removed: true });
    const user = userEvent.setup();
    render(<InterviewerCoverage interviewId="f1" />);

    expect(await screen.findByText('Asked for availability (2)')).toBeInTheDocument();
    expect(screen.getByText('Ada Reyes · answered')).toBeInTheDocument();
    expect(screen.getByText('Ben Ortiz · waiting')).toBeInTheDocument();
    expect(screen.queryByText(/Cy Park ·/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remind those who have not answered' }));
    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/admin/interviews/f1/request-availability', { everyone: false })
    );

    const benChip = screen.getByText('Ben Ortiz · waiting').closest('.MuiChip-root');
    await user.click(benChip.querySelector('.MuiChip-deleteIcon'));
    await waitFor(() =>
      expect(apiClient.delete).toHaveBeenCalledWith('/admin/interviews/f1/availability-invites/u2')
    );
  });
});
