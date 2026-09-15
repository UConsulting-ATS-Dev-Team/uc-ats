import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import usePolling from '../hooks/usePolling';
import liveVoteApi from '../utils/liveVoteApi';
import { supabase } from '../supabaseClient';
import { usePreviewActive } from '../utils/previewMode';
import LiveVoteJoinPrompt from '../components/liveVote/LiveVoteJoinPrompt';

// Whether a live vote is running, for every admin and member on any page.
//
// Mounted above the routes rather than in Layout: Layout is rebuilt per route,
// and this should keep one subscription for the whole visit instead of
// dropping it on every navigation. The broadcast makes the join prompt appear
// within a second of launch; the slow poll is what keeps it honest when the
// socket is down.

const ACTIVE_POLL_MS = 15000;

const LiveVoteContext = createContext({ activeSession: null, refresh: () => {} });

const dismissKey = (sessionId) => `liveVote:dismissed:${sessionId}`;

const readDismissed = (sessionId) => {
  try {
    return window.sessionStorage.getItem(dismissKey(sessionId)) === '1';
  } catch {
    return false;
  }
};

export function LiveVoteProvider({ children }) {
  const { user } = useAuth();
  const eligible = (user?.role === 'ADMIN' || user?.role === 'MEMBER') && !user?.isExternalTalent;

  const [activeSession, setActiveSession] = useState(null);
  const fetcher = useCallback((signal) => liveVoteApi.active({ signal }), []);

  const { refresh } = usePolling({
    fetcher,
    enabled: eligible,
    interval: ACTIVE_POLL_MS,
    pauseWhenHidden: true,
    onData: (payload) => setActiveSession(payload?.session ?? null)
  });

  useEffect(() => {
    if (!eligible) setActiveSession(null);
  }, [eligible]);

  useEffect(() => {
    if (!eligible || !supabase) return undefined;
    const channel = supabase.channel('live-votes', { config: { broadcast: { self: false } } });
    channel.on('broadcast', { event: 'session:changed' }, () => refresh());
    channel.subscribe();
    return () => {
      try { channel.unsubscribe(); } catch { /* already gone */ }
      try { supabase.removeChannel(channel); } catch { /* already gone */ }
    };
  }, [eligible, refresh]);

  const value = useMemo(() => ({ activeSession, refresh }), [activeSession, refresh]);

  return (
    <LiveVoteContext.Provider value={value}>
      {children}
      {eligible && <LiveVoteJoinOverlay activeSession={activeSession} />}
    </LiveVoteContext.Provider>
  );
}

function LiveVoteJoinOverlay({ activeSession }) {
  const location = useLocation();
  const navigate = useNavigate();
  const previewActive = usePreviewActive();
  const [dismissed, setDismissed] = useState(() => (activeSession ? readDismissed(activeSession.id) : false));

  useEffect(() => {
    setDismissed(activeSession ? readDismissed(activeSession.id) : false);
  }, [activeSession?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Nothing pops over a candidate looking at the screen, and nothing asks you to
  // join the vote you are already in.
  if (!activeSession || previewActive || location.pathname.startsWith('/live-vote/')) return null;

  const dismiss = () => {
    try {
      window.sessionStorage.setItem(dismissKey(activeSession.id), '1');
    } catch {
      // Storage unavailable: the prompt may come back after a reload.
    }
    setDismissed(true);
  };

  return (
    <LiveVoteJoinPrompt
      session={activeSession}
      promptOpen={!activeSession.joined && !dismissed}
      onJoin={() => {
        dismiss();
        navigate(`/live-vote/${activeSession.id}`);
      }}
      onDismiss={dismiss}
    />
  );
}

export const useLiveVote = () => useContext(LiveVoteContext);
