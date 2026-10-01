// "Run a session" holds an admin's first session of a round behind that round's
// tutorials, through the real button, with the category taken from the interview.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import InterviewManageList from './InterviewManageList';
import apiClient from '../../utils/api';

vi.mock('../../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const roundOf = (interviewType, label) => ({
  round: 2,
  label,
  interviewType,
  interviews: [{ id: 'iv1', title: `Fall ${label}`, startDate: '2026-10-14T16:00:00.000Z', status: 'UPCOMING' }],
  slots: [{ id: 's1', interviewId: 'iv1', label: 'Afternoon Session', signups: [], interviewers: [] }],
  unassigned: [],
  stats: {},
});

const TUTORIAL = { id: 't1', title: 'Running a Coffee Chat', videoUrl: 'https://youtu.be/abcdefghijk' };

const gateAnswer = (required) => (url) => {
  if (url.startsWith('/member/help/tutorial-gates/')) {
    return Promise.resolve(required ? { required: true, cycleId: 'c1', tutorials: [TUTORIAL] } : { required: false });
  }
  return Promise.resolve([]);
};

const renderList = (round) =>
  render(
    <MemoryRouter>
      <InterviewManageList round={round} onChanged={() => {}} />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.post.mockResolvedValue({ completed: true });
});

describe('Run a session behind the round tutorial gate', () => {
  it("shows a coffee chat's tutorials before the session picker, then the picker", async () => {
    apiClient.get.mockImplementation(gateAnswer(true));
    renderList(roundOf('COFFEE_CHAT', 'Coffee Chats'));

    fireEvent.click(await screen.findByRole('button', { name: /Run a session/ }));

    expect(await screen.findByText(/before you run a coffee chat/)).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith('/member/help/tutorial-gates/COFFEE_CHATS');
    expect(screen.queryByText('Which session are you running?')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('I watched the whole tutorial'));
    fireEvent.click(screen.getByRole('button', { name: 'Start the interview' }));

    expect(await screen.findByText('Which session are you running?')).toBeInTheDocument();
    expect(apiClient.post).toHaveBeenCalledWith('/member/help/tutorial-gates/COFFEE_CHATS/complete', { cycleId: 'c1', token: null });
  });

  it("asks the final round's gate for a final round", async () => {
    apiClient.get.mockImplementation(gateAnswer(false));
    renderList(roundOf('FINAL_ROUND', 'Final Round Interviews'));

    fireEvent.click(await screen.findByRole('button', { name: /Run a session/ }));

    expect(await screen.findByText('Which session are you running?')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith('/member/help/tutorial-gates/FINAL_ROUND');
  });
});
