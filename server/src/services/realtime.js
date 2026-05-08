import supabase, { isSupabaseAvailable } from '../supabaseClient.js';

export async function broadcastToConversation(conversationId, event, payload) {
  if (!isSupabaseAvailable()) return;
  try {
    const channel = supabase.channel(`conv:${conversationId}`);
    if (typeof channel.httpSend === 'function') {
      await channel.httpSend(event, payload);
    } else {
      await channel.send({ type: 'broadcast', event, payload });
    }
  } catch (err) {
    console.error(`[realtime] broadcast failed for ${conversationId}/${event}:`, err);
  }
}

export const channelNameFor = (conversationId) => `conv:${conversationId}`;
