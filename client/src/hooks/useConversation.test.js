import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import useConversation, { toggleLocally } from './useConversation';

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('../utils/api', () => ({
  default: {
    get: (...args) => mockGet(...args),
    post: (...args) => mockPost(...args)
  }
}));

// Null unless a test hands in a fake realtime client.
const mockRealtime = { client: null };
vi.mock('../supabaseClient', () => ({
  get supabase() {
    return mockRealtime.client;
  }
}));

/** A fake Supabase client whose channel lets a test fire broadcasts. */
function fakeRealtime() {
  const handlers = {};
  const channel = {
    on: (_type, { event }, handler) => {
      handlers[event] = handler;
      return channel;
    },
    subscribe: (cb) => {
      cb?.('SUBSCRIBED');
      return channel;
    },
    unsubscribe: () => {}
  };
  return {
    client: { channel: () => channel, removeChannel: () => {} },
    fire: (event, payload) => handlers[event]?.({ payload })
  };
}

describe('useConversation', () => {
  const currentUser = { id: 'user-1', fullName: 'Test User', email: 'test@test.local', role: 'MEMBER' };
  const resolve = vi.fn();

  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    resolve.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('loads conversation and messages', async () => {
    const conv = { id: 'conv-1', title: 'T', participants: [{ userId: 'user-1', lastReadAt: null }] };
    const history = [];
    resolve.mockResolvedValue(conv);
    mockGet.mockResolvedValue(history);

    const { result } = renderHook(() => useConversation({ resolve, currentUser }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.conversation).toEqual(conv);
    expect(result.current.messages).toEqual(history);
    expect(result.current.error).toBeNull();
  });

  it('shows empty state for a conversation with no messages', async () => {
    const conv = { id: 'conv-1', title: 'T', participants: [{ userId: 'user-1', lastReadAt: null }] };
    resolve.mockResolvedValue(conv);
    mockGet.mockResolvedValue([]);

    const { result } = renderHook(() => useConversation({ resolve, currentUser }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.messages).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });

  it('shows an error state when loading fails', async () => {
    resolve.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useConversation({ resolve, currentUser }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('Network error');
    expect(result.current.conversation).toBeNull();
  });

  it('shows an unauthorized error when the server returns 403', async () => {
    resolve.mockRejectedValue(new Error('Forbidden (Status: 403)'));

    const { result } = renderHook(() => useConversation({ resolve, currentUser }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toMatch(/Forbidden/);
  });

  it('sends a message and replaces the optimistic message with the persisted one', async () => {
    const conv = { id: 'conv-1', title: 'T', participants: [{ userId: 'user-1', lastReadAt: null }] };
    const created = { id: 'msg-1', conversationId: 'conv-1', body: 'hello', createdAt: '2026-01-01T00:00:00.000Z', editedAt: null, deletedAt: null, sender: currentUser };
    resolve.mockResolvedValue(conv);
    mockGet.mockResolvedValue([]);
    mockPost.mockResolvedValue(created);

    const { result } = renderHook(() => useConversation({ resolve, currentUser }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.send('hello'); });

    expect(mockPost).toHaveBeenCalledWith('/conversations/conv-1/messages', { body: 'hello' });
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0].id).toBe('msg-1');
    expect(result.current.sending).toBe(false);
  });

  it('prevents duplicate sends while a message is in flight', async () => {
    const conv = { id: 'conv-1', title: 'T', participants: [{ userId: 'user-1', lastReadAt: null }] };
    resolve.mockResolvedValue(conv);
    mockGet.mockResolvedValue([]);

    let resolveSend;
    mockPost.mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));

    const { result } = renderHook(() => useConversation({ resolve, currentUser }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { result.current.send('first'); });
    await act(async () => { result.current.send('second'); });

    expect(mockPost).toHaveBeenCalledTimes(1);

    await act(async () => { resolveSend({ id: 'msg-1', conversationId: 'conv-1', body: 'first', createdAt: '2026-01-01T00:00:00.000Z', editedAt: null, deletedAt: null, sender: currentUser }); });

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0].body).toBe('first');
  });

  it('marks a failed message and allows retry', async () => {
    const conv = { id: 'conv-1', title: 'T', participants: [{ userId: 'user-1', lastReadAt: null }] };
    resolve.mockResolvedValue(conv);
    mockGet.mockResolvedValue([]);
    mockPost.mockRejectedValueOnce(new Error('Failed to send'));

    const { result } = renderHook(() => useConversation({ resolve, currentUser }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.send('hello'); });

    await waitFor(() => expect(result.current.messages[0]._failed).toBe(true));

    const created = { id: 'msg-1', conversationId: 'conv-1', body: 'hello', createdAt: '2026-01-01T00:00:00.000Z', editedAt: null, deletedAt: null, sender: currentUser };
    mockPost.mockResolvedValue(created);

    await act(async () => { await result.current.retry(result.current.messages[0].id); });

    await waitFor(() => expect(result.current.messages[0].id).toBe('msg-1'));
    expect(result.current.messages[0]._failed).toBeFalsy();
  });

  describe('reactions', () => {
    const conv = { id: 'conv-1', title: 'T', participants: [{ userId: 'user-1', lastReadAt: null }] };
    const T0 = '2026-10-04T10:00:00.000Z';
    const msg = { id: 'msg-1', body: 'hi', createdAt: T0, sender: { id: 'user-2' }, reactions: [], reactionsReadAt: T0 };
    const me = { id: 'user-1', fullName: 'Test User' };
    const at = (s) => `2026-10-04T10:00:${String(s).padStart(2, '0')}.000Z`;

    async function mount() {
      const hook = renderHook(() => useConversation({ resolve, currentUser }));
      await waitFor(() => expect(hook.result.current.loading).toBe(false));
      return hook.result;
    }

    function withRealtime(fn) {
      return async () => {
        const realtime = fakeRealtime();
        mockRealtime.client = realtime.client;
        try {
          await fn(realtime);
        } finally {
          mockRealtime.client = null;
        }
      };
    }

    beforeEach(() => {
      resolve.mockResolvedValue(conv);
    });

    it('shows a tap at once and settles on the answer', async () => {
      mockGet.mockResolvedValue([msg]);
      let answer;
      mockPost.mockReturnValue(new Promise((r) => { answer = r; }));
      const result = await mount();

      let pending;
      act(() => { pending = result.current.react('msg-1', '👍'); });
      expect(result.current.messages[0].reactions).toEqual([{ emoji: '👍', count: 1, users: [me] }]);
      expect(mockPost).toHaveBeenCalledWith('/conversations/conv-1/messages/msg-1/reactions', { emoji: '👍' });

      const fromServer = [{ emoji: '👍', count: 2, users: [me, { id: 'user-3' }] }];
      await act(async () => { answer({ reactions: fromServer, readAt: at(1) }); await pending; });
      expect(result.current.messages[0].reactions).toEqual(fromServer);
    });

    it('keeps a saved tap even when nothing else reads it back', async () => {
      mockGet.mockResolvedValue([msg]);
      mockPost.mockResolvedValue({ reactions: [{ emoji: '👍', count: 1, users: [me] }], readAt: at(1) });
      const result = await mount();

      await act(async () => { await result.current.react('msg-1', '👍'); });
      expect(result.current.messages[0].reactions).toEqual([{ emoji: '👍', count: 1, users: [me] }]);
    });

    it('keeps a newer tap shown while an older one settles', async () => {
      mockGet.mockResolvedValue([msg]);
      const posts = [];
      mockPost.mockImplementation(() => new Promise((r) => posts.push(r)));
      const result = await mount();

      act(() => { result.current.react('msg-1', '👍'); });
      act(() => { result.current.react('msg-1', '❤️'); });
      await act(async () => { posts[0]({ reactions: [{ emoji: '👍', count: 1, users: [me] }], readAt: at(1) }); });

      expect(result.current.messages[0].reactions.map((r) => r.emoji)).toEqual(['👍', '❤️']);
    });

    it('reads reactions back itself when the server saved the tap but could not', async () => {
      const mine = [{ emoji: '👍', count: 1, users: [me] }];
      let read;
      mockGet.mockImplementation((url) =>
        url.endsWith('/reactions') ? new Promise((r) => { read = r; }) : Promise.resolve([msg])
      );
      mockPost.mockResolvedValue({ messageId: 'msg-1', reactions: null, readAt: null });
      const result = await mount();

      let pending;
      act(() => { pending = result.current.react('msg-1', '👍'); });
      await waitFor(() => expect(read).toBeDefined());
      // Still shown while the read is out.
      expect(result.current.messages[0].reactions).toEqual(mine);

      await act(async () => { read({ messageId: 'msg-1', reactions: mine, readAt: at(3) }); await pending; });
      expect(result.current.messages[0].reactions).toEqual(mine);
      expect(result.current.error).toBeNull();
    });

    it('keeps a saved tap when neither the server nor the client can read it back', async () => {
      mockGet.mockImplementation((url) =>
        url.endsWith('/reactions') ? Promise.reject(new Error('offline')) : Promise.resolve([msg])
      );
      mockPost.mockResolvedValue({ messageId: 'msg-1', reactions: null, readAt: null });
      const result = await mount();

      await act(async () => { await result.current.react('msg-1', '👍'); });
      expect(result.current.messages[0].reactions).toEqual([{ emoji: '👍', count: 1, users: [me] }]);
    });

    it('drops a refused tap and says why', async () => {
      mockGet.mockResolvedValue([msg]);
      mockPost.mockRejectedValue(new Error('Reactions are not available yet'));
      const result = await mount();

      await act(async () => { await result.current.react('msg-1', '👍'); });
      expect(result.current.messages[0].reactions).toEqual([]);
      expect(result.current.error).toBe('Reactions are not available yet');
    });

    it('fetches only the reacted message on a cue, even an old one', withRealtime(async (realtime) => {
      const fresh = [{ emoji: '🎉', count: 1, users: [{ id: 'user-2', fullName: 'Other' }] }];
      mockGet.mockImplementation((url) =>
        Promise.resolve(url.endsWith('/reactions') ? { messageId: 'msg-1', reactions: fresh, readAt: at(2) } : [msg])
      );
      const result = await mount();

      await act(async () => { realtime.fire('message:reactions', { conversationId: 'conv-1', messageId: 'msg-1' }); });

      expect(mockGet).toHaveBeenCalledWith('/conversations/conv-1/messages/msg-1/reactions');
      await waitFor(() => expect(result.current.messages[0].reactions).toEqual(fresh));
    }));

    it('ignores an older read that finishes last', withRealtime(async (realtime) => {
      const reads = [];
      mockGet.mockImplementation((url) =>
        url.endsWith('/reactions') ? new Promise((r) => reads.push(r)) : Promise.resolve([msg])
      );
      const result = await mount();

      act(() => {
        realtime.fire('message:reactions', { conversationId: 'conv-1', messageId: 'msg-1' });
        realtime.fire('message:reactions', { conversationId: 'conv-1', messageId: 'msg-1' });
      });
      await waitFor(() => expect(reads).toHaveLength(2));

      const newer = [{ emoji: '🎉', count: 2, users: [{ id: 'user-2' }, { id: 'user-3' }] }];
      const older = [{ emoji: '🎉', count: 1, users: [{ id: 'user-2' }] }];
      await act(async () => { reads[1]({ reactions: newer, readAt: at(5) }); });
      await act(async () => { reads[0]({ reactions: older, readAt: at(4) }); });

      expect(result.current.messages[0].reactions).toEqual(newer);
    }));

    it('picks up reactions from a newer page when a cue was missed', withRealtime(async (realtime) => {
      const fresh = [{ emoji: '👀', count: 1, users: [{ id: 'user-3' }] }];
      let page = [msg];
      mockGet.mockImplementation(() => Promise.resolve(page));
      const result = await mount();

      page = [{ ...msg, reactions: fresh, reactionsReadAt: at(9) }];
      await act(async () => { realtime.fire('message:created', { conversationId: 'conv-1', messageId: 'msg-2' }); });

      await waitFor(() => expect(result.current.messages[0].reactions).toEqual(fresh));
    }));
  });

  describe('toggleLocally', () => {
    const me = { id: 'me', fullName: 'Me' };
    const other = { id: 'o', fullName: 'O' };

    it('adds a new emoji, joins an existing one, and takes mine off again', () => {
      const added = toggleLocally([], '🎉', me);
      expect(added).toEqual([{ emoji: '🎉', count: 1, users: [me] }]);
      const joined = toggleLocally([{ emoji: '🎉', count: 1, users: [other] }], '🎉', me);
      expect(joined).toEqual([{ emoji: '🎉', count: 2, users: [other, me] }]);
      expect(toggleLocally(joined, '🎉', me)).toEqual([{ emoji: '🎉', count: 1, users: [other] }]);
      expect(toggleLocally(added, '🎉', me)).toEqual([]);
    });
  });
});
