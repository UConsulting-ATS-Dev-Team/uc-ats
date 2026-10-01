import prisma from '../prismaClient.js';
import { resolveAdminCycle } from './activeCycle.js';

// The rubric a grader scores a resume, cover letter / short answer or video
// against, in words and ranges an admin can change.
//
// What an admin can change per category: title, description, the score range
// (min..max, whole numbers) and the criteria rows that explain the range. They
// can also remove a category, as long as one is left, and add it back later.
// What they cannot: add a category the type has no column for, or change how a
// document's overall score is folded from its categories. Both are fixed by
// the storage - every score table has exactly three Int columns
// (scoreOne/Two/Three) - and by the Staging ranking, which adds the three
// documents' overall scores together. A type with no row reads as
// DEFAULT_RUBRICS, so nothing moves until someone saves.
//
// A removed category's column is simply not read: graders are not asked for
// it, the overall is folded from the categories that remain, and a regrade
// stores it as null.
//
// Changing a range does not rescale anything already graded. Existing scores
// stay as they were entered; `previewRubric` counts how many of this cycle's
// would fall outside the new range so the editor can say so before saving.

export const DOCUMENT_TYPES = Object.freeze(['resume', 'coverLetter', 'video']);

export const SCORE_FIELDS = Object.freeze(['scoreOne', 'scoreTwo', 'scoreThree']);

/**
 * How each type's overall score is built from its categories. Fixed per type:
 * Staging and every score list read overallScore with these meanings.
 */
export const AGGREGATION = Object.freeze({
  resume: 'sum',
  coverLetter: 'average',
  video: 'single'
});

/** Staging adds up to this many participation points (events + GTKUC) to the document total. */
export const PARTICIPATION_MAX = 3;

const SCORE_MODEL = Object.freeze({
  resume: 'resumeScore',
  coverLetter: 'coverLetterScore',
  video: 'videoScore'
});

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 1000;
const CRITERION_LABEL_MAX = 20;
const CRITERION_TEXT_MAX = 1000;
const CRITERIA_MAX = 12;
/** overallScore is Decimal(5,2); two categories at 100 still fit. */
const SCORE_CEILING = 100;

/** Today's rubrics, word for word. Order of `categories` is fixed per type. */
export const DEFAULT_RUBRICS = Object.freeze({
  resume: {
    categories: [
      {
        id: 'scoreOne',
        title: 'Content, Relevance, and Impact',
        description: 'Evaluates how well the resume showcases relevant experience, leadership, and business acumen while clearly demonstrating measurable impact and achievements.',
        min: 1,
        max: 10,
        criteria: [
          { label: '1-3', text: 'Mostly generic experience, little relevance, no clear results' },
          { label: '4-6', text: 'Relevant experience present, but minimal quantification or impact' },
          { label: '7-10', text: 'Strong, relevant experience with leadership/impact metrics and quantifiable outcomes' }
        ]
      },
      {
        id: 'scoreTwo',
        title: 'Structure & Formatting',
        description: 'Assesses professionalism, organization, and readability.',
        min: 1,
        max: 3,
        criteria: [
          { label: '1', text: 'Major red flags' },
          { label: '2', text: 'Easy to read but lacks professionalism' },
          { label: '3', text: 'Professional, structured and fully complete bullet points' }
        ]
      }
    ]
  },
  coverLetter: {
    categories: [
      {
        id: 'scoreOne',
        title: 'Consulting Interest',
        description: 'Demonstrates understanding and passion for consulting career',
        min: 1,
        max: 3,
        criteria: [
          { label: '1', text: 'Minimal or unclear interest in consulting. Little to no effort made to explore or understand the field.' },
          { label: '2', text: 'Shows substantial knowledge of consulting industry. Has clear goals set defining match between personality and consulting.' },
          { label: '3', text: 'Clearly articulates professional goals in consulting that strongly align personal experiences, traits, and skills. Shows passion and purpose for consulting interest.' }
        ]
      },
      {
        id: 'scoreTwo',
        title: 'UC Interest',
        description: 'Shows specific knowledge and interest in UConsulting',
        min: 1,
        max: 3,
        criteria: [
          { label: '1', text: 'Fails to include any UC specific details. Absence of personalization.' },
          { label: '2', text: 'References to specific initiatives, including but not limited to past projects, committees, firm events, etc.' },
          { label: '3', text: 'Applies specific references of UC to personal growth objectives. Displays sincere interest to capitalize on and contribute to UC initiatives and resources.' }
        ]
      },
      {
        id: 'scoreThree',
        title: 'Culture Addition',
        description: 'Demonstrates unique traits and contributions to UC culture',
        min: 1,
        max: 3,
        criteria: [
          { label: '1', text: 'Does not elaborate on any traits, qualifications, or experiences that make the candidate unique.' },
          { label: '2', text: 'Describes noteworthy traits, qualifications, or experiences and how to apply them at UC. Demonstrates passion for something.' },
          { label: '3', text: 'Exceptionally unique story and background. Advanced explanation of how candidate traits advance and contribute to UC.' }
        ]
      }
    ]
  },
  video: {
    categories: [
      {
        id: 'scoreOne',
        title: 'Overall Video Assessment',
        description: 'Comprehensive evaluation of the candidate based on video content',
        min: 0,
        max: 2,
        criteria: [
          { label: '0', text: 'Learn little about the person, low energy, not good fit for UC' },
          { label: '1', text: 'Learn a little about the person, medium energy, ok fit' },
          { label: '2', text: 'Awesome video learn a lot about the person, high energy, definite fit for UC' }
        ]
      }
    ]
  }
});

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

