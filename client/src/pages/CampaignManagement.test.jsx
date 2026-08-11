import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import CampaignManagement from './CampaignManagement';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

describe('CampaignManagement', () => {
  const cycles = [
    { id: 'cycle-1', name: 'Fall 2026', isActive: true },
  ];

  const templates = [
    { id: 'tpl-1', name: 'Welcome', subject: 'Welcome {{name}}', body: '<p>Hi {{name}},</p>', mergeFields: [], version: 1 },
  ];

  const audiences = [
    { id: 'aud-1', name: 'All applicants', filters: { statuses: ['SUBMITTED'] } },
  ];

  const sends = [
    {
      id: 'send-1',
      name: 'Welcome send',
      status: 'PENDING_APPROVAL',
      scheduledAt: null,
      recipientCount: null,
      template: { name: 'Welcome' },
      audience: { name: 'All applicants' },
    },
  ];

  let user;

  beforeEach(() => {
    user = userEvent.setup();
    vi.clearAllMocks();
    apiClient.get.mockImplementation((url) => {
      if (url === '/admin/cycles') return Promise.resolve(cycles);
      if (url.startsWith('/admin/campaigns/templates')) return Promise.resolve(templates);
      if (url.startsWith('/admin/campaigns/audiences')) return Promise.resolve(audiences);
      if (url.startsWith('/admin/campaigns/sends')) {
        if (url === '/admin/campaigns/sends/send-1/preview') {
          return Promise.resolve({
            sendId: 'send-1',
            count: 3,
            sample: [
              { email: 'alice@example.com', firstName: 'Alice' },
              { email: 'bob@example.com', firstName: 'Bob' },
            ],
            renderedPreview: '<p>Hi Alice,</p><p>Welcome to UConsulting.</p>',
            recipientSnapshot: [
              { email: 'alice@example.com', firstName: 'Alice' },
              { email: 'bob@example.com', firstName: 'Bob' },
              { email: 'charlie@example.com', firstName: 'Charlie' },
            ],
          });
        }
        return Promise.resolve(sends);
      }
      if (url === '/admin/campaigns/suppressions') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    apiClient.post.mockImplementation((url) => {
      if (url === '/admin/campaigns/sends/send-1/approve') {
        return Promise.resolve({ id: 'send-1', approvalFingerprint: 'fp-123' });
      }
      return Promise.resolve({});
    });
  });

  it('opens the approval preview dialog and shows rendered content and sample recipients', async () => {
    render(<MemoryRouter><CampaignManagement /></MemoryRouter>);

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith('/admin/cycles');
    });

    fireEvent.click(screen.getByRole('tab', { name: /sends/i }));

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith('/admin/campaigns/sends?cycleId=cycle-1');
    });

    await waitFor(() => {
      expect(screen.getByText('Welcome send')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Approve rendered content and audience'));

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith('/admin/campaigns/sends/send-1/preview');
    });

    expect(await screen.findByText(/Review campaign before approval/i)).toBeInTheDocument();
    expect(await screen.findByTestId('approval-recipient-count')).toHaveTextContent('Recipients: 3');
    expect(await screen.findByTestId('approval-sample')).toHaveTextContent(/alice@example.com/);
    expect(await screen.findByTestId('approval-rendered-preview')).toContainHTML('Hi Alice');
  });

  it('calls the approve endpoint and refreshes the sends list', async () => {
    render(<MemoryRouter><CampaignManagement /></MemoryRouter>);

    fireEvent.click(screen.getByRole('tab', { name: /sends/i }));

    await waitFor(() => {
      expect(screen.getByText('Welcome send')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Approve rendered content and audience'));

    await waitFor(() => {
      expect(screen.getByText(/Review campaign before approval/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /approve send/i }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/admin/campaigns/sends/send-1/approve', {});
    });

    await waitFor(() => {
      expect(screen.queryByText(/Review campaign before approval/i)).not.toBeInTheDocument();
    });
  });
});
