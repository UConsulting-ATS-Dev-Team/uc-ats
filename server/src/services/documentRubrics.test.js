// What matters about document rubrics: a type nobody has edited grades exactly
// as before, a saved range is what a score is checked against, a blank category
// is not a zero, and an admin can still edit a score graded under an older range.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_RUBRICS,
  adminScorePatch,
  computeOverall,
  getRubric,
  getRubrics,
  maxOverall,
  normalizeRubric,
  previewRubric,
  resetRubric,
  saveRubric,
  scoreFromRubric,
  validateCategoryScores
} from './documentRubrics.js';

vi.mock('../prismaClient.js', () => ({ default: {} }));

// document_rubrics, the admin cycle pointer and one score table per type.
function fakeDb({ scores = {}, cycle = { id: 'cycle-1', name: 'Fall 2026' } } = {}) {
  let rows = [];
  const scoreTable = (type) => ({
    findMany: async ({ where }) => (scores[type] || []).filter((row) => row.cycleId === where.cycleId)
  });
  return {
    documentRubric: {
      findMany: async ({ where } = {}) => rows.filter((row) => !where || row.type === where.type),
      upsert: async ({ where, create, update }) => {
        const existing = rows.find((row) => row.type === where.type);
        if (existing) return Object.assign(existing, update, { updatedAt: new Date() });
        const row = { id: `r-${rows.length + 1}`, updatedAt: new Date(), ...create };
        rows.push(row);
        return row;
      },
      deleteMany: async ({ where }) => {
        rows = rows.filter((row) => row.type !== where.type);
        return { count: 1 };
      }
    },
    recruitingCycle: {
      findFirst: async ({ where }) => (where.isAdminActive ? null : cycle)
    },
    resumeScore: scoreTable('resume'),
    coverLetterScore: scoreTable('coverLetter'),
    videoScore: scoreTable('video')
  };
}

const user = { id: 'admin-1' };

/** The default rubric for `type` with some categories' fields replaced. */
const edited = (type, changes) => ({
  categories: DEFAULT_RUBRICS[type].categories.map((category) => ({ ...category, ...(changes[category.id] || {}) }))
});

let db;
beforeEach(() => { db = fakeDb(); });

describe('reading', () => {
  it('serves the shipped rubric when nothing is saved', async () => {
    const { rubrics, stagingMax } = await getRubrics({ client: db });
    expect(rubrics.resume.rubric).toEqual(DEFAULT_RUBRICS.resume);
    expect(rubrics.resume.customized).toBe(false);
    expect(rubrics.resume.maxOverall).toBe(13);
    expect(rubrics.coverLetter.maxOverall).toBe(3);
    expect(rubrics.video.maxOverall).toBe(2);
    expect(stagingMax).toBe(21);
  });

  it('falls back to the shipped rubric while the table does not exist yet', async () => {
    db.documentRubric.findMany = async () => { throw Object.assign(new Error('missing'), { code: 'P2021' }); };
    expect(await getRubric({ client: db, type: 'video' })).toEqual(DEFAULT_RUBRICS.video);
  });

  it('falls back when a stored row no longer validates', async () => {
    db.documentRubric.findMany = async () => [{ type: 'video', rubric: { categories: [] } }];
    expect(await getRubric({ client: db, type: 'video' })).toEqual(DEFAULT_RUBRICS.video);
  });

  it('serves a saved rubric, and reset returns to the shipped one', async () => {
    await saveRubric({ client: db, type: 'resume', rubric: edited('resume', { scoreOne: { max: 20 } }), user });
    const saved = await getRubrics({ client: db });
    expect(saved.rubrics.resume.customized).toBe(true);
    expect(saved.rubrics.resume.maxOverall).toBe(23);
    expect(saved.stagingMax).toBe(31);

    const reset = await resetRubric({ client: db, type: 'resume' });
    expect(reset.rubrics.resume.maxOverall).toBe(13);
  });
});

