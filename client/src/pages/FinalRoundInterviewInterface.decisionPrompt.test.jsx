// Save All on a final round ends by asking for a decision on each candidate still
// without one. The decision used to live only in My Evaluations, where members forgot
// it; the prompt can be put off, and a save from this page never clears a decision.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const QUESTIONS = { g1: [{ id: 'q1', text: 'Why consulting?', order: 0 }] };
const APPS = [
  { id: 'a1', name: 'Taylor Kim' },
  { id: 'a2', name: 'Sam Okafor' },
];
let evaluations;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  evaluations = [];
  apiClient.get.mockImplementation((url) => {
    if (url === '/member/profile') return Promise.resolve({ id: 'm1', role: 'MEMBER' });
    if (url === '/member/interviews/iv1') return Promise.resolve({ id: 'iv1', title: 'Final Rounds', interviewType: 'FINAL_ROUND' });
    if (url.startsWith('/member/interviews/iv1/config')) return Promise.resolve({ behavioralQuestions: QUESTIONS });
    if (url.startsWith('/member/interviews/iv1/applications')) return Promise.resolve(APPS);
    if (url.startsWith('/member/evaluations')) return Promise.resolve(evaluations);
    if (url.startsWith('/cases/interviews/iv1/permissions')) return Promise.resolve({ canManage: false });
    return Promise.resolve([]);
  });
  apiClient.post.mockResolvedValue({ success: true });
});

const renderPage = async () => {
  render(
    <MemoryRouter initialEntries={['/member/final-round-interview?interviewId=iv1&groupIds=g1']}>
      <FinalRoundInterviewInterface />
    </MemoryRouter>
  );
  await screen.findAllByText('Taylor Kim');
};

const saveAll = () => fireEvent.click(screen.getByRole('button', { name: /Save All/ }));

describe('final round decision prompt', () => {
  it('asks for each undecided candidate after Save All, and saves only what was picked', async () => {
    await renderPage();
    saveAll();

    const dialog = await screen.findByRole('dialog', { name: 'Your decision on each candidate' });
    expect(window.alert).not.toHaveBeenCalled();
    fireEvent.click(within(within(dialog).getByRole('group', { name: 'Decision for Taylor Kim' })).getByRole('button', { name: 'Yes' }));
    apiClient.post.mockClear();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save decisions' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith('/member/evaluations', { interviewId: 'iv1', applicationId: 'a1', decision: 'YES' });
  });

  it('can be put off, saving nothing', async () => {
    await renderPage();
    saveAll();
    const dialog = await screen.findByRole('dialog');
    apiClient.post.mockClear();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('does not ask once everyone has a decision', async () => {
    evaluations = APPS.map((a) => ({ applicationId: a.id, evaluatorId: 'm1', decision: 'MAYBE_YES', behavioralNotes: {} }));
    await renderPage();
    saveAll();
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('All evaluations saved successfully!'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never sends a decision the page does not have, so Save All cannot clear one', async () => {
    await renderPage();
    saveAll();
    await screen.findByRole('dialog');
    for (const [, body] of apiClient.post.mock.calls) expect(body).not.toHaveProperty('decision');
  });
});
