// The shape of a Master Communications audience, and the boolean logic that
// combines its rules. No database here: what each rule matches is answered by
// audiencePeople.js, and this file only validates the tree and folds rule
// results together with AND, OR and NOT.
//
// A tree looks like:
//
//   { version: 2, root: {
//       kind: 'group', op: 'AND', children: [
//         { kind: 'group', op: 'OR', children: [
//           { kind: 'rule', type: 'applied', params: { scope: 'previous' } },
//           { kind: 'rule', type: 'mailingList', params: {} },
//         ] },
//         { kind: 'rule', type: 'gradYear', params: { min: 2028 } },
//         { kind: 'rule', type: 'account', params: { roles: ['MEMBER', 'ADMIN'] }, negate: true },
//       ] } }
//
// Every node may carry `negate`. NOT is taken against everyone the ATS knows
// (the universe in audiencePeople.js), so "NOT a member" means every known
// person who is not one - which is why an audience made only of negations is
// refused: it is almost never what someone meant, and it reaches everybody.

export const AUDIENCE_TREE_VERSION = 2;

const MAX_DEPTH = 4;
const MAX_RULES = 40;

export const ACCOUNT_ROLES = ['USER', 'MEMBER', 'ADMIN'];
export const APPLICATION_STATUSES = ['SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'WAITLISTED'];
// Round numbers as roundProgression.js has them; 5 is "accepted".
export const ROUND_NUMBERS = ['1', '2', '3', '4', '5'];
export const DECISION_ROUNDS = ['1', '2', '3', '4'];
export const DECISION_VALUES = ['yes', 'no', 'maybe', 'undecided'];
export const APPLIED_SCOPES = ['any', 'cycles', 'previous'];
export const CAMPAIGN_OUTCOMES = ['any', 'delivered', 'failed'];

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Param coercers. Each takes the raw value and the rule's label for messages,
// and returns the clean value or undefined when absent.

const stringList = (raw, label, name, { required = false, allowed = null } = {}) => {
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const clean = [...new Set(list.map((v) => String(v).trim()).filter(Boolean))];
  if (allowed) {
    const bad = clean.find((v) => !allowed.includes(v));
    if (bad) throw badRequest(`${label}: "${bad}" is not a valid ${name}`);
  }
  if (required && clean.length === 0) throw badRequest(`${label}: choose at least one ${name}`);
  return clean;
};

const optionalInt = (raw, label, name, { min = null, max = null } = {}) => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw badRequest(`${label}: ${name} must be a whole number`);
  if (min !== null && n < min) throw badRequest(`${label}: ${name} must be at least ${min}`);
  if (max !== null && n > max) throw badRequest(`${label}: ${name} must be at most ${max}`);
  return n;
};

const optionalDate = (raw, label, name) => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw badRequest(`${label}: ${name} is not a date`);
  return d.toISOString();
};

const optionalBool = (raw) => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return raw === true || raw === 'true';
};

const oneOf = (raw, label, name, allowed, fallback) => {
  const value = raw === undefined || raw === null || raw === '' ? fallback : String(raw);
  if (!allowed.includes(value)) throw badRequest(`${label}: "${value}" is not a valid ${name}`);
  return value;
};

/**
 * Every rule an audience can use. `params` validates and cleans the rule's
 * parameters; what the rule matches lives in audiencePeople.js under the same
 * key. The client keeps its own copy of the labels and editors in
 * components/communications/audienceRules.js - add a rule in both.
 */