describe('normalizeRubric', () => {
  it('refuses a range whose maximum is not above its minimum', () => {
    expect(() => normalizeRubric('video', edited('video', { scoreOne: { min: 2, max: 2 } })))
      .toThrow(/maximum must be above its minimum/);
  });

  it('refuses fractional and negative ranges', () => {
    expect(() => normalizeRubric('video', edited('video', { scoreOne: { max: 2.5 } }))).toThrow(/whole numbers/);
    expect(() => normalizeRubric('video', edited('video', { scoreOne: { min: -1 } }))).toThrow(/between 0/);
  });

  it('refuses a rubric missing one of the type\'s categories', () => {
    const rubric = { categories: DEFAULT_RUBRICS.coverLetter.categories.slice(0, 2) };
    expect(() => normalizeRubric('coverLetter', rubric)).toThrow(/Category 3 is missing/);
  });

  it('ignores categories the type does not have', () => {
    const rubric = { categories: [...DEFAULT_RUBRICS.video.categories, { id: 'scoreTwo', title: 'Extra', min: 0, max: 5 }] };
    expect(normalizeRubric('video', rubric).categories.map((category) => category.id)).toEqual(['scoreOne']);
  });

  it('drops blank criteria rows but refuses half-filled ones', () => {
    const blankRow = edited('video', { scoreOne: { criteria: [{ label: '0', text: 'Low' }, { label: ' ', text: '' }] } });
    expect(normalizeRubric('video', blankRow).categories[0].criteria).toEqual([{ label: '0', text: 'Low' }]);

    const halfRow = edited('video', { scoreOne: { criteria: [{ label: '0', text: '' }] } });
    expect(() => normalizeRubric('video', halfRow)).toThrow(/both a score and a description/);
  });

  it('requires a title', () => {
    expect(() => normalizeRubric('video', edited('video', { scoreOne: { title: '  ' } }))).toThrow(/needs a title/);
  });
});

describe('overall score', () => {
  it('sums resume, averages cover letter, takes video as is', () => {
    expect(computeOverall('resume', DEFAULT_RUBRICS.resume, { scoreOne: 8, scoreTwo: 3 })).toBe(11);
    expect(computeOverall('coverLetter', DEFAULT_RUBRICS.coverLetter, { scoreOne: 3, scoreTwo: 2, scoreThree: 1 })).toBe(2);
    expect(computeOverall('video', DEFAULT_RUBRICS.video, { scoreOne: 2 })).toBe(2);
  });

  it('leaves a blank category out of an average instead of counting it as zero', () => {
    expect(computeOverall('coverLetter', DEFAULT_RUBRICS.coverLetter, { scoreOne: 3, scoreTwo: 3, scoreThree: null })).toBe(3);
  });

  it('counts a real zero', () => {
    const rubric = edited('coverLetter', { scoreOne: { min: 0 }, scoreTwo: { min: 0 }, scoreThree: { min: 0 } });
    expect(computeOverall('coverLetter', rubric, { scoreOne: 3, scoreTwo: 0, scoreThree: 3 })).toBe(2);
  });

  it('gives the average of the maxima for an average type', () => {
    const rubric = edited('coverLetter', { scoreOne: { max: 5 } });
    expect(maxOverall('coverLetter', rubric)).toBeCloseTo(11 / 3);
  });
});

