import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import InterviewQuestionPanel from './InterviewQuestionPanel';

vi.mock('../../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../../context/AuthContext', () => ({ useAuth: vi.fn() }));

// One fake Supabase channel, inspected by the broadcast tests below. `vi.hoisted` because
// the mock factory is hoisted above every other statement in this file.
const realtime = vi.hoisted(() => {
  const state = { name: null, handler: null, subscribed: null, unsubscribed: 0, removed: 0 };
  state.channel = {
    on: (_type, _filter, handler) => {
      state.handler = handler;
      return state.channel;
    },
    subscribe: (cb) => {
      state.subscribed = cb;
      return state.channel;
    },
    unsubscribe: () => {
      state.unsubscribed += 1;
    },
  };
  state.reset = () => {
    state.name = null;
    state.handler = null;
    state.subscribed = null;
    state.unsubscribed = 0;
    state.removed = 0;
  };
  return state;
});

vi.mock('../../supabaseClient', () => ({
  supabase: {
    channel: (name) => {
      realtime.name = name;
      return realtime.channel;
    },
    removeChannel: () => {
      realtime.removed += 1;
    },
  },
}));

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

function mockGets({ session = [mine, theirs], bank = bankRows } = {}) {
  apiClient.get.mockImplementation((url) => {
    if (url.includes('/question-bank/facets')) return Promise.resolve(facets);
    if (url.includes('/question-bank')) return Promise.resolve(bank);
    if (url.includes('/session-questions')) return Promise.resolve(session);
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
    realtime.reset();
    useAuth.mockReturnValue({ user: me });
    mockGets();
  });

  afterEach(() => vi.useRealTimers());

  it('renders nothing without an interview', () => {
    const { container } = render(<InterviewQuestionPanel interviewId={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(['COFFEE_CHAT', 'DELIBERATIONS', undefined])('renders nothing for a %s interview', (round) => {
    const { container } = render(<InterviewQuestionPanel interviewId="int-1" round={round} />);
    expect(container).toBeEmptyDOMElement();
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it.each(['ROUND_ONE', 'ROUND_TWO', 'FINAL_ROUND'])('offers the question panel in a %s interview', (round) => {
    render(<InterviewQuestionPanel interviewId="int-1" round={round} />);
    expect(screen.getByRole('button', { name: 'Interview questions' })).toBeInTheDocument();
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

  // The bank an interviewer browses belongs to the interview's own cycle. Asking for it
  // by cycle meant asking for whichever cycle was active right now, which is a different
  // cycle the moment recruitment moves on - and then the bank comes back empty and there
  // is nothing to add. Asking by interview is what keeps the two from drifting apart.
  it('asks for the bank of this interview, never a bare cycle-scoped list', async () => {
    // Served under either shape on purpose: the assertion below is about which endpoint
    // was asked, not about whether anything came back.
    apiClient.get.mockImplementation((url) => {
      if (url.includes('facets')) return Promise.resolve(facets);
      if (url.includes('question-bank') || url.includes('/member/interview-questions')) {
        return Promise.resolve(bankRows);
      }
      if (url.includes('/session-questions')) return Promise.resolve([mine, theirs]);
      return Promise.resolve([]);
    });
    renderPanel();
    await openPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Question bank' }));
    await waitFor(() => expect(screen.getByText('Size the LA scooter market.')).toBeInTheDocument());

    const urls = apiClient.get.mock.calls.map(([url]) => url);
    expect(urls.some((u) => u.startsWith('/member/interviews/int-1/question-bank'))).toBe(true);
    expect(urls.some((u) => u.startsWith('/member/interview-questions'))).toBe(false);
    expect(urls.some((u) => u.startsWith('/member/interviews/int-1/question-bank/facets'))).toBe(true);
  });

  // A full read rebuilds the list from scratch, so one that started before the Add landed
  // used to wipe the new question straight back out again. The button said it worked, the
  // question showed for an instant, and then it was gone - which is what "Add does not
  // add it" looked like from the interviewer's side.
  it('keeps a question added while a read was already in flight', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    let releasePoll;
    let sessionReads = 0;
    apiClient.get.mockImplementation((url) => {
      if (url.includes('facets')) return Promise.resolve(facets);
      if (url.includes('question-bank') || url.includes('/member/interview-questions')) {
        return Promise.resolve(bankRows);
      }
      if (url.includes('/session-questions')) {
        sessionReads += 1;
        // The first read is the panel opening. The second is the fallback poll, and it is
        // held open across the Add so it lands afterwards carrying the older list.
        if (sessionReads === 1) return Promise.resolve([]);
        return new Promise((resolve) => { releasePoll = resolve; });
      }
      return Promise.resolve([]);
    });
    apiClient.post.mockResolvedValue({
      id: 'sq-9',
      interviewId: 'int-1',
      prompt: 'Size the LA scooter market.',
      guidance: null,
      questionBankId: 'bank-2',
      addedBy: 'me-1',
      position: 1,
      updatedAt: '2026-08-27T10:03:00.000Z',
      deletedAt: null,
    });

    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Interview questions' }));
    await waitFor(() => expect(screen.getByText(/No questions queued/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: 'Question bank' }));
    await waitFor(() => expect(screen.getByText('Size the LA scooter market.')).toBeInTheDocument());

    // The fallback poll fires and is left in flight...
    await act(async () => { vi.advanceTimersByTime(10000); });
    await waitFor(() => expect(typeof releasePoll).toBe('function'));

    // ...while the interviewer adds a question.
    fireEvent.click(screen.getByRole('button', { name: 'Add: Size the LA scooter market.' }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());

    // Now the stale read lands, still describing an empty interview.
    await act(async () => { releasePoll([]); });

    expect(await screen.findByRole('button', { name: /Already added/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('tab', { name: /This interview/ }));
    expect(await screen.findByText('Size the LA scooter market.')).toBeInTheDocument();
  });

  // The guard that protects a local write must not eat a co-interviewer's. An incremental
  // read only ever adds rows, so dropping one throws away the only copy of everything that
  // changed in the window it covers, and no later `since` read asks for that window again.
  it('keeps a co-interviewer\u2019s change that arrived during a local add', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // theirs is at 10:01, so the panel opens with a watermark of 10:01.
    const remote = {
      id: 'sq-3',
      interviewId: 'int-1',
      prompt: 'What did you learn from it?',
      guidance: null,
      questionBankId: null,
      addedBy: 'someone-else',
      position: 2,
      updatedAt: '2026-08-27T10:02:00.000Z',
      deletedAt: null,
    };

    let releasePoll;
    let sessionReads = 0;
    apiClient.get.mockImplementation((url) => {
      if (url.includes('facets')) return Promise.resolve(facets);
      if (url.includes('question-bank')) return Promise.resolve(bankRows);
      if (url.includes('/session-questions')) {
        sessionReads += 1;
        if (sessionReads === 1) return Promise.resolve([mine, theirs]);
        // The poll carries the co-interviewer's question, written before the local add.
        return new Promise((resolve) => { releasePoll = () => resolve([remote]); });
      }
      return Promise.resolve([]);
    });
    apiClient.post.mockResolvedValue({
      ...mine,
      id: 'sq-9',
      questionBankId: 'bank-2',
      prompt: 'Size the LA scooter market.',
      position: 3,
      // Stamped after the remote question, which is what used to strand it.
      updatedAt: '2026-08-27T10:03:00.000Z',
    });

    renderPanel();
    await openPanel();

    fireEvent.click(screen.getByRole('tab', { name: 'Question bank' }));
    await waitFor(() => expect(screen.getByText('Size the LA scooter market.')).toBeInTheDocument());

    await act(async () => { vi.advanceTimersByTime(10000); });
    await waitFor(() => expect(typeof releasePoll).toBe('function'));

    fireEvent.click(screen.getByRole('button', { name: 'Add: Size the LA scooter market.' }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());

    await act(async () => { releasePoll(); });

    fireEvent.click(screen.getByRole('tab', { name: /This interview/ }));
    // Both survive: the local add, and the remote question the poll was carrying.
    expect(await screen.findByText('Size the LA scooter market.')).toBeInTheDocument();
    expect(screen.getByText(remote.prompt)).toBeInTheDocument();
  });

  it('defaults the bank filter to the round being interviewed', async () => {
    renderPanel();
    await openPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Question bank' }));

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith(
        expect.stringContaining('/member/interviews/int-1/question-bank?round=ROUND_ONE')
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

  describe('realtime nudges', () => {
    const nudge = async (payload) => {
      await act(async () => {
        realtime.handler({ payload });
      });
    };

    it('subscribes to this interview’s channel only while the panel is open', async () => {
      renderPanel();
      expect(realtime.name).toBeNull();

      await openPanel();
      expect(realtime.name).toBe('interview-questions:int-1');

      fireEvent.click(screen.getByRole('button', { name: 'Close questions' }));
      await waitFor(() => expect(realtime.unsubscribed).toBe(1));
      expect(realtime.removed).toBe(1);
    });

    it('refetches when a nudge reports a change newer than the watermark', async () => {
      renderPanel();
      await openPanel();
      const before = apiClient.get.mock.calls.length;

      await nudge({ interviewId: 'int-1', at: '2026-08-27T10:05:00.000Z' });

      await waitFor(() => expect(apiClient.get.mock.calls.length).toBe(before + 1), {
        timeout: 2000,
      });
      // Incremental, not a full reload: the watermark from the open is still good.
      expect(apiClient.get.mock.calls.at(-1)[0]).toContain('since=');
    });

    it('collapses a burst of nudges into one refetch', async () => {
      renderPanel();
      await openPanel();
      const before = apiClient.get.mock.calls.length;

      // Nothing stops someone with the anon key from flooding the channel. Twelve events
      // must not become twelve authenticated reads from every panel on this interview.
      await act(async () => {
        for (let minute = 10; minute < 22; minute += 1) {
          realtime.handler({
            payload: { interviewId: 'int-1', at: `2026-08-27T10:${minute}:00.000Z` },
          });
        }
      });

      await waitFor(() => expect(apiClient.get.mock.calls.length).toBe(before + 1), {
        timeout: 2000,
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(apiClient.get.mock.calls.length).toBe(before + 1);
    });

    it('starts no read after the panel closes mid-flight', async () => {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });

      renderPanel();
      await openPanel();

      // The next session read hangs until this test lets it go.
      apiClient.get.mockImplementation((url) => {
        if (url.includes('/interview-questions/facets')) return Promise.resolve(facets);
        if (url.includes('/session-questions')) return gate.then(() => [mine, theirs]);
        return Promise.resolve([]);
      });

      await act(async () => {
        realtime.handler({ payload: { interviewId: 'int-1', at: '2026-08-27T10:30:00.000Z' } });
      });
      // Long enough that the coalesced read is genuinely in flight.
      await new Promise((resolve) => setTimeout(resolve, 700));

      // A second nudge lands while that read is still going - it queues a follow-up - and
      // then the panel closes before the first read comes back.
      await act(async () => {
        realtime.handler({ payload: { interviewId: 'int-1', at: '2026-08-27T10:31:00.000Z' } });
      });
      fireEvent.click(screen.getByRole('button', { name: 'Close questions' }));

      const before = apiClient.get.mock.calls.length;
      await act(async () => {
        release();
        await gate;
      });
      await new Promise((resolve) => setTimeout(resolve, 900));

      expect(apiClient.get.mock.calls.length).toBe(before);
    });

    it('keeps the ten-second poll while subscribed but undelivered', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderPanel();
      await openPanel();

      // The browser reached Supabase. That says nothing about the server being able to
      // publish - if its own credentials are missing, no nudge will ever arrive.
      act(() => realtime.subscribed('SUBSCRIBED'));
      const before = apiClient.get.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(11000);
      });

      expect(apiClient.get.mock.calls.length).toBeGreaterThan(before);
    });

    it('slows the poll once a nudge has proved delivery', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderPanel();
      await openPanel();
      act(() => realtime.subscribed('SUBSCRIBED'));

      await act(async () => {
        realtime.handler({ payload: { interviewId: 'int-1', at: '2026-08-27T10:30:00.000Z' } });
        await vi.advanceTimersByTimeAsync(1000);
      });
      const afterNudge = apiClient.get.mock.calls.length;

      // Eleven more seconds. The old interval would have polled by now; this one waits.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11000);
      });

      expect(apiClient.get.mock.calls.length).toBe(afterNudge);
    });

    it('ignores its own echo, and nudges for other interviews', async () => {
      renderPanel();
      await openPanel();
      const before = apiClient.get.mock.calls.length;

      // The server broadcasts, so the interviewer who added the question is sent their
      // own nudge. Their watermark already covers it.
      await nudge({ interviewId: 'int-1', at: theirs.updatedAt });
      await nudge({ interviewId: 'int-2', at: '2026-08-27T11:00:00.000Z' });

      // Long enough that a coalesced refetch would have fired.
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(apiClient.get.mock.calls.length).toBe(before);
    });
  });
});
