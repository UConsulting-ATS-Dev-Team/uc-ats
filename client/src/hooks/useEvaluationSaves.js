import { useCallback, useEffect, useRef } from 'react';

// Saving an interview evaluation from the interview pages: an autosave a moment after
// the last edit, plus Save and Save All. One instance per page, keyed by application.
// `scope` names the interview and the interviewer, so neither the same candidate in two
// interviews nor two people signed in on one browser ever share a queue.
//
// Saves of one candidate's evaluation go out one at a time. They used to be sent the
// moment they were asked for, so a slow autosave could land after the save that
// followed it and put the older notes back, and an autosave and Save sent together
// both tried to create the evaluation. Each save now waits for the one before it, and
// `send` reads the evaluation when it actually goes out, so what lands last is the
// latest. A save asked for while one is already waiting shares that one.
//
// A failed autosave is retried on a backoff instead of waiting for the next edit,
// which may never come (the interviewer moves on to the next candidate). It is retried
// only if nothing newer was asked for since it started: an edit brings its own
// autosave, and a Save already sent the notes after it. Nothing is retried once the
// page is gone. `onAutoSaveError` is told about every failure and `onSaved` about
// every save that lands, so the page can show "Auto-save failed" and take it down once
// a retry, a later autosave or Save gets through.
//
// Leaving the page sends whatever autosave was still waiting rather than dropping it.
// The queues live outside the page for that reason: if the interviewer reopens the
// interview at once, the new page's saves wait behind the old page's last one, so the
// old notes cannot land after the new ones.
//
// A save waits for the one ahead of it however long that takes. Giving up after a time
// limit would let the hung request finish later and overwrite newer notes, since the
// server cannot tell an old write from a new one. Waiting costs only time: once the
// hung request settles, the next save sends the latest notes.

export const AUTOSAVE_RETRY_DELAYS_MS = [2000, 5000, 15000];

// The last save queued for each scope and application, across every page instance.
const queueTails = new Map();

export default function useEvaluationSaves({
  scope,
  send,
  delayMs = 2000,
  retryDelaysMs = AUTOSAVE_RETRY_DELAYS_MS,
  onAutoSaveError,
  onSaved,
}) {
  // Read at call time: the page hands in fresh closures every render.
  const latest = useRef({});
  latest.current = { scope, send, delayMs, retryDelaysMs, onAutoSaveError, onSaved };

  const timers = useRef({});
  // Bumped by every edit and every Save, so a failed autosave can tell it is stale.
  const requests = useRef({});
  const unmounted = useRef(false);
  const waiting = useRef({});

  const cancelAutoSave = useCallback((id) => {
    if (!timers.current[id]) return false;
    clearTimeout(timers.current[id]);
    delete timers.current[id];
    return true;
  }, []);

  // Runs `task` once every save already queued for `id` has finished, failed or not.
  const enqueue = useCallback((id, task) => {
    const key = `${latest.current.scope ?? ''}\u0000${id}`;
    const run = (queueTails.get(key) || Promise.resolve()).catch(() => {}).then(task);
    queueTails.set(key, run);
    const forget = () => { if (queueTails.get(key) === run) queueTails.delete(key); };
    run.then(forget, forget);
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
    const request = requests.current[id];
    sendQueued(id).catch((error) => {
      if (unmounted.current) return;
      latest.current.onAutoSaveError?.(id, error);
      if (requests.current[id] !== request) return;
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
    if (unmounted.current) return;
    requests.current[id] = (requests.current[id] || 0) + 1;
    cancelAutoSave(id);
    timers.current[id] = setTimeout(() => {
      delete timers.current[id];
      autoSave(id);
    }, latest.current.delayMs);
  }, [autoSave, cancelAutoSave]);

  /**
   * Save `id` now, after any save of it already on the way. Rejects if this save
   * fails, so Save and Save All can report it. A failed Save then hands over to an
   * autosave, which retries on the backoff: this Save stopped any earlier autosave
   * from retrying, so without it an outage would leave the notes unsaved.
   */
  const saveNow = useCallback((id) => {
    const request = (requests.current[id] || 0) + 1;
    requests.current[id] = request;
    cancelAutoSave(id);
    const run = sendQueued(id);
    run.catch(() => {
      if (!unmounted.current && requests.current[id] === request) scheduleAutoSave(id);
    });
    return run;
  }, [cancelAutoSave, scheduleAutoSave, sendQueued]);

  /** Run a one-off write of `id` (e.g. just its decision) in its place in the queue. */
  const runInQueue = useCallback((id, task) => enqueue(id, task), [enqueue]);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      for (const id of Object.keys(timers.current)) {
        cancelAutoSave(id);
        sendQueued(id).catch((error) => console.error('Auto-save on leaving failed:', error));
      }
    };
  }, [cancelAutoSave, sendQueued]);

  return { scheduleAutoSave, saveNow, runInQueue };
}
