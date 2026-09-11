import React, { useState } from 'react';
import { CheckIcon, PencilIcon, PlusIcon, TrashIcon, XMarkIcon } from '@heroicons/react/24/outline';
import './CandidateQuestionList.css';

// One candidate's own round-one questions: add, edit and remove inline.
// renderNotes lets the interview grid hang a notes box under each question; the
// setup step leaves it out and shows just the list.
export default function CandidateQuestionList({
  candidateName,
  questions = [],
  onAdd,
  onUpdate,
  onRemove,
  renderNotes,
}) {
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const firstName = (candidateName || '').split(' ')[0] || 'this candidate';

  const run = async (work) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (e) {
      setError(e.message || 'Something went wrong. Try again.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (await run(() => onAdd(text))) setDraft('');
  };

  const handleSave = async (e, question) => {
    e.preventDefault();
    const text = editText.trim();
    if (!text || text === question.text) {
      setEditingId(null);
      return;
    }
    if (await run(() => onUpdate(question, text))) setEditingId(null);
  };

  const handleRemove = async (question) => {
    if (!window.confirm(`Remove "${question.text}" for ${firstName}?`)) return;
    await run(() => onRemove(question));
  };

  return (
    <div className="candidate-questions">
      {questions.map((question) => (
        <div key={question.id} className="candidate-questions__item">
          {editingId === question.id ? (
            <form className="candidate-questions__row" onSubmit={(e) => handleSave(e, question)}>
              <input
                className="candidate-questions__input"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                aria-label="Edit question"
                autoFocus
                disabled={busy}
              />
              <button type="submit" className="candidate-questions__icon-btn" aria-label="Save question" disabled={busy}>
                <CheckIcon />
              </button>
              <button
                type="button"
                className="candidate-questions__icon-btn"
                aria-label="Cancel editing"
                onClick={() => setEditingId(null)}
                disabled={busy}
              >
                <XMarkIcon />
              </button>
            </form>
          ) : (
            <div className="candidate-questions__row">
              <span className="candidate-questions__text">{question.text}</span>
              <button
                type="button"
                className="candidate-questions__icon-btn"
                aria-label={`Edit: ${question.text}`}
                onClick={() => {
                  setEditingId(question.id);
                  setEditText(question.text);
                }}
                disabled={busy}
              >
                <PencilIcon />
              </button>
              <button
                type="button"
                className="candidate-questions__icon-btn candidate-questions__icon-btn--danger"
                aria-label={`Remove: ${question.text}`}
                onClick={() => handleRemove(question)}
                disabled={busy}
              >
                <TrashIcon />
              </button>
            </div>
          )}
          {renderNotes?.(question)}
        </div>
      ))}

      <form className="candidate-questions__row candidate-questions__add" onSubmit={handleAdd}>
        <input
          className="candidate-questions__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Add a question for ${firstName}`}
          aria-label={`Add a question for ${candidateName || firstName}`}
          disabled={busy}
        />
        <button type="submit" className="candidate-questions__add-btn" disabled={busy || !draft.trim()}>
          <PlusIcon />
          Add
        </button>
      </form>

      {error && (
        <div className="candidate-questions__error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
