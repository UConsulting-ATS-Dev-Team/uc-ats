import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  QuestionMarkCircleIcon,
  XMarkIcon,
  PlusIcon,
  TrashIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import apiClient from '../../utils/api';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../supabaseClient';
import './InterviewQuestionPanel.css';

// Polling is the fallback, not the transport. A Supabase broadcast says "this interview's
// questions changed" and the list is refetched at once; these intervals only cover the
// case where that nudge never arrives - env vars unset, socket blocked, subscription
// dropped. Matches the live vote rooms, which treat Supabase the same way.
const POLL_MS = { realtime: 30000, polling: 10000 };

// A broadcast is an untrusted trigger - anyone holding the anon key can post one - so a
// burst of them must not become a burst of authenticated reads. Nudges collapse onto a
// single trailing refetch, and a read already in flight absorbs whatever lands during it.
const NUDGE_COALESCE_MS = 500;

const questionsChannel = (interviewId) => `interview-questions:${interviewId}`;

const ROUND_LABELS = {
  COFFEE_CHAT: 'Coffee Chat',
  ROUND_ONE: 'Round 1',
  ROUND_TWO: 'Round 2',
  FINAL_ROUND: 'Final Round',
  DELIBERATIONS: 'Deliberations',
};

const roundLabel = (round) => ROUND_LABELS[round] || round;

// Question prep only belongs to the structured rounds. ROUND_TWO is the legacy
// alias of FINAL_ROUND everywhere else in the app, so it keeps the panel too.
const QUESTION_ROUNDS = new Set(['ROUND_ONE', 'ROUND_TWO', 'FINAL_ROUND']);

// Session questions arrive as a stream of changes, not a snapshot: a ?since poll returns
// soft-deleted rows too, because those tombstones are the only signal that a co-interviewer
// removed something. Rows are folded into a Map so the boundary row a `gte` filter re-sends
// on every poll is idempotent rather than a duplicate.
function foldRows(map, rows) {
  let watermark = null;
  rows.forEach((row) => {
    if (row.deletedAt) map.delete(row.id);
    else map.set(row.id, row);
    if (!watermark || new Date(row.updatedAt) > new Date(watermark)) watermark = row.updatedAt;
  });
  return watermark;
}

function sortQuestions(questions) {
  return [...questions].sort(
    (a, b) => a.position - b.position || new Date(a.updatedAt) - new Date(b.updatedAt)
  );
}

