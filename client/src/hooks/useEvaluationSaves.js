import { useCallback, useEffect, useRef } from 'react';

// Saving an interview evaluation from the interview pages: an autosave a moment after
// the last edit, plus Save and Save All. One instance per page, keyed by application.
//
// Saves of one candidate's evaluation go out one at a time. They used to be sent the
// moment they were asked for, so a slow autosave could land after the save that
// followed it and put the older notes back, and an autosave and Save sent together
// both tried to create the evaluation. Each save now waits for the one before it, and
// `send` reads the evaluation when it actually goes out, so what lands last is the
// latest. A save asked for while one is already waiting shares that one.
//
// A failed autosave is retried on a backoff instead of waiting for the next edit,
// which may never come (the interviewer moves on to the next candidate). An edit made
// meanwhile replaces the retry with its own autosave. `onAutoSaveError` is told about
// every failure and `onSaved` about every save that lands, so the page can show
// "Auto-save failed" and take it down once a retry, a later autosave or Save gets through.
//
// Leaving the page sends whatever autosave was still waiting rather than dropping it.

export const AUTOSAVE_RETRY_DELAYS_MS = [2000, 5000, 15000];

export default function useEvaluationSaves({
  send,
  delayMs = 2000,
  retryDelaysMs = AUTOSAVE_RETRY_DELAYS_MS,
  onAutoSaveError,
  onSaved,
}) {
  // Read at call time: the page hands in fresh closures every render.
  const latest = useRef({});
  latest.current = { send, delayMs, retryDelaysMs, onAutoSaveError, onSaved };

  const timers = useRef({});
  const tails = useRef({});
  const waiting = useRef({});

  const cancelAutoSave = useCallback((id) => {
    if (!timers.current[id]) return false;
    clearTimeout(timers.current[id]);
    delete timers.current[id];
    return true;
  }, []);

  // Runs `task` once every save already queued for `id` has finished, failed or not.
  const enqueue = useCallback((id, task) => {
    const run = (tails.current[id] || Promise.resolve()).catch(() => {}).then(task);
    tails.current[id] = run;
    return run;
  }, []);

  const sendQueued = useCallback((id) => {
    if (waiting.current[id]) return waiting.current[id];
    const run = enqueue(id, async () => {
      delete waiting.current[id];
      await latest.current.send(id);
      latest.current.onSaved?.(id);
    });
    waiting.current[id] = run;
    return run;
  }, [enqueue]);

  const autoSave = useCallback((id, attempt = 0) => {
    sendQueued(id).catch((error) => {
      latest.current.onAutoSaveError?.(id, error);
      // A newer edit already scheduled its own autosave, which is the retry.
      if (timers.current[id]) return;
      const delay = latest.current.retryDelaysMs[attempt];
      if (delay === undefined) return;
      timers.current[id] = setTimeout(() => {
        delete timers.current[id];
        autoSave(id, attempt + 1);
      }, delay);
    });
  }, [sendQueued]);

  /** Autosave `id` once edits to it have paused for `delayMs`. */
  const scheduleAutoSave = useCallback((id) => {
    cancelAutoSave(id);
    timers.current[id] = setTimeout(() => {
      delete timers.current[id];
      autoSave(id);
    }, latest.current.delayMs);
  }, [autoSave, cancelAutoSave]);

  /**
   * Save `id` now, after any save of it already on the way. Rejects if this save
   * fails, so Save and Save All can report it; an autosave it replaced is put back,
   * so the edit is still retried.
   */
  const saveNow = useCallback((id) => {
    const hadAutoSave = cancelAutoSave(id);
    const run = sendQueued(id);
    if (hadAutoSave) run.catch(() => { if (!timers.current[id]) scheduleAutoSave(id); });
    return run;
  }, [cancelAutoSave, scheduleAutoSave, sendQueued]);

  /** Run a one-off write of `id` (e.g. just its decision) in its place in the queue. */
  const runInQueue = useCallback((id, task) => enqueue(id, task), [enqueue]);

  useEffect(() => () => {
    for (const id of Object.keys(timers.current)) {
      cancelAutoSave(id);
      sendQueued(id).catch((error) => console.error('Auto-save on leaving failed:', error));
    }
  }, [cancelAutoSave, sendQueued]);

  return { scheduleAutoSave, saveNow, runInQueue };
}
