import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import InterviewManageList from './InterviewManageList';
import apiClient from '../../utils/api';

// The interviews in one round of the Interviews page. Sessions come from the
// round the page already loaded; only the interview records are fetched.

const slot = (id, interviewId, overrides = {}) => ({
  id,
  interviewId,
  label: `Session ${id}`,
  startTime: '2027-01-10T17:00:00Z',
  endTime: '2027-01-10T18:00:00Z',
  signups: [],
  interviewers: [],
  ...overrides,
});

const round = (interviews, slots = []) => ({
  round: 2,
  label: 'First Round Interviews',
  interviewType: 'ROUND_ONE',
  interviews,
  slots,
});

const renderList = (r) =>
  render(
    <MemoryRouter>
      <InterviewManageList round={r} />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('confirm', vi.fn(() => true));
  apiClient.get = vi.fn((endpoint) => {
    if (endpoint === '/admin/interviews') {
      return Promise.resolve([
        { id: 'iv1', title: 'W27 First Round', interviewType: 'ROUND_ONE', location: 'Bunche 2156' },
        { id: 'other', title: 'W27 Coffee Chats', interviewType: 'COFFEE_CHAT' },
      ]);
    }
    return Promise.resolve([]);
  });
  apiClient.post = vi.fn().mockResolvedValue({});
  apiClient.patch = vi.fn().mockResolvedValue({});
  apiClient.delete = vi.fn().mockResolvedValue({});
});

describe('InterviewManageList', () => {
  it('lists only the interviews in its round', async () => {
    renderList(round([{ id: 'iv1', title: 'W27 First Round', startDate: '2027-01-10T17:00:00Z' }]));

    expect(await screen.findByText(/Bunche 2156/)).toBeInTheDocument();
    expect(screen.getByText('W27 First Round')).toBeInTheDocument();
    expect(screen.queryByText('W27 Coffee Chats')).not.toBeInTheDocument();
    // One list call, not a roster fetch per interview.
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('blocks running an interview with no sessions', async () => {
    renderList(round([{ id: 'iv1', title: 'W27 First Round' }]));

    expect(await screen.findByText('No sessions yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run a session/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /add sessions/i })).toBeEnabled();
  });

  it('counts sessions from the round and offers them when running one', async () => {
    renderList(
      round(
        [{ id: 'iv1', title: 'W27 First Round' }],
        [slot('s1', 'iv1'), slot('s2', 'iv1'), slot('x', 'someone-else')]
      )
    );

    const row = await screen.findByTestId('interview-row-iv1');
    expect(within(row).getByText(/2 sessions/)).toBeInTheDocument();

    await userEvent.click(within(row).getByRole('button', { name: /run a session/i }));
    expect(screen.getByText('Session s1')).toBeInTheDocument();
    expect(screen.getByText('Session s2')).toBeInTheDocument();
    expect(screen.queryByText('Session x')).not.toBeInTheDocument();
  });

  it('deletes from the overflow menu', async () => {
    const onChanged = vi.fn();
    render(
      <MemoryRouter>
        <InterviewManageList round={round([{ id: 'iv1', title: 'W27 First Round' }])} onChanged={onChanged} />
      </MemoryRouter>
    );

    await userEvent.click(await screen.findByRole('button', { name: /more actions for w27 first round/i }));
    await userEvent.click(screen.getByText('Delete interview'));

    expect(apiClient.delete).toHaveBeenCalledWith('/admin/interviews/iv1');
    expect(onChanged).toHaveBeenCalled();
  });
});
