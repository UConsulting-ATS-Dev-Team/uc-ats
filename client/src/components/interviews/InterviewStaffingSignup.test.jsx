import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import InterviewStaffingSignup from './InterviewStaffingSignup';
import apiClient from '../../utils/api';

vi.mock('../../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

// The availability card fetches on its own; keep it inert so this file is only
// about which interviews get one.
vi.mock('./InterviewerAvailability', () => ({
  default: ({ interviewId }) => <div data-testid="availability">{interviewId}</div>,
}));

const mine = [
  { id: 'cc1', title: 'W27 Coffee Chats', interviewType: 'COFFEE_CHAT' },
  { id: 'fr1', title: 'W27 First Round', interviewType: 'ROUND_ONE' },
];

describe('InterviewStaffingSignup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockImplementation((url) =>
      url === '/member/interviews'
        ? Promise.resolve(mine)
        : Promise.resolve({
            interviews: [
              {
                id: 'cc1',
                title: 'W27 Coffee Chats',
                interviewType: 'COFFEE_CHAT',
                slots: [{ id: 'm1', label: 'Morning Session', startTime: '2026-10-06T16:00:00.000Z', endTime: '2026-10-06T18:00:00.000Z', candidateCount: 0, interviewers: [], interviewerCapacity: 4 }],
              },
              {
                id: 'fr1',
                title: 'W27 First Round',
                interviewType: 'ROUND_ONE',
                slots: [{ id: 'g1', label: 'Group 1A', startTime: '2026-10-06T16:00:00.000Z', endTime: '2026-10-06T17:00:00.000Z', candidateCount: 4, interviewers: [], interviewerCapacity: 2 }],
              },
            ],
          })
    );
  });

  it('lets members claim coffee chat sittings but never first round groups', async () => {
    render(<InterviewStaffingSignup />);

    // Recruitment builds first round groups out of availability. A member
    // picking their own group decides the schedule before anyone knows who is
    // free, which is the thing availability exists to prevent.
    expect(await screen.findByText('Morning Session')).toBeInTheDocument();
    expect(screen.queryByText('Group 1A')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /sign up to run this/i })).toHaveLength(1);
  });

  it('asks for availability only where the sessions do not exist yet', async () => {
    render(<InterviewStaffingSignup />);

    // A coffee chat's sittings already exist and are claimed outright below, so
    // asking "are you free for Morning Session?" there is the same question
    // twice - and only one of the two does anything.
    await waitFor(() => expect(screen.getAllByTestId('availability')).toHaveLength(1));
    expect(screen.getByTestId('availability')).toHaveTextContent('fr1');
  });
});
