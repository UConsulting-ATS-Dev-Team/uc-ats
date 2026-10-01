// The Interviews page's "Questions" dialog: it shows a session's saved questions as
// text, and saves them as a questions update the server recognises.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import InterviewManageList from './InterviewManageList';
import apiClient from '../../utils/api';

vi.mock('../../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const round = {
  round: 3,
  label: 'Final Round Interviews',
  interviewType: 'FINAL_ROUND',
  interviews: [{ id: 'iv1', title: 'Fall Final Rounds', startDate: '2026-10-28T16:00:00.000Z', status: 'UPCOMING' }],
  slots: [{ id: 's1', interviewId: 'iv1', label: 'Room A', signups: [], interviewers: [] }],
  unassigned: [],
  stats: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.get.mockImplementation((url) => {
    if (url.startsWith('/admin/interviews/iv1/config')) {
      return Promise.resolve({ behavioralQuestions: { s1: [{ id: 'q1', text: 'Why consulting?', order: 0 }] } });
    }
    return Promise.resolve([]);
  });
  apiClient.patch.mockResolvedValue({ success: true });
});

describe('Questions dialog', () => {
  it('shows saved questions as text and saves them as a questions update', async () => {
    render(
      <MemoryRouter>
        <InterviewManageList round={round} onChanged={() => {}} />
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: /^Questions$/ }));
    expect(await screen.findByDisplayValue('Why consulting?')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('[object Object]')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith('/admin/interviews/iv1/config', {
        type: 'behavioral_questions',
        config: { behavioralQuestions: true, groupId: 's1', questions: ['Why consulting?'] },
      })
    );
  });
});
