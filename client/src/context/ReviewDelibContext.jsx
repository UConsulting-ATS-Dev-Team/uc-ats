import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import usePolling from '../hooks/usePolling';
import reviewDelibApi from '../utils/reviewDelibApi';
import { supabase } from '../supabaseClient';
import { usePreviewActive } from '../utils/previewMode';
import ReviewDelibJoinPrompt from '../components/reviewDelib/ReviewDelibJoinPrompt';

// Which review team deliberations are running that this person may join: every
// one for an admin, their own team's for a member. The server does the
// filtering, so a member on another team never hears about it.
//
// Mounted above the routes beside LiveVoteProvider, for the same reason: one
// subscription for the whole visit, not one per page.

const ACTIVE_POLL_MS = 15000;

const ReviewDelibContext = createContext({ sessions: [], refresh: () => {} });

const dismissKey = (ids) => `reviewDelib:dismissed:${ids}`;

const readDismissed = (key) => {
  try {
    return window.sessionStorage.getItem(dismissKey(key)) === '1';
  } catch {
    return false;
  }
};

export function ReviewDelibProvider({ children }) {
  const { user } = useAuth();
  const eligible = (user?.role === 'ADMIN' || user?.role === 'MEMBER') && !user?.isExternalTalent;

  const [sessions, setSessions] = useState([]);
  const fetcher = useCallback((signal) => reviewDelibApi.active({ signal }), []);

  const { refresh } = usePolling({
    fetcher,
    enabled: eligible,
    interval: ACTIVE_POLL_MS,
    pauseWhenHidden: true,
    onData: (payload) => setSessions(payload?.sessions ?? [])
  });

  useEffect(() => {
    if (!eligible) setSessions([]);
  }, [eligible]);

  useEffect(() => {
    if (!eligible || !supabase) return undefined;
    const channel = supabase.channel('review-delibs', { config: { broadcast: { self: false } } });
    channel.on('broadcast', { event: 'session:changed' }, () => refresh());
    channel.subscribe();
    return () => {
      try { channel.unsubscribe(); } catch { /* already gone */ }
      try { supabase.removeChannel(channel); } catch { /* already gone */ }
    };
  }, [eligible, refresh]);

  const value = useMemo(() => ({ sessions, refresh }), [sessions, refresh]);

  return (
    <ReviewDelibContext.Provider value={value}>
      {children}
      {eligible && <ReviewDelibJoinOverlay sessions={sessions} isAdmin={user?.role === 'ADMIN'} />}
    </ReviewDelibContext.Provider>
  );
}

function ReviewDelibJoinOverlay({ sessions, isAdmin }) {
  const location = useLocation();
  const navigate = useNavigate();
  const previewActive = usePreviewActive();
  // Keyed on the set of sessions, so a new team starting brings the prompt back.
  const key = sessions.map((session) => session.id).sort().join(',');
  const [dismissed, setDismissed] = useState(() => (key ? readDismissed(key) : false));
  // The corner pill's "show me the list again", with several running.
  const [reopened, setReopened] = useState(false);

  useEffect(() => {
    setDismissed(key ? readDismissed(key) : false);
    setReopened(false);
  }, [key]);

  if (!sessions.length || previewActive || location.pathname.startsWith('/review-delib/')) return null;

  const dismiss = () => {
    try {
      window.sessionStorage.setItem(dismissKey(key), '1');
    } catch {
      // Storage unavailable: the prompt may come back after a reload.
    }
    setDismissed(true);
    setReopened(false);
  };

  return (
    <ReviewDelibJoinPrompt
      sessions={sessions}
      isAdmin={isAdmin}
      promptOpen={reopened || (sessions.some((session) => !session.joined) && !dismissed)}
      onJoin={(session) => {
        dismiss();
        navigate(`/review-delib/${session.id}`);
      }}
      onDismiss={dismiss}
      onReopen={() => setReopened(true)}
    />
  );
}

export const useReviewDelibs = () => useContext(ReviewDelibContext);
