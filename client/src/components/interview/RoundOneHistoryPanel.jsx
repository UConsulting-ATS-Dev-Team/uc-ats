import React, { useEffect, useState } from 'react';
import { ChevronRightIcon, ClipboardDocumentListIcon } from '@heroicons/react/24/outline';
import apiClient from '../../utils/api';
import { isRecordLockedError } from '../../utils/recordLock';
import LockedRecord from '../LockedRecord';
import '../../styles/RoundOneHistoryPanel.css';

// What one candidate was asked in round one, shown read-only to whoever is
// writing their questions for a later round. See
// server/src/services/roundOneHistory.js for where the two question lists come
// from and why the notes are the evaluator's, not the candidate's.

const formatDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

const countQuestions = (history) =>
  history.interviews.reduce((total, interview) => total + interview.questions.length, 0);

const countEvaluators = (history) =>
  new Set(
    history.interviews.flatMap((interview) => interview.evaluators.map((e) => e.evaluatorId))
  ).size;

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function QuestionRow({ question, evaluators }) {
  // Only evaluators who actually wrote something about this question. An empty
  // note is noise here - it says the box existed, not that anything was observed.
  const notes = evaluators
    .map((evaluator) => ({
      evaluatorId: evaluator.evaluatorId,
      evaluatorName: evaluator.evaluatorName,
      text: (evaluator.notesByQuestionId?.[question.id] || '').trim()
    }))
    .filter((note) => note.text);

  return (
    <li className="r1-history__question">
      <div className="r1-history__question-head">
        <p className="r1-history__question-text">{question.text}</p>
        {question.scope === 'CANDIDATE' && (
          <span className="r1-history__scope" title="Written for this candidate only">
            Candidate-specific
          </span>
        )}
      </div>

      {notes.length > 0 ? (
        <ul className="r1-history__notes">
          {notes.map((note) => (
            <li key={`${question.id}-${note.evaluatorId}`} className="r1-history__note">
              <span className="r1-history__note-author">{note.evaluatorName}</span>
              <span className="r1-history__note-text">{note.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="r1-history__no-note">No notes recorded on this question.</p>
      )}
    </li>
  );
}

function InterviewBlock({ interview }) {
  const date = formatDate(interview.startDate);
  const extras = interview.evaluators.filter(
    (evaluator) => evaluator.marketSizingNotes || evaluator.additionalNotes
  );

  return (
    <div className="r1-history__interview">
      <div className="r1-history__interview-head">
        <h5 className="r1-history__interview-title">{interview.title || 'Round One'}</h5>
        {date && <span className="r1-history__interview-date">{date}</span>}
      </div>

      {interview.questions.length > 0 ? (
        <ul className="r1-history__questions">
          {interview.questions.map((question) => (
            <QuestionRow key={question.id} question={question} evaluators={interview.evaluators} />
          ))}
        </ul>
      ) : (
        <p className="r1-history__empty-inline">No questions were recorded for this interview.</p>
      )}

      {extras.length > 0 && (
        <div className="r1-history__extras">
          {extras.map((evaluator) => (
            <div key={evaluator.evaluationId} className="r1-history__extra">
              <span className="r1-history__note-author">{evaluator.evaluatorName}</span>
              {evaluator.marketSizingNotes && (
                <p className="r1-history__extra-line">
                  <span className="r1-history__extra-label">Market sizing:</span>{' '}
                  {evaluator.marketSizingNotes}
                </p>
              )}
              {evaluator.additionalNotes && (
                <p className="r1-history__extra-line">
                  <span className="r1-history__extra-label">Additional:</span>{' '}
                  {evaluator.additionalNotes}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RoundOneHistoryPanel({ applicationId, candidateName }) {
  const [history, setHistory] = useState(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!applicationId) return undefined;

    let active = true;
    setLoading(true);
    setError(null);
    setLocked(false);

    apiClient
      .get(`/member/applications/${applicationId}/round-one-history`)
      .then((data) => {
        if (!active) return;
        setHistory(data);
      })
      .catch((err) => {
        if (!active) return;
        // A sealed candidate is an expected answer here, not a failure.
        if (isRecordLockedError(err)) setLocked(true);
        else setError(err.serverMessage || 'Could not load round one history.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [applicationId]);

  const hasHistory = Boolean(history?.interviews?.length);
  const summary = (() => {
    if (loading) return 'Loading…';
    if (locked) return 'Sealed';
    if (error) return 'Unavailable';
    if (!hasHistory) return 'No record';
    return `${plural(countQuestions(history), 'question')} · ${plural(
      countEvaluators(history),
      'evaluator'
    )}`;
  })();

  return (
    <div className="r1-history">
      <button
        type="button"
        className="r1-history__toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ChevronRightIcon className={`r1-history__chevron ${open ? 'is-open' : ''}`} />
        <ClipboardDocumentListIcon className="r1-history__icon" />
        <span className="r1-history__label">Round One history</span>
        <span className="r1-history__summary">{summary}</span>
      </button>

      {open && (
        <div className="r1-history__body">
          {locked ? (
            <LockedRecord
              title="Round One is sealed"
              description={`Round One questions and notes for ${
                candidateName || 'this candidate'
              } are sealed. Only the executive committee can view them.`}
            />
          ) : error ? (
            <p className="r1-history__error">{error}</p>
          ) : loading ? (
            <p className="r1-history__empty">Loading Round One history…</p>
          ) : !hasHistory ? (
            <p className="r1-history__empty">
              No Round One interview is on record for this candidate.
            </p>
          ) : (
            <>
              <p className="r1-history__disclaimer">
                These are the Round One interviewers&rsquo; own notes on each question — not a
                transcript of what the candidate said.
              </p>
              {history.interviews.map((interview) => (
                <InterviewBlock key={interview.interviewId} interview={interview} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
