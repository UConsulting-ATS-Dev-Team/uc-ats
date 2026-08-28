import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import InterviewQuestionPanel from './InterviewQuestionPanel';

vi.mock('../../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../../context/AuthContext', () => ({ useAuth: vi.fn() }));

import apiClient from '../../utils/api';
import { useAuth } from '../../context/AuthContext';

const me = { id: 'me-1', role: 'MEMBER' };

const mine = {
  id: 'sq-1',
  interviewId: 'int-1',
  prompt: 'Tell me about a team you led.',
  guidance: 'Look for ownership.',
  questionBankId: 'bank-1',
  addedBy: 'me-1',
  position: 0,
  updatedAt: '2026-08-27T10:00:00.000Z',
  deletedAt: null,
};

const theirs = {
  id: 'sq-2',
  interviewId: 'int-1',
  prompt: 'Why consulting?',
  guidance: null,
  questionBankId: null,
  addedBy: 'someone-else',
  position: 1,
  updatedAt: '2026-08-27T10:01:00.000Z',
  deletedAt: null,
};

const bankRows = [
  { id: 'bank-1', prompt: 'Tell me about a team you led.', guidance: 'Look for ownership.', round: 'ROUND_ONE', category: 'Behavioral' },
  { id: 'bank-2', prompt: 'Size the LA scooter market.', guidance: null, round: 'ROUND_ONE', category: 'Casing' },
];

const facets = { categories: ['Behavioral', 'Casing'], rounds: ['ROUND_ONE'] };

function mockGets({ session = [me] && [mine, theirs], bank = bankRows } = {}) {
  apiClient.get.mockImplementation((url) => {
    if (url.includes('/interview-questions/facets')) return Promise.resolve(facets);
    if (url.includes('/session-questions')) return Promise.resolve(session);
    if (url.includes('/member/interview-questions')) return Promise.resolve(bank);
    return Promise.resolve([]);
  });
}

const renderPanel = () =>
  render(<InterviewQuestionPanel interviewId="int-1" round="ROUND_ONE" interviewTitle="W26 Round 1" />);

const openPanel = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Interview questions' }));
  await waitFor(() => expect(screen.getByText(mine.prompt)).toBeInTheDocument());
};

