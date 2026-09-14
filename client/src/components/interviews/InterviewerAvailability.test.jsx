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

  it('asks a coffee chat by its named sessions, not by the hour', async () => {
    apiClient.get.mockResolvedValue({
      interview: {
        id: 'i2',
        title: 'Coffee Chats',
        interviewType: 'COFFEE_CHAT',
        startDate: '2026-10-06T16:00:00.000Z',
        endDate: '2026-10-06T23:00:00.000Z',
        slots: [
          {
            id: 's1',
            label: 'Morning Session',
            startTime: '2026-10-06T16:00:00.000Z',
            endTime: '2026-10-06T18:00:00.000Z',
            interviewerCapacity: 4,
          },
        ],
      },
      windows: [],
      assignments: [],
    });
    render(<InterviewerAvailability interviewId="i2" />);

    expect(await screen.findByText('Morning Session')).toBeInTheDocument();
    expect(screen.queryByText('9:00 AM - 10:00 AM')).not.toBeInTheDocument();
  });
});