export const RULE_TYPES = {
  // Where they came from --------------------------------------------------
  mailingList: {
    label: 'On the mailing list',
    params: (p, l) => ({ sourceFiles: stringList(p.sourceFiles, l, 'import') }),
  },
  account: {
    label: 'Has an ATS account',
    params: (p, l) => ({
      roles: stringList(p.roles, l, 'role', { allowed: ACCOUNT_ROLES }),
      createdFrom: optionalDate(p.createdFrom, l, 'created from'),
      createdTo: optionalDate(p.createdTo, l, 'created to'),
    }),
  },
  externalTalent: { label: 'Talent portal account', params: () => ({}) },
  emailVerified: { label: 'Verified their email', params: () => ({}) },
  meetingSignup: {
    label: 'Booked a coffee chat / meeting',
    params: (p) => ({ attended: optionalBool(p.attended) }),
  },
  lumaGuest: {
    label: 'Registered on Luma',
    params: (p, l) => ({
      eventIds: stringList(p.eventIds, l, 'event'),
      checkedIn: optionalBool(p.checkedIn),
    }),
  },

  // Application history ---------------------------------------------------
  applied: {
    label: 'Applied',
    params: (p, l) => {
      const scope = oneOf(p.scope, l, 'scope', APPLIED_SCOPES, 'any');
      const cycleIds = stringList(p.cycleIds, l, 'cycle', { required: scope === 'cycles' });
      return {
        scope,
        cycleIds: scope === 'cycles' ? cycleIds : [],
        statuses: stringList(p.statuses, l, 'status', { allowed: APPLICATION_STATUSES }),
        submittedFrom: optionalDate(p.submittedFrom, l, 'submitted from'),
        submittedTo: optionalDate(p.submittedTo, l, 'submitted to'),
      };
    },
  },
  appliedCount: {
    label: 'Applied in N or more cycles',
    params: (p, l) => ({ min: optionalInt(p.min, l, 'count', { min: 1, max: 20 }) ?? 2 }),
  },
  reachedRound: {
    label: 'Reached a round',
    params: (p, l) => ({
      round: oneOf(p.round, l, 'round', ROUND_NUMBERS, '2'),
      cycleIds: stringList(p.cycleIds, l, 'cycle'),
    }),
  },
  decision: {
    label: 'Decision in a round',
    params: (p, l) => ({
      round: oneOf(p.round, l, 'round', DECISION_ROUNDS, '1'),
      decisions: stringList(p.decisions, l, 'decision', { required: true, allowed: DECISION_VALUES }),
      cycleIds: stringList(p.cycleIds, l, 'cycle'),
    }),
  },
  talentPoolOptIn: { label: 'Opted into the Talent Partner Network', params: () => ({}) },
  referred: {
    label: 'Was referred',
    params: (p, l) => ({ cycleIds: stringList(p.cycleIds, l, 'cycle') }),
  },

  // Academic --------------------------------------------------------------
  gradYear: {
    label: 'Graduation year',
    params: (p, l) => {
      const years = stringList(p.years, l, 'year').map((y) => {
        const n = Number(y);
        if (!Number.isInteger(n) || n < 1990 || n > 2100) throw badRequest(`${l}: "${y}" is not a year`);
        return n;
      });
      const min = optionalInt(p.min, l, 'earliest year', { min: 1990, max: 2100 });
      const max = optionalInt(p.max, l, 'latest year', { min: 1990, max: 2100 });
      if (years.length === 0 && min === undefined && max === undefined) {
        throw badRequest(`${l}: give a year, or an earliest or latest year`);
      }
      if (min !== undefined && max !== undefined && min > max) {
        throw badRequest(`${l}: the earliest year is after the latest`);
      }
      return { years, min, max };
    },
  },
  major: {
    label: 'Major',
    params: (p, l) => ({ terms: stringList(p.terms, l, 'major', { required: true }) }),
  },
  transfer: { label: 'Transfer student', params: () => ({}) },
  firstGen: { label: 'First-generation student', params: () => ({}) },

  // Engagement ------------------------------------------------------------
  eventRsvp: {
    label: "RSVP'd to an event",
    params: (p, l) => ({ eventIds: stringList(p.eventIds, l, 'event') }),
  },
  eventAttended: {
    label: 'Attended events',
    params: (p, l) => ({
      eventIds: stringList(p.eventIds, l, 'event'),
      minCount: optionalInt(p.minCount, l, 'count', { min: 1, max: 100 }) ?? 1,
    }),
  },
  rsvpNoShow: {
    label: "RSVP'd but didn't come",
    params: (p, l) => ({ eventIds: stringList(p.eventIds, l, 'event') }),
  },
  receivedCampaign: {
    label: 'Received a past send',
    params: (p, l) => ({
      messageLogIds: stringList(p.messageLogIds, l, 'send', { required: true }),
      outcome: oneOf(p.outcome, l, 'outcome', CAMPAIGN_OUTCOMES, 'any'),
    }),
  },
  emailedWithin: {
    label: 'Emailed from here recently',
    params: (p, l) => ({ days: optionalInt(p.days, l, 'days', { min: 1, max: 365 }) ?? 14 }),
  },
};

/**
 * Validate and clean a tree. Throws a 400 naming the problem. Empty groups are
 * dropped rather than refused - they are what an admin leaves behind after
 * deleting the last rule in one - but an audience with no rules at all is
 * refused, because an empty AND is everyone.
 */
