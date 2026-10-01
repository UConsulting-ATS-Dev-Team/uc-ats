// My Interviews' Start Interview holds the first interview of a round behind that
// round's tutorials, through the real button, with the category from the interview.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AssignedInterviews from './AssignedInterviews';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../components/AccessControl', () => ({ default: ({ children }) => <>{children}</> }));

const interviewOf = (interviewType) => ({
  id: 'iv1',
  title: 'Fall First Rounds',
  interviewType,
  startDate: '2026-10-20T16:00:00.000Z',
  endDate: '2026-10-20T23:00:00.000Z',
  location: 'Bunche Hall',
  status: 'UPCOMING',
});

const TUTORIAL = { id: 't1', title: 'Running a First Round', videoUrl: 'https://youtu.be/abcdefghijk' };

const answer = (interviewType, required) => (url) => {
  if (url === '/member/profile') return Promise.resolve({ id: 'm1', fullName: 'Jordan Rivera' });
  if (url === '/member/interviews') return Promise.resolve([interviewOf(interviewType)]);
  if (url.startsWith('/member/interviews/iv1/config')) {
    return Promise.resolve({ memberGroups: [], applicationGroups: [], groupAssignments: {} });
  }
  if (url.startsWith('/member/help/tutorial-gates/')) {
    return Promise.resolve(required ? { required: true, cycleId: 'c1', tutorials: [TUTORIAL] } : { required: false });
  }
  return Promise.resolve([]);
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <AssignedInterviews />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.post.mockResolvedValue({ completed: true });
});

describe('Start Interview behind the round tutorial gate', () => {
  it("shows a first round's tutorials before the group picker, then the picker", async () => {
    apiClient.get.mockImplementation(answer('ROUND_ONE', true));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Start Interview/ }));

    expect(await screen.findByText(/before you run a first round/)).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith('/member/help/tutorial-gates/FIRST_ROUND');
    expect(screen.queryByText('Select Application Groups to Evaluate')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('I watched the whole tutorial'));
    fireEvent.click(screen.getByRole('button', { name: 'Start the interview' }));

    expect(await screen.findByText('Select Application Groups to Evaluate')).toBeInTheDocument();
    expect(apiClient.post).toHaveBeenCalledWith('/member/help/tutorial-gates/FIRST_ROUND/complete');
  });

  it("asks the coffee chat gate for a coffee chat", async () => {
    apiClient.get.mockImplementation(answer('COFFEE_CHAT', false));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Start Interview/ }));

    expect(await screen.findByText('Select Application Groups to Evaluate')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith('/member/help/tutorial-gates/COFFEE_CHATS');
  });
});
