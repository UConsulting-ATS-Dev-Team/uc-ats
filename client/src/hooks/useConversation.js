import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../utils/api';
import { supabase } from '../supabaseClient';

export default function useConversation({ resolve, currentUser }) {
  const currentUserId = currentUser?.id;
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const channelRef = useRef(null);
  const conversationIdRef = useRef(null);

  const upsertMessage = useCallback((incoming) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === incoming.id)) return prev;
      const next = [...prev, incoming];
      next.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const conv = await resolve();
        if (cancelled || !conv) return;
        setConversation(conv);
        conversationIdRef.current = conv.id;

        const history = await apiClient.get(`/conversations/${conv.id}/messages`);
        if (cancelled) return;
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
      upsertMessage(payload);
      if (payload.sender.id !== currentUserId) {
        setUnreadCount((c) => c + 1);
      }
    });

    channel.subscribe();
    channelRef.current = channel;

    return () => {
      try { channel.unsubscribe(); } catch (_) {}
      try { supabase.removeChannel(channel); } catch (_) {}
      channelRef.current = null;
    };
  }, [conversation, currentUserId, upsertMessage]);

  const send = useCallback(async (body) => {
    if (!conversation || !currentUser) return;
    const trimmed = body?.trim();
    if (!trimmed) return;

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
    setSending(true);
    setError(null);

    try {
      const created = await apiClient.post(`/conversations/${conversation.id}/messages`, { body: trimmed });
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
      setSending(false);
    }
  }, [conversation, currentUser]);

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
    send,
    markRead
  }), [conversation, messages, loading, sending, error, unreadCount, send, markRead]);
}
