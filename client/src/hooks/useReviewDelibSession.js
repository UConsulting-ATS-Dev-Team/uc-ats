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

/**
 * Fetches `load()` whenever `key` changes, keeping only the answer to the
 * latest request. An error belongs to the `load` that raised it (one candidate's
 * card), so switching to another candidate does not show the last one's error
 * while the new one loads, but a refetch of the same one keeps it up.
 */
function useKeyedFetch(load, key, enabled) {
  const [data, setData] = useState(null);
  const [failure, setFailure] = useState(null);
  const requestRef = useRef(0);

  const run = useCallback(async () => {
    if (!enabled) return;
    const request = ++requestRef.current;
    try {
      const result = await load();
      if (request === requestRef.current) {
        setData(result);
        setFailure(null);
      }
    } catch (e) {
      if (request === requestRef.current) setFailure({ load, error: e });
    }
  }, [load, enabled]);
  const error = failure && failure.load === load ? failure.error : null;

  useEffect(() => {
    if (!enabled) {
      requestRef.current += 1;
      setData(null);
      setFailure(null);
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
  // Every action in flight. A set, not one value: an admin can save a second
  // score before the first returns, and the first finishing must not mark the
  // second done.
  const [pending, setPending] = useState(() => new Set());

  const versionRef = useRef(null);
  const joinedRef = useRef(false);
  const endedRef = useRef(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // The page stays mounted when the URL moves to another session, so a reply
  // for the previous one can still arrive. Versions are per session and say
  // nothing across two of them; the session id does.
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const accept = useCallback((next) => {
    if (!next?.version && next?.version !== 0) return;
    if (next.session?.id && next.session.id !== sessionRef.current) return;
    if (versionRef.current != null && next.version < versionRef.current) return;
    versionRef.current = next.version;
    endedRef.current = next.session?.status === 'ENDED';
    setState(next);
  }, []);

  const report = useCallback((error) => {
    onErrorRef.current?.(error?.serverMessage || error?.message || 'Something went wrong');
  }, []);

  const join = useCallback(async () => {
    const id = sessionId;
    const stale = () => sessionRef.current !== id;
    try {
      const joined = await reviewDelibApi.join(id);
      if (stale()) {
        // Joined a session the viewer has already left behind.
        reviewDelibApi.leave(id);
        return;
      }
      accept(joined);
      joinedRef.current = true;
      setReady(true);
    } catch (error) {
      if (stale()) return;
      if (error?.code === 'SESSION_ENDED') {
        // Too late to join, but the summary is still worth showing.
        try {
          const ended = await reviewDelibApi.state(id);
          if (stale()) return;
          accept(ended);
          setReady(true);
          return;
        } catch {
          if (stale()) return;
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
    // No getVersion: usePolling keeps the highest version it has applied for
    // the life of the page, so after moving from a session at version 50 to
    // one at 3 it would drop every poll of the new one. `accept` orders
    // responses per session instead.
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

  // Keyed on the session too: two sessions can be at the same version.
  const loadTeam = useCallback(() => reviewDelibApi.team(sessionId), [sessionId]);
  const team = useKeyedFetch(loadTeam, `${sessionId}:${version}:${teamTick}`, ready && version !== null);

  // The open card refreshes on the same tick as the team view: a grade saved
  // outside the session, or a record sealed, changes no version.
  const loadCard = useCallback(
    () => reviewDelibApi.candidate(sessionId, currentApplicationId),
    [sessionId, currentApplicationId]
  );
  const card = useKeyedFetch(loadCard, `${sessionId}:${currentApplicationId}:${version}:${teamTick}`, ready && Boolean(currentApplicationId));

  const loadChanges = useCallback(() => reviewDelibApi.changes(sessionId), [sessionId]);
  const changes = useKeyedFetch(loadChanges, `${sessionId}:${version}`, ready && step === 'SUMMARY');

  // --- Admin actions --------------------------------------------------------

  const runAction = useCallback(async (name, request) => {
    setPending((current) => new Set(current).add(name));
    try {
      accept(await request());
      return true;
    } catch (error) {
      if (!QUIET_CODES.has(error?.code)) report(error);
      refreshRef.current?.();
      return false;
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(name);
        return next;
      });
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
    changesError: changes.error,
    // Nothing polls after a session ends, so a failed load needs a way to try again.
    reloadTeam: team.reload,
    reloadChanges: changes.reload,
    error: fatal,
    loading: !ready && !fatal,
    connected,
    pending,
    busy: pending.size > 0,
    refresh,
    ...actions
  };
}
