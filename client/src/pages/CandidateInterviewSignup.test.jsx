import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CandidateInterviewSignup from './CandidateInterviewSignup';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../components/AccessControl', () => ({
  default: ({ children }) => <>{children}</>,
}));

import apiClient from '../utils/api';

const inDays = (days) => new Date(Date.now() + days * 86400000).toISOString();

const options = (over = {}) => ({
  modifyCutoffHours: 12,
  interviews: [
    {
      id: 'iv1',
      title: 'Coffee Chats',
      interviewType: 'COFFEE_CHAT',
      location: 'Covel',
      yourSignup: null,
      slots: [
        {
          id: 'morning',
          label: 'Morning Block',
          startTime: inDays(5),
          endTime: inDays(5),
          capacity: 40,
          seatsRemaining: 0,
          isFull: true,
          isOpen: true,
          yourStatus: null,
        },
        {
          id: 'afternoon',
          label: 'Afternoon Block',
          startTime: inDays(5),
          endTime: inDays(5),
          capacity: 40,
          seatsRemaining: 12,
          isFull: false,
          isOpen: true,
          yourStatus: null,
        },
      ],
    },
  ],
  ...over,
});

const mine = (status, slotId = 'morning') => ({
  modifyCutoffHours: 12,
  signups: [
    {
      id: 'signup1',
      status,
      canModify: true,
      interview: { id: 'iv1', title: 'Coffee Chats', interviewType: 'COFFEE_CHAT' },
      slot: { id: slotId, label: slotId === 'morning' ? 'Morning Block' : 'Afternoon Block', startTime: inDays(5), endTime: inDays(5), location: 'Covel' },
    },
  ],
});

const mockLoad = (signupsPayload, optionsPayload = options()) => {
  apiClient.get.mockImplementation((url) =>
    Promise.resolve(url.includes('/options') ? optionsPayload : signupsPayload)
  );
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CandidateInterviewSignup', () => {
  it('shows an empty state rather than a blank page when there is nothing to book', async () => {
    mockLoad({ signups: [], modifyCutoffHours: 12 }, { interviews: [] });
    render(<CandidateInterviewSignup />);
    expect(await screen.findByText(/nothing to schedule yet/i)).toBeInTheDocument();
  });

  it('shows a full slot as full instead of hiding it', async () => {
    // Hiding it would leave the candidate wondering why there is only one
    // option; showing "Full" is what makes the waitlist button make sense.
    mockLoad({ signups: [], modifyCutoffHours: 12 });
    render(<CandidateInterviewSignup />);
    expect(await screen.findByText('Morning Block')).toBeInTheDocument();
    expect(screen.getByText('Full')).toBeInTheDocument();
    expect(screen.getByText('12 left')).toBeInTheDocument();
  });

  it('offers the waitlist on a full slot and booking on an open one', async () => {
    mockLoad({ signups: [], modifyCutoffHours: 12 });
    render(<CandidateInterviewSignup />);
    expect(await screen.findByRole('button', { name: /join waitlist/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /book this time/i })).toBeInTheDocument();
  });

  it('relays the server\'s explanation when a booking lands on the waitlist', async () => {
    mockLoad({ signups: [], modifyCutoffHours: 12 });
    apiClient.post.mockResolvedValue({
      outcome: 'WAITLISTED',
      message: 'That session was full, so we booked you into the next available one.',
    });
    render(<CandidateInterviewSignup />);

    await userEvent.click(await screen.findByRole('button', { name: /join waitlist/i }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/my-interview-signups', { slotId: 'morning' });
    });
    expect(await screen.findByText(/we booked you into the next available one/i)).toBeInTheDocument();
  });

  it('tells a waitlisted candidate they already hold a spot', async () => {
    // The single most important sentence on the page: the anxious reading of
    // "waitlisted" is "I have nothing", and that is not what it means here.
    mockLoad(mine('WAITLISTED'));
    render(<CandidateInterviewSignup />);
    expect(await screen.findByText(/you have a confirmed spot/i)).toBeInTheDocument();
    expect(screen.getByText(/we will move you\s+automatically/i)).toBeInTheDocument();
  });

  it('explains the overflow case instead of showing a dead end', async () => {
    mockLoad(mine('NEEDS_PLACEMENT'));
    render(<CandidateInterviewSignup />);
    expect(await screen.findByText(/recruitment has been notified/i)).toBeInTheDocument();
  });

  it('locks the controls inside the cutoff window', async () => {
    const locked = mine('CONFIRMED');
    locked.signups[0].canModify = false;
    mockLoad(locked);
    render(<CandidateInterviewSignup />);

    expect(await screen.findByText(/changes are locked within 12 hours/i)).toBeInTheDocument();
    screen.getAllByRole('button').forEach((button) => {
      if (/cancel|switch|book|waitlist/i.test(button.textContent)) {
        expect(button).toBeDisabled();
      }
    });
  });

  it('surfaces a server error rather than failing silently', async () => {
    mockLoad({ signups: [], modifyCutoffHours: 12 });
    apiClient.post.mockRejectedValue(new Error('This slot is full (Status: 409)'));
    render(<CandidateInterviewSignup />);

    await userEvent.click(await screen.findByRole('button', { name: /book this time/i }));
    expect(await screen.findByText(/this slot is full/i)).toBeInTheDocument();
  });
});
