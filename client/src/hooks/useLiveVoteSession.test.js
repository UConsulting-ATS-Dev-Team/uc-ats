// State for one live vote reaches the page by poll, by host action response and
// by broadcast-prompted refetch, in whatever order the network delivers them.
// These pin the rule that makes that safe - never step back to an older version -
// plus joining, leaving and the optimistic vote.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import useLiveVoteSession from './useLiveVoteSession';
import liveVoteApi from '../utils/liveVoteApi';

const broadcast = { handler: null };

vi.mock('../supabaseClient', () => {
  const channel = {
    on: (type, filter, handler) => {
      broadcast.handler = handler;
      return channel;
    },
    subscribe: (callback) => {
      callback('SUBSCRIBED');
      return channel;
    },
    unsubscribe: () => {}
  };
  return { supabase: { channel: () => channel, removeChannel: () => {} } };
});

vi.mock('../utils/liveVoteApi', () => ({
  default: {
    join: vi.fn(), state: vi.fn(), vote: vi.fn(), leave: vi.fn(),
    begin: vi.fn(), close: vi.fn(), reopen: vi.fn(), navigate: vi.fn(), decide: vi.fn(), end: vi.fn()
  }
}));

const stateAt = (version, overrides = {}) => ({
  version,
  session: { id: 's1', status: 'ACTIVE', currentIndex: 0, candidateCount: 2 },
  me: { isHost: true },
  current: {
    sessionCandidateId: 'sc1',
    ballot: { id: 'b1', status: 'OPEN', myVote: null, canVote: true, votedCount: 0, eligibleCount: 3 }
  },
  ...overrides
});

beforeEach(() => {
  broadcast.handler = null;
  Object.values(liveVoteApi).forEach((fn) => fn.mockReset());
  liveVoteApi.join.mockResolvedValue(stateAt(1));
  liveVoteApi.state.mockResolvedValue(stateAt(1));
  liveVoteApi.leave.mockResolvedValue();
});

async function mount(options) {
  const hook = renderHook(() => useLiveVoteSession('s1', options));
  await waitFor(() => expect(hook.result.current.state?.version).toBe(1));
  return hook;
}

describe('useLiveVoteSession', () => {
  it('joins on mount and leaves on unmount', async () => {
    const { result, unmount } = await mount();
    expect(liveVoteApi.join).toHaveBeenCalledWith('s1');
    expect(result.current.connected).toBe(true);
    unmount();
    expect(liveVoteApi.leave).toHaveBeenCalledWith('s1');
  });

  it('never replaces newer state with an older poll', async () => {
    const { result } = await mount();
    liveVoteApi.close.mockResolvedValue(stateAt(5, { current: { sessionCandidateId: 'sc1', ballot: { id: 'b1', status: 'CLOSED' } } }));
    await act(() => result.current.close());
    expect(result.current.state.version).toBe(5);

    liveVoteApi.state.mockResolvedValue(stateAt(4));
    await act(() => result.current.refresh());
    expect(result.current.state.version).toBe(5);
    expect(result.current.state.current.ballot.status).toBe('CLOSED');
  });

  it('refetches when a broadcast announces a newer version, and ignores stale ones', async () => {
    await mount();
    liveVoteApi.state.mockClear().mockResolvedValue(stateAt(9));

    await act(async () => {
      broadcast.handler({ payload: { sessionId: 's1', version: 1, kind: 'control' } });
    });
    expect(liveVoteApi.state).not.toHaveBeenCalled();

    await act(async () => {
      broadcast.handler({ payload: { sessionId: 's1', version: 9, kind: 'control' } });
    });
    await waitFor(() => expect(liveVoteApi.state).toHaveBeenCalled());
  });

  it('shows a vote as cast straight away and takes it back if voting had closed', async () => {
    const onError = vi.fn();
    const { result } = await mount({ onError });

    let settle;
    liveVoteApi.vote.mockImplementation(() => new Promise((resolve, reject) => { settle = { resolve, reject }; }));
    act(() => { result.current.vote('YES'); });
    await waitFor(() => expect(result.current.myVote).toBe('YES'));

    await act(async () => {
      settle.reject(Object.assign(new Error('closed'), { code: 'BALLOT_CLOSED', status: 409 }));
    });
    await waitFor(() => expect(result.current.myVote).toBeNull());
    expect(onError).toHaveBeenCalledWith('Voting closed before your vote was counted.');
  });

  it('stays quiet when another admin already moved the session on', async () => {
    const onError = vi.fn();
    const { result } = await mount({ onError });
    liveVoteApi.navigate.mockRejectedValue(Object.assign(new Error('moved'), { code: 'STALE_INDEX', status: 409 }));
    await act(() => result.current.navigate(1));
    expect(onError).not.toHaveBeenCalled();
    expect(liveVoteApi.navigate).toHaveBeenCalledWith('s1', 0, 1);
  });

  it('shows the summary to someone who arrives after the session ended', async () => {
    liveVoteApi.join.mockRejectedValue(Object.assign(new Error('ended'), { code: 'SESSION_ENDED', status: 409 }));
    liveVoteApi.state.mockResolvedValue(stateAt(3, { session: { id: 's1', status: 'ENDED' } }));
    const { result } = renderHook(() => useLiveVoteSession('s1'));
    await waitFor(() => expect(result.current.state?.session.status).toBe('ENDED'));
    expect(result.current.error).toBeNull();
  });
});
