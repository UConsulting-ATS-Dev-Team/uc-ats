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
    const msg = { id: 'msg-1', body: 'hi', createdAt: '2026-10-04T10:00:00Z', sender: { id: 'user-2' }, reactions: [] };

    it('shows the reaction at once and settles on what the server returns', async () => {
      resolve.mockResolvedValue(conv);
      mockGet.mockResolvedValue([msg]);
      const serverReactions = [{ emoji: '👍', count: 2, users: [{ id: 'user-1' }, { id: 'user-3' }] }];
      let answer;
      mockPost.mockReturnValue(new Promise((r) => { answer = r; }));

      const { result } = renderHook(() => useConversation({ resolve, currentUser }));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let pending;
      act(() => { pending = result.current.react('msg-1', '👍'); });
      expect(result.current.messages[0].reactions).toEqual([
        { emoji: '👍', count: 1, users: [{ id: 'user-1', fullName: 'Test User' }] }
      ]);
      expect(mockPost).toHaveBeenCalledWith('/conversations/conv-1/messages/msg-1/reactions', { emoji: '👍' });

      await act(async () => { answer({ messageId: 'msg-1', reactions: serverReactions }); await pending; });
      expect(result.current.messages[0].reactions).toEqual(serverReactions);
    });

    it('keeps a newer tap on top when an older answer arrives late', async () => {
      resolve.mockResolvedValue(conv);
      mockGet.mockResolvedValue([msg]);
      const answers = [];
      mockPost.mockImplementation(() => new Promise((r) => answers.push(r)));

      const { result } = renderHook(() => useConversation({ resolve, currentUser }));
      await waitFor(() => expect(result.current.loading).toBe(false));

      // 👍 on, then ❤️ on, before either answer is back.
      let first;
      let second;
      act(() => { first = result.current.react('msg-1', '👍'); });
      act(() => { second = result.current.react('msg-1', '❤️'); });

      // The first answer knows only about 👍. ❤️ must survive it.
      const me = { id: 'user-1', fullName: 'Test User' };
      await act(async () => { answers[0]({ reactions: [{ emoji: '👍', count: 1, users: [me] }] }); await first; });
      expect(result.current.messages[0].reactions.map((r) => r.emoji)).toEqual(['👍', '❤️']);

      await act(async () => {
        answers[1]({ reactions: [{ emoji: '👍', count: 1, users: [me] }, { emoji: '❤️', count: 1, users: [me] }] });
        await second;
      });
      expect(result.current.messages[0].reactions.map((r) => r.emoji)).toEqual(['👍', '❤️']);
    });

    it('fetches only the reacted message when told its reactions changed, even an old one', async () => {
      const realtime = fakeRealtime();
      mockRealtime.client = realtime.client;
      resolve.mockResolvedValue(conv);
      const fresh = [{ emoji: '🎉', count: 1, users: [{ id: 'user-2', fullName: 'Other' }] }];
      mockGet.mockImplementation((url) =>
        Promise.resolve(url.endsWith('/reactions') ? { messageId: 'msg-1', reactions: fresh } : [msg])
      );

      try {
        const { result } = renderHook(() => useConversation({ resolve, currentUser }));
        await waitFor(() => expect(result.current.loading).toBe(false));

        await act(async () => { realtime.fire('message:reactions', { conversationId: 'conv-1', messageId: 'msg-1' }); });

        expect(mockGet).toHaveBeenCalledWith('/conversations/conv-1/messages/msg-1/reactions');
        await waitFor(() => expect(result.current.messages[0].reactions).toEqual(fresh));
      } finally {
        mockRealtime.client = null;
      }
    });

    it('puts the reactions back when the server refuses', async () => {
      resolve.mockResolvedValue(conv);
      mockGet.mockResolvedValue([msg]);
      mockPost.mockRejectedValue(new Error('Reactions are not available yet'));

      const { result } = renderHook(() => useConversation({ resolve, currentUser }));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => { await result.current.react('msg-1', '👍'); });
      expect(result.current.messages[0].reactions).toEqual([]);
      expect(result.current.error).toBe('Reactions are not available yet');
    });
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
