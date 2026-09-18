// What matters about the decision guide: a round nobody has configured still
// reads correctly, 'general' moves every round that has not been overridden,
// a round's own wording wins, and an empty field falls through instead of
// showing a reviewer a blank.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DECISION_VALUES,
  DEFAULT_GUIDE,
  GUIDE_PHASES,
  getGuide,
  getGuides,
  guidePhaseOrGeneral,
  normalizeGuide,
  resetGuide,
  saveGuide
} from './decisionGuides.js';

vi.mock('../prismaClient.js', () => ({ default: {} }));

// A decision_guides table and nothing else - the only calls this service makes.
function fakeDb() {
  let rows = [];
  let seq = 0;

  const matches = (row, where = {}) =>
    Object.entries(where).every(([key, expected]) => (
      expected && typeof expected === 'object' && 'in' in expected
        ? expected.in.includes(row[key])
        : row[key] === expected
    ));

  return {
    rows: () => rows,
    decisionGuide: {
      findMany: async ({ where } = {}) => rows.filter((row) => matches(row, where)),
      upsert: async ({ where, create, update }) => {
        const existing = rows.find((row) => matches(row, where));
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const row = { id: `guide-${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        rows.push(row);
        return row;
      },
      deleteMany: async ({ where }) => {
        const before = rows.length;
        rows = rows.filter((row) => !matches(row, where));
        return { count: before - rows.length };
      }
    }
  };
}

const user = { id: 'admin-1' };
const criteriaFor = (guide, value) => guide.decisions.find((entry) => entry.value === value);

let db;
beforeEach(() => { db = fakeDb(); });

describe('phases and decisions', () => {
  it('covers the shared base plus every pipeline round', () => {
    expect(GUIDE_PHASES).toEqual(['general', 'resume', 'coffee', 'firstRound', 'final']);
  });

  it('documents only the four decisions a picker actually offers', () => {
    expect(DECISION_VALUES).toEqual(['YES', 'MAYBE_YES', 'MAYBE_NO', 'NO']);
    expect(DECISION_VALUES).not.toContain('UNSURE');
  });

  it('sends an interview with no round of its own to the shared base', () => {
    expect(guidePhaseOrGeneral('firstRound')).toBe('firstRound');
    expect(guidePhaseOrGeneral(undefined)).toBe('general');
    expect(guidePhaseOrGeneral('nonsense')).toBe('general');
  });
});

describe('resolution', () => {
  it('serves the shipped copy when nothing is stored', async () => {
    const { guide } = await getGuide({ client: db, phase: 'coffee' });

    expect(guide.intro).toBe(DEFAULT_GUIDE.intro);
    expect(guide.introSource).toBe('default');
    expect(guide.customized).toBe(false);
    expect(guide.phaseLabel).toBe('Coffee Chat');
    for (const value of DECISION_VALUES) {
      expect(criteriaFor(guide, value).criteria).toBe(DEFAULT_GUIDE.criteria[value]);
      expect(criteriaFor(guide, value).source).toBe('default');
    }
  });

  it('lets the general guide move every round that has no wording of its own', async () => {
    await saveGuide({
      client: db,
      phase: 'general',
      intro: 'House rules.',
      criteria: { YES: 'Advance them.' },
      user
    });

    for (const phase of ['resume', 'coffee', 'firstRound', 'final']) {
      const { guide } = await getGuide({ client: db, phase });
      expect(guide.intro).toBe('House rules.');
      expect(guide.introSource).toBe('general');
      expect(criteriaFor(guide, 'YES').criteria).toBe('Advance them.');
      expect(criteriaFor(guide, 'YES').source).toBe('general');
      // Untouched decisions keep falling through to the shipped copy.
      expect(criteriaFor(guide, 'NO').criteria).toBe(DEFAULT_GUIDE.criteria.NO);
      expect(criteriaFor(guide, 'NO').source).toBe('default');
      expect(guide.customized).toBe(false);
    }
  });

  it("prefers a round's own wording over the general guide", async () => {
    await saveGuide({ client: db, phase: 'general', intro: 'House rules.', criteria: { YES: 'General yes.' }, user });
    await saveGuide({ client: db, phase: 'final', intro: '', criteria: { YES: 'Final-round yes.' }, user });

    const { guide } = await getGuide({ client: db, phase: 'final' });
    expect(criteriaFor(guide, 'YES').criteria).toBe('Final-round yes.');
    expect(criteriaFor(guide, 'YES').source).toBe('final');
    expect(guide.customized).toBe(true);
    // The round said nothing about the note, so the general one still shows.
    expect(guide.intro).toBe('House rules.');
    expect(guide.introSource).toBe('general');
  });

  it('does not leak one round\'s wording into another', async () => {
    await saveGuide({ client: db, phase: 'final', intro: '', criteria: { NO: 'Final-round no.' }, user });

    const { guide } = await getGuide({ client: db, phase: 'coffee' });
    expect(criteriaFor(guide, 'NO').criteria).toBe(DEFAULT_GUIDE.criteria.NO);
  });

  it('never hands back a blank where an admin cleared a field', async () => {
    await saveGuide({ client: db, phase: 'general', intro: 'House rules.', criteria: { YES: 'General yes.' }, user });
    await saveGuide({ client: db, phase: 'coffee', intro: '', criteria: { YES: '   ' }, user });

    const { guide } = await getGuide({ client: db, phase: 'coffee' });
    expect(criteriaFor(guide, 'YES').criteria).toBe('General yes.');
    expect(criteriaFor(guide, 'YES').source).toBe('general');
  });

  // Reset is offered on whatever has a row of its own. The general guide layers
  // itself in as `general` rather than as `own`, so deriving customized from
  // `own` reported it uncustomized and hid Reset on the one guide every round
  // inherits from.
  it('reports the general guide as customized once an admin has saved it', async () => {
    expect((await getGuide({ client: db, phase: 'general' })).guide.customized).toBe(false);

    await saveGuide({ client: db, phase: 'general', intro: 'House rules.', criteria: {}, user });

    expect((await getGuide({ client: db, phase: 'general' })).guide.customized).toBe(true);
    expect((await getGuides({ client: db })).guides.general.customized).toBe(true);
    // Saving the base does not make the rounds look customized.
    expect((await getGuides({ client: db })).guides.coffee.customized).toBe(false);
  });

  it('puts the general guide back to the shipped copy', async () => {
    await saveGuide({ client: db, phase: 'general', intro: 'House rules.', criteria: { YES: 'General yes.' }, user });
    const { guides } = await resetGuide({ client: db, phase: 'general' });

    expect(guides.general.customized).toBe(false);
    expect(guides.general.intro).toBe(DEFAULT_GUIDE.intro);
    expect(criteriaFor(guides.coffee, 'YES').criteria).toBe(DEFAULT_GUIDE.criteria.YES);
  });

  it('reads the general phase without inheriting from itself twice', async () => {
    await saveGuide({ client: db, phase: 'general', intro: 'House rules.', criteria: {}, user });

    const { guide } = await getGuide({ client: db, phase: 'general' });
    expect(guide.phaseLabel).toBe('All rounds');
    expect(guide.intro).toBe('House rules.');
    expect(guide.introSource).toBe('general');
  });
});

describe('editing', () => {
  it('returns every phase with what is stored kept apart from what is shown', async () => {
    await saveGuide({ client: db, phase: 'firstRound', intro: 'Round note.', criteria: {}, user });

    const { guides, phases } = await getGuides({ client: db });
    expect(phases).toEqual(GUIDE_PHASES);
    expect(guides.firstRound.stored).toEqual({ intro: 'Round note.', criteria: { YES: '', MAYBE_YES: '', MAYBE_NO: '', NO: '' } });
    expect(guides.firstRound.intro).toBe('Round note.');
    // A phase nobody has written has nothing stored, but still shows copy.
    expect(guides.coffee.stored).toBeNull();
    expect(guides.coffee.intro).toBe(DEFAULT_GUIDE.intro);
  });

  it('overwrites rather than accumulating rows for one phase', async () => {
    await saveGuide({ client: db, phase: 'resume', intro: 'First.', criteria: {}, user });
    await saveGuide({ client: db, phase: 'resume', intro: 'Second.', criteria: {}, user });

    expect(db.rows().filter((row) => row.phase === 'resume')).toHaveLength(1);
    const { guide } = await getGuide({ client: db, phase: 'resume' });
    expect(guide.intro).toBe('Second.');
  });

  it('puts a round back to inheriting', async () => {
    await saveGuide({ client: db, phase: 'general', intro: 'House rules.', criteria: {}, user });
    await saveGuide({ client: db, phase: 'resume', intro: 'Resume note.', criteria: {}, user });

    const { guides } = await resetGuide({ client: db, phase: 'resume' });
    expect(guides.resume.customized).toBe(false);
    expect(guides.resume.intro).toBe('House rules.');
  });

  it('treats resetting an already-inherited round as a no-op', async () => {
    await expect(resetGuide({ client: db, phase: 'final' })).resolves.toBeTruthy();
  });

  it('refuses a phase that is not a round', async () => {
    await expect(getGuide({ client: db, phase: 'deliberations' })).rejects.toMatchObject({ status: 400, code: 'INVALID_PHASE' });
    await expect(saveGuide({ client: db, phase: 'nope', intro: '', criteria: {}, user }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_PHASE' });
  });
});

describe('normalizeGuide', () => {
  it('trims and fills in every decision', () => {
    expect(normalizeGuide({ intro: '  hello  ', criteria: { YES: ' y ' } })).toEqual({
      intro: 'hello',
      criteria: { YES: 'y', MAYBE_YES: '', MAYBE_NO: '', NO: '' }
    });
  });

  it('drops keys that are not decisions instead of refusing the save', () => {
    const { criteria } = normalizeGuide({ intro: '', criteria: { YES: 'y', UNSURE: 'u', bogus: 'b' } });
    expect(criteria).toEqual({ YES: 'y', MAYBE_YES: '', MAYBE_NO: '', NO: '' });
  });

  it('rejects copy that is too long', () => {
    expect(() => normalizeGuide({ intro: 'x'.repeat(2001), criteria: {} }))
      .toThrow(/over 2000 characters/);
    expect(() => normalizeGuide({ intro: '', criteria: { MAYBE_NO: 'x'.repeat(2001) } }))
      .toThrow(/Maybe-No is over 2000 characters/);
  });

  it('rejects shapes it cannot read', () => {
    expect(() => normalizeGuide(null)).toThrow(/must be an object/);
    expect(() => normalizeGuide({ criteria: ['YES'] })).toThrow(/keyed by decision/);
  });
});