export const assertDocumentType = (type) => {
  if (!DOCUMENT_TYPES.includes(type)) throw fail(400, `Unknown document type: ${type}`, 'INVALID_DOCUMENT_TYPE');
};

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

const categoryIds = (type) => DEFAULT_RUBRICS[type].categories.map((category) => category.id);

/**
 * Validates what an admin submitted for `type`. Categories are matched by id
 * against the type's own and come back in the type's order; an id the type
 * does not have, or one given twice, is refused, and a missing one means the
 * admin removed it. At
 * least one must be left. Criteria rows that are entirely blank are dropped
 * rather than refused, so an editor's spare empty row saves.
 */
export function normalizeRubric(type, input) {
  assertDocumentType(type);
  if (!input || typeof input !== 'object' || !Array.isArray(input.categories)) {
    throw fail(400, 'A rubric needs a list of categories', 'INVALID_RUBRIC');
  }

  // Leaving a category out removes it, so an id that is not one of this type's
  // columns (a typo, say) is refused rather than read as a removal of the
  // category it was meant to be.
  const ids = categoryIds(type);
  const submitted = new Map();
  for (const category of input.categories.filter(Boolean)) {
    if (!ids.includes(category.id)) throw fail(400, `Unknown category: ${category.id}`, 'INVALID_RUBRIC');
    if (submitted.has(category.id)) throw fail(400, `Category ${category.id} appears twice`, 'INVALID_RUBRIC');
    submitted.set(category.id, category);
  }

  const kept = ids.filter((id) => submitted.has(id));
  if (kept.length === 0) throw fail(400, 'A rubric needs at least one category', 'INVALID_RUBRIC');

  const categories = kept.map((id, index) => {
    const category = submitted.get(id);
    const name = `Category ${index + 1}`;

    const title = trimmed(category.title);
    if (!title) throw fail(400, `${name} needs a title`, 'INVALID_RUBRIC');
    if (title.length > TITLE_MAX) throw fail(400, `${name}'s title is over ${TITLE_MAX} characters`, 'INVALID_RUBRIC');

    const description = trimmed(category.description);
    if (description.length > DESCRIPTION_MAX) {
      throw fail(400, `${title}'s description is over ${DESCRIPTION_MAX} characters`, 'INVALID_RUBRIC');
    }

    const min = Number(category.min);
    const max = Number(category.max);
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw fail(400, `${title}'s range must be whole numbers`, 'INVALID_RUBRIC');
    }
    if (min < 0 || max > SCORE_CEILING) {
      throw fail(400, `${title}'s range must fall between 0 and ${SCORE_CEILING}`, 'INVALID_RUBRIC');
    }
    if (min >= max) throw fail(400, `${title}'s maximum must be above its minimum`, 'INVALID_RUBRIC');

    if (category.criteria !== undefined && !Array.isArray(category.criteria)) {
      throw fail(400, `${title}'s criteria must be a list`, 'INVALID_RUBRIC');
    }
    const criteria = (category.criteria || [])
      .map((row) => ({ label: trimmed(row?.label), text: trimmed(row?.text) }))
      .filter((row) => row.label || row.text);
    if (criteria.length > CRITERIA_MAX) {
      throw fail(400, `${title} has more than ${CRITERIA_MAX} criteria`, 'INVALID_RUBRIC');
    }
    for (const row of criteria) {
      if (!row.label || !row.text) {
        throw fail(400, `Every criterion under ${title} needs both a score and a description`, 'INVALID_RUBRIC');
      }
      if (row.label.length > CRITERION_LABEL_MAX) {
        throw fail(400, `A score label under ${title} is over ${CRITERION_LABEL_MAX} characters`, 'INVALID_RUBRIC');
      }
      if (row.text.length > CRITERION_TEXT_MAX) {
        throw fail(400, `A criterion under ${title} is over ${CRITERION_TEXT_MAX} characters`, 'INVALID_RUBRIC');
      }
    }

    return { id, title, description, min, max, criteria };
  });

  return { categories };
}

