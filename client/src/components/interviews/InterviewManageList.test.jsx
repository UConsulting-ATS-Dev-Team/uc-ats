import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import InterviewManageList from './InterviewManageList';
import apiClient from '../../utils/api';

// Replaces AdminAssignedInterviews.test.jsx. That page folded into the
// Interviews page and its create flow moved here; the coverage moves with it.

const cycle = { id: 'cycle-1', name: 'Test Cycle' };

const renderList = () =>
  render(
    <MemoryRouter>
      <InterviewManageList cycle={cycle} />
    </MemoryRouter>
  );

const roster = (slots = []) => ({ slots, unassigned: [] });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('confirm', vi.fn(() => true));
  apiClient.get = vi.fn((endpoint) => {
    if (endpoint === '/admin/interviews') return Promise.resolve([]);
    if (endpoint.includes('/roster')) return Promise.resolve(roster());
    return Promise.resolve([]);
  });
  apiClient.post = vi.fn().mockResolvedValue({});
  apiClient.patch = vi.fn().mockResolvedValue({});
  apiClient.delete = vi.fn().mockResolvedValue({});
});

describe('InterviewManageList', () => {
  it('says what to do when the cycle has no interviews', async () => {
    renderList();
    expect(await screen.findByText(/no interviews in this cycle yet/i)).toBeInTheDocument();
  });

  it('shows counts per interview and blocks running one with no sessions', async () => {
    apiClient.get = vi.fn((endpoint) => {
      if (endpoint === '/admin/interviews') {
        return Promise.resolve([
          { id: 'iv1', title: 'Coffee Chats', interviewType: 'COFFEE_CHAT', cycleId: 'cycle-1', startDate: '2027-01-10T17:00:00Z', location: 'Covel' },
        ]);
      }
      if (endpoint.includes('/roster')) return Promise.resolve(roster());
      return Promise.resolve([]);
    });
    renderList();

    expect(await screen.findByText('Coffee Chats')).toBeInTheDocument();
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run a session/i })).toBeDisabled();
  });
});

