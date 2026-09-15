import supabase, { isSupabaseAvailable } from '../supabaseClient.js';

// Supabase Realtime broadcast. Channels are joined in the browser with the anon
// key, so anyone holding that key can listen: a payload sent here must be safe to
// publish. Anything private is fetched through the authenticated API instead.

export async function broadcast(channelName, event, payload) {
  if (!isSupabaseAvailable()) return;
  try {
    const channel = supabase.channel(channelName);
    if (typeof channel.httpSend === 'function') {
      await channel.httpSend(event, payload);
    } else {
      await channel.send({ type: 'broadcast', event, payload });
    }
  } catch (err) {
    console.error(`[realtime] broadcast failed for ${channelName}/${event}:`, err);
  }
}

export function broadcastToConversation(conversationId, event, payload) {
  return broadcast(channelNameFor(conversationId), event, payload);
}

export const channelNameFor = (conversationId) => `conv:${conversationId}`;

// Live votes. These only say "session X is now at version N" - a nudge to go and
// fetch - never who voted or how.

export const liveVoteChannel = (sessionId) => `live-vote:${sessionId}`;
export const LIVE_VOTES_CHANNEL = 'live-votes';

// A room of forty voting at once should cost a handful of broadcasts, not forty.
// Vote nudges are coalesced per session and sent once the burst's first vote is
// this old, carrying the newest version seen. Control changes go out at once.
export const VOTE_NUDGE_MS = 400;
const pendingVoteNudges = new Map();

export function nudgeLiveVote(sessionId, { version, kind = 'control' }) {
  if (kind !== 'vote') {
    void broadcast(liveVoteChannel(sessionId), 'state:changed', { sessionId, version, kind });
    return;
  }

  const pending = pendingVoteNudges.get(sessionId);
  if (pending) {
    pending.version = Math.max(pending.version, version);
    return;
  }

  const entry = { version };
  const timer = setTimeout(() => {
    pendingVoteNudges.delete(sessionId);
    void broadcast(liveVoteChannel(sessionId), 'state:changed', { sessionId, version: entry.version, kind });
  }, VOTE_NUDGE_MS);
  timer.unref?.();
  pendingVoteNudges.set(sessionId, entry);
}

export function nudgeLiveVotesGlobal({ sessionId, status }) {
  void broadcast(LIVE_VOTES_CHANNEL, 'session:changed', { sessionId, status });
}
