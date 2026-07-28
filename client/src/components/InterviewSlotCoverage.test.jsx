import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import InterviewSlotCoverage from './InterviewSlotCoverage';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

describe('InterviewSlotCoverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockReset();
    apiClient.post.mockReset();
    apiClient.put.mockReset();
    apiClient.delete.mockReset();
  });

  const adminInterviews = [
    { id: 'iv-1', title: 'Coffee Chat Round', interviewType: 'COFFEE_CHAT' },
    { id: 'iv-2', title: 'Round 1', interviewType: 'ROUND_ONE' },
  ];

  const coverage = {
    interview: { id: 'iv-1', title: 'Coffee Chat Round', interviewType: 'COFFEE_CHAT', cycleId: 'c-1' },
    activeCycle: { id: 'c-1', name: 'Fall 2026' },
    slots: [
      {
        id: 'slot-1',
        startTime: '2026-10-02T14:00:00Z',
        endTime: '2026-10-02T15:00:00Z',
        capacity: 2,
        _count: { signups: 1 },
        signups: [
          { id: 'signup-1', user: { id: 'u-1', fullName: 'Alice', email: 'alice@example.com' }, confirmationStatus: 'SENT' },
        ],
      },
      {
        id: 'slot-2',
        startTime: '2026-10-03T16:00:00Z',
        endTime: '2026-10-03T17:00:00Z',
        capacity: 3,
        _count: { signups: 3 },
        signups: [
          { id: 'signup-2', user: { id: 'u-2', fullName: 'Bob', email: 'bob@example.com' }, confirmationStatus: 'FAILED' },
        ],
      },
    ],
  };

  it('renders coverage table with filled/capacity and confirmation status', async () => {
    apiClient.get.mockImplementation((url) => {
      if (url === '/admin/interviews') return Promise.resolve(adminInterviews);
      if (url === '/admin/interviews/iv-1/slots') return Promise.resolve(coverage);
      return Promise.reject(new Error(`Unexpected ${url}`));
    });

    render(<InterviewSlotCoverage />);

    await waitFor(() => expect(screen.getByText('Capacity')).toBeInTheDocument());
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('SENT')).toBeInTheDocument();
    expect(screen.getByText('FAILED')).toBeInTheDocument();
    expect(screen.getByText(/1\s*\/\s*2/)).toBeInTheDocument();
    expect(screen.getByText(/3\s*\/\s*3/)).toBeInTheDocument();
  });

  it('shows empty state when there are no interviews of supported types', async () => {
    apiClient.get.mockResolvedValueOnce([
      { id: 'iv-3', title: 'Final Round', interviewType: 'FINAL_ROUND' },
    ]);

    render(<InterviewSlotCoverage />);

    await waitFor(() => expect(screen.getByText(/No Coffee Chat/i)).toBeInTheDocument());
  });

  it('creates a slot and refreshes coverage', async () => {
    apiClient.get.mockImplementation((url) => {
      if (url === '/admin/interviews') return Promise.resolve(adminInterviews);
      if (url === '/admin/interviews/iv-1/slots') return Promise.resolve({ ...coverage, slots: [] });
      return Promise.reject(new Error(`Unexpected ${url}`));
    });
    apiClient.post.mockResolvedValueOnce({ slots: [{ id: 'slot-3' }] });

    render(<InterviewSlotCoverage />);

    await waitFor(() => expect(screen.getByText('Add slot')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Add slot'));

    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '2026-10-04T09:00' } });
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '2026-10-04T10:00' } });

    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith(
      '/admin/interviews/iv-1/slots',
      { slots: [{ startTime: '2026-10-04T09:00', endTime: '2026-10-04T10:00', capacity: 2 }] }
    ));
  });

  it('removes a signup with confirmation', async () => {
    apiClient.get.mockImplementation((url) => {
      if (url === '/admin/interviews') return Promise.resolve(adminInterviews);
      if (url === '/admin/interviews/iv-1/slots') return Promise.resolve(coverage);
      return Promise.reject(new Error(`Unexpected ${url}`));
    });
    apiClient.delete.mockResolvedValueOnce({ message: 'removed' });

    render(<InterviewSlotCoverage />);

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    const removeButtons = screen.getAllByLabelText(/Remove member from slot/i);
    fireEvent.click(removeButtons[0]);

    await waitFor(() => expect(screen.getByText(/Remove member from slot/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText('Remove'));

    await waitFor(() => expect(apiClient.delete).toHaveBeenCalledWith('/admin/interviews/signups/signup-1'));
  });

  it('retries a failed confirmation email', async () => {
    apiClient.get.mockImplementation((url) => {
      if (url === '/admin/interviews') return Promise.resolve(adminInterviews);
      if (url === '/admin/interviews/iv-1/slots') return Promise.resolve(coverage);
      return Promise.reject(new Error(`Unexpected ${url}`));
    });
    apiClient.post.mockResolvedValueOnce({ signup: { confirmationStatus: 'SENT' } });

    render(<InterviewSlotCoverage />);

    await waitFor(() => expect(screen.getByText('FAILED')).toBeInTheDocument());
    const retryButtons = screen.getAllByLabelText(/Retry confirmation email/i);
    fireEvent.click(retryButtons[0]);

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/admin/interviews/signups/signup-2/retry-confirmation'));
  });
});
