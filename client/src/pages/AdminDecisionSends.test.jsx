import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminDecisionSends from './AdminDecisionSends';
import api from '../utils/api';

vi.mock('../utils/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

describe('AdminDecisionSends', () => {
  const applications = [
    {
      id: 'app-1',
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@example.com',
      decisionSendStatus: 'UNKNOWN',
      decisionSendAttemptedAt: '2026-07-27T10:00:00.000Z',
      decisionSendMessageId: null,
      decisionSendReconciledBy: null,
      decisionSendReconciledAt: null,
    },
    {
      id: 'app-2',
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@example.com',
      decisionSendStatus: 'SENDING',
      decisionSendAttemptedAt: '2026-07-27T09:00:00.000Z',
      decisionSendMessageId: 'msg-456',
      decisionSendReconciledBy: 'ops-admin',
      decisionSendReconciledAt: '2026-07-27T11:00:00.000Z',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ applications, total: 2, page: 1, limit: 25, totalPages: 1 });
    api.post.mockResolvedValue({});
  });

  it('renders decision send statuses and reconcile buttons', async () => {
    render(<MemoryRouter><AdminDecisionSends /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
    expect(screen.getByText('SENDING')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Reconcile/i })).toHaveLength(2);
  });

  it('reconciles a decision send as SENT with a provider message id', async () => {
    render(<MemoryRouter><AdminDecisionSends /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: /Reconcile/i })[0]);

    await waitFor(() => {
      expect(screen.getByText('Reconcile Final Decision Send')).toBeInTheDocument();
    });

    const messageInput = screen.getByLabelText(/Provider Message ID/i);
    fireEvent.change(messageInput, { target: { value: 'msg-789' } });

    fireEvent.click(screen.getByRole('button', { name: /Confirm$/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/admin/decision-sends/app-1/reconcile', {
        status: 'SENT',
        messageId: 'msg-789',
        reason: undefined,
      });
    });
  });

  it('reconciles a decision send as FAILED with a reason', async () => {
    render(<MemoryRouter><AdminDecisionSends /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: /Reconcile/i })[0]);

    await waitFor(() => {
      expect(screen.getByText('Reconcile Final Decision Send')).toBeInTheDocument();
    });

    const statusSelect = screen.getByLabelText(/Verified Status/i);
    fireEvent.mouseDown(statusSelect);
    await waitFor(() => screen.getByText(/FAILED.*provider confirmed not sent/i));
    fireEvent.click(screen.getByText(/FAILED.*provider confirmed not sent/i));

    const reasonInput = screen.getByLabelText(/Reason/i);
    fireEvent.change(reasonInput, { target: { value: 'Provider bounce' } });

    fireEvent.click(screen.getByRole('button', { name: /Confirm$/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/admin/decision-sends/app-1/reconcile', {
        status: 'FAILED',
        messageId: undefined,
        reason: 'Provider bounce',
      });
    });
  });

  it('shows an error alert when loading fails', async () => {
    api.get.mockRejectedValue(new Error('Network down'));
    render(<MemoryRouter><AdminDecisionSends /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByText(/Network down/i)).toBeInTheDocument();
    });
  });
});