describe('validateCategoryScores', () => {
  it('holds a score to the configured range', () => {
    const rubric = edited('resume', { scoreOne: { max: 20 } });
    expect(validateCategoryScores('resume', rubric, { scoreOne: 15, scoreTwo: 2 }).scoreOne).toBe(15);
    expect(() => validateCategoryScores('resume', DEFAULT_RUBRICS.resume, { scoreOne: 15 }))
      .toThrow(/Content, Relevance, and Impact must be a whole number from 1 to 10/);
    expect(() => validateCategoryScores('resume', DEFAULT_RUBRICS.resume, { scoreOne: 0 })).toThrow(/from 1 to 10/);
  });

  it('nulls the columns the type does not use', () => {
    expect(validateCategoryScores('resume', DEFAULT_RUBRICS.resume, { scoreOne: 5, scoreTwo: 2, scoreThree: 7 }))
      .toEqual({ scoreOne: 5, scoreTwo: 2, scoreThree: null });
  });

  it('keeps a blank as null', () => {
    expect(validateCategoryScores('video', DEFAULT_RUBRICS.video, { scoreOne: '' }).scoreOne).toBeNull();
    expect(validateCategoryScores('video', DEFAULT_RUBRICS.video, { scoreOne: 0 }).scoreOne).toBe(0);
  });
});

describe('scoreFromRubric', () => {
  it('checks a grader\'s save against the saved rubric', async () => {
    await saveRubric({ client: db, type: 'video', rubric: edited('video', { scoreOne: { max: 5 } }), user });
    expect((await scoreFromRubric('video', { scoreOne: 4 }, { client: db })).overallScore).toBe(4);
    await expect(scoreFromRubric('video', { scoreOne: 6 }, { client: db })).rejects.toMatchObject({ status: 400 });
  });
});

describe('adminScorePatch', () => {
  const stored = { scoreOne: 9, scoreTwo: 3, scoreThree: null, overallScore: 12, adminScore: null };

  it('recomputes the overall when a category changes and the prefilled overall came back untouched', async () => {
    const data = await adminScorePatch({ client: db, type: 'resume', existing: stored, body: { scoreOne: 5, overallScore: '12' } });
    expect(data).toMatchObject({ scoreOne: 5, overallScore: 8 });
  });

  it('keeps an overall the admin typed', async () => {
    const data = await adminScorePatch({ client: db, type: 'resume', existing: stored, body: { overallScore: 10 } });
    expect(data.overallScore).toBe(10);
  });

  it('refuses an override above the rubric\'s maximum', async () => {
    await expect(adminScorePatch({ client: db, type: 'resume', existing: stored, body: { adminScore: 14 } }))
      .rejects.toThrow(/Admin score must be between 0 and 13/);
  });

  it('leaves a score graded under a wider range editable', async () => {
    const legacy = { scoreOne: 18, scoreTwo: 3, scoreThree: null, overallScore: 21, adminScore: 20 };
    const data = await adminScorePatch({
      client: db,
      type: 'resume',
      existing: legacy,
      body: { scoreOne: 18, scoreTwo: 3, overallScore: 21, adminScore: 20, notes: 'fixed a typo' }
    });
    expect(data).toEqual({ overallScore: 21, adminScore: 20 });
  });

  it('still holds a changed category on a legacy row to the current range', async () => {
    const legacy = { scoreOne: 18, scoreTwo: 3, scoreThree: null, overallScore: 21, adminScore: null };
    await expect(adminScorePatch({ client: db, type: 'resume', existing: legacy, body: { scoreOne: 17 } }))
      .rejects.toThrow(/from 1 to 10/);
  });
});

describe('previewRubric', () => {
  it('counts this cycle\'s scores the new range would leave out, and writes nothing', async () => {
    db = fakeDb({
      scores: {
        resume: [
          { cycleId: 'cycle-1', scoreOne: 9, scoreTwo: 3 },
          { cycleId: 'cycle-1', scoreOne: 4, scoreTwo: 2 },
          { cycleId: 'cycle-1', scoreOne: null, scoreTwo: 3 },
          { cycleId: 'old-cycle', scoreOne: 10, scoreTwo: 3 }
        ]
      }
    });
    const preview = await previewRubric({ client: db, type: 'resume', rubric: edited('resume', { scoreOne: { max: 8 } }) });
    expect(preview.outOfRange).toEqual({ count: 1, cycleName: 'Fall 2026' });
    expect(preview.maxOverall).toBe(11);
    expect((await getRubrics({ client: db })).rubrics.resume.customized).toBe(false);
  });
});