/**
 * A stored row as a usable rubric, or the default when the row is missing or
 * no longer valid (a category added to the code after the row was saved, say).
 * A reader must never be left without a rubric to grade against.
 */
function storedOrDefault(type, row) {
  if (!row?.rubric) return { rubric: DEFAULT_RUBRICS[type], customized: false };
  try {
    return { rubric: normalizeRubric(type, row.rubric), customized: true };
  } catch (error) {
    console.error(`[documentRubrics] Stored ${type} rubric is unreadable; using the default`, error.message);
    return { rubric: DEFAULT_RUBRICS[type], customized: false };
  }
}

/** The highest overall score a document of this type can get under `rubric`. */
export function maxOverall(type, rubric) {
  const maxes = rubric.categories.map((category) => category.max);
  if (AGGREGATION[type] === 'sum') return maxes.reduce((sum, max) => sum + max, 0);
  if (AGGREGATION[type] === 'average') return maxes.reduce((sum, max) => sum + max, 0) / maxes.length;
  return maxes[0];
}

/** The lowest overall score, for range labels. */
export function minOverall(type, rubric) {
  const mins = rubric.categories.map((category) => category.min);
  if (AGGREGATION[type] === 'sum') return mins.reduce((sum, min) => sum + min, 0);
  if (AGGREGATION[type] === 'average') return mins.reduce((sum, min) => sum + min, 0) / mins.length;
  return mins[0];
}

const presentScore = (value) => value !== null && value !== undefined && value !== '';

/**
 * A document's overall score from its category scores. A blank category is
 * left out rather than counted as zero - zero can be a real score.
 */
export function computeOverall(type, rubric, scores) {
  const values = rubric.categories
    .map((category) => scores[category.id])
    .filter(presentScore)
    .map(Number);
  if (values.length === 0) return 0;
  if (AGGREGATION[type] === 'sum') return values.reduce((sum, value) => sum + value, 0);
  if (AGGREGATION[type] === 'average') return values.reduce((sum, value) => sum + value, 0) / values.length;
  return values[0];
}

/**
 * Checks category scores against the rubric and returns them ready to store:
 * each rubric category as an integer or null, every column the type does not
 * use as null. Throws 400 naming the first category out of range.
 */
export function validateCategoryScores(type, rubric, scores) {
  const clean = Object.fromEntries(SCORE_FIELDS.map((field) => [field, null]));
  for (const category of rubric.categories) {
    const raw = scores?.[category.id];
    if (!presentScore(raw)) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < category.min || value > category.max) {
      throw fail(400, `${category.title} must be a whole number from ${category.min} to ${category.max}`, 'SCORE_OUT_OF_RANGE');
    }
    clean[category.id] = value;
  }
  return clean;
}

/** Guards an admin-entered overall or override score. Null/blank passes through. */
export function validateOverallScore(type, rubric, value, label = 'Score') {
  if (!presentScore(value)) return null;
  const number = Number(value);
  const max = maxOverall(type, rubric);
  if (!Number.isFinite(number) || number < 0 || number > max) {
    throw fail(400, `${label} must be between 0 and ${formatScore(max)}`, 'SCORE_OUT_OF_RANGE');
  }
  return number;
}

/**
 * What a grader's save stores: the category scores checked against the
 * configured rubric, and the overall folded from them. Throws 400 on a score
 * out of range.
 */
export async function scoreFromRubric(type, scores, { client = prisma } = {}) {
  const rubric = await getRubric({ client, type });
  const clean = validateCategoryScores(type, rubric, scores);
  return { ...clean, overallScore: computeOverall(type, rubric, clean), rubric };
}

/**
 * The score half of an admin's edit to an existing score row: the columns to
 * write, checked against the configured rubric.
 *
 * Only what the request changes is checked. A row graded under an older, wider
 * range stays editable - an admin fixing the notes on it, or resubmitting the
 * overall the form was prefilled with, is not asked to regrade it first.
 * The overall is recomputed from the categories unless one is given.
 */
