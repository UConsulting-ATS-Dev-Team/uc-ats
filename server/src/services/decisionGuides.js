import prisma from '../prismaClient.js';
import { ROUNDS } from '../utils/roundProgression.js';
import { phaseLabel, roundForPhase } from './stagingDecisions.js';

// What each decision on a candidate means, in words an admin can change.
//
// A reviewer finishing an interview picks one of four InterviewDecision values.
// Nothing in the app says what they mean, so two reviewers can file the same
// judgment under different labels. This is the copy that fixes that: a note on
// what deliberation is for, plus one description per decision.
//
// Resolution runs built-in defaults -> the 'general' guide -> the round's own
// guide, each layer overriding the one before it. A round nobody has edited
// therefore still reads correctly, and editing 'general' moves every round that
// has not been given its own wording. `source` on the way out says which layer
// answered, so the editor can show "inherited" rather than pretend an admin
// wrote it.
//
// Labels are not editable. They have to match the radio buttons in the
// interview interfaces, and a guide that names the options differently from the
// form is worse than no guide at all.

const INTRO_MAX = 2000;
const CRITERIA_MAX = 2000;

/** The phase every round inherits from. Not a round - see the header. */
export const GENERAL_PHASE = 'general';

/** Round phases, plus the shared base. The only values `phase` may take. */
export const GUIDE_PHASES = Object.freeze([GENERAL_PHASE, ...ROUNDS.map((round) => round.phase)]);

/**
 * The four values an interviewer can record, in the order they are shown.
 *
 * InterviewDecision also has UNSURE, which no picker in the app offers. It is
 * left undocumented on purpose: describing an option nobody can select only
 * raises questions. If UNSURE is ever added to the form, add it here too.
 */
export const DECISION_VALUES = Object.freeze(['YES', 'MAYBE_YES', 'MAYBE_NO', 'NO']);

export const DECISION_LABELS = Object.freeze({
  YES: 'Yes',
  MAYBE_YES: 'Maybe-Yes',
  MAYBE_NO: 'Maybe-No',
  NO: 'No'
});

/**
 * Shipped copy, used until an admin writes their own. Deliberately describes
 * the reviewer's own position rather than ruling on the candidate, so it stays
 * usable at every round and does not do the deciding for anyone.
 */
export const DEFAULT_GUIDE = Object.freeze({
  intro:
    'Deliberation is a discussion, not a calculation. Record the decision that matches your own '
    + "reading of this candidate against the round's rubric. The rubric and the group's judgment are "
    + 'what decide, not this note. Your decision here is a recommendation stored against the '
    + 'candidate. Advancing and rejecting happen later, in Staging.',
  criteria: Object.freeze({
    YES: 'You would advance this candidate as they stand. They meet the criteria for this round and you '
      + 'have no reservation you need the group to resolve first.',
    MAYBE_YES: 'You lean toward advancing. They meet most of the criteria and the questions you have left '
      + 'are small enough that a short discussion should settle them.',
    MAYBE_NO: 'You lean toward not advancing. Something the round asks for is missing or unclear, but you '
      + 'would change your mind if the group can account for it.',
    NO: 'You would not advance this candidate. They fall short on criteria that matter for this round, and '
      + 'you do not expect discussion to change that.'
  })
});

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

const assertPhase = (phase) => {
  if (!GUIDE_PHASES.includes(phase)) throw fail(400, `Unknown round: ${phase}`, 'INVALID_PHASE');
};

/** "Resume Review", or "All rounds" for the shared base. */
export const guidePhaseLabel = (phase) =>
  (phase === GENERAL_PHASE ? 'All rounds' : phaseLabel(phase));

const trimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Validates and trims what an admin submitted.
 *
 * Every decision is expected in `criteria`; an empty string is allowed and
 * means "say nothing extra for this one", which then falls through to the layer
 * below rather than showing a blank. Unknown keys are dropped instead of
 * refused, so a stale client cannot lock an admin out of saving.
 */
export function normalizeGuide(input) {
  if (!input || typeof input !== 'object') throw fail(400, 'A decision guide must be an object', 'INVALID_GUIDE');

  const intro = trimmedString(input.intro);
  if (intro.length > INTRO_MAX) {
    throw fail(400, `The deliberation note is over ${INTRO_MAX} characters`, 'INVALID_GUIDE');
  }

  const submitted = input.criteria;
  if (submitted !== undefined && (typeof submitted !== 'object' || submitted === null || Array.isArray(submitted))) {
    throw fail(400, 'Decision criteria must be an object keyed by decision', 'INVALID_GUIDE');
  }

  const criteria = {};
  for (const value of DECISION_VALUES) {
    const text = trimmedString(submitted?.[value]);
    if (text.length > CRITERIA_MAX) {
      throw fail(400, `${DECISION_LABELS[value]} is over ${CRITERIA_MAX} characters`, 'INVALID_GUIDE');
    }
    criteria[value] = text;
  }

  return { intro, criteria };
}

