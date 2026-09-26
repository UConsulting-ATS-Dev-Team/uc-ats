// The filter builder's vocabulary: every rule an audience can use, how each is
// edited, and the ready-made starting points.
//
// The server owns what a rule means (server/src/services/audiences/). This
// file only knows how to show and edit one, so the keys and params here must
// match RULE_TYPES in audienceFilters.js - add a rule in both places.

let nextId = 0;
export const newId = () => `n${Date.now().toString(36)}${(nextId++).toString(36)}`;

export const APPLICATION_STATUSES = ['SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'WAITLISTED'];

export const ROUND_OPTIONS = [
  { value: '1', label: 'Resume review' },
  { value: '2', label: 'Coffee chats' },
  { value: '3', label: 'First round' },
  { value: '4', label: 'Final round' },
];

const REACHED_OPTIONS = [...ROUND_OPTIONS, { value: '5', label: 'Accepted' }];

const DECISION_OPTIONS = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'maybe', label: 'Maybe' },
  { value: 'undecided', label: 'Undecided' },
];

/**
 * `fields` drive the generic editor in AudienceBuilder. Kinds:
 *   cycles | events | campaigns             - multi-selects over loaded options
 *   multi (options) | select (options)      - fixed choices
 *   triBool                                 - any / yes / no
 *   date | int | csv                        - typed inputs; csv is a comma list
 */
