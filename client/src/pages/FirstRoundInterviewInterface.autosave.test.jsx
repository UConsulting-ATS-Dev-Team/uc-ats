// The first round page autosaves two seconds after the last edit. It used to send
// the evaluation as it stood before that edit, so the last change before a pause was
// never saved unless someone pressed Save All.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FirstRoundInterviewInterface from './FirstRoundInterviewInterface';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../components/AccessControl', () => ({ default: ({ children }) => <>{children}</> }));
vi.mock('../components/chat/InterviewChatWidget', () => ({ default: () => null }));
vi.mock('../components/interview/InterviewQuestionPanel', () => ({ default: () => null }));

const INTERVIEW = { id: 'iv1', title: 'Fall First Rounds', interviewType: 'ROUND_ONE' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  apiClient.get.mockImplementation((url) => {
    if (url === '/admin/profile') return Promise.reject(new Error('403'));
    if (url === '/member/profile') return Promise.resolve({ id: 'm1', role: 'MEMBER', fullName: 'Jordan Rivera' });
    if (url === '/member/interviews/iv1') return Promise.resolve(INTERVIEW);
    if (url.startsWith('/member/interviews/iv1/config')) {
      return Promise.resolve({ behavioralQuestions: { g1: [{ id: 'q1', text: 'Tell us about a setback', order: 0, createdBy: { fullName: 'Jordan Rivera' } }] } });
    }
    if (url.startsWith('/member/interviews/iv1/applications')) return Promise.resolve([{ id: 'a1', name: 'Taylor Kim', firstName: 'Taylor' }]);
    if (url.startsWith('/member/interviews/iv1/candidate-questions')) return Promise.resolve({});
    if (url.startsWith('/member/evaluations')) return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  apiClient.post.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('first round autosave', () => {
  it('saves the edit just made along with the ones before it', async () => {
    render(
      <MemoryRouter initialEntries={['/member/first-round-interview?interviewId=iv1&groupIds=g1']}>
        <FirstRoundInterviewInterface />
      </MemoryRouter>
    );
    await screen.findAllByText('Tell us about a setback');
    const [comments] = screen.getAllByPlaceholderText('Comments');
    vi.useFakeTimers();

    fireEvent.change(comments, { target: { value: 'Owned the miss, fixed the process' } });
    const [leadership] = screen.getAllByRole('combobox');
    fireEvent.change(leadership, { target: { value: '4' } });
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });

    const saves = apiClient.post.mock.calls.filter(([url]) => url === '/member/evaluations');
    expect(saves).toHaveLength(1);
    expect(saves[0][1]).toMatchObject({
      applicationId: 'a1',
      behavioralLeadership: 4,
      behavioralNotes: { q1: 'Owned the miss, fixed the process' },
    });
  });
});
