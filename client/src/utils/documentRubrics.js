import { useCallback, useEffect, useState } from 'react';
import apiClient from './api';

// Document grading rubrics (server/src/services/documentRubrics.js). Members
// and admins read them; admins edit them from Admin Document Grading.
//
// One fetch is shared by every component on the page, and a save pushes the
// new rubrics to all of them, so the grading modal, the score lists and the
// Staging bar never disagree about a range.

const base = '/document-rubrics';

export const documentRubricApi = {
  all: () => apiClient.get(base),
  /** Validates a draft and counts this cycle's scores it would leave out of range. */
  preview: (type, rubric) => apiClient.post(`${base}/${type}/preview`, { rubric }),
  /** The same count for going back to the shipped default. */
  previewReset: (type) => apiClient.post(`${base}/${type}/preview`, { reset: true }),
  save: (type, rubric) => apiClient.put(`${base}/${type}`, { rubric }),
  reset: (type) => apiClient.delete(`${base}/${type}`)
};

export const DOCUMENT_TYPE_LABELS = Object.freeze({
  resume: 'Resume',
  coverLetter: 'Cover letter / short answer',
  video: 'Video'
});

/**
 * The shipped maxima, used only until the rubrics arrive (or if they cannot be
 * fetched), so a score list never renders without a denominator.
 */
const FALLBACK_MAX = Object.freeze({ resume: 13, coverLetter: 3, video: 2 });
const FALLBACK_PARTICIPATION_MAX = 3;

let cache = null;
let inflight = null;
/**
 * Bumped by every publish. A fetch remembers the generation it started in and
 * publishes only if nothing was published since, so a GET that started before
 * an admin's save and finished after it cannot put the old rubric back.
 */
let generation = 0;
const listeners = new Set();

const publish = (data) => {
  cache = data;
  generation += 1;
  listeners.forEach((listener) => listener(data));
};

/** Replaces what every mounted reader shows. Takes a GET /document-rubrics body. */
export const setDocumentRubrics = (data) => {
  if (data?.rubrics) publish(data);
};

async function load() {
  if (!inflight) {
    const startedAt = generation;
    inflight = documentRubricApi.all()
      .then((data) => {
        if (!data?.rubrics) throw new Error('Rubrics response had no rubrics');
        if (generation === startedAt) publish(data);
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

const loadFailure = (err) => err?.message?.replace(/ \(Status: \d+\)$/, '') || 'Could not load the grading rubrics';

/**
 * `{ data, error, refreshError, reload }`.
 *
 * - `data` is the GET /document-rubrics body, or null until it has loaded.
 * - `error` means there is nothing to show at all.
 * - `refreshError` means the last refetch failed and `data` may be out of
 *   date. It is not swallowed just because an older copy is on screen: a
 *   grader told their score is out of range needs to know the range they are
 *   looking at did not refresh.
 *
 * Every mount shows what is cached and refetches behind it, so a page opened
 * after another admin's edit catches up without a reload. Concurrent mounts
 * share one request. `reload` resolves true when the rubrics are current.
 */
export function useDocumentRubrics() {
  const [data, setData] = useState(cache);
  const [error, setError] = useState(null);
  const [refreshError, setRefreshError] = useState(null);

  const reload = useCallback(() => load().then(
    () => {
      setError(null);
      setRefreshError(null);
      return true;
    },
    (err) => {
      if (cache) setRefreshError(loadFailure(err));
      else setError(loadFailure(err));
      return false;
    }
  ), []);

  useEffect(() => {
    listeners.add(setData);
    reload();
    return () => { listeners.delete(setData); };
  }, [reload]);

  return { data, error, refreshError, reload };
}

/** 13, 2.5, 2.33 - no trailing zeros. */
export const formatScore = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.round(number * 100) / 100) : '';
};

/** Highest overall score for a document type, from loaded rubrics or the shipped fallback. */
export const documentMax = (data, type) => data?.rubrics?.[type]?.maxOverall ?? FALLBACK_MAX[type];

/** The Staging Resume Review total: every document's max plus participation. */
export const stagingMax = (data) =>
  data?.stagingMax ?? (FALLBACK_MAX.resume + FALLBACK_MAX.coverLetter + FALLBACK_MAX.video + FALLBACK_PARTICIPATION_MAX);

/** A category by column (scoreOne/Two/Three), or undefined. */
export const rubricCategory = (data, type, id) =>
  data?.rubrics?.[type]?.rubric?.categories?.find((category) => category.id === id);

/** "1–10" */
export const rangeLabel = ({ min, max }) => `${min}–${max}`;

/** One line saying how a type's categories become its overall score. */
export function aggregationText(type, rubric) {
  const categories = rubric?.categories || [];
  const parts = categories.map((category) => `${category.title} (${rangeLabel(category)})`);
  if (categories.length <= 1) return 'Single category score';
  if (type === 'resume') return `Sum of ${parts.join(' and ')}`;
  return `Average of ${categories.length === 3 ? 'all three' : 'the'} category scores`;
}

/** Highest overall for a draft rubric in the editor, mirroring the server. */
export function draftMaxOverall(type, rubric) {
  const maxes = (rubric?.categories || []).map((category) => Number(category.max) || 0);
  if (maxes.length === 0) return 0;
  if (type === 'resume') return maxes.reduce((sum, max) => sum + max, 0);
  if (type === 'coverLetter') return maxes.reduce((sum, max) => sum + max, 0) / maxes.length;
  return maxes[0];
}
