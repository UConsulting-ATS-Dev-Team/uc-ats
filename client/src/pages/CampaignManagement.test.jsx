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

  let sends = [
    {
      id: 'send-1',
      name: 'Welcome send',
      status: 'PENDING_APPROVAL',
      scheduledAt: null,
      recipientCount: null,
      failedRecipientCount: null,
      previewCount: null,
      template: { name: 'Welcome' },
      audience: { name: 'All applicants' },
    },
  ];

  const sendDetail = {
    id: 'send-1',
    name: 'Welcome send',
    status: 'PARTIAL',
    recipientCount: 1,
    failedRecipientCount: 1,
    previewCount: 2,
    logs: [
      {
        id: 'log-1',
        email: 'bob@example.com',
        status: 'AMBIGUOUS',
        attemptNumber: 1,
        providerMessageId: 'ses-abc-123',
        error: 'SMTP timeout',
        renderedBody: '<p>Hi Bob</p>',
        resolutions: [],
      },
      {
        id: 'log-2',
        email: 'alice@example.com',
        status: 'SENT',
        attemptNumber: 1,
        providerMessageId: 'ses-def-456',
        error: null,
        renderedBody: '<p>Hi Alice</p>',
        resolutions: [],
      },
    ],
  };

  let user;

  beforeEach(() => {
    user = userEvent.setup();
    vi.clearAllMocks();
    sends = [
      {
        id: 'send-1',
        name: 'Welcome send',
        status: 'PENDING_APPROVAL',
        scheduledAt: null,
        recipientCount: null,
        failedRecipientCount: null,
        previewCount: null,
        template: { name: 'Welcome' },
        audience: { name: 'All applicants' },
      },
    ];
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
            approvalFingerprint: 'preview-fp-123',
          });
        }
        if (url === '/admin/campaigns/sends/send-1') {
          return Promise.resolve(sendDetail);
        }
        return Promise.resolve(sends);
      }
      if (url === '/admin/campaigns/suppressions') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    apiClient.post.mockImplementation((url, body) => {
      if (url === '/admin/campaigns/sends/send-1/approve') {
        return Promise.resolve({ id: 'send-1', approvalFingerprint: body?.approvalFingerprint });
      }
      if (url === '/admin/campaigns/logs/log-1/resolve') {
        return Promise.resolve({ id: 'log-1', status: body?.status, resolution: { id: 'res-1', status: body?.status, reason: body?.reason } });
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
    const previewFrame = await screen.findByTestId('approval-rendered-preview');
    expect(previewFrame).toHaveAttribute('sandbox', '');
    expect(previewFrame).toHaveAttribute('srcdoc', expect.stringContaining('Hi Alice'));
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
      expect(apiClient.post).toHaveBeenCalledWith('/admin/campaigns/sends/send-1/approve', {
        approvalFingerprint: 'preview-fp-123',
      });
    });

    await waitFor(() => {
      expect(screen.queryByText(/Review campaign before approval/i)).not.toBeInTheDocument();
    });
  });

  it('opens the send detail dialog, shows provider IDs and resolution controls for ambiguous logs, and submits an audited resolution', async () => {
    render(<MemoryRouter><CampaignManagement /></MemoryRouter>);

    fireEvent.click(screen.getByRole('tab', { name: /sends/i }));

    await waitFor(() => {
      expect(screen.getByText('Welcome send')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('View details'));

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith('/admin/campaigns/sends/send-1');
    });

    expect(screen.getByText('ses-abc-123')).toBeInTheDocument();
    expect(screen.getByText('SMTP timeout')).toBeInTheDocument();
    const deliveredBtn = screen.getByTestId('resolve-delivered-log-1');
    const failedBtn = screen.getByTestId('resolve-failed-log-1');
    expect(deliveredBtn).toBeInTheDocument();
    expect(failedBtn).toBeInTheDocument();
    expect(deliveredBtn).toBeDisabled();
    expect(failedBtn).toBeDisabled();

    const reasonInput = screen.getByTestId('resolve-reason-log-1').querySelector('input');
    fireEvent.change(reasonInput, { target: { value: '   ' } });
    expect(deliveredBtn).toBeDisabled();
    expect(failedBtn).toBeDisabled();

    fireEvent.change(reasonInput, { target: { value: 'SES console confirms delivery' } });
    expect(deliveredBtn).not.toBeDisabled();
    expect(failedBtn).not.toBeDisabled();
    fireEvent.click(deliveredBtn);

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/admin/campaigns/logs/log-1/resolve', {
        status: 'SENT',
        reason: 'SES console confirms delivery',
      });
    });
  });

  it('shows partial-failure status and successful/failed recipient counts in the sends table', async () => {
    sends = [
      {
        id: 'send-2',
        name: 'Mixed send',
        status: 'PARTIAL',
        scheduledAt: null,
        recipientCount: 2,
        failedRecipientCount: 1,
        previewCount: 3,
        template: { name: 'Welcome' },
        audience: { name: 'All applicants' },
      },
    ];

    render(<MemoryRouter><CampaignManagement /></MemoryRouter>);

    fireEvent.click(screen.getByRole('tab', { name: /sends/i }));

    await waitFor(() => {
      expect(screen.getByText('Partial failure')).toBeInTheDocument();
    });

    const cells = screen.getAllByText('1');
    expect(cells.length).toBeGreaterThanOrEqual(1);
  });
});
