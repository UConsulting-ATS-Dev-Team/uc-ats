import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import InterviewSignup from './InterviewSignup';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

describe('InterviewSignup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading and then grouped slots', async () => {
    apiClient.get.mockResolvedValueOnce({
      activeCycle: { id: 'c-1', name: 'Fall 2026' },
      groups: [
        {
          interview: { id: 'iv-1', title: 'Coffee Chat Round', interviewType: 'COFFEE_CHAT' },
          slots: [
            {
              id: 'slot-1',
              startTime: '2026-10-02T14:00:00Z',
              endTime: '2026-10-02T15:00:00Z',
              capacity: 2,
              remainingSeats: 1,
              isFull: false,
              userSignup: null,
              signups: [],
            },
            {
              id: 'slot-2',
              startTime: '2026-10-03T16:00:00Z',
              endTime: '2026-10-03T17:00:00Z',
              capacity: 1,
              remainingSeats: 0,
              isFull: true,
              userSignup: null,
              signups: [],
            },
          ],
        },
      ],
    });

    render(<InterviewSignup />);

    expect(screen.getByRole('progressbar')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText(/Coffee Chat Round/i)).toBeInTheDocument());
    expect(screen.getByText('1 seat left')).toBeInTheDocument();
    expect(screen.getAllByText('Full')).toHaveLength(2);
    expect(screen.getByText('Active cycle: Fall 2026')).toBeInTheDocument();
  });

  it('shows empty state when no slots are available', async () => {
    apiClient.get.mockResolvedValueOnce({ activeCycle: { id: 'c-1', name: 'Fall 2026' }, groups: [] });

    render(<InterviewSignup />);

    await waitFor(() => expect(screen.getByText(/No interview slots are available/i)).toBeInTheDocument());
  });

  it('shows error state', async () => {
    apiClient.get.mockRejectedValueOnce(new Error('Failed to load interview signups'));

    render(<InterviewSignup />);

    await waitFor(() => expect(screen.getByText(/Failed to load interview signups/i)).toBeInTheDocument());
  });

  it('signs up for a slot and refreshes', async () => {
    const member = { id: 'm-1', fullName: 'Member A', email: 'member@example.com' };
    const slot1 = {
      id: 'slot-1',
      startTime: '2026-10-02T14:00:00Z',
      endTime: '2026-10-02T15:00:00Z',
      capacity: 2,
      remainingSeats: 1,
      isFull: false,
      userSignup: null,
      signups: [],
    };

    apiClient.get.mockResolvedValueOnce({
      activeCycle: { id: 'c-1', name: 'Fall 2026' },
      groups: [{ interview: { id: 'iv-1', title: 'Round 1', interviewType: 'ROUND_ONE' }, slots: [slot1] }],
    });

    apiClient.post.mockResolvedValueOnce({
      signup: {
        id: 'signup-1',
        user: member,
        slot: { id: 'slot-1' },
        confirmationStatus: 'SENT',
      },
    });

    apiClient.get.mockResolvedValueOnce({
      activeCycle: { id: 'c-1', name: 'Fall 2026' },
      groups: [{
        interview: { id: 'iv-1', title: 'Round 1', interviewType: 'ROUND_ONE' },
        slots: [{ ...slot1, remainingSeats: 0, isFull: true, userSignup: { id: 'signup-1', user: member, confirmationStatus: 'SENT' } }],
      }],
    });

    render(<InterviewSignup />);

    await waitFor(() => expect(screen.getByText(/Round 1/i)).toBeInTheDocument());
    const buttons = screen.getAllByText('Sign Up');
    fireEvent.click(buttons[0]);

    await waitFor(() => expect(screen.getByText(/You're signed up/i)).toBeInTheDocument());
    expect(apiClient.post).toHaveBeenCalledWith('/member/interviews/slots/slot-1/signup');
  });

  it('shows a conflict/full message from the API', async () => {
    const slot1 = {
      id: 'slot-1',
      startTime: '2026-10-02T14:00:00Z',
      endTime: '2026-10-02T15:00:00Z',
      capacity: 2,
      remainingSeats: 1,
      isFull: false,
      userSignup: null,
      signups: [],
    };

    apiClient.get.mockResolvedValueOnce({
      activeCycle: { id: 'c-1', name: 'Fall 2026' },
      groups: [{ interview: { id: 'iv-1', title: 'Round 2', interviewType: 'ROUND_TWO' }, slots: [slot1] }],
    });

    apiClient.post.mockRejectedValueOnce(new Error('This slot is full (Status: 409)'));

    render(<InterviewSignup />);

    await waitFor(() => expect(screen.getByText(/Round 2/i)).toBeInTheDocument());
    const buttons = screen.getAllByText('Sign Up');
    fireEvent.click(buttons[0]);

    await waitFor(() => expect(screen.getByText(/This slot is full/i)).toBeInTheDocument());
  });
});