export default function InterviewQuestionPanel({ interviewId, round, interviewTitle }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('session');

  const [sessionQuestions, setSessionQuestions] = useState([]);
  const [bank, setBank] = useState([]);
  const [facets, setFacets] = useState({ categories: [], rounds: [] });

  const [connected, setConnected] = useState(false);
  const [delivered, setDelivered] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [loadingBank, setLoadingBank] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [roundFilter, setRoundFilter] = useState(round || '');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [busyId, setBusyId] = useState(null);

  const questionMap = useRef(new Map());
  const watermark = useRef(null);

  // A read that started before this panel changed the list describes a list that no
  // longer exists, and a full read rebuilds the map from scratch - so letting a stale one
  // land erases the change. That is what made Add look broken: the button reported
  // success, the question appeared, and the poll already in flight wiped it out again.
  // Counting reads and local writes separately is enough to recognise both cases.
  const loadSeq = useRef(0);
  const localSeq = useRef(0);

  // Question prep only belongs to the structured rounds, and there is nothing to sync
  // without an interview. Every effect below is inert otherwise, because the hooks still
  // run on a coffee chat where the panel itself renders nothing.
  const active = Boolean(interviewId) && QUESTION_ROUNDS.has(round);

  useEffect(() => {
    if (round && !roundFilter) setRoundFilter(round);
  }, [round]); // eslint-disable-line react-hooks/exhaustive-deps

  const publish = useCallback(() => {
    setSessionQuestions(sortQuestions([...questionMap.current.values()]));
  }, []);

  // Everything this panel writes itself goes through here, so the counter can never be
  // missed. It deliberately leaves the watermark alone: the watermark means "every change
  // up to here has been seen", and a local write only proves the panel has seen its own.
  // Jumping it to the new row's stamp would skip a co-interviewer's change made a moment
  // earlier, and no later `since` read would ever ask for that window again.
  const applyLocal = useCallback(
    (rows) => {
      foldRows(questionMap.current, rows.filter(Boolean));
      localSeq.current += 1;
      publish();
    },
    [publish]
  );

  const loadSession = useCallback(
    async ({ full = false } = {}) => {
      if (!interviewId) return;
      if (full) setLoadingSession(true);
      const seq = ++loadSeq.current;
      const localAtStart = localSeq.current;
      try {
        // No watermark yet (first load, or an empty list) means a full read. Deriving the
        // watermark from the rows themselves rather than the local clock keeps this correct
        // when the server and the browser disagree about the time.
        const useSince = !full && watermark.current;
        const url = `/member/interviews/${interviewId}/session-questions${
          useSince ? `?since=${encodeURIComponent(watermark.current)}` : ''
        }`;
        const rows = await apiClient.get(url);
        // A newer read has already answered. This one is behind it and asked for no less,
        // so it has nothing to add and could resurrect a row the newer one tombstoned.
        if (seq !== loadSeq.current) return;
        const list = Array.isArray(rows) ? rows : [];
        // Only a read that rebuilds the map from scratch can erase a local write, and
        // only one that started before that write carries a list old enough to do it.
        // An incremental read is additive, so it is always safe to apply - dropping one
        // would throw away the sole copy of whatever a co-interviewer changed in the
        // window it covers.
        const rebuilds = full || !useSince;
        if (rebuilds && localSeq.current !== localAtStart) return;
        if (rebuilds) questionMap.current = new Map();
        const next = foldRows(questionMap.current, list);
        if (next) watermark.current = next;
        publish();
        setError(null);
      } catch (e) {
        setError(e.message || 'Could not load this interview’s questions.');
      } finally {
        if (full) setLoadingSession(false);
      }
    },
    [interviewId, publish]
  );

  const loadBank = useCallback(async () => {
    setLoadingBank(true);
    try {
      const params = new URLSearchParams();
      if (roundFilter) params.set('round', roundFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      const qs = params.toString();
      // Asked for by interview, not by cycle: the bank that belongs to this interview is
      // the one its own cycle owns, which stops being the active cycle the moment
      // recruitment moves on.
      const rows = await apiClient.get(
        `/member/interviews/${interviewId}/question-bank${qs ? `?${qs}` : ''}`
      );
      setBank(Array.isArray(rows) ? rows : []);
      setError(null);
    } catch (e) {
      setError(e.message || 'Could not load the question bank.');
    } finally {
      setLoadingBank(false);
    }
  }, [interviewId, roundFilter, categoryFilter]);

  useEffect(() => {
    if (!open) return undefined;
    loadSession({ full: true });
    apiClient
      .get(`/member/interviews/${interviewId}/question-bank/facets`)
      .then((data) =>
        setFacets({
          categories: Array.isArray(data?.categories) ? data.categories : [],
          rounds: Array.isArray(data?.rounds) ? data.rounds : [],
        })
      )
      .catch(() => setFacets({ categories: [], rounds: [] }));
    return undefined;
  }, [open, interviewId, loadSession]);

  useEffect(() => {
    if (!open || tab !== 'bank') return undefined;
    loadBank();
    return undefined;
  }, [open, tab, loadBank]);

  // The fallback poll still only runs while the panel is open, and it slows down only
  // once a nudge has actually arrived. Subscribing proves the browser reached Supabase,
  // not that the server can publish: if the server's own credentials are missing or a
  // send fails, `broadcast()` returns quietly while the client sits happily SUBSCRIBED.
  // Waiting for delivery means a panel with no working realtime keeps the interval it
  // had before this existed, rather than a slower one.
  useEffect(() => {
    if (!open) return undefined;
    const interval = connected && delivered ? POLL_MS.realtime : POLL_MS.polling;
    const timer = setInterval(() => loadSession(), interval);
    return () => clearInterval(timer);
  }, [open, connected, delivered, loadSession]);

  const loadSessionRef = useRef(loadSession);
  loadSessionRef.current = loadSession;

  const nudge = useRef({ timer: null, inFlight: false, pending: false });

  const refetchFromNudge = useCallback(() => {
    const state = nudge.current;
    // A read is already running. Let it finish and follow it with exactly one more - it
    // may have started before the change this nudge is about.
    if (state.inFlight) {
      state.pending = true;
      return;
    }
    if (state.timer) return;
    state.timer = setTimeout(async () => {
      state.timer = null;
      // Closing the panel swaps in a fresh state object. Anything still holding the old
      // one is a leftover from a panel that is no longer open, and a closed panel starts
      // no reads - not the queued one here, and not the follow-up below, which reschedules
      // through this same function and would otherwise land on the replacement.
      if (nudge.current !== state) return;
      state.inFlight = true;
      state.pending = false;
      try {
        await loadSessionRef.current?.();
      } finally {
        state.inFlight = false;
        if (state.pending && nudge.current === state) refetchFromNudge();
      }
    }, NUDGE_COALESCE_MS);
  }, []);

  // Subscribed only while the panel is open, for the same reason the poll is: a closed
  // panel deliberately fetches nothing, and a nudge it cannot act on is a wasted socket.
  // The full read on open is what catches whatever was missed in the meantime.
  useEffect(() => {
    if (!open || !active || !supabase) return undefined;
    const channel = supabase.channel(questionsChannel(interviewId));

    channel.on('broadcast', { event: 'questions:changed' }, ({ payload }) => {
      if (payload?.interviewId !== interviewId) return;
      // Any nudge at all, even one this panel goes on to ignore, is proof that the server
      // can publish and this browser receives - which is what the poll interval keys on.
      setDelivered(true);
      // Anyone holding the anon key can post here, so a nudge is only ever a reason to
      // re-read through the authenticated API, never data in its own right. What bounds
      // the cost of a forged one is the coalescing below, not this check.
      if (payload.at && watermark.current && new Date(payload.at) <= new Date(watermark.current)) {
        return;
      }
      refetchFromNudge();
    });

    channel.subscribe((status) => setConnected(status === 'SUBSCRIBED'));

    return () => {
      setConnected(false);
      setDelivered(false);
      if (nudge.current.timer) clearTimeout(nudge.current.timer);
      nudge.current = { timer: null, inFlight: false, pending: false };
      try { channel.unsubscribe(); } catch { /* already gone */ }
      try { supabase.removeChannel(channel); } catch { /* already gone */ }
    };
  }, [open, active, interviewId, refetchFromNudge]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const addedBankIds = useMemo(
    () => new Set(sessionQuestions.map((q) => q.questionBankId).filter(Boolean)),
    [sessionQuestions]
  );

  const visibleBank = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return bank;
    return bank.filter(
      (q) =>
        (q.prompt || '').toLowerCase().includes(needle) ||
        (q.guidance || '').toLowerCase().includes(needle) ||
        (q.category || '').toLowerCase().includes(needle)
    );
  }, [bank, search]);

  const addAdHoc = async (e) => {
    e.preventDefault();
    const prompt = draft.trim();
    if (!prompt) return;
    setDraft('');
    try {
      const created = await apiClient.post(`/member/interviews/${interviewId}/session-questions`, {
        prompt,
      });
      applyLocal([created]);
    } catch (err) {
      setDraft(prompt);
      setError(err.message || 'Could not add that question.');
    }
  };

  const addFromBank = async (question) => {
    setBusyId(question.id);
    try {
      const created = await apiClient.post(
        `/member/interviews/${interviewId}/session-questions/bank`,
        { questionId: question.id }
      );
      applyLocal([created]);
      setNotice('Added to this interview.');
    } catch (err) {
      setError(err.message || 'Could not add that question.');
    } finally {
      setBusyId(null);
    }
  };

  const removeQuestion = async (question) => {
    setBusyId(question.id);
    try {
      const removed = await apiClient.delete(
        `/member/interviews/${interviewId}/session-questions/${question.id}`
      );
      // The route answers with the soft-deleted row, so the tombstone carries both the
      // removal and the stamp that advances the watermark past it.
      questionMap.current.delete(question.id);
      applyLocal([removed]);
    } catch (err) {
      setError(err.message || 'Could not remove that question.');
    } finally {
      setBusyId(null);
    }
  };

  const move = async (index, delta) => {
    const next = index + delta;
    if (next < 0 || next >= sessionQuestions.length) return;
    const reordered = [...sessionQuestions];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(next, 0, moved);
    // Optimistic, and counted: a read already in flight must not undo it on arrival.
    reordered.forEach((q, i) => questionMap.current.set(q.id, { ...q, position: i }));
    localSeq.current += 1;
    setSessionQuestions(reordered);

    try {
      const rows = await apiClient.patch(
        `/member/interviews/${interviewId}/session-questions/reorder`,
        { order: reordered.map((q) => q.id) }
      );
      applyLocal(Array.isArray(rows) ? rows : []);
    } catch (err) {
      // A 409 means someone else added or removed a question while this list was on
      // screen. Resyncing is the honest recovery - the local order was computed against
      // a list that no longer exists.
      if (/409/.test(err.message || '')) {
        setNotice('Another interviewer changed the list. Reloaded.');
      } else {
        setError(err.message || 'Could not save the new order.');
      }
      watermark.current = null;
      loadSession({ full: true });
    }
  };

  const canRemove = (question) =>
    user?.role === 'ADMIN' || question.addedBy === user?.id;

  if (!active) return null;

  return (
    <>
      <button
        type="button"
        className="question-panel-tab"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Interview questions"
      >
        <QuestionMarkCircleIcon className="question-panel-tab__icon" />
        <span className="question-panel-tab__label">Questions</span>
        {sessionQuestions.length > 0 && (
          <span className="question-panel-tab__count">{sessionQuestions.length}</span>
        )}
      </button>

      {open && (
        <aside className="question-panel" role="complementary" aria-label="Interview questions">
          <header className="question-panel__header">
            <div className="question-panel__heading">
              <h4 className="question-panel__title">Questions</h4>
              <p className="question-panel__subtitle">
                {interviewTitle || 'This interview'}
                {round ? ` · ${roundLabel(round)}` : ''}
              </p>
            </div>
            <button
              type="button"
              className="question-panel__close"
              onClick={() => setOpen(false)}
              aria-label="Close questions"
            >
              <XMarkIcon />
            </button>
          </header>

          <div className="question-panel__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'session'}
              className={`question-panel__tab ${tab === 'session' ? 'is-active' : ''}`}
              onClick={() => setTab('session')}
            >
              This interview {sessionQuestions.length > 0 && `(${sessionQuestions.length})`}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'bank'}
              className={`question-panel__tab ${tab === 'bank' ? 'is-active' : ''}`}
              onClick={() => setTab('bank')}
            >
              Question bank
            </button>
          </div>

          {error && (
            <div className="question-panel__error" role="alert">
              {error}
              <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
                <XMarkIcon />
              </button>
            </div>
          )}
          {notice && <div className="question-panel__notice">{notice}</div>}

          {tab === 'session' ? (
            <>
              <div className="question-panel__body">
                {loadingSession && sessionQuestions.length === 0 ? (
                  <p className="question-panel__muted">Loading…</p>
                ) : sessionQuestions.length === 0 ? (
                  <div className="question-panel__empty">
                    <p>No questions queued for this interview yet.</p>
                    <button type="button" className="question-panel__link" onClick={() => setTab('bank')}>
                      Browse the question bank
                    </button>
                  </div>
                ) : (
                  <ol className="question-panel__list">
                    {sessionQuestions.map((q, index) => (
                      <li key={q.id} className="question-card">
                        <div className="question-card__main">
                          <p className="question-card__prompt">{q.prompt}</p>
                          {q.guidance && <p className="question-card__guidance">{q.guidance}</p>}
                          {!q.questionBankId && (
                            <span className="question-card__badge">Added live</span>
                          )}
                        </div>
                        <div className="question-card__actions">
                          <button
                            type="button"
                            onClick={() => move(index, -1)}
                            disabled={index === 0}
                            aria-label={`Move up: ${q.prompt}`}
                          >
                            <ChevronUpIcon />
                          </button>
                          <button
                            type="button"
                            onClick={() => move(index, 1)}
                            disabled={index === sessionQuestions.length - 1}
                            aria-label={`Move down: ${q.prompt}`}
                          >
                            <ChevronDownIcon />
                          </button>
                          {canRemove(q) && (
                            <button
                              type="button"
                              className="question-card__remove"
                              onClick={() => removeQuestion(q)}
                              disabled={busyId === q.id}
                              aria-label={`Remove: ${q.prompt}`}
                            >
                              <TrashIcon />
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              <form className="question-panel__composer" onSubmit={addAdHoc}>
                <input
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Ask something else…"
                  aria-label="Add a question to this interview"
                />
                <button type="submit" disabled={!draft.trim()} aria-label="Add question">
                  <PlusIcon />
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="question-panel__filters">
                <div className="question-panel__search">
                  <MagnifyingGlassIcon />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search questions"
                    aria-label="Search the question bank"
                  />
                </div>
                <div className="question-panel__selects">
                  <select
                    value={roundFilter}
                    onChange={(e) => setRoundFilter(e.target.value)}
                    aria-label="Filter by round"
                  >
                    <option value="">All rounds</option>
                    {facets.rounds.map((r) => (
                      <option key={r} value={r}>
                        {roundLabel(r)}
                      </option>
                    ))}
                  </select>
                  <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    aria-label="Filter by category"
                  >
                    <option value="">All categories</option>
                    {facets.categories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="question-panel__body">
                {loadingBank ? (
                  <p className="question-panel__muted">Loading…</p>
                ) : visibleBank.length === 0 ? (
                  <div className="question-panel__empty">
                    <p>
                      {bank.length === 0
                        ? 'No published questions for this cycle yet.'
                        : 'No questions match these filters.'}
                    </p>
                  </div>
                ) : (
                  <ul className="question-panel__list">
                    {visibleBank.map((q) => {
                      const already = addedBankIds.has(q.id);
                      return (
                        <li key={q.id} className="question-card">
                          <div className="question-card__main">
                            <p className="question-card__prompt">{q.prompt}</p>
                            {q.guidance && <p className="question-card__guidance">{q.guidance}</p>}
                            <div className="question-card__meta">
                              <span className="question-card__chip">{roundLabel(q.round)}</span>
                              {q.category && (
                                <span className="question-card__chip">{q.category}</span>
                              )}
                            </div>
                          </div>
                          <div className="question-card__actions">
                            <button
                              type="button"
                              className="question-card__add"
                              onClick={() => addFromBank(q)}
                              disabled={already || busyId === q.id}
                              aria-label={already ? `Already added: ${q.prompt}` : `Add: ${q.prompt}`}
                            >
                              {already ? 'Added' : 'Add'}
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
        </aside>
      )}
    </>
  );
}