export function normalizeAudienceTree(input) {
  const tree = typeof input === 'string' ? safeParse(input) : input;
  if (!tree || typeof tree !== 'object' || !tree.root) {
    throw badRequest('Audience filters are missing');
  }
  if (tree.version !== undefined && Number(tree.version) !== AUDIENCE_TREE_VERSION) {
    throw badRequest(`Unsupported audience filter version: ${tree.version}`);
  }

  let rules = 0;
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object') throw badRequest('Audience filters contain an empty entry');
    if (depth > MAX_DEPTH) throw badRequest(`Groups can be nested at most ${MAX_DEPTH} deep`);
    const negate = node.negate === true;

    if (node.kind === 'rule') {
      const def = RULE_TYPES[node.type];
      if (!def) throw badRequest(`Unknown audience filter: ${node.type}`);
      rules += 1;
      if (rules > MAX_RULES) throw badRequest(`An audience can have at most ${MAX_RULES} filters`);
      return { kind: 'rule', type: node.type, params: def.params(node.params || {}, def.label), negate };
    }

    if (node.kind === 'group') {
      const op = node.op === 'OR' ? 'OR' : node.op === 'AND' || node.op === undefined ? 'AND' : null;
      if (!op) throw badRequest(`Unknown group operator: ${node.op}`);
      const children = (Array.isArray(node.children) ? node.children : [])
        .map((child) => walk(child, depth + 1))
        .filter(Boolean);
      if (children.length === 0) return null;
      return { kind: 'group', op, negate, children };
    }

    throw badRequest(`Unknown audience filter entry: ${node.kind}`);
  };

  const root = walk(tree.root, 1);
  if (!root) throw badRequest('Add at least one filter to the audience');
  if (!hasPositiveRule(root)) {
    throw badRequest('An audience needs at least one filter that is not negated — "not X" alone reaches everyone the ATS knows');
  }
  return { version: AUDIENCE_TREE_VERSION, root };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('Audience filters are not valid JSON');
  }
}

// True when the tree narrows the universe somewhere, i.e. it is not built only
// out of negations. A negated group of negations counts as positive: NOT (NOT a
// AND NOT b) is (a OR b).
function hasPositiveRule(node, negated = false) {
  const flipped = negated !== node.negate;
  if (node.kind === 'rule') return !flipped;
  return node.children.some((child) => hasPositiveRule(child, flipped));
}

export function isAudienceTree(filters) {
  return Boolean(filters && typeof filters === 'object' && filters.root);
}

/** Each distinct rule in the tree, for loading what they need up front. */
export function collectRules(root) {
  const out = [];
  const walk = (node) => {
    if (node.kind === 'rule') out.push(node);
    else node.children.forEach(walk);
  };
  walk(root);
  return out;
}

/**
 * Fold a normalized tree into the set of people it matches.
 *
 * `matchRule(rule)` answers a rule with a Set of person keys; `universe` is the
 * Set of every known person, which NOT is taken against. Rules are matched in
 * parallel and each once, even when the same rule appears twice.
 */
export async function evaluateAudienceTree(tree, { matchRule, universe }) {
  const distinct = new Map();
  for (const rule of collectRules(tree.root)) {
    const key = ruleKey(rule);
    if (!distinct.has(key)) distinct.set(key, rule);
  }
  const resolved = new Map(
    await Promise.all([...distinct].map(async ([key, rule]) => [key, await matchRule(rule)]))
  );

  const evaluate = (node) => {
    let set;
    if (node.kind === 'rule') {
      set = resolved.get(ruleKey(node)) || new Set();
    } else if (node.op === 'OR') {
      set = new Set();
      for (const child of node.children) for (const k of evaluate(child)) set.add(k);
    } else {
      const [first, ...rest] = node.children.map(evaluate).sort((a, b) => a.size - b.size);
      set = new Set([...first].filter((k) => rest.every((s) => s.has(k))));
    }
    if (!node.negate) return set;
    return new Set([...universe].filter((k) => !set.has(k)));
  };

  const matched = evaluate(tree.root);
  // Rules may name people outside the universe (the universe drops deactivated
  // and client accounts); those never go out.
  return new Set([...matched].filter((k) => universe.has(k)));
}

function ruleKey(rule) {
  return `${rule.type}:${JSON.stringify(rule.params)}`;
}
