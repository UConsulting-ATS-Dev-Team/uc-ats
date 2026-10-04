// The decision batch page is where an admin sees what happened to a send, so
// these check that the states needing a person show up as things to act on.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DecisionBatchPanel from './DecisionBatchPanel';
import apiClient from '../../utils/api';

const person = (overrides) => ({
  firstName: 'Sam',
  lastName: 'Lee',
  email: 'sam@ucla.edu',
  status: 'PENDING',
  needsInvite: false,
  error: null,
  delivery: null,
  addressOk: true,
  ...overrides
});

const batchWith = (messages) => ({
  id: 'batch-1',
  roundLabel: 'Resume Review',
  processedAt: '2026-10-04T02:14:45Z',
  processedBy: { fullName: 'Exec' },
  cycle: { name: 'Fall 2026' },
  groups: [
    {
      outcome: 'REJECTED',
      label: 'Not moving forward',
      template: { subject: 'Update', body: 'Thank you.' },
      messages
    }
  ]
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(apiClient, 'post').mockResolvedValue({ subject: 'Update', html: '<p>Thank you.</p>' });
});

describe('a decision batch', () => {
  it('turns sending off until an address that cannot receive mail is fixed', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(
      batchWith([person({ id: 'm1' }), person({ id: 'm2', firstName: 'Dana', email: 'd', addressOk: false })])
    );
    render(<DecisionBatchPanel initialBatchId="batch-1" />);

    expect(await screen.findByText('Not an address')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve & send 2 emails/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: "Change Dana Lee's email address" })).toBeInTheDocument();
  });

  it('asks an admin to settle a send that was cut off', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(batchWith([person({ id: 'm1', status: 'UNCONFIRMED' })]));
    render(<DecisionBatchPanel initialBatchId="batch-1" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Send again' }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/master-communications/decision-batches/batch-1/resolve', {
        messageIds: ['m1'],
        resolution: 'SEND_AGAIN'
      })
    );
    expect(screen.getByRole('button', { name: 'Mark sent' })).toBeInTheDocument();
  });

  it('shows what SES reported once a message is sent', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(
      batchWith([person({ id: 'm1', status: 'SENT', delivery: { status: 'BOUNCED', error: 'Mailbox does not exist' } })])
    );
    render(<DecisionBatchPanel initialBatchId="batch-1" />);
    expect(await screen.findByText('Bounced')).toBeInTheDocument();
  });

  it('shows progress and a way to stop while sending', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(
      batchWith([person({ id: 'm1', status: 'SENT' }), person({ id: 'm2', status: 'QUEUED' })])
    );
    render(<DecisionBatchPanel initialBatchId="batch-1" />);

    expect(await screen.findByRole('button', { name: 'Stop sending' })).toBeInTheDocument();
    const bars = screen.getAllByRole('progressbar').map((bar) => bar.getAttribute('aria-valuenow'));
    expect(bars).toContain('50');
  });
});
