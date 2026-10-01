// The wording of an application question, so a grader can see what the
// candidate was asked. Nothing stores it: the ATS keeps only the answers, and
// the question lives in the cycle's Google Form, so it is read from there.
//
// Questions are found by the same `database_mappings` the form sync uses, so
// a question is whichever one fills that Application column. Its title and
// description are returned as written on the form.
//
// Nothing here throws. A cycle without a usable form link, a form the service
// account cannot read, and a question missing from the form all answer null,
// and the grading page shows the answer without its prompt.
import prisma from '../prismaClient.js';
import config from '../config.js';
import { getFormQuestions } from './google/forms.js';
import { syncableFormId } from '../utils/formUtils.js';

// Forms are rarely edited mid-cycle and every open grading dialog asks, so a
// form is read at most once per window. A failure is cached for less time so
// a fixed sharing setting shows up soon.
const CACHE_MS = 10 * 60 * 1000;
const FAILURE_CACHE_MS = 60 * 1000;

const cache = new Map(); // formId -> { expiresAt, items: Promise<items|null> }

function loadFormItems(formId) {
  const cached = cache.get(formId);
  if (cached && cached.expiresAt > Date.now()) return cached.items;

  const entry = { expiresAt: Date.now() + CACHE_MS, items: null };
  entry.items = getFormQuestions(formId).catch((error) => {
    console.error(`Could not read questions for form ${formId}:`, error.message);
    entry.expiresAt = Date.now() + FAILURE_CACHE_MS;
    return null;
  });
  cache.set(formId, entry);
  return entry.items;
}

function questionIdsFor(field) {
  const mappings = config.form?.database_mappings || {};
  return new Set(
    Object.entries(mappings)
      .filter(([, mapping]) => mapping?.field === field)
      .map(([questionId]) => questionId)
  );
}

function promptFromItems(items, field) {
  const ids = questionIdsFor(field);
  const item = (items || []).find((it) => ids.has(it.questionItem?.question?.questionId));
  if (!item) return null;
  const text = [item.title, item.description]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join('\n\n');
  return text || null;
}

/**
 * The question behind an Application column in a cycle, as the form words it.
 * @param {string} cycleId
 * @param {string} field - the Application column, e.g. 'shortAnswer'
 * @returns {Promise<string|null>}
 */
export async function getCycleQuestionPrompt(cycleId, field) {
  if (!cycleId) return null;
  const cycle = await prisma.recruitingCycle.findUnique({
    where: { id: cycleId },
    select: { formUrl: true }
  });
  const formId = syncableFormId(cycle?.formUrl);
  if (!formId) return null;
  return promptFromItems(await loadFormItems(formId), field);
}

export function clearFormPromptCache() {
  cache.clear();
}
