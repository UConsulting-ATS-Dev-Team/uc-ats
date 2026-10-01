// Final round "Add Question" asks for the question and saves it; it used to append an
// empty string the server drops, and still say "Question added successfully!".
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FinalRoundInterviewInterface from './FinalRoundInterviewInterface';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../components/AccessControl', () => ({ default: ({ children }) => <>{children}</> }));
vi.mock('../components/chat/InterviewChatWidget', () => ({ default: () => null }));
vi.mock('../components/interview/InterviewQuestionPanel', () => ({ default: () => null }));
vi.mock('../components/case/CaseViewer', () => ({ default: () => null }));
vi.mock('../components/interview/RoundOneHistoryPanel', () => ({ default: () => null }));

const QUESTIONS = { g1: [{ id: 'q1', text: 'Why consulting?', order: 0, createdBy: { fullName: 'Jordan Rivera' } }] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  apiClient.get.mockImplementation((url) => {
    if (url === '/member/profile') return Promise.resolve({ id: 'm1', role: 'MEMBER' });
    if (url === '/member/interviews/iv1') return Promise.resolve({ id: 'iv1', title: 'Final Rounds', interviewType: 'FINAL_ROUND' });
    if (url.startsWith('/member/interviews/iv1/config')) return Promise.resolve({ behavioralQuestions: QUESTIONS });
    if (url.startsWith('/member/interviews/iv1/applications')) return Promise.resolve([{ id: 'a1', name: 'Taylor Kim' }]);
    if (url.startsWith('/member/evaluations')) return Promise.resolve([]);
    if (url.startsWith('/cases/interviews/iv1/permissions')) return Promise.resolve({ canManage: false });
    return Promise.resolve([]);
  });
  apiClient.patch.mockResolvedValue({ success: true });
});

const renderPage = async () => {
  render(
    <MemoryRouter initialEntries={['/member/final-round-interview?interviewId=iv1&groupIds=g1']}>
      <FinalRoundInterviewInterface />
    </MemoryRouter>
  );
  await screen.findAllByText('Why consulting?');
};

describe('final round Add Question', () => {
  it('saves the question typed into the prompt alongside the existing ones', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('  Tell us about a hard call you made.  ');
    await renderPage();

    fireEvent.click(screen.getAllByRole('button', { name: /Add Question/ })[0]);

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith('/member/interviews/iv1/config', {
        type: 'behavioral_questions',
        config: {
          behavioralQuestions: true,
          groupId: 'g1',
          questions: ['Why consulting?', 'Tell us about a hard call you made.'],
        },
      })
    );
  });

  it.each([
    ['cancelled', null],
    ['blank', '   '],
  ])('sends nothing when the prompt is %s', async (_, answer) => {
    vi.spyOn(window, 'prompt').mockReturnValue(answer);
    await renderPage();

    fireEvent.click(screen.getAllByRole('button', { name: /Add Question/ })[0]);

    await new Promise((r) => setTimeout(r, 50));
    expect(apiClient.patch).not.toHaveBeenCalled();
    expect(window.alert).not.toHaveBeenCalledWith('Question added successfully!');
  });
});
