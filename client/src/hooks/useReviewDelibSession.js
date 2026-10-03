import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePolling from './usePolling';
import reviewDelibApi from '../utils/reviewDelibApi';
import { supabase } from '../supabaseClient';

// One review team deliberation, kept current for this viewer.
//
// Two layers. The light state (which step, which candidate, who is here) is
// polled and nudged exactly like a live vote: every response goes through
// `accept`, which drops anything older than the version on screen. The heavy
// payloads - the team's numbers and the candidate card on screen - are fetched
// only when that state says something changed, so a room of ten polling every
// second and a half reads one small row, not the whole cycle's scores.

export const POLL_MS = { realtime: 4000, polling: 1500, hidden: 10000 };
// Grades saved outside the session do not bump its version.
const TEAM_REFRESH_MS = 30000;

// Another admin got there first, or the session just ended. Not worth an error.
const QUIET_CODES = new Set(['STALE_NAV', 'SESSION_ENDED']);

const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** Fetches `load()` whenever `key` changes, keeping only the answer to the latest request. */
function useKeyedFetch(load, key, enabled) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const requestRef = useRef(0);

  const run = useCallback(async () => {
    if (!enabled) return;
    const request = ++requestRef.current;
    try {
      const result = await load();
      if (request === requestRef.current) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (request === requestRef.current) setError(e);
    }
  }, [load, enabled]);

  useEffect(() => {
    if (!enabled) {
      requestRef.current += 1;
      setData(null);
      setError(null);
      return;
    }
    run();
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, error, reload: run };
}

export default function useReviewDelibSession(sessionId, { onError } = {}) {
  const [state, setState] = useState(null);
  const [fatal, setFatal] = useState(null);
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [hidden, setHidden] = useState(isHidden);
  const [pendingAction, setPendingAction] = useState(null);

  const versionRef = useRef(null);
  const joinedRef = useRef(false);
  const endedRef = useRef(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const accept = useCallback((next) => {
    if (!next?.version && next?.version !== 0) return;
    if (versionRef.current != null && next.version < versionRef.current) return;
    versionRef.current = next.version;
    endedRef.current = next.session?.status === 'ENDED';
    setState(next);
  }, []);

  const report = useCallback((error) => {
    onErrorRef.current?.(error?.serverMessage || error?.message || 'Something went wrong');
  }, []);

  const join = useCallback(async () => {
    try {
      accept(await reviewDelibApi.join(sessionId));
      joinedRef.current = true;
      setReady(true);
    } catch (error) {
      if (error?.code === 'SESSION_ENDED') {
        // Too late to join, but the summary is still worth showing.
        try {
          accept(await reviewDelibApi.state(sessionId));
          setReady(true);
          return;
        } catch {
          // fall through to the fatal error below
        }
      }
      setFatal(error);
    }
  }, [sessionId, accept]);

  useEffect(() => {
    versionRef.current = null;
    joinedRef.current = false;
    endedRef.current = false;
    setState(null);
    setFatal(null);
    setReady(false);
    join();

    const leave = () => {
      if (joinedRef.current && !endedRef.current) {
        joinedRef.current = false;
        reviewDelibApi.leave(sessionId);
      }
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [sessionId, join]);

  useEffect(() => {
    const onVisibility = () => setHidden(isHidden());
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const fetcher = useCallback((signal) => reviewDelibApi.state(sessionId, { signal }), [sessionId]);

  const { refresh } = usePolling({
    fetcher,
    enabled: ready && state?.session?.status !== 'ENDED',
    immediate: false,
    // Never paused: the poll doubles as the presence heartbeat.
    pauseWhenHidden: false,
    interval: hidden ? POLL_MS.hidden : connected ? POLL_MS.realtime : POLL_MS.polling,
    getVersion: (payload) => payload.version,
    onData: accept,
    onError: (error) => {
      if (error?.code === 'NOT_JOINED') join();
      else if (error?.code === 'NOT_ON_TEAM') setFatal(error);
    }
  });

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!supabase || !sessionId) return undefined;
    const channel = supabase.channel(`review-delib:${sessionId}`, { config: { broadcast: { self: false } } });
    channel.on('broadcast', { event: 'state:changed' }, ({ payload }) => {
      if (payload?.sessionId !== sessionId) return;
      if (versionRef.current != null && payload.version <= versionRef.current) return;
      refreshRef.current?.();
    });
    channel.subscribe((subscriptionStatus) => setConnected(subscriptionStatus === 'SUBSCRIBED'));
    return () => {
      setConnected(false);
      try { channel.unsubscribe(); } catch { /* already gone */ }
      try { supabase.removeChannel(channel); } catch { /* already gone */ }
    };
  }, [sessionId]);

  // --- Heavy payloads, refetched when the light state moves -----------------

  const version = state?.version ?? null;
  const currentApplicationId = state?.session?.currentApplicationId ?? null;
  const step = state?.session?.status === 'ENDED' ? 'SUMMARY' : state?.session?.step;

  const [teamTick, setTeamTick] = useState(0);
  useEffect(() => {
    if (!ready || state?.session?.status === 'ENDED') return undefined;
    const timer = setInterval(() => setTeamTick((tick) => tick + 1), TEAM_REFRESH_MS);
    return () => clearInterval(timer);
  }, [ready, state?.session?.status]);

  const loadTeam = useCallback(() => reviewDelibApi.team(sessionId), [sessionId]);
  const team = useKeyedFetch(loadTeam, `${version}:${teamTick}`, ready && version !== null);

  const loadCard = useCallback(
    () => reviewDelibApi.candidate(sessionId, currentApplicationId),
    [sessionId, currentApplicationId]
  );
  const card = useKeyedFetch(loadCard, `${currentApplicationId}:${version}`, ready && Boolean(currentApplicationId));

  const loadChanges = useCallback(() => reviewDelibApi.changes(sessionId), [sessionId]);
  const changes = useKeyedFetch(loadChanges, version, ready && step === 'SUMMARY');

  // --- Admin actions --------------------------------------------------------

  const runAction = useCallback(async (name, request) => {
    setPendingAction(name);
    try {
      accept(await request());
      return true;
    } catch (error) {
      if (!QUIET_CODES.has(error?.code)) report(error);
      refreshRef.current?.();
      return false;
    } finally {
      setPendingAction(null);
    }
  }, [accept, report]);

  const actions = useMemo(() => ({
    navigate: (toStep, applicationId = null) => state?.session && runAction('navigate', () =>
      reviewDelibApi.navigate(sessionId, {
        step: toStep,
        applicationId,
        from: { step: state.session.step, applicationId: state.session.currentApplicationId }
      })),
    setThreshold: (pct) => runAction('threshold', () => reviewDelibApi.threshold(sessionId, pct)),
    override: (type, scoreId, value) => runAction(`override:${scoreId}`, () => reviewDelibApi.override(sessionId, type, scoreId, value)),
    decide: (applicationId, decision) => runAction(`decide:${applicationId}`, () => reviewDelibApi.decide(sessionId, applicationId, decision)),
    end: () => runAction('end', () => reviewDelibApi.end(sessionId))
  }), [runAction, sessionId, state]);

  return {
    state,
    team: team.data,
    teamError: team.error,
    card: card.data && card.data.applicationId === currentApplicationId ? card.data : null,
    cardError: card.error,
    changes: changes.data,
    error: fatal,
    loading: !ready && !fatal,
    connected,
    pendingAction,
    refresh,
    ...actions
  };
}