export async function adminScorePatch({ client = prisma, type, existing, body }) {
  const rubric = await getRubric({ client, type });
  const data = {};

  // The edit form sends every category back, so "changed" means different
  // from what is stored, not merely present in the request.
  const changed = {};
  for (const field of SCORE_FIELDS) {
    if (body[field] === undefined) continue;
    const storedValue = existing[field] ?? null;
    const sentValue = presentScore(body[field]) ? Number(body[field]) : null;
    if (sentValue === storedValue) continue;
    const used = rubric.categories.some((category) => category.id === field);
    changed[field] = used ? body[field] : null;
  }
  Object.assign(data, pick(validateCategoryScores(type, rubric, changed), Object.keys(changed)));

  const sameAsStored = (value, stored) =>
    presentScore(value) && stored !== null && stored !== undefined && Number(value) === Number(stored);

  if (body.adminScore !== undefined) {
    data.adminScore = sameAsStored(body.adminScore, existing.adminScore)
      ? Number(body.adminScore)
      : validateOverallScore(type, rubric, body.adminScore, 'Admin score');
  }

  // The edit form sends the overall back prefilled. Unchanged, it is not a
  // decision the admin made, so a category edit still recomputes it.
  const categoriesChanged = Object.keys(changed).length > 0;
  const overallUnchanged = sameAsStored(body.overallScore, existing.overallScore);
  if (presentScore(body.overallScore) && !(overallUnchanged && categoriesChanged)) {
    data.overallScore = overallUnchanged
      ? Number(body.overallScore)
      : validateOverallScore(type, rubric, body.overallScore, 'Overall score');
  } else if (categoriesChanged) {
    data.overallScore = computeOverall(type, rubric, { ...existing, ...data });
  }

  return data;
}

const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key]]));

/** 13, 2.5, 2.33 - no trailing zeros. */
export const formatScore = (value) => String(Math.round(value * 100) / 100);

const describe = (type, rubric, customized, row) => ({
  type,
  aggregation: AGGREGATION[type],
  rubric,
  /** Every column this type can score, so the editor can offer a removed category back. */
  slots: categoryIds(type),
  minOverall: minOverall(type, rubric),
  maxOverall: maxOverall(type, rubric),
  customized,
  updatedAt: row?.updatedAt ?? null
});

/**
 * Stored rows, or none when the table is not there yet (P2021). Grading and
 * score saves read the rubric, and must not start failing because a deploy
 * got ahead of the migration.
 */
async function readRows(client, where) {
  try {
    return await client.documentRubric.findMany(where ? { where } : undefined);
  } catch (error) {
    if (error?.code === 'P2021') return [];
    throw error;
  }
}

/** The rubric graders see for one type. */
export async function getRubric({ client = prisma, type }) {
  assertDocumentType(type);
  const [row] = await readRows(client, { type });
  const { rubric } = storedOrDefault(type, row);
  return rubric;
}

/**
 * Every type at once, plus the Staging total they add up to. The weight line
 * is there because Staging sums raw document scores: raising one type's range
 * gives it more say in the ranking, and the editor has to show that.
 */
export async function getRubrics({ client = prisma } = {}) {
  const rows = await readRows(client);
  const byType = new Map(rows.map((row) => [row.type, row]));
  const rubrics = {};
  for (const type of DOCUMENT_TYPES) {
    const { rubric, customized } = storedOrDefault(type, byType.get(type));
    rubrics[type] = describe(type, rubric, customized, byType.get(type));
  }
  const documentsMax = DOCUMENT_TYPES.reduce((sum, type) => sum + rubrics[type].maxOverall, 0);
  return {
    rubrics,
    types: DOCUMENT_TYPES,
    participationMax: PARTICIPATION_MAX,
    stagingMax: documentsMax + PARTICIPATION_MAX
  };
}

/**
 * How many of the current admin cycle's scores for `type` fall outside
 * `rubric`. Nothing is changed; this is what the editor warns with.
 */
async function countOutOfRange({ client, type, rubric }) {
  const cycle = await resolveAdminCycle(client);
  if (!cycle) return { count: 0, cycleName: null };
  const rows = await client[SCORE_MODEL[type]].findMany({
    where: { cycleId: cycle.id },
    select: { scoreOne: true, scoreTwo: true, scoreThree: true }
  });
  const count = rows.filter((row) => rubric.categories.some((category) => {
    const value = row[category.id];
    return presentScore(value) && (value < category.min || value > category.max);
  })).length;
  return { count, cycleName: cycle.name ?? null };
}

/**
 * Validates a draft and reports what saving it would leave out of range.
 * With `reset`, previews going back to the shipped default instead, which can
 * narrow a range just as an edit can. Writes nothing.
 */
export async function previewRubric({ client = prisma, type, rubric: input, reset = false }) {
  assertDocumentType(type);
  const rubric = reset ? DEFAULT_RUBRICS[type] : normalizeRubric(type, input);
  const outOfRange = await countOutOfRange({ client, type, rubric });
  return { ...describe(type, rubric, true, null), outOfRange };
}

export async function saveRubric({ client = prisma, type, rubric: input, user }) {
  const rubric = normalizeRubric(type, input);
  await client.documentRubric.upsert({
    where: { type },
    create: { type, rubric, updatedById: user.id },
    update: { rubric, updatedById: user.id }
  });
  return getRubrics({ client });
}

/** Drops the type's row so it reads as the default again. Not an error if there was none. */
export async function resetRubric({ client = prisma, type }) {
  assertDocumentType(type);
  await client.documentRubric.deleteMany({ where: { type } });
  return getRubrics({ client });
}
