import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChatBubbleLeftRightIcon, XMarkIcon, PaperAirplaneIcon } from '@heroicons/react/24/solid';
import useConversation from '../../hooks/useConversation';
import { useAuth } from '../../context/AuthContext';
import MemberAvatar from '../MemberAvatar';
import './ChatWidget.css';

function formatTime(date) {
  const d = new Date(date);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatDayLabel(date) {
  const d = new Date(date);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function MessageList({ messages, currentUserId }) {
  const items = useMemo(() => {
    const result = [];
    let lastDay = null;
    let lastSender = null;
    for (const msg of messages) {
      const day = new Date(msg.createdAt).toDateString();
      if (day !== lastDay) {
        result.push({ kind: 'divider', label: formatDayLabel(msg.createdAt), key: `d-${day}` });
        lastDay = day;
        lastSender = null;
      }
      const showSender = msg.sender.id !== currentUserId && msg.sender.id !== lastSender;
      result.push({ kind: 'message', msg, showSender, key: msg.id });
      lastSender = msg.sender.id;
    }
    return result;
  }, [messages, currentUserId]);

  return (
    <>
      {items.map((item) => {
        if (item.kind === 'divider') {
          return <div className="chat-day-divider" key={item.key}>{item.label}</div>;
        }
        const { msg, showSender } = item;
        const mine = msg.sender.id === currentUserId;
        const classes = ['chat-message-row'];
        if (mine) classes.push('chat-message-row--mine');
        if (msg._pending) classes.push('chat-message-row--pending');
        if (msg._failed) classes.push('chat-message-row--failed');
        return (
          <div className={classes.join(' ')} key={item.key}>
            {!mine && (
              <MemberAvatar
                member={msg.sender}
                size={28}
                className="chat-message-row__avatar"
              />
            )}
            <div className="chat-message-row__bubble-col">
              {showSender && <div className="chat-message-row__sender">{msg.sender.fullName}</div>}
              <div className="chat-message-bubble">{msg.body}</div>
              <div className="chat-message-row__meta">
                {msg._failed ? 'Failed to send' : msg._pending ? 'Sending…' : formatTime(msg.createdAt)}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

export default function ChatWidget({ resolve, title, subtitle }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const messagesRef = useRef(null);
  const textareaRef = useRef(null);

  const { conversation, messages, loading, sending, error, unreadCount, send, markRead } =
    useConversation({ resolve, currentUser: user });

  useLayoutEffect(() => {
    if (!messagesRef.current) return;
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [messages, open]);

  useEffect(() => {
    if (open && conversation) markRead();
  }, [open, conversation, markRead, messages.length]);

  const handleSubmit = async (e) => {
    e?.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    send(body);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  if (!user) return null;

  return (
    <>
      {!open && (
        <button
          type="button"
          className="chat-widget-launcher"
          onClick={() => setOpen(true)}
          aria-label="Open chat"
        >
          <ChatBubbleLeftRightIcon style={{ width: 24, height: 24 }} />
          {unreadCount > 0 && (
            <span className="chat-widget-launcher__badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
          )}
        </button>
      )}

      {open && (
        <div className="chat-widget-panel" role="dialog" aria-label="Chat">
          <div className="chat-widget-panel__header">
            <div className="chat-widget-panel__header-text">
              <h4 className="chat-widget-panel__title">{title || 'Interview chat'}</h4>
              {subtitle && <p className="chat-widget-panel__subtitle">{subtitle}</p>}
            </div>
            <button
              type="button"
              className="chat-widget-panel__close"
              onClick={() => setOpen(false)}
              aria-label="Close chat"
            >
              <XMarkIcon style={{ width: 20, height: 20 }} />
            </button>
          </div>

          <div className="chat-widget-panel__messages" ref={messagesRef}>
            {loading && <div className="chat-widget-panel__loading">Loading…</div>}
            {!loading && error && <div className="chat-widget-panel__error">{error}</div>}
            {!loading && !error && messages.length === 0 && (
              <div className="chat-widget-panel__empty">
                No messages yet. Say hi to your fellow interviewers.
              </div>
            )}
            {!loading && !error && messages.length > 0 && (
              <MessageList messages={messages} currentUserId={user.id} />
            )}
          </div>

          <form className="chat-widget-panel__composer" onSubmit={handleSubmit}>
            <textarea
              ref={textareaRef}
              rows={1}
              placeholder="Write a reply..."
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!conversation}
            />
            <button
              type="submit"
              className="chat-widget-panel__send"
              disabled={!draft.trim() || !conversation}
              aria-label="Send"
            >
              <PaperAirplaneIcon style={{ width: 16, height: 16 }} />
            </button>
          </form>
        </div>
      )}
    </>
  );
}
