import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import apiClient from '../../utils/api';
import CandidateCommunications from './CandidateCommunications';
import { statusStyleFor } from './communicationLabels';

vi.mock('../../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

const row = (overrides = {}) => ({
  id: 'r1',
  channel: 'email',
  category: 'APPLICATION_RECEIVED',
  trigger: 'AUTOMATED',
  status: 'SENT',
  recipient: 'maria@g.ucla.edu',
  recipientName: 'Maria Lopez',
  subject: 'We Received Your Application - Fall 2026',
  bodyPreview: 'Thank you for applying to UConsulting!',
  sentAt: '2026-10-02T00:53:36.000Z',
  ...overrides,
});

const page = (rows, total = rows.length) => ({
  rows,
  total,
  limit: 25,
  offset: 0,
  matchedOn: { emails: ['maria@g.ucla.edu', 'maria@ucla.edu'], phones: ['3105551234'] },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CandidateCommunications', () => {
  it('lists what was sent and says which addresses it searched', async () => {
    apiClient.get.mockResolvedValue(page([row()]));

    render(<CandidateCommunications candidateId="cand-1" />);

    expect(await screen.findByText('We Received Your Application - Fall 2026')).toBeTruthy();
    expect(screen.getByText('Application received')).toBeTruthy();
    expect(screen.getByText('Communications (1)')).toBeTruthy();
    expect(screen.getByText(/maria@g\.ucla\.edu, maria@ucla\.edu, 3105551234/)).toBeTruthy();
    expect(apiClient.get).toHaveBeenCalledWith('/admin/candidate-communications/cand-1?limit=25&offset=0');
  });

  it('opens the message when a row is clicked', async () => {
    apiClient.get.mockResolvedValue(page([row()]));
    render(<CandidateCommunications candidateId="cand-1" />);

    fireEvent.click(await screen.findByText('We Received Your Application - Fall 2026'));

    expect(await screen.findByText('Thank you for applying to UConsulting!')).toBeTruthy();
  });

  it('loads the next page on demand', async () => {
    apiClient.get
      .mockResolvedValueOnce(page([row({ id: 'r1' })], 2))
      .mockResolvedValueOnce({ ...page([row({ id: 'r2', subject: 'Older one' })], 2), offset: 1 });
    render(<CandidateCommunications candidateId="cand-1" />);

    fireEvent.click(await screen.findByText('Load more'));

    expect(await screen.findByText('Older one')).toBeTruthy();
    expect(apiClient.get).toHaveBeenLastCalledWith('/admin/candidate-communications/cand-1?limit=25&offset=1');
    await waitFor(() => expect(screen.queryByText('Load more')).toBeNull());
  });

  it('says so when nothing has been sent', async () => {
    apiClient.get.mockResolvedValue(page([]));
    render(<CandidateCommunications candidateId="cand-1" />);

    expect(await screen.findByText('Nothing has been sent to this candidate')).toBeTruthy();
  });

  it('shows the error when the history cannot load', async () => {
    apiClient.get.mockRejectedValue(new Error('Failed to load communications'));
    render(<CandidateCommunications candidateId="cand-1" />);

    expect(await screen.findByText('Failed to load communications')).toBeTruthy();
  });
});

describe('statusStyleFor', () => {
  const now = new Date('2026-10-02T01:00:00.000Z').getTime();

  it('shows a fresh claim as sending, not failed', () => {
    expect(statusStyleFor({ status: 'SENDING', sentAt: '2026-10-02T00:59:59.000Z' }, now).label).toBe('Sending…');
  });

  it('calls a claim that never finished interrupted', () => {
    expect(statusStyleFor({ status: 'SENDING', sentAt: '2026-10-02T00:30:00.000Z' }, now))
      .toEqual({ color: 'error', label: 'Interrupted' });
  });

  it('passes unknown statuses through as they are', () => {
    expect(statusStyleFor({ status: 'NEW_THING', sentAt: '2026-10-02T00:30:00.000Z' }, now).label).toBe('NEW_THING');
  });
});
