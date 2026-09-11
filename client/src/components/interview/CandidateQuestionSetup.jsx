import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import apiClient from '../../utils/api';
import useCandidateQuestions from '../../hooks/useCandidateQuestions';
import CandidateQuestionList from './CandidateQuestionList';
import './CandidateQuestionList.css';

// Pre-interview setup for round one: add questions for individual candidates in
// the selected groups. Unlike the shared list above it, these save immediately.
export default function CandidateQuestionSetup({ interviewId, groupIds, basePath }) {
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const groupKey = (groupIds || []).join(',');

  useEffect(() => {
    if (!interviewId || !groupKey) {
      setApplications([]);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    apiClient
      .get(`${basePath}/interviews/${interviewId}/applications?groupIds=${groupKey}`)
      .then((rows) => {
        if (cancelled) return;
        setApplications(Array.isArray(rows) ? rows : []);
        setLoadError(null);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e.message || 'Could not load the candidates in these groups.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [interviewId, groupKey, basePath]);

  const applicationIds = useMemo(() => applications.map((a) => a.id), [applications]);
  const { byApplication, error, add, update, remove } = useCandidateQuestions(interviewId, applicationIds, basePath);

  return (
    <section className="candidate-question-setup">
      <h4 className="candidate-question-setup__title">Questions for specific candidates</h4>
      <p className="candidate-question-setup__hint">
        Only that candidate&apos;s row shows these during the interview. They save as soon as you add them.
      </p>

      {(loadError || error) && (
        <div className="candidate-questions__error" role="alert">
          {loadError || error}
        </div>
      )}
      {loading && <p className="candidate-question-setup__hint">Loading candidates…</p>}
      {!loading && !loadError && applications.length === 0 && (
        <p className="candidate-question-setup__hint">No candidates in the selected groups.</p>
      )}

      <ul className="candidate-question-setup__list">
        {applications.map((application) => {
          const questions = byApplication[application.id] || [];
          const open = expandedId === application.id;
          return (
            <li key={application.id} className="candidate-question-setup__candidate">
              <button
                type="button"
                className="candidate-question-setup__toggle"
                aria-expanded={open}
                onClick={() => setExpandedId(open ? null : application.id)}
              >
                {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
                <span>{application.name}</span>
                {questions.length > 0 && (
                  <span className="candidate-question-setup__count" aria-label={`${questions.length} questions`}>
                    {questions.length}
                  </span>
                )}
              </button>
              {open && (
                <CandidateQuestionList
                  candidateName={application.name}
                  questions={questions}
                  onAdd={(text) => add(application.id, text)}
                  onUpdate={update}
                  onRemove={remove}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
