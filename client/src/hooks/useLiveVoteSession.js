import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePolling from './usePolling';
import liveVoteApi from '../utils/liveVoteApi';
import { supabase } from '../supabaseClient';

// One live vote session, kept current for this viewer.
//
// State arrives three ways - poll responses, host action responses, and a
// refetch prompted by a Supabase broadcast - and they can land out of order.
// Every one goes through `accept`, which drops anything older than the version
// already on screen, so a slow poll can never undo a click.
//
// Supabase is a nudge, not the transport: the broadcast says "version N exists"
// and this fetches it through the authenticated API. Without Supabase (env vars
// unset, socket blocked) polling alone keeps the room within ~1.5s.

export const POLL_MS = { realtime: 4000, polling: 1500, hidden: 10000 };

// Another admin got there first. Not worth an error; just show where things are.
const QUIET_CODES = new Set(['STALE_INDEX', 'BALLOT_NOT_OPEN', 'BALLOT_ALREADY_OPEN', 'INVALID_STATE']);

const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export default function useLiveVoteSession(sessionId, { onError } = {}) {
  const [state, setState] = useState(null);
  const [fatal, setFatal] = useState(null);
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [hidden, setHidden] = useState(isHidden);
  const [pendingVote, setPendingVote] = useState(null);
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
      accept(await liveVoteApi.join(sessionId));
      joinedRef.current = true;
      setReady(true);
    } catch (error) {
      if (error?.code === 'SESSION_ENDED') {
        // Too late to join, but the summary is still worth showing.
        try {
          accept(await liveVoteApi.state(sessionId));
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
        liveVoteApi.leave(sessionId);
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

  const fetcher = useCallback((signal) => liveVoteApi.state(sessionId, { signal }), [sessionId]);

  const { status, refresh } = usePolling({
    fetcher,
    enabled: ready && state?.session?.status !== 'ENDED',
    immediate: false,
    // Never paused: the poll doubles as the presence heartbeat, and a voter who
    // flicks to their notes for a minute is still in the room.
    pauseWhenHidden: false,
    interval: hidden ? POLL_MS.hidden : connected ? POLL_MS.realtime : POLL_MS.polling,
    getVersion: (payload) => payload.version,
    onData: accept,
    onError: (error) => {
      if (error?.code === 'NOT_JOINED') join();
    }
  });

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!supabase || !sessionId) return undefined;
    const channel = supabase.channel(`live-vote:${sessionId}`, { config: { broadcast: { self: false } } });
    const timers = new Set();

    channel.on('broadcast', { event: 'state:changed' }, ({ payload }) => {
      if (payload?.sessionId !== sessionId) return;
      if (versionRef.current != null && payload.version <= versionRef.current) return;
      // Forty screens refetching on the same millisecond is a thundering herd;
      // a vote tally can wait a beat, a host action should not.
      const delay = payload.kind === 'vote' ? Math.random() * 250 : 0;
      const timer = setTimeout(() => {
        timers.delete(timer);
        refreshRef.current?.();
      }, delay);
      timers.add(timer);
    });
    channel.subscribe((subscriptionStatus) => setConnected(subscriptionStatus === 'SUBSCRIBED'));

    return () => {
      timers.forEach(clearTimeout);
      setConnected(false);
      try { channel.unsubscribe(); } catch { /* already gone */ }
      try { supabase.removeChannel(channel); } catch { /* already gone */ }
    };
  }, [sessionId]);

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

  const currentBallot = state?.current?.ballot ?? null;

  const vote = useCallback(async (value) => {
    const ballot = state?.current?.ballot;
    if (!ballot || ballot.status !== 'OPEN' || !ballot.canVote) return;
    setPendingVote({ ballotId: ballot.id, value });
    try {
      await liveVoteApi.vote(sessionId, ballot.id, value);
      await refreshRef.current?.();
    } catch (error) {
      report(error?.code === 'BALLOT_CLOSED'
        ? { message: 'Voting closed before your vote was counted.' }
        : error);
      refreshRef.current?.();
    } finally {
      setPendingVote((current) => (current?.ballotId === ballot.id && current.value === value ? null : current));
    }
  }, [sessionId, state, report]);

  const actions = useMemo(() => ({
    begin: () => runAction('begin', () => liveVoteApi.begin(sessionId)),
    close: () => currentBallot && runAction('close', () => liveVoteApi.close(sessionId, currentBallot.id)),
    reopen: () => state?.current &&
      runAction('reopen', () => liveVoteApi.reopen(sessionId, state.current.sessionCandidateId)),
    navigate: (toIndex) => state?.session &&
      runAction('navigate', () => liveVoteApi.navigate(sessionId, state.session.currentIndex, toIndex)),
    decide: (decision) => state?.current &&
      runAction('decide', () => liveVoteApi.decide(sessionId, state.current.sessionCandidateId, decision)),
    end: () => runAction('end', () => liveVoteApi.end(sessionId))
  }), [runAction, sessionId, currentBallot, state]);

  // A vote on its way shows as cast; it is replaced by the server's answer.
  const myVote = pendingVote && pendingVote.ballotId === currentBallot?.id
    ? pendingVote.value
    : currentBallot?.myVote ?? null;

  return {
    state,
    error: fatal,
    loading: !ready && !fatal,
    status,
    connected,
    myVote,
    voting: Boolean(pendingVote),
    pendingAction,
    vote,
    refresh,
    ...actions
  };
}
