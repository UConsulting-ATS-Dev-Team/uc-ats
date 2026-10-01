import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import InterviewInterface from './InterviewInterface';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../components/AccessControl', () => ({ default: ({ children }) => <>{children}</> }));
vi.mock('../components/chat/InterviewChatWidget', () => ({ default: () => null }));
vi.mock('../components/interview/InterviewQuestionPanel', () => ({ default: () => null }));

const admin = { id: 'ad1', fullName: 'Ryan K', role: 'ADMIN' };
// A slot-based coffee chat: the roster lives in sessions, so the interview's
// description holds no applicationGroups at all.
const interview = { id: 'iv1', title: 'Coffee Chats', interviewType: 'COFFEE_CHAT', description: 'Come say hi' };
const config = {
  source: 'slots',
  memberGroups: [{ id: 'members-s1', name: 'Morning Session', memberIds: ['m1'], slotId: 's1' }],
  applicationGroups: [
    { id: 's1', name: 'Morning Session', applicationIds: ['a1', 'a2'] },
    { id: 's2', name: 'Evening Session', applicationIds: ['a3'] },
  ],
  groupAssignments: { 'members-s1': ['s1'] },
};
const applications = [{ id: 'a1', name: 'Taylor Kim', major: 'Economics', year: 2028 }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  apiClient.get.mockImplementation((url) => {
    if (url === '/admin/profile') return Promise.resolve(admin);
    if (url === '/admin/interviews/iv1') return Promise.resolve(interview);
    if (url.startsWith('/admin/interviews/iv1/applications')) return Promise.resolve(applications);
    if (url.startsWith('/admin/interviews/iv1/config')) return Promise.resolve(config);
    if (url === '/admin/interviews/iv1/evaluations') return Promise.resolve([]);
    if (url.startsWith('/decision-guides/')) return Promise.reject(new Error('no guide'));
    return Promise.resolve([]);
  });
  apiClient.post.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/interview-interface?interviewId=iv1&groupIds=s1']}>
      <InterviewInterface />
    </MemoryRouter>
  );

describe('InterviewInterface (admin)', () => {
  it('autosaves the edit just made, not the one before it', async () => {
    renderPage();
    await screen.findByText('Taylor Kim');
    vi.useFakeTimers();

    fireEvent.change(screen.getByPlaceholderText('Add your interview notes here...'), {
      target: { value: 'Great energy' },
    });
    fireEvent.click(screen.getByLabelText('Yes'));
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });

    expect(apiClient.post).toHaveBeenLastCalledWith(
      '/admin/interviews/iv1/evaluations',
      expect.objectContaining({ applicationId: 'a1', notes: 'Great energy', decision: 'YES' })
    );
  });

  it('offers every session under Interview Another Group', async () => {
    renderPage();
    await screen.findByText('Taylor Kim');

    fireEvent.click(screen.getByRole('button', { name: /Save All/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Interview Another Group/ }));

    expect(await screen.findByText('Morning Session')).toBeInTheDocument();
    expect(screen.getByText('Evening Session')).toBeInTheDocument();
    expect(screen.queryByText('No application groups available')).not.toBeInTheDocument();
  });
});
