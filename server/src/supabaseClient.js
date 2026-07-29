import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Supabase Realtime requires a WebSocket transport in Node.js < 22.
import { WebSocket } from 'ws';

dotenv.config();

// Create Supabase client for server-side operations
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('Warning: Supabase configuration missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.');
}

export const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      },
      realtime: { transport: WebSocket }
    })
  : null;

// Helper function to check if Supabase is available
export function isSupabaseAvailable() {
  return supabase !== null;
}

export default supabase;