import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChatBubbleLeftRightIcon, XMarkIcon, PencilSquareIcon, ArrowLeftIcon } from '@heroicons/react/24/solid';
import apiClient from '../../utils/api';
import { supabase } from '../../supabaseClient';
import { useAuth } from '../../context/AuthContext';
import useConversation from '../../hooks/useConversation';
import MemberAvatar from '../MemberAvatar';
import { ConversationBody } from './ChatWidget';
import './ChatWidget.css';

// Coffee chat interviewers message the people they pick instead of one room for
// the whole round (server/src/services/interviewThreads.js). The launcher opens a
// list of your chats; each one you open docks as its own window beside it, so
// several conversations run at once.

/// You plus five others; the server enforces the same.
export const MAX_THREAD_PARTICIPANTS = 6;
/// Windows open side by side before the oldest makes room for a new one.
export const MAX_OPEN_WINDOWS = 3;
const POLL_MS = 30000;

// Layout, matching ChatWidget.css: a 340px window plus a 16px gap each, beside the
// launcher (56px) or the open list (380px), inside a 24px margin. At or below
// NARROW_PX one full-width window shows at a time.
const WINDOW_PX = 340 + 16;
const NARROW_PX = 900;

/**
 * How many chat windows fit beside the launcher or list at this width. Only
 * these are mounted: a window that is not drawn must not mark messages read.
 */
export function windowsThatFit(viewportWidth, listOpen) {
  if (viewportWidth <= NARROW_PX) return 1;
  const used = 24 * 2 + (listOpen ? 380 : 56) + 16;
  return Math.max(1, Math.min(MAX_OPEN_WINDOWS, Math.floor((viewportWidth - used) / WINDOW_PX)));
}

