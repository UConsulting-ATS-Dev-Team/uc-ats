// The one-group picker on My Interviews: a click on another group swaps the
// pick, and the questions shown are always the picked group's.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AssignedInterviews from './AssignedInterviews';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../components/AccessControl', () => ({ default: ({ children }) => <>{children}</> }));

const INTERVIEW = {
  id: 'iv1',
  title: 'Fall Final Rounds',
  interviewType: 'FINAL_ROUND',
  startDate: '2026-10-20T16:00:00.000Z',
  endDate: '2026-10-20T23:00:00.000Z',
  status: 'UPCOMING',
};
const CONFIG = {
  memberGroups: [{ id: 'members-g1', name: 'Room 1', memberIds: ['m1'] }],
  applicationGroups: [
    { id: 'gA', name: 'Group A', applicationIds: ['a1'] },
    { id: 'gB', name: 'Group B', applicationIds: ['a2'] },
  ],
  groupAssignments: { 'members-g1': ['gA', 'gB'] },
};

let releaseGroupA;

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.get.mockImplementation((url) => {
    if (url === '/member/profile') return Promise.resolve({ id: 'm1', fullName: 'Jordan Rivera' });
    if (url === '/member/interviews') return Promise.resolve([INTERVIEW]);
    if (url === '/member/interviews/iv1/config?groupIds=gA') {
      return new Promise((resolve) => {
        releaseGroupA = () => resolve({ ...CONFIG, behavioralQuestions: { gA: ['Question for A'] } });
      });
    }
    if (url === '/member/interviews/iv1/config?groupIds=gB') {
      return Promise.resolve({ ...CONFIG, behavioralQuestions: { gB: ['Question for B'] } });
    }
    if (url.startsWith('/member/interviews/iv1/config')) return Promise.resolve({ ...CONFIG, behavioralQuestions: {} });
    if (url.startsWith('/member/help/tutorial-gates/')) return Promise.resolve({ required: false });
    return Promise.resolve([]);
  });
});

const openPicker = async () => {
  render(
    <MemoryRouter initialEntries={['/assigned-interviews']}>
      <AssignedInterviews />
    </MemoryRouter>
  );
  fireEvent.click(await screen.findByRole('button', { name: /Start Interview/ }));
  return (await screen.findByText('Select Application Groups to Evaluate')).closest('.modal-content');
};

describe('My Interviews one-group picker', () => {
  it('swaps the pick when another group is clicked', async () => {
    const picker = await openPicker();
    const groupA = within(picker).getByRole('checkbox', { name: /Group A/ });
    const groupB = within(picker).getByRole('checkbox', { name: /Group B/ });

    fireEvent.click(groupA);
    expect(groupB).toHaveAttribute('aria-disabled', 'false');

    fireEvent.click(groupB);
    expect(groupA).toHaveAttribute('aria-checked', 'false');
    expect(groupB).toHaveAttribute('aria-checked', 'true');
  });

  it("keeps the picked group's questions when the earlier pick's arrive late", async () => {
    const picker = await openPicker();
    fireEvent.click(within(picker).getByRole('checkbox', { name: /Group A/ }));
    fireEvent.click(within(picker).getByRole('checkbox', { name: /Group B/ }));
    await act(async () => {});

    await act(async () => releaseGroupA());

    fireEvent.click(screen.getByRole('button', { name: /Start Interview \(1 group/ }));
    expect(await screen.findByDisplayValue('Question for B')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Question for A')).not.toBeInTheDocument();
  });
});
