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

// What the open-for-availability endpoint returns: coffee chats are already
// excluded server-side, since their sittings exist and are claimed outright.
const askable = [{ id: 'fr1', title: 'W27 First Round', interviewType: 'ROUND_ONE' }];

describe('InterviewStaffingSignup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockImplementation((url) =>
      url === '/member/interviews/open-for-availability'
        ? Promise.resolve(askable)
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

    // The list is NOT the member's assigned interviews: availability is
    // collected before anybody is placed, so filtering it by placement would be
    // circular - nobody assigned, nobody sees the form, nobody ever assigned.
    await waitFor(() => expect(screen.getAllByTestId('availability')).toHaveLength(1));
    expect(screen.getByTestId('availability')).toHaveTextContent('fr1');
  });
});