function useViewportWidth() {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

const nameOf = (person) => person?.fullName || person?.email || 'Someone';

export function threadTitle(people) {
  if (!people?.length) return 'Just you';
  const names = people.map(nameOf);
  return names.length <= 2 ? names.join(' & ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

function sessionText(person) {
  return (person.sessions || []).map((s) => s.label).filter(Boolean).join(', ') || (person.role === 'ADMIN' ? 'Admin' : '');
}

function ThreadWindow({ thread, index, listOpen, onClose, onActivity }) {
  const { user } = useAuth();
  const resolve = useCallback(() => apiClient.get(`/conversations/${thread.id}`), [thread.id]);
  const chat = useConversation({ resolve, currentUser: user });
  const { conversation, messages, markRead } = chat;

  // An open window is being read.
  useEffect(() => {
    if (!conversation) return;
    markRead().then(onActivity);
  }, [conversation, markRead, messages.length, onActivity]);

  return (
    <div
      className="chat-thread-window"
      style={{ '--chat-window-index': index, '--chat-list-offset': listOpen ? 1 : 0 }}
      role="dialog"
      aria-label={`Chat with ${threadTitle(thread.people)}`}
    >
      <div className="chat-widget-panel__header">
        <div className="chat-widget-panel__header-text">
          <h4 className="chat-widget-panel__title">{threadTitle(thread.people)}</h4>
          {thread.people?.length > 1 && (
            <p className="chat-widget-panel__subtitle">{thread.people.length + 1} people</p>
          )}
        </div>
        <button type="button" className="chat-widget-panel__close" onClick={() => onClose(thread.id)} aria-label="Close this chat">
          <XMarkIcon style={{ width: 20, height: 20 }} />
        </button>
      </div>
      <ConversationBody chat={chat} user={user} emptyText="No messages yet." />
    </div>
  );
}

function NewChat({ people, onStart, onBack }) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter((p) => `${nameOf(p)} ${p.email || ''} ${sessionText(p)}`.toLowerCase().includes(q));
  }, [people, query]);

  const full = picked.length + 1 >= MAX_THREAD_PARTICIPANTS;
  const toggle = (id) =>
    setPicked((current) => (current.includes(id) ? current.filter((x) => x !== id) : full ? current : [...current, id]));

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      await onStart(picked);
    } catch (err) {
      setError(err.message || 'Could not start the chat');
      setBusy(false);
    }
  };

  return (
    <>
      <div className="chat-widget-panel__header">
        <button type="button" className="chat-widget-panel__close" onClick={onBack} aria-label="Back to chats">
          <ArrowLeftIcon style={{ width: 18, height: 18 }} />
        </button>
        <div className="chat-widget-panel__header-text" style={{ flex: 1, marginLeft: 8 }}>
          <h4 className="chat-widget-panel__title">New chat</h4>
          <p className="chat-widget-panel__subtitle">
            Pick one person, or up to {MAX_THREAD_PARTICIPANTS - 1} for a group
          </p>
        </div>
      </div>
      <div className="chat-picker__search">
        <input
          type="search"
          placeholder="Search by name or session"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search people"
          autoFocus
        />
      </div>
      <ul className="chat-picker__list" aria-label="People working this coffee chat">
        {shown.length === 0 && <li className="chat-widget-panel__empty">Nobody matches.</li>}
        {shown.map((person) => {
          const on = picked.includes(person.id);
          return (
            <li key={person.id}>
              <label className={`chat-picker__person${on ? ' chat-picker__person--on' : ''}`} data-no-track>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!on && full}
                  onChange={() => toggle(person.id)}
                />
                <MemberAvatar member={person} size={28} />
                <span className="chat-picker__text">
                  <span className="chat-picker__name">{nameOf(person)}</span>
                  {sessionText(person) && <span className="chat-picker__meta">{sessionText(person)}</span>}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {error && <div className="chat-widget-panel__status chat-widget-panel__status--error" role="alert">{error}</div>}
      <div className="chat-picker__footer">
        <button
          type="button"
          className="chat-picker__start"
          disabled={picked.length === 0 || busy}
          onClick={start}
          data-track="coffee-chat-start-thread"
        >
          {busy ? 'Opening…' : picked.length > 1 ? `Start group chat (${picked.length + 1})` : 'Start chat'}
        </button>
      </div>
    </>
  );
}

export default function CoffeeChatThreads({ interviewId }) {
  const { user } = useAuth();
  const [listOpen, setListOpen] = useState(false);
  const [view, setView] = useState('list');
  const [data, setData] = useState({ people: [], threads: [] });
  const [loadError, setLoadError] = useState('');
  const [openIds, setOpenIds] = useState([]);
  const viewportWidth = useViewportWidth();

  const refresh = useCallback(async () => {
    if (!interviewId) return;
    try {
      const next = await apiClient.get(`/conversations/interviews/${interviewId}/threads`);
      setData({ people: next.people || [], threads: next.threads || [] });
      setLoadError('');
    } catch (err) {
      setLoadError(err.message || 'Could not load your chats');
    }
  }, [interviewId]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // A content-free nudge whenever a thread on this interview changes; the list
  // (who, unread counts) is always fetched through the API.
  useEffect(() => {
    if (!supabase || !interviewId) return undefined;
    const channel = supabase.channel(`interview-threads:${interviewId}`);
    channel.on('broadcast', { event: 'threads:changed' }, () => refresh());
    channel.subscribe();
    return () => {
      try { supabase.removeChannel(channel); } catch (_) {}
    };
  }, [interviewId, refresh]);

  const openThread = useCallback((id) => {
    setOpenIds((current) => [...current.filter((x) => x !== id), id].slice(-MAX_OPEN_WINDOWS));
  }, []);
  const closeThread = useCallback((id) => setOpenIds((current) => current.filter((x) => x !== id)), []);

  const startChat = async (userIds) => {
    const conversation = await apiClient.post(`/conversations/interviews/${interviewId}/threads`, { userIds });
    await refresh();
    openThread(conversation.id);
    setView('list');
  };

  if (!user || !interviewId) return null;

  const threadsById = new Map(data.threads.map((t) => [t.id, t]));
  // The newest open chats that fit on screen. The rest stay open and come back
  // when there is room, but are not drawn, so they count as unread meanwhile.
  const shownIds = openIds.slice(-windowsThatFit(viewportWidth, listOpen));
  const openThreads = shownIds.map((id) => threadsById.get(id) ?? { id, people: [] });
  const unread = data.threads.reduce((sum, t) => sum + (shownIds.includes(t.id) ? 0 : t.unreadCount || 0), 0);

  return (
    <>
      {openThreads.map((thread, index) => (
        <ThreadWindow
          key={thread.id}
          thread={thread}
          index={openThreads.length - 1 - index}
          listOpen={listOpen}
          onClose={closeThread}
          onActivity={refresh}
        />
      ))}

      {!listOpen && (
        <button type="button" className="chat-widget-launcher" onClick={() => setListOpen(true)} aria-label="Open chats">
          <ChatBubbleLeftRightIcon style={{ width: 24, height: 24 }} />
          {unread > 0 && <span className="chat-widget-launcher__badge">{unread > 99 ? '99+' : unread}</span>}
        </button>
      )}

      {listOpen && (
        <div className="chat-widget-panel chat-thread-list" role="dialog" aria-label="Your chats">
          {view === 'new' ? (
            <NewChat people={data.people} onStart={startChat} onBack={() => setView('list')} />
          ) : (
            <>
              <div className="chat-widget-panel__header">
                <div className="chat-widget-panel__header-text">
                  <h4 className="chat-widget-panel__title">Chats</h4>
                  <p className="chat-widget-panel__subtitle">Message the people you pick</p>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    type="button"
                    className="chat-widget-panel__close"
                    onClick={() => setView('new')}
                    aria-label="New chat"
                    data-track="coffee-chat-new-thread"
                  >
                    <PencilSquareIcon style={{ width: 18, height: 18 }} />
                  </button>
                  <button type="button" className="chat-widget-panel__close" onClick={() => setListOpen(false)} aria-label="Close chats">
                    <XMarkIcon style={{ width: 20, height: 20 }} />
                  </button>
                </div>
              </div>
              <ul className="chat-thread-list__items">
                {loadError && <li className="chat-widget-panel__error">{loadError}</li>}
                {!loadError && data.threads.length === 0 && (
                  <li className="chat-widget-panel__empty">
                    No chats yet. Start one with the pencil above.
                  </li>
                )}
                {data.threads.map((thread) => (
                  <li key={thread.id}>
                    <button
                      type="button"
                      className={`chat-thread-row${shownIds.includes(thread.id) ? ' chat-thread-row--open' : ''}`}
                      onClick={() => openThread(thread.id)}
                      data-no-track
                    >
                      <MemberAvatar member={thread.people[0]} size={32} />
                      <span className="chat-picker__text">
                        <span className="chat-picker__name">{threadTitle(thread.people)}</span>
                        <span className="chat-picker__meta">
                          {thread.lastMessage
                            ? `${thread.lastMessage.sender?.id === user.id ? 'You: ' : ''}${thread.lastMessage.body}`
                            : 'No messages yet'}
                        </span>
                      </span>
                      {thread.unreadCount > 0 && !shownIds.includes(thread.id) && (
                        <span className="chat-thread-row__unread">{thread.unreadCount}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </>
  );
}
