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
      url === '/member/interviews' ? Promise.resolve(mine) : Promise.resolve({ interviews: [] })
    );
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
