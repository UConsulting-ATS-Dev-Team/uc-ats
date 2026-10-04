import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import MemberInterviewInterface from './MemberInterviewInterface';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn() }
}));
vi.mock('../components/AccessControl', () => ({ default: ({ children }) => children }));
vi.mock('../components/chat/InterviewChatWidget', () => ({ default: () => null }));
vi.mock('../components/interview/InterviewQuestionPanel', () => ({ default: () => null }));
vi.mock('../components/deliberations/DecisionGuide', () => ({
  DecisionGuideButton: () => null,
  DecisionGuidePanel: () => null,
  DeliberationNotice: () => null,
  useDecisionGuide: () => ({ guide: null, open: false, openGuide: () => {}, closeGuide: () => {} })
}));

const config = {
  applicationGroups: [
    { id: 'g-4a', name: '4A', applicationIds: ['app-1'] },
    { id: 'g-5a', name: '5A', applicationIds: ['app-2'] }
  ],
  memberGroups: [{ id: 'mg-1', memberIds: ['user-1'] }],
  groupAssignments: { 'mg-1': ['g-4a', 'g-5a'] }
};

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.get.mockImplementation((url) => {
    if (url === '/member/profile') return Promise.resolve({ id: 'user-1' });
    if (url.endsWith('/config')) return Promise.resolve(config);
    if (url.includes('/applications')) return Promise.resolve([]);
    if (url.startsWith('/member/evaluations')) return Promise.resolve([]);
    return Promise.resolve({ id: 'int-1', title: 'Coffee Chats', interviewType: 'COFFEE_CHAT' });
  });
});

const openPicker = async () => {
  render(
    <MemoryRouter initialEntries={['/member/interview-interface?interviewId=int-1&groupIds=g-4a']}>
      <MemberInterviewInterface />
    </MemoryRouter>
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Select Groups' }));
  return screen.getByText('5A').closest('.group-selection-item');
};

describe('MemberInterviewInterface group picker', () => {
  it('selects a group with one click on its checkbox', async () => {
    const row = await openPicker();
    await userEvent.click(within(row).getByRole('checkbox'));

    expect(screen.getByText('1/3 groups selected')).toBeInTheDocument();
    expect(within(row).getByRole('checkbox')).toBeChecked();
  });

  it('selects a group with one click on its name, and a second click clears it', async () => {
    const row = await openPicker();
    await userEvent.click(screen.getByText('5A'));
    expect(screen.getByText('1/3 groups selected')).toBeInTheDocument();

    await userEvent.click(screen.getByText('5A'));
    expect(screen.getByText('0/3 groups selected')).toBeInTheDocument();
    expect(within(row).getByRole('checkbox')).not.toBeChecked();
  });
});
