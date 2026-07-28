import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import useConversation from './useConversation';

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('../utils/api', () => ({
  default: {
    get: (...args) => mockGet(...args),
    post: (...args) => mockPost(...args)
  }
}));

vi.mock('../supabaseClient', () => ({
  supabase: null
}));

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
});
