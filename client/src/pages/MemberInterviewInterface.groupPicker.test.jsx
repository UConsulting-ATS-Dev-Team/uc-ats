import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

// The row is the control; the input inside it is only drawn.
const openPicker = async () => {
  render(
    <MemoryRouter initialEntries={['/member/interview-interface?interviewId=int-1&groupIds=g-4a']}>
      <MemberInterviewInterface />
    </MemoryRouter>
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Select Groups' }));
  return screen.getByRole('checkbox', { name: /5A/ });
};

describe('MemberInterviewInterface group picker', () => {
  it('selects a group with one click on the box drawn beside it', async () => {
    const row = await openPicker();
    await userEvent.click(row.querySelector('.checkmark'));

    expect(screen.getByText('1/3 groups selected')).toBeInTheDocument();
    expect(row).toHaveAttribute('aria-checked', 'true');
  });

  // jsdom ignores the CSS that keeps clicks off the input, so this click lands
  // on it, as every click on the box did before: it must still count once.
  it('counts a click that reaches the hidden input once', async () => {
    const row = await openPicker();
    await userEvent.click(row.querySelector('input'));

    expect(screen.getByText('1/3 groups selected')).toBeInTheDocument();
  });

  it('selects a group with one click on its name, and a second click clears it', async () => {
    const row = await openPicker();
    await userEvent.click(screen.getByText('5A'));
    expect(screen.getByText('1/3 groups selected')).toBeInTheDocument();

    await userEvent.click(screen.getByText('5A'));
    expect(screen.getByText('0/3 groups selected')).toBeInTheDocument();
    expect(row).toHaveAttribute('aria-checked', 'false');
  });

  it('selects a group from the keyboard', async () => {
    const row = await openPicker();
    row.focus();
    await userEvent.keyboard(' ');
    expect(screen.getByText('1/3 groups selected')).toBeInTheDocument();

    await userEvent.keyboard('{Enter}');
    expect(screen.getByText('0/3 groups selected')).toBeInTheDocument();
  });
});