/** A stored row, or null when nothing readable is there. */
const storedGuide = (row) => {
  const stored = row?.guide;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const criteria = (stored.criteria && typeof stored.criteria === 'object' && !Array.isArray(stored.criteria))
    ? stored.criteria
    : {};
  return { intro: trimmedString(stored.intro), criteria };
};

/**
 * Folds the layers into the copy a reviewer actually sees. Each field takes the
 * last layer that had something to say about it, so a round can override the
 * note without restating all four decisions.
 */
function resolveGuide({ phase, general, own }) {
  const layers = [
    { source: 'default', guide: { intro: DEFAULT_GUIDE.intro, criteria: { ...DEFAULT_GUIDE.criteria } } },
    ...(general ? [{ source: GENERAL_PHASE, guide: general }] : []),
    ...(own ? [{ source: phase, guide: own }] : [])
  ];

  const resolved = { intro: '', criteria: {}, introSource: 'default', criteriaSources: {} };
  for (const { source, guide } of layers) {
    if (guide.intro) {
      resolved.intro = guide.intro;
      resolved.introSource = source;
    }
    for (const value of DECISION_VALUES) {
      const text = trimmedString(guide.criteria?.[value]);
      if (text) {
        resolved.criteria[value] = text;
        resolved.criteriaSources[value] = source;
      }
    }
  }

  return {
    phase,
    phaseLabel: guidePhaseLabel(phase),
    intro: resolved.intro,
    introSource: resolved.introSource,
    decisions: DECISION_VALUES.map((value) => ({
      value,
      label: DECISION_LABELS[value],
      criteria: resolved.criteria[value] || '',
      source: resolved.criteriaSources[value] || 'default'
    })),
    /** False while this round is still reading someone else's words. */
    customized: Boolean(own)
  };
}

/**
 * The guide a reviewer should see for `phase`. An interview with no round of
 * its own (deliberations) passes GENERAL_PHASE and gets the shared base.
 */
export async function getGuide({ client = prisma, phase = GENERAL_PHASE } = {}) {
  assertPhase(phase);
  const rows = await client.decisionGuide.findMany({
    where: { phase: { in: phase === GENERAL_PHASE ? [GENERAL_PHASE] : [GENERAL_PHASE, phase] } }
  });
  const byPhase = new Map(rows.map((row) => [row.phase, row]));
  const own = phase === GENERAL_PHASE ? null : storedGuide(byPhase.get(phase));
  return {
    guide: resolveGuide({ phase, general: storedGuide(byPhase.get(GENERAL_PHASE)), own }),
    updatedAt: byPhase.get(phase)?.updatedAt ?? null
  };
}

/** Every phase at once, for the admin editor. */
export async function getGuides({ client = prisma } = {}) {
  const rows = await client.decisionGuide.findMany();
  const byPhase = new Map(rows.map((row) => [row.phase, row]));
  const general = storedGuide(byPhase.get(GENERAL_PHASE));

  const guides = {};
  for (const phase of GUIDE_PHASES) {
    const own = phase === GENERAL_PHASE ? null : storedGuide(byPhase.get(phase));
    guides[phase] = {
      ...resolveGuide({ phase, general, own }),
      /** Exactly what is stored for this phase, so the editor edits it and not the inherited text. */
      stored: storedGuide(byPhase.get(phase)),
      updatedAt: byPhase.get(phase)?.updatedAt ?? null
    };
  }
  return { guides, phases: GUIDE_PHASES };
}

export async function saveGuide({ client = prisma, phase, intro, criteria, user }) {
  assertPhase(phase);
  const guide = normalizeGuide({ intro, criteria });
  await client.decisionGuide.upsert({
    where: { phase },
    create: { phase, guide, updatedById: user.id },
    update: { guide, updatedById: user.id }
  });
  return getGuides({ client });
}

/** Drops this phase's row so it inherits again. Not an error if there was none. */
export async function resetGuide({ client = prisma, phase }) {
  assertPhase(phase);
  await client.decisionGuide.deleteMany({ where: { phase } });
  return getGuides({ client });
}

/** Guards a phase coming off a query string, falling back to the shared base. */
export const guidePhaseOrGeneral = (phase) =>
  (roundForPhase(phase) ? phase : GENERAL_PHASE);
