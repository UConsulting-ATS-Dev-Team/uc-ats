import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../utils/api';
import { useAuth } from './AuthContext';
import ExecUnlockDialog from '../components/ExecUnlockDialog';
import ExecAccessIndicator from '../components/ExecAccessIndicator';

// Executive access to sealed recruiting records - a promoted member's own file
// and their cohort's. Entering the executive-committee password buys a 30-minute
// unlock token. This keeps it in sessionStorage (a refresh keeps it, a new
// browser session does not), hands it to the API client, and drops it when it
// expires or the user signs out.
//
// `version` changes whenever access changes. Pages that load sealed data list it
// as an effect dependency, so unlocking re-fetches what was hidden and locking
// hides it again.

const STORAGE_KEY = 'uc-ats:exec-unlock';

const ExecUnlockContext = createContext(null);

// What a page sees outside the provider (isolated component tests): locked, and
// nothing to unlock with.
const LOCKED_DEFAULT = {
  unlocked: false,
  expiresAt: null,
  version: 0,
  unlock: async () => {},
  lock: () => {},
  openUnlockDialog: () => {}
};

const readStored = () => {
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || 'null');
    if (stored?.token && Date.parse(stored.expiresAt) > Date.now()) return stored;
  } catch {
    // Storage unavailable or corrupt - start locked.
  }
  return null;
};

const persist = (unlock) => {
  try {
    if (unlock) {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(unlock));
    } else {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage unavailable - the unlock still works until the page reloads.
  }
};

export function ExecUnlockProvider({ children }) {
  const { user } = useAuth();
  const [unlock, setUnlock] = useState(() => {
    const stored = readStored();
    // Handed to the client here rather than in an effect: children's effects run
    // before this provider's, and a page's first fetch must already carry it.
    apiClient.setExecUnlockToken(stored?.token ?? null);
    return stored;
  });
  const [version, setVersion] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);

  const apply = useCallback((next) => {
    // Same ordering concern: the client has the token before anything re-renders.
    apiClient.setExecUnlockToken(next?.token ?? null);
    persist(next);
    setUnlock(next);
    setVersion((current) => current + 1);
  }, []);

  const lock = useCallback(() => apply(null), [apply]);

  const unlockWithPassword = useCallback(async (password) => {
    const { token, expiresAt } = await apiClient.post('/exec-access/unlock', { password });
    apply({ token, expiresAt, userId: user?.id ?? null });
  }, [apply, user?.id]);

  const openUnlockDialog = useCallback(() => setDialogOpen(true), []);

  // Expire on schedule instead of waiting for the next 423.
  useEffect(() => {
    if (!unlock) return undefined;
    const timer = setTimeout(lock, Math.max(Date.parse(unlock.expiresAt) - Date.now(), 0));
    return () => clearTimeout(timer);
  }, [unlock, lock]);

  // Drop the unlock when its owner signs out or someone else signs in. `user` is
  // also null while the session is still being verified after a refresh, so a
  // null only counts once a user has actually been seen.
  const lastUserId = useRef(null);
  useEffect(() => {
    if (user) {
      if (unlock?.userId && unlock.userId !== user.id) lock();
      lastUserId.current = user.id;
    } else if (lastUserId.current) {
      lastUserId.current = null;
      lock();
    }
  }, [user, unlock, lock]);

  const value = useMemo(() => ({
    unlocked: Boolean(unlock),
    expiresAt: unlock?.expiresAt ?? null,
    version,
    unlock: unlockWithPassword,
    lock,
    openUnlockDialog
  }), [unlock, version, unlockWithPassword, lock, openUnlockDialog]);

  return (
    <ExecUnlockContext.Provider value={value}>
      {children}
      <ExecAccessIndicator />
      <ExecUnlockDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onUnlock={unlockWithPassword}
      />
    </ExecUnlockContext.Provider>
  );
}

export const useExecUnlock = () => useContext(ExecUnlockContext) ?? LOCKED_DEFAULT;