export const RULES = {
  mailingList: {
    group: 'Where they came from',
    label: 'On the mailing list',
    fields: [],
  },
  account: {
    group: 'Where they came from',
    label: 'Has an ATS account',
    fields: [
      { key: 'roles', kind: 'multi', label: 'Role (any if empty)', options: [
        { value: 'USER', label: 'Applicant / student' },
        { value: 'MEMBER', label: 'Member' },
        { value: 'ADMIN', label: 'Admin' },
      ] },
      { key: 'createdFrom', kind: 'date', label: 'Created on or after' },
      { key: 'createdTo', kind: 'date', label: 'Created on or before' },
    ],
  },
  externalTalent: { group: 'Where they came from', label: 'Talent portal account', fields: [] },
  emailVerified: { group: 'Where they came from', label: 'Verified their email', fields: [] },
  meetingSignup: {
    group: 'Where they came from',
    label: 'Booked a coffee chat / meeting',
    fields: [{ key: 'attended', kind: 'triBool', label: 'Showed up' }],
  },
  lumaGuest: {
    group: 'Where they came from',
    label: 'Registered on Luma',
    fields: [
      { key: 'eventIds', kind: 'events', label: 'Event (any if empty)' },
      { key: 'checkedIn', kind: 'triBool', label: 'Checked in' },
    ],
  },

  applied: {
    group: 'Application history',
    label: 'Applied',
    fields: [
      { key: 'scope', kind: 'select', label: 'When', options: [
        { value: 'any', label: 'In any cycle' },
        { value: 'previous', label: 'In a past cycle (not the active one)' },
        { value: 'cycles', label: 'In specific cycles' },
      ] },
      { key: 'cycleIds', kind: 'cycles', label: 'Cycles', showIf: (p) => p.scope === 'cycles' },
      { key: 'statuses', kind: 'multi', label: 'With status (any if empty)', options: APPLICATION_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') })) },
      { key: 'submittedFrom', kind: 'date', label: 'Submitted on or after' },
      { key: 'submittedTo', kind: 'date', label: 'Submitted on or before' },
    ],
    defaults: { scope: 'any' },
  },
  appliedCount: {
    group: 'Application history',
    label: 'Applied in several cycles',
    fields: [{ key: 'min', kind: 'int', label: 'At least this many cycles' }],
    defaults: { min: 2 },
  },
  reachedRound: {
    group: 'Application history',
    label: 'Reached a round',
    fields: [
      { key: 'round', kind: 'select', label: 'Got at least as far as', options: REACHED_OPTIONS },
      { key: 'cycleIds', kind: 'cycles', label: 'In cycles (any if empty)' },
    ],
    defaults: { round: '2' },
  },
  decision: {
    group: 'Application history',
    label: 'Decision in a round',
    fields: [
      { key: 'round', kind: 'select', label: 'Round', options: ROUND_OPTIONS },
      { key: 'decisions', kind: 'multi', label: 'Decision', options: DECISION_OPTIONS },
      { key: 'cycleIds', kind: 'cycles', label: 'In cycles (any if empty)' },
    ],
    defaults: { round: '1', decisions: ['no'] },
  },
  talentPoolOptIn: { group: 'Application history', label: 'Opted into the Talent Partner Network', fields: [] },
  referred: {
    group: 'Application history',
    label: 'Was referred',
    fields: [{ key: 'cycleIds', kind: 'cycles', label: 'In cycles (any if empty)' }],
  },

  gradYear: {
    group: 'Academic',
    label: 'Graduation year',
    fields: [
      { key: 'years', kind: 'csv', label: 'Exactly (e.g. 2027, 2028)' },
      { key: 'min', kind: 'int', label: 'Or from' },
      { key: 'max', kind: 'int', label: 'Through' },
    ],
  },
  major: {
    group: 'Academic',
    label: 'Major',
    fields: [{ key: 'terms', kind: 'csv', label: 'Contains any of (e.g. econ, math)' }],
  },
  transfer: { group: 'Academic', label: 'Transfer student', fields: [] },
  firstGen: { group: 'Academic', label: 'First-generation student', fields: [] },

  eventRsvp: {
    group: 'Engagement',
    label: "RSVP'd to an event",
    fields: [{ key: 'eventIds', kind: 'events', label: 'Event (any if empty)' }],
  },
  eventAttended: {
    group: 'Engagement',
    label: 'Attended events',
    fields: [
      { key: 'eventIds', kind: 'events', label: 'Of these events (any if empty)' },
      { key: 'minCount', kind: 'int', label: 'At least this many' },
    ],
    defaults: { minCount: 1 },
  },
  rsvpNoShow: {
    group: 'Engagement',
    label: "RSVP'd but didn't come",
    fields: [{ key: 'eventIds', kind: 'events', label: 'Event (any past event if empty)' }],
  },
  receivedCampaign: {
    group: 'Engagement',
    label: 'Received a past email send',
    fields: [
      { key: 'messageLogIds', kind: 'campaigns', label: 'Send' },
      { key: 'outcome', kind: 'select', label: 'Outcome', options: [
        { value: 'any', label: 'Any' },
        { value: 'delivered', label: 'Went through' },
        { value: 'failed', label: 'Failed or bounced' },
      ] },
    ],
    defaults: { outcome: 'any' },
  },
  emailedWithin: {
    group: 'Engagement',
    label: 'Emailed from here recently',
    fields: [{ key: 'days', kind: 'int', label: 'In the last N days' }],
    defaults: { days: 14 },
  },
};

export const RULE_GROUPS = ['Where they came from', 'Application history', 'Academic', 'Engagement'];

export const makeRule = (type, params = {}, negate = false) => ({
  id: newId(),
  kind: 'rule',
  type,
  params: { ...(RULES[type]?.defaults || {}), ...params },
  negate,
});

export const makeGroup = (op = 'AND', children = [], negate = false) => ({
  id: newId(),
  kind: 'group',
  op,
  negate,
  children,
});

export const emptyTree = () => ({ version: 2, root: makeGroup('AND', []) });

/** Give every node an id, so a tree loaded from the server can be edited. */
export function withIds(tree) {
  const walk = (node) =>
    node.kind === 'group'
      ? { ...node, id: newId(), children: (node.children || []).map(walk) }
      : { ...node, id: newId(), params: { ...(node.params || {}) } };
  return { version: 2, root: walk(tree?.root || makeGroup()) };
}

/** Drop editor-only fields. The server validates and cleans the rest. */
export function toServerTree(tree) {
  const walk = (node) =>
    node.kind === 'group'
      ? { kind: 'group', op: node.op, negate: Boolean(node.negate), children: node.children.map(walk) }
      : { kind: 'rule', type: node.type, params: node.params, negate: Boolean(node.negate) };
  return { version: 2, root: walk(tree.root) };
}

export function countRules(node) {
  if (!node) return 0;
  return node.kind === 'rule' ? 1 : node.children.reduce((n, c) => n + countRules(c), 0);
}

/**
 * The class that graduates at the end of the current academic year. After
 * June, that is next calendar year's.
 */
export function currentGradYear(now = new Date()) {
  return now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
}

const STAFF = () => makeRule('account', { roles: ['MEMBER', 'ADMIN'] }, true);

/**
 * Starting points for the sends that come up every cycle. Each is an ordinary
 * tree, so it can be edited after loading and saved under its own name.
 */
export function presets({ activeCycleIds = [] } = {}) {
  const gy = currentGradYear();
  const notThisCycle = activeCycleIds.length
    ? [makeRule('applied', { scope: 'cycles', cycleIds: activeCycleIds }, true)]
    : [];
  return [
    {
      key: 'kickoff',
      label: 'Recruiting kickoff',
      description: `Past applicants who weren't accepted, the mailing list, and accounts that never applied. Not graduating before ${gy + 1}; members excluded.`,
      build: () => makeGroup('AND', [
        makeGroup('OR', [
          makeRule('applied', { scope: 'previous', statuses: ['SUBMITTED', 'UNDER_REVIEW', 'REJECTED', 'WAITLISTED'] }),
          makeRule('mailingList'),
          makeGroup('AND', [makeRule('account', { roles: ['USER'] }), makeRule('applied', { scope: 'any' }, true)]),
        ]),
        makeRule('gradYear', { min: gy + 1 }),
        STAFF(),
      ]),
    },
    {
      key: 'reapply',
      label: 'Re-apply nudge',
      description: 'Rejected before the first round in a past cycle, still eligible, and not in this cycle yet.',
      build: () => makeGroup('AND', [
        makeRule('applied', { scope: 'previous', statuses: ['REJECTED'] }),
        makeRule('reachedRound', { round: '3' }, true),
        makeRule('gradYear', { min: gy + 1 }),
        ...notThisCycle,
        STAFF(),
      ]),
    },
    {
      key: 'no-application',
      label: 'Accounts with no application this cycle',
      description: 'Student accounts that have not applied in the active cycle - for deadline reminders.',
      build: () => makeGroup('AND', [
        makeRule('account', { roles: ['USER'] }),
        ...(notThisCycle.length ? notThisCycle : [makeRule('applied', { scope: 'any' }, true)]),
      ]),
    },
    {
      key: 'event-followup',
      label: 'Came to an event, has not applied',
      description: 'Attended at least one event and has no application in the active cycle.',
      build: () => makeGroup('AND', [
        makeRule('eventAttended', { minCount: 1 }),
        ...(notThisCycle.length ? notThisCycle : [makeRule('applied', { scope: 'any' }, true)]),
        STAFF(),
      ]),
    },
    {
      key: 'tpn',
      label: 'Talent Partner Network opt-ins',
      description: 'Anyone who opted in to sharing their resume with partner companies.',
      build: () => makeGroup('AND', [makeRule('talentPoolOptIn'), STAFF()]),
    },
    {
      key: 'seniors',
      label: `Graduating members (${gy})`,
      description: 'Members and admins in the class graduating this academic year.',
      build: () => makeGroup('AND', [
        makeRule('account', { roles: ['MEMBER', 'ADMIN'] }),
        makeRule('gradYear', { years: [gy] }),
      ]),
    },
  ];
}

// Drafts and schedules saved before the builder used the flat applicant and
// mailing-list filters. Opening one turns it into the equivalent tree.
const LEGACY_ROUND = { COFFEE_CHAT: '2', ROUND_ONE: '3', FINAL_ROUND: '4' };

export function legacyToTree(audience, filters = {}) {
  if (audience === 'mailing-list') return { version: 2, root: makeGroup('AND', [makeRule('mailingList')]) };
  if (audience !== 'applicants') return null;

  const children = [
    makeRule('applied', {
      scope: filters.cycleIds?.length ? 'cycles' : 'any',
      cycleIds: filters.cycleIds || [],
      statuses: filters.applicationStatus ? [filters.applicationStatus] : [],
    }),
  ];
  const round = LEGACY_ROUND[filters.interviewRound];
  if (round && filters.decision) {
    children.push(makeRule('decision', { round, decisions: [String(filters.decision).toLowerCase()], cycleIds: filters.cycleIds || [] }));
  }
  if (filters.eventRsvpId) children.push(makeRule('eventRsvp', { eventIds: [filters.eventRsvpId] }));
  if (filters.eventAttendedId) children.push(makeRule('eventAttended', { eventIds: [filters.eventAttendedId], minCount: 1 }));
  return { version: 2, root: makeGroup('AND', children) };
}

export const SOURCE_LABELS = {
  account: 'ATS account',
  applicant: 'applied',
  'mailing-list': 'mailing list',
  meeting: 'coffee chat',
  luma: 'Luma',
};
