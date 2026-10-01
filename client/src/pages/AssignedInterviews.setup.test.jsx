// First round setup on My Interviews: the "Configure Questions" step lets an
// interviewer through once there is something to ask, whether that is a shared
// question or a question for one candidate.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import AssignedInterviews from './AssignedInterviews';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../components/AccessControl', () => ({ default: ({ children }) => <>{children}</> }));

const INTERVIEW = {
  id: 'iv1',
  title: 'Fall First Rounds',
  interviewType: 'ROUND_ONE',
  startDate: '2026-10-20T16:00:00.000Z',
  endDate: '2026-10-20T23:00:00.000Z',
  status: 'UPCOMING',
};
const CONFIG = {
  memberGroups: [{ id: 'members-g1', name: 'Room 1', memberIds: ['m1'] }],
  applicationGroups: [{ id: 'g1', name: 'Room 1 · 10:00', applicationIds: ['a1'] }],
  groupAssignments: { 'members-g1': ['g1'] },
};

const withCandidateQuestions = (byApplication) =>
  apiClient.get.mockImplementation((url) => {
    if (url === '/member/profile') return Promise.resolve({ id: 'm1', fullName: 'Jordan Rivera' });
    if (url === '/member/interviews') return Promise.resolve([INTERVIEW]);
    if (url.startsWith('/member/interviews/iv1/config')) return Promise.resolve({ ...CONFIG, behavioralQuestions: {} });
    if (url.startsWith('/member/interviews/iv1/applications')) {
      return Promise.resolve([{ id: 'a1', name: 'Taylor Kim', firstName: 'Taylor' }]);
    }
    if (url.startsWith('/member/interviews/iv1/candidate-questions')) return Promise.resolve(byApplication);
    if (url.startsWith('/member/help/tutorial-gates/')) return Promise.resolve({ required: false });
    return Promise.resolve([]);
  });

function Landed() {
  const { pathname, search } = useLocation();
  return <p>landed on {pathname}{search}</p>;
}

const openQuestionStep = async () => {
  render(
    <MemoryRouter initialEntries={['/assigned-interviews']}>
      <Routes>
        <Route path="/assigned-interviews" element={<AssignedInterviews />} />
        <Route path="*" element={<Landed />} />
      </Routes>
    </MemoryRouter>
  );
  fireEvent.click(await screen.findByRole('button', { name: /Start Interview/ }));
  const picker = (await screen.findByText('Select Application Groups to Evaluate')).closest('.modal-content');
  fireEvent.click(within(picker).getByText('Room 1 · 10:00'));
  fireEvent.click(screen.getByRole('button', { name: /Start Interview \(1 group/ }));
  await screen.findByText('Configure Behavioral Questions');
  await screen.findByText('Taylor Kim');
};

const configure = () => screen.getByRole('button', { name: /Configure Questions/ });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Configure Questions on first round setup', () => {
  it('goes ahead with only candidate-specific questions', async () => {
    withCandidateQuestions({ a1: [{ id: 'q1', text: 'Walk me through the pantry project', applicationId: 'a1' }] });
    await openQuestionStep();

    await waitFor(() => expect(configure()).toBeEnabled());

    fireEvent.click(configure());

    expect(
      await screen.findByText('landed on /member/first-round-interview?interviewId=iv1&groupIds=g1')
    ).toBeInTheDocument();
    // Nothing shared was written, so nothing shared is saved over what is there.
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it('waits while there is nothing to ask', async () => {
    withCandidateQuestions({});
    await openQuestionStep();

    expect(configure()).toBeDisabled();
    // An empty shared question is still nothing to ask.
    fireEvent.click(screen.getByRole('button', { name: /Add First Question/ }));
    expect(configure()).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Behavioral Question 1'), { target: { value: 'Tell me about a time…' } });
    expect(configure()).toBeEnabled();
  });
});
