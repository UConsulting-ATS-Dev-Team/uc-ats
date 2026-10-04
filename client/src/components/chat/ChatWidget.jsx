import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChatBubbleLeftRightIcon, XMarkIcon, PaperAirplaneIcon, ArrowPathIcon, FaceSmileIcon } from '@heroicons/react/24/solid';
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

/// Must match REACTION_EMOJI in server/src/services/messaging.js.
export const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '👎', '🎉', '👀'];

function reactorNames(reaction, currentUserId) {
  return reaction.users.map((u) => (u.id === currentUserId ? 'You' : u.fullName || 'Someone')).join(', ');
}

function Reactions({ msg, currentUserId, onReact }) {
  const [picking, setPicking] = useState(false);
  const reactions = msg.reactions || [];
  if (msg._pending || msg._failed || !onReact) return null;

  const choose = (emoji) => {
    setPicking(false);
    onReact(msg.id, emoji);
  };

  return (
    <div className="chat-reactions">
      {reactions.map((reaction) => {
        const mine = reaction.users.some((u) => u.id === currentUserId);
        return (
          <button
            type="button"
            key={reaction.emoji}
            className={`chat-reaction${mine ? ' chat-reaction--mine' : ''}`}
            title={reactorNames(reaction, currentUserId)}
            aria-label={`${reaction.emoji} ${reaction.count}${mine ? ', including you' : ''}`}
            aria-pressed={mine}
            data-no-track
            onClick={() => choose(reaction.emoji)}
          >
            <span>{reaction.emoji}</span>
            <span className="chat-reaction__count">{reaction.count}</span>
          </button>
        );
      })}
      <div className="chat-reaction-add-wrap">
        <button
          type="button"
          className="chat-reaction-add"
          aria-label="Add reaction"
          aria-expanded={picking}
          data-track="chat-add-reaction"
          onClick={() => setPicking((open) => !open)}
        >
          <FaceSmileIcon style={{ width: 14, height: 14 }} />
        </button>
        {picking && (
          <div className="chat-reaction-picker" role="menu" onMouseLeave={() => setPicking(false)}>
            {REACTION_EMOJI.map((emoji) => (
              <button
                type="button"
                role="menuitem"
                key={emoji}
                aria-label={`React ${emoji}`}
                data-track="chat-pick-reaction"
                onClick={() => choose(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MessageList({ messages, currentUserId, onRetry, onReact }) {
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
              <Reactions msg={msg} currentUserId={currentUserId} onReact={onReact} />
              <div className="chat-message-row__meta">
                {msg._failed ? (
                  <>
                    Failed to send
                    <button
                      type="button"
                      className="chat-message-row__retry"
                      onClick={() => onRetry?.(msg.id)}
                      aria-label="Retry"
                    >
                      <ArrowPathIcon style={{ width: 12, height: 12 }} />
                    </button>
                  </>
                ) : msg._pending ? (
                  'Sending…'
                ) : (
                  formatTime(msg.createdAt)
                )}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

/**
 * The inside of a chat: status, messages and composer, for one conversation.
 * The interview room widget and each coffee chat thread window draw this.
 */
export function ConversationBody({ chat, user, emptyText = 'No messages yet. Say hi to your fellow interviewers.' }) {
  const [draft, setDraft] = useState('');
  const messagesRef = useRef(null);
  const textareaRef = useRef(null);
  const { conversation, messages, loading, sending, error, connected, send, retry, react } = chat;

  useLayoutEffect(() => {
    if (!messagesRef.current) return;
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [messages.length]);

  const handleSubmit = async (e) => {
    e?.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setDraft('');
    await send(body);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const isUnauthorized = !loading && error && /Forbidden|Unauthorized/i.test(error);
  const canSend = draft.trim() && conversation && !sending;

  return (
    <>
      {!connected && (
        <div className="chat-widget-panel__status chat-widget-panel__status--disconnected">
          Realtime disconnected — messages will refresh on reconnect
        </div>
      )}

      <div className="chat-widget-panel__messages" ref={messagesRef}>
        {loading && <div className="chat-widget-panel__loading">Loading…</div>}
        {!loading && isUnauthorized && (
          <div className="chat-widget-panel__error chat-widget-panel__error--unauthorized">
            You do not have access to this conversation.
          </div>
        )}
        {!loading && !isUnauthorized && error && !conversation && <div className="chat-widget-panel__error">{error}</div>}
        {!loading && conversation && messages.length === 0 && (
          <div className="chat-widget-panel__empty">{emptyText}</div>
        )}
        {!loading && conversation && messages.length > 0 && (
          <MessageList messages={messages} currentUserId={user.id} onRetry={retry} onReact={react} />
        )}
      </div>

      {!loading && conversation && error && !isUnauthorized && (
        <div className="chat-widget-panel__status chat-widget-panel__status--error" role="alert">{error}</div>
      )}

      <form className="chat-widget-panel__composer" onSubmit={handleSubmit}>
        <textarea
          ref={textareaRef}
          rows={1}
          placeholder="Write a reply..."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!conversation || sending}
        />
        <button
          type="submit"
          className="chat-widget-panel__send"
          disabled={!canSend}
          aria-label="Send"
        >
          <PaperAirplaneIcon style={{ width: 16, height: 16 }} />
        </button>
      </form>
    </>
  );
}

export default function ChatWidget({ resolve, title, subtitle }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  const chat = useConversation({ resolve, currentUser: user });
  const { conversation, messages, unreadCount, markRead } = chat;

  useEffect(() => {
    if (open && conversation) markRead();
  }, [open, conversation, markRead, messages.length]);

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
          <ConversationBody chat={chat} user={user} />
        </div>
      )}
    </>
  );
}
