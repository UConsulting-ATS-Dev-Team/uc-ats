// The page stays mounted when the URL moves from one session to another, so a
// slow reply for the first must never land on the second.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import useReviewDelibSession from './useReviewDelibSession';
import reviewDelibApi from '../utils/reviewDelibApi';

vi.mock('../supabaseClient', () => ({ supabase: null }));
vi.mock('../utils/reviewDelibApi', () => ({
  default: {
    join: vi.fn(),
    state: vi.fn(),
    team: vi.fn(),
    candidate: vi.fn(),
    changes: vi.fn(),
    leave: vi.fn()
  }
}));

const stateFor = (id, version) => ({
  version,
  session: { id, groupName: id, status: 'ACTIVE', step: 'OVERVIEW', currentApplicationId: null, outlierApplicationIds: [] },
  viewer: { isHost: false },
  participants: []
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  reviewDelibApi.team.mockResolvedValue({ version: 1 });
  reviewDelibApi.state.mockImplementation((id) => Promise.resolve(stateFor(id, id === 'A' ? 50 : 3)));
});

describe('useReviewDelibSession', () => {
  it("drops the old session's join when the URL has moved on, and leaves it", async () => {
    const joinA = deferred();
    reviewDelibApi.join.mockImplementation((id) => (id === 'A' ? joinA.promise : Promise.resolve(stateFor('B', 3))));

    const { result, rerender } = renderHook(({ id }) => useReviewDelibSession(id), { initialProps: { id: 'A' } });
    rerender({ id: 'B' });
    await waitFor(() => expect(result.current.state?.session.id).toBe('B'));

    // A answers late, at a higher version than B's.
    await act(async () => { joinA.resolve(stateFor('A', 50)); });

    expect(result.current.state.session.id).toBe('B');
    expect(result.current.state.version).toBe(3);
    expect(reviewDelibApi.leave).toHaveBeenCalledWith('A');
  });

  it('keeps polling a session at a lower version than the one before it', async () => {
    reviewDelibApi.join.mockImplementation((id) => Promise.resolve(stateFor(id, id === 'A' ? 50 : 3)));
    let bVersion = 3;
    reviewDelibApi.state.mockImplementation((id) => Promise.resolve(stateFor(id, id === 'A' ? 50 : bVersion)));

    const { result, rerender } = renderHook(({ id }) => useReviewDelibSession(id), { initialProps: { id: 'A' } });
    await waitFor(() => expect(result.current.state?.version).toBe(50));
    await act(async () => { await result.current.refresh(); }); // a poll of A, at 50

    rerender({ id: 'B' });
    await waitFor(() => expect(result.current.state?.session.id).toBe('B'));
    bVersion = 4;
    await act(async () => { await result.current.refresh(); });
    expect(result.current.state.version).toBe(4);
  });

  it("ignores the old session's join error", async () => {
    const joinA = deferred();
    reviewDelibApi.join.mockImplementation((id) => (id === 'A' ? joinA.promise : Promise.resolve(stateFor('B', 3))));

    const { result, rerender } = renderHook(({ id }) => useReviewDelibSession(id), { initialProps: { id: 'A' } });
    rerender({ id: 'B' });
    await waitFor(() => expect(result.current.state?.session.id).toBe('B'));

    await act(async () => {
      joinA.resolve(Promise.reject(Object.assign(new Error('nope'), { code: 'NOT_ON_TEAM' })));
    });
    expect(result.current.error).toBe(null);
  });
});
