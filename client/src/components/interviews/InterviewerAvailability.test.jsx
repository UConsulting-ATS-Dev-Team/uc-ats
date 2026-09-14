import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InterviewerAvailability from './InterviewerAvailability';
import apiClient from '../../utils/api';

vi.mock('../../utils/api', () => ({
  default: { get: vi.fn(), put: vi.fn() },
}));

// 9am - 12pm Pacific on a first round day, expressed in UTC.
const firstRound = {
  interview: {
    id: 'i1',
    title: 'First Round Interviews',
    interviewType: 'ROUND_ONE',
    startDate: '2026-10-06T16:00:00.000Z',
    endDate: '2026-10-06T19:00:00.000Z',
    slots: [],
  },
  windows: [],
  assignments: [],
};

describe('InterviewerAvailability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.put.mockResolvedValue({});
  });

  it('offers one tick per hour across the interview range', async () => {
    apiClient.get.mockResolvedValue(firstRound);
    render(<InterviewerAvailability interviewId="i1" />);

    // Three whole hours between 9 and 12, and nothing past the end.
    expect(await screen.findByText('9:00 AM - 10:00 AM')).toBeInTheDocument();
    expect(screen.getByText('10:00 AM - 11:00 AM')).toBeInTheDocument();
    expect(screen.getByText('11:00 AM - 12:00 PM')).toBeInTheDocument();
    expect(screen.queryByText('12:00 PM - 1:00 PM')).not.toBeInTheDocument();
  });

  it('saves a ticked hour as an hour-long window', async () => {
    apiClient.get.mockResolvedValue(firstRound);
    render(<InterviewerAvailability interviewId="i1" />);

    await userEvent.click(await screen.findByText('10:00 AM - 11:00 AM'));
    await userEvent.click(screen.getByRole('button', { name: /save my availability/i }));

    await waitFor(() => expect(apiClient.put).toHaveBeenCalled());
    const [, body] = apiClient.put.mock.calls[0];
    expect(body.windows).toHaveLength(1);
    expect(body.windows[0].startTime).toBe('2026-10-06T17:00:00.000Z');
    expect(body.windows[0].endTime).toBe('2026-10-06T18:00:00.000Z');
  });

  it('lights up the hours a saved window already covers', async () => {
    apiClient.get.mockResolvedValue({
      ...firstRound,
      // One merged 9-11 window covers two of the three hours.
      windows: [
        { id: 'w1', startTime: '2026-10-06T16:00:00.000Z', endTime: '2026-10-06T18:00:00.000Z', note: null },
      ],
    });
    render(<InterviewerAvailability interviewId="i1" />);

    await userEvent.click(await screen.findByRole('button', { name: /save my availability/i }));

    await waitFor(() => expect(apiClient.put).toHaveBeenCalled());
    const [, body] = apiClient.put.mock.calls[0];
    expect(body.windows.map((w) => w.startTime)).toEqual([
      '2026-10-06T16:00:00.000Z',
      '2026-10-06T17:00:00.000Z',
    ]);
  });

  it('still asks first round by the hour once its groups exist', async () => {
    apiClient.get.mockResolvedValue({
      ...firstRound,
      interview: {
        ...firstRound.interview,
        // Two parallel groups at the same hour - the case that used to render
        // as two identical "11:00 AM - 12:00 PM" checkboxes.
        slots: [
          { id: 'g1', label: 'Group 1A', startTime: '2026-10-06T18:00:00.000Z', endTime: '2026-10-06T19:00:00.000Z' },
          { id: 'g2', label: 'Group 1B', startTime: '2026-10-06T18:00:00.000Z', endTime: '2026-10-06T19:00:00.000Z' },
        ],
      },
    });
    render(<InterviewerAvailability interviewId="i1" />);

    expect(await screen.findByText('9:00 AM - 10:00 AM')).toBeInTheDocument();
    expect(screen.queryByText('Group 1A')).not.toBeInTheDocument();
    expect(screen.queryByText('Group 1B')).not.toBeInTheDocument();
  });

});