describe('InterviewQuestionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuth.mockReturnValue({ user: me });
    mockGets();
  });

  afterEach(() => vi.useRealTimers());

  it('renders nothing without an interview', () => {
    const { container } = render(<InterviewQuestionPanel interviewId={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('stays out of the way until opened, then shows the queued questions with guidance', async () => {
    renderPanel();
    expect(screen.queryByText(mine.prompt)).not.toBeInTheDocument();

    await openPanel();
    expect(screen.getByText('Why consulting?')).toBeInTheDocument();
    expect(screen.getByText('Look for ownership.')).toBeInTheDocument();
    expect(screen.getByText('W26 Round 1 · Round 1')).toBeInTheDocument();
  });

  it('does not fetch anything while closed', () => {
    renderPanel();
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it('only offers remove on questions the member added', async () => {
    renderPanel();
    await openPanel();

    expect(screen.getByRole('button', { name: `Remove: ${mine.prompt}` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Remove: ${theirs.prompt}` })).not.toBeInTheDocument();
  });

  it('lets an admin remove anyone’s question', async () => {
    useAuth.mockReturnValue({ user: { id: 'admin-1', role: 'ADMIN' } });
    renderPanel();
    await openPanel();

    expect(screen.getByRole('button', { name: `Remove: ${theirs.prompt}` })).toBeInTheDocument();
  });

  it('polls with a watermark taken from the rows, and drops tombstoned questions', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Interview questions' }));
    await waitFor(() => expect(screen.getByText(mine.prompt)).toBeInTheDocument());

    // The next poll reports that someone soft-deleted the second question.
    apiClient.get.mockImplementation((url) => {
      if (url.includes('/interview-questions/facets')) return Promise.resolve(facets);
      if (url.includes('/session-questions')) {
        return Promise.resolve([
          { ...theirs, deletedAt: '2026-08-27T10:05:00.000Z', updatedAt: '2026-08-27T10:05:00.000Z' },
        ]);
      }
      return Promise.resolve([]);
    });

    await act(async () => { vi.advanceTimersByTime(10000); });

    await waitFor(() => expect(screen.queryByText(theirs.prompt)).not.toBeInTheDocument());
    expect(screen.getByText(mine.prompt)).toBeInTheDocument();

    // The since value is the newest updatedAt seen, not the browser clock.
    const pollUrl = apiClient.get.mock.calls.map((c) => c[0]).find((u) => u.includes('since='));
    expect(pollUrl).toContain(encodeURIComponent(theirs.updatedAt));
  });

  it('adds an ad-hoc question without waiting for the next poll', async () => {
    const created = { ...theirs, id: 'sq-3', prompt: 'Anything for us?', addedBy: 'me-1', position: 2, updatedAt: '2026-08-27T10:02:00.000Z' };
    apiClient.post.mockResolvedValue(created);
    renderPanel();
    await openPanel();

    fireEvent.change(screen.getByLabelText('Add a question to this interview'), {
      target: { value: 'Anything for us?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add question' }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/member/interviews/int-1/session-questions', {
        prompt: 'Anything for us?',
      });
    });
    expect(await screen.findByText('Anything for us?')).toBeInTheDocument();
  });

  it('adds from the bank and marks what is already queued', async () => {
    apiClient.post.mockResolvedValue({ ...mine, id: 'sq-9', questionBankId: 'bank-2', prompt: 'Size the LA scooter market.', position: 2, updatedAt: '2026-08-27T10:03:00.000Z' });
    renderPanel();
    await openPanel();

    fireEvent.click(screen.getByRole('tab', { name: 'Question bank' }));
    await waitFor(() => expect(screen.getByText('Size the LA scooter market.')).toBeInTheDocument());

    // bank-1 is already in the session, so it cannot be added twice.
    expect(screen.getByRole('button', { name: /Already added/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Add: Size the LA scooter market.' }));
    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        '/member/interviews/int-1/session-questions/bank',
        { questionId: 'bank-2' }
      );
    });
  });

  it('defaults the bank filter to the round being interviewed', async () => {
    renderPanel();
    await openPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Question bank' }));

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith(
        expect.stringContaining('/member/interview-questions?round=ROUND_ONE')
      );
    });
  });

  it('sends the whole order on reorder', async () => {
    apiClient.patch.mockResolvedValue([
      { ...theirs, position: 0 },
      { ...mine, position: 1 },
    ]);
    renderPanel();
    await openPanel();

    fireEvent.click(screen.getByRole('button', { name: `Move down: ${mine.prompt}` }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        '/member/interviews/int-1/session-questions/reorder',
        { order: ['sq-2', 'sq-1'] }
      );
    });
  });

  it('resyncs and explains itself when someone else changed the list mid-reorder', async () => {
    apiClient.patch.mockRejectedValue(new Error('order must list every active question (Status: 409)'));
    renderPanel();
    await openPanel();

    const getsBefore = apiClient.get.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: `Move down: ${mine.prompt}` }));

    expect(await screen.findByText('Another interviewer changed the list. Reloaded.')).toBeInTheDocument();
    await waitFor(() => expect(apiClient.get.mock.calls.length).toBeGreaterThan(getsBefore));
    // A resync must be a full read - the local watermark is no longer trustworthy.
    const last = apiClient.get.mock.calls.at(-1)[0];
    expect(last).not.toContain('since=');
  });

  it('surfaces a failed load rather than showing an empty question list', async () => {
    apiClient.get.mockImplementation((url) => {
      if (url.includes('/interview-questions/facets')) return Promise.resolve(facets);
      return Promise.reject(new Error('Not assigned to this interview (Status: 403)'));
    });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Interview questions' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Not assigned to this interview');
  });
});
