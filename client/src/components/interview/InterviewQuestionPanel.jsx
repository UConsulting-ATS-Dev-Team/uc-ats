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

  const loadSession = useCallback(
    async ({ full = false } = {}) => {
      if (!interviewId) return;
      if (full) setLoadingSession(true);
      try {
        // No watermark yet (first load, or an empty list) means a full read. Deriving the
        // watermark from the rows themselves rather than the local clock keeps this correct
        // when the server and the browser disagree about the time.
        const useSince = !full && watermark.current;
        const url = `/member/interviews/${interviewId}/session-questions${
          useSince ? `?since=${encodeURIComponent(watermark.current)}` : ''
        }`;
        const rows = await apiClient.get(url);
        const list = Array.isArray(rows) ? rows : [];
        if (full || !useSince) questionMap.current = new Map();
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
      const rows = await apiClient.get(`/member/interview-questions${qs ? `?${qs}` : ''}`);
      setBank(Array.isArray(rows) ? rows : []);
      setError(null);
    } catch (e) {
      setError(e.message || 'Could not load the question bank.');
    } finally {
      setLoadingBank(false);
    }
  }, [roundFilter, categoryFilter]);

  useEffect(() => {
    if (!open) return undefined;
    loadSession({ full: true });
    apiClient
      .get('/member/interview-questions/facets')
      .then((data) =>
        setFacets({
          categories: Array.isArray(data?.categories) ? data.categories : [],
          rounds: Array.isArray(data?.rounds) ? data.rounds : [],
        })
      )
      .catch(() => setFacets({ categories: [], rounds: [] }));
    return undefined;
  }, [open, loadSession]);

  useEffect(() => {
    if (!open || tab !== 'bank') return undefined;
    loadBank();
    return undefined;
  }, [open, tab, loadBank]);

  // The fallback poll still only runs while the panel is open, but it can be slow now
  // that a broadcast carries the urgent case. It stays at the old ten seconds whenever
  // the subscription is not up, which is the whole point of keeping it.
  useEffect(() => {
    if (!open) return undefined;
    const timer = setInterval(() => loadSession(), connected ? POLL_MS.realtime : POLL_MS.polling);
    return () => clearInterval(timer);
  }, [open, connected, loadSession]);

  const loadSessionRef = useRef(loadSession);
  loadSessionRef.current = loadSession;

  // Subscribed only while the panel is open, for the same reason the poll is: a closed
  // panel deliberately fetches nothing, and a nudge it cannot act on is a wasted socket.
  // The full read on open is what catches whatever was missed in the meantime.
  useEffect(() => {
    if (!open || !active || !supabase) return undefined;
    const channel = supabase.channel(questionsChannel(interviewId));

    channel.on('broadcast', { event: 'questions:changed' }, ({ payload }) => {
      if (payload?.interviewId !== interviewId) return;
      // Anyone holding the anon key can post here, so a nudge is only ever a reason to
      // re-read through the authenticated API - never data in its own right. The worst a
      // forged one buys is a redundant GET.
      if (payload.at && watermark.current && new Date(payload.at) <= new Date(watermark.current)) {
        return;
      }
      loadSessionRef.current?.();
    });

    channel.subscribe((status) => setConnected(status === 'SUBSCRIBED'));

    return () => {
      setConnected(false);
      try { channel.unsubscribe(); } catch { /* already gone */ }
      try { supabase.removeChannel(channel); } catch { /* already gone */ }
    };
  }, [open, active, interviewId]);

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
      foldRows(questionMap.current, [created]);
      watermark.current = created.updatedAt || watermark.current;
      publish();
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
      foldRows(questionMap.current, [created]);
      watermark.current = created.updatedAt || watermark.current;
      publish();
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
      questionMap.current.delete(question.id);
      watermark.current = removed?.updatedAt || watermark.current;
      publish();
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
    setSessionQuestions(reordered); // optimistic

    try {
      const rows = await apiClient.patch(
        `/member/interviews/${interviewId}/session-questions/reorder`,
        { order: reordered.map((q) => q.id) }
      );
      foldRows(questionMap.current, Array.isArray(rows) ? rows : []);
      publish();
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
