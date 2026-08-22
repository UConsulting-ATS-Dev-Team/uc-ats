import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminFeedbackJobs from './AdminFeedbackJobs';
import AccessControl from '../components/AccessControl';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';

vi.mock('../utils/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('../context/AuthContext', async () => {
  const actual = await vi.importActual('../context/AuthContext');
  return { ...actual, useAuth: vi.fn() };
});

describe('AdminFeedbackJobs', () => {
  const cycles = [{ id: 'cycle-1', name: 'Fall 2026' }];

  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation((url) => {
      if (url.startsWith('/admin/cycles')) return Promise.resolve(cycles);
      if (url.startsWith('/admin/feedback-jobs')) {
        return Promise.resolve({
          jobs: [
            { id: 'job-1', status: 'UNKNOWN', attempts: 1, lastError: 'Lease expired', application: { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' } },
            { id: 'job-2', status: 'FAILED', attempts: 2, lastError: 'Bounced', application: { firstName: 'John', lastName: 'Doe', email: 'john@example.com' } },
            { id: 'job-3', status: 'SENT', attempts: 1, application: { firstName: 'Alice', lastName: 'Smith', email: 'alice@example.com' } },
          ],
          total: 3,
        });
      }
      return Promise.resolve([]);
    });
    api.post.mockResolvedValue({});
  });

  it('renders status chips, errors, and safe retry/reconcile visibility', async () => {
    render(<MemoryRouter><AdminFeedbackJobs /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    });

    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
    expect(screen.getByText('FAILED')).toBeInTheDocument();
    expect(screen.getByText('SENT')).toBeInTheDocument();
    expect(screen.getByText('Lease expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reconcile/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });

  it('reconciles an UNKNOWN job as SENT and reloads', async () => {
    render(<MemoryRouter><AdminFeedbackJobs /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: /Reconcile/i })[0]);

    await waitFor(() => {
      expect(screen.getByText('Reconcile Feedback Job')).toBeInTheDocument();
    });

    const messageInput = screen.getByLabelText(/Provider Message ID/i);
    fireEvent.change(messageInput, { target: { value: 'msg-123' } });

    fireEvent.click(screen.getByRole('button', { name: /Confirm$/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/admin/feedback-jobs/job-1/reconcile', {
        status: 'SENT',
        messageId: 'msg-123',
        reason: undefined,
      });
    });
  });

  it('retries a FAILED job', async () => {
    render(<MemoryRouter><AdminFeedbackJobs /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('John Doe')).toBeInTheDocument());

    const retryButton = screen.getAllByRole('button', { name: /Retry/i })[0];
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/admin/feedback-jobs/job-2/retry');
    });
  });

  it('shows an error alert when loading fails', async () => {
    api.get.mockRejectedValue(new Error('Network down'));
    render(<MemoryRouter><AdminFeedbackJobs /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByText(/Network down/i)).toBeInTheDocument();
    });
  });

  it('denies MEMBER users via the ADMIN-only AccessControl wrapper', () => {
    useAuth.mockReturnValue({ user: { role: 'MEMBER' }, loading: false });
    render(
      <MemoryRouter>
        <AccessControl allowedRoles={['ADMIN']}>
          <div data-testid="admin-content">Admin content</div>
        </AccessControl>
      </MemoryRouter>
    );

    expect(screen.getByText(/Access Denied/i)).toBeInTheDocument();
    expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
  });
});
