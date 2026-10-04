import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../utils/api';
import { supabase } from '../supabaseClient';

/** A message's reactions with this user's `emoji` added or taken off. */
export function toggleLocally(reactions, emoji, user) {
  const existing = reactions.find((r) => r.emoji === emoji);
  if (existing?.users.some((u) => u.id === user.id)) {
    const users = existing.users.filter((u) => u.id !== user.id);
    return users.length
      ? reactions.map((r) => (r.emoji === emoji ? { ...r, count: users.length, users } : r))
      : reactions.filter((r) => r.emoji !== emoji);
  }
  const me = { id: user.id, fullName: user.fullName };
  return existing
    ? reactions.map((r) => (r.emoji === emoji ? { ...r, count: r.count + 1, users: [...r.users, me] } : r))
    : [...reactions, { emoji, count: 1, users: [me] }];
}

export default function useConversation({ resolve, currentUser }) {
  const currentUserId = currentUser?.id;
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [connected, setConnected] = useState(true);
  const channelRef = useRef(null);
  const conversationIdRef = useRef(null);
  const sendingRef = useRef(false);
  // Ids of messages already counted, so a refetch only counts what is new.
  const knownIdsRef = useRef(new Set());
  // Reactions as the server last reported them, and this user's taps still in
  // flight. What is shown is always the taps replayed on the server's state, so
  // a late answer or a refetch never undoes a newer tap.
  const serverReactionsRef = useRef(new Map());
  const pendingReactionsRef = useRef(new Map());
  const refetchingRef = useRef(false);
  const refetchAgainRef = useRef(false);

  /**
   * Record a read of a message's reactions if it is at least as new as the one
   * held. Reads arrive from pages, cues and taps in any order; the server stamps
   * each with when it was taken, so the newest wins whichever finishes last.
   */
  const acceptReactions = useCallback((messageId, reactions, readAt) => {
    const held = serverReactionsRef.current.get(messageId);
    if (held?.readAt && readAt && readAt < held.readAt) return false;
    serverReactionsRef.current.set(messageId, { reactions: reactions || [], readAt: readAt || held?.readAt || null });
    return true;
  }, []);

  const shownReactions = useCallback((messageId) => {
    const pending = pendingReactionsRef.current.get(messageId) ?? [];
    return pending.reduce(
      (reactions, tap) => toggleLocally(reactions, tap.emoji, currentUser),
      serverReactionsRef.current.get(messageId)?.reactions ?? []
    );
  }, [currentUser]);

  const showReactions = useCallback((messageId) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions: shownReactions(messageId) } : m)));
  }, [shownReactions]);

  /** Fold a page of messages from the server into what is shown. */
  const applyServerPage = useCallback((page) => {
    let unseen = 0;
    for (const m of page) {
      acceptReactions(m.id, m.reactions, m.reactionsReadAt);
      if (!knownIdsRef.current.has(m.id)) {
        knownIdsRef.current.add(m.id);
        if (m.sender.id !== currentUserId) unseen += 1;
      }
    }
    setMessages((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const m of page) byId.set(m.id, { ...m, reactions: shownReactions(m.id) });
      return [...byId.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    });
    if (unseen) setUnreadCount((c) => c + unseen);
  }, [currentUserId, shownReactions, acceptReactions]);

  const refetchReactions = useCallback(async (conversationId, messageId) => {
    try {
      const result = await apiClient.get(`/conversations/${conversationId}/messages/${messageId}/reactions`);
      if (conversationIdRef.current !== conversationId) return;
      if (acceptReactions(messageId, result.reactions, result.readAt)) showReactions(messageId);
      return true;
    } catch (_) {
      // The next cue, or reopening the chat, catches up.
      return false;
    }
  }, [acceptReactions, showReactions]);

  // Broadcasts carry no content: each one is a cue to fetch the latest page
  // through the API, which checks access. Overlapping cues share one fetch.
  const refetchLatest = useCallback(async () => {
    const id = conversationIdRef.current;
    if (!id) return;
    if (refetchingRef.current) {
      refetchAgainRef.current = true;
      return;
    }
    refetchingRef.current = true;
    try {
      do {
        refetchAgainRef.current = false;
        const page = await apiClient.get(`/conversations/${id}/messages`);
        if (conversationIdRef.current === id) applyServerPage(page);
      } while (refetchAgainRef.current);
    } catch (_) {
      // The next cue, or reopening the chat, tries again.
    } finally {
      refetchingRef.current = false;
    }
  }, [applyServerPage]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      setConnected(true);
      try {
        const conv = await resolve();
        if (cancelled || !conv) return;
        setConversation(conv);
        conversationIdRef.current = conv.id;

        const history = await apiClient.get(`/conversations/${conv.id}/messages`);
        if (cancelled) return;
        knownIdsRef.current = new Set(history.map((m) => m.id));
        serverReactionsRef.current = new Map(
          history.map((m) => [m.id, { reactions: m.reactions || [], readAt: m.reactionsReadAt || null }])
        );
        pendingReactionsRef.current = new Map();
        setMessages(history);

        const lastReadAt = conv.participants.find((p) => p.userId === currentUserId)?.lastReadAt;
        const unread = lastReadAt
          ? history.filter((m) => m.sender.id !== currentUserId && new Date(m.createdAt) > new Date(lastReadAt)).length
          : history.filter((m) => m.sender.id !== currentUserId).length;
        setUnreadCount(unread);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load conversation');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [resolve, currentUserId]);

  useEffect(() => {
    if (!conversation || !supabase) return;
    const channelName = conversation.channelName || `conv:${conversation.id}`;
    const channel = supabase.channel(channelName, { config: { broadcast: { self: false } } });

    channel.on('broadcast', { event: 'message:created' }, ({ payload }) => {
      if (!payload || payload.conversationId !== conversationIdRef.current) return;
      refetchLatest();
    });
    // Just the one message: it may be older than the latest page.
    channel.on('broadcast', { event: 'message:reactions' }, ({ payload }) => {
      if (!payload?.messageId || payload.conversationId !== conversationIdRef.current) return;
      refetchReactions(payload.conversationId, payload.messageId);
    });

    channel.subscribe((status) => {
      setConnected(status === 'SUBSCRIBED');
    });
    channelRef.current = channel;

    return () => {
      setConnected(true);
      try { channel.unsubscribe(); } catch (_) {}
      try { supabase.removeChannel(channel); } catch (_) {}
      channelRef.current = null;
    };
  }, [conversation, refetchLatest, refetchReactions]);

  const submitMessage = useCallback(async (body, tempId, optimistic) => {
    if (!conversation || !currentUser) return;
    try {
      const created = await apiClient.post(`/conversations/${conversation.id}/messages`, { body: body.trim() });
      knownIdsRef.current.add(created.id);
      acceptReactions(created.id, created.reactions, created.reactionsReadAt);
      setMessages((prev) => {
        const filtered = prev.filter((m) => m.id !== tempId);
        if (filtered.some((m) => m.id === created.id)) return filtered;
        const next = [...filtered, created];
        next.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        return next;
      });
    } catch (err) {
      setError(err.message || 'Failed to send');
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, _pending: false, _failed: true } : m)));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [conversation, currentUser, acceptReactions]);

  const send = useCallback(async (body) => {
    if (!conversation || !currentUser) return;
    const trimmed = body?.trim();
    if (!trimmed) return;
    if (sendingRef.current) return;

    sendingRef.current = true;
    setSending(true);
    setError(null);

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic = {
      id: tempId,
      conversationId: conversation.id,
      body: trimmed,
      createdAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
      sender: {
        id: currentUser.id,
        fullName: currentUser.fullName,
        email: currentUser.email,
        profileImage: currentUser.profileImage,
        role: currentUser.role
      },
      _pending: true
    };
    setMessages((prev) => [...prev, optimistic]);

    await submitMessage(body, tempId, optimistic);
  }, [conversation, currentUser, submitMessage]);

  const retry = useCallback(async (messageId) => {
    const message = messages.find((m) => m.id === messageId && m._failed);
    if (!message || !conversation || !currentUser) return;
    if (sendingRef.current) return;

    sendingRef.current = true;
    setSending(true);
    setError(null);

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic = {
      ...message,
      id: tempId,
      _pending: true,
      _failed: false
    };

    setMessages((prev) => prev.map((m) => (m.id === messageId ? optimistic : m)));

    await submitMessage(message.body, tempId, optimistic);
  }, [conversation, currentUser, messages, submitMessage]);

  // Shows the tap at once, replayed on top of whatever the server reports,
  // until the tap's own answer is recorded. A refused tap simply drops out.
  const react = useCallback(async (messageId, emoji) => {
    if (!conversation || !currentUser) return;
    const tap = { emoji };
    const pending = pendingReactionsRef.current;
    pending.set(messageId, [...(pending.get(messageId) ?? []), tap]);
    showReactions(messageId);
    try {
      const result = await apiClient.post(`/conversations/${conversation.id}/messages/${messageId}/reactions`, { emoji });
      // Saved, but the server could not read the reactions back: keep the tap
      // shown until a read of our own lands.
      if (result.reactions) acceptReactions(messageId, result.reactions, result.readAt);
      else if (!(await refetchReactions(conversation.id, messageId))) {
        // Nothing could be read, but the server said which way the toggle went
        // and when. Unless something read since then, make what is held agree,
        // stamped with that moment so any later read replaces it. Set, not
        // toggled: another read may already have it.
        const held = serverReactionsRef.current.get(messageId);
        const heldReactions = held?.reactions ?? [];
        const newerRead = held?.readAt && result.reactedAt && held.readAt > result.reactedAt;
        const isOn = heldReactions.some((r) => r.emoji === emoji && r.users.some((u) => u.id === currentUser.id));
        if (typeof result.reacted === 'boolean' && !newerRead && isOn !== result.reacted) {
          serverReactionsRef.current.set(messageId, {
            reactions: toggleLocally(heldReactions, emoji, currentUser),
            readAt: result.reactedAt ?? held?.readAt ?? null
          });
        }
      }
    } catch (err) {
      setError(err.message || 'Failed to react');
    } finally {
      const rest = (pending.get(messageId) ?? []).filter((t) => t !== tap);
      if (rest.length) pending.set(messageId, rest);
      else pending.delete(messageId);
      showReactions(messageId);
    }
  }, [conversation, currentUser, acceptReactions, showReactions, refetchReactions]);

  const markRead = useCallback(async () => {
    if (!conversation) return;
    try {
      await apiClient.post(`/conversations/${conversation.id}/read`, {});
      setUnreadCount(0);
    } catch (_) {}
  }, [conversation]);

  return useMemo(() => ({
    conversation,
    messages,
    loading,
    sending,
    error,
    unreadCount,
    connected,
    send,
    retry,
    react,
    markRead
  }), [conversation, messages, loading, sending, error, unreadCount, connected, send, retry, react, markRead]);
}
