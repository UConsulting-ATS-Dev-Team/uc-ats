// The builder's tree helpers. The server validates every tree it receives, so
// what matters here is that the editor sends the shape the server expects and
// that old drafts open as the audience they used to mean.
import { describe, it, expect } from 'vitest';
import {
  RULES,
  countRules,
  currentGradYear,
  legacyToTree,
  makeGroup,
  makeRule,
  presets,
  toServerTree,
  withIds,
} from './audienceRules';

describe('toServerTree', () => {
  it('strips editor ids and keeps the logic', () => {
    const tree = { version: 2, root: makeGroup('OR', [makeRule('mailingList'), makeRule('transfer', {}, true)]) };
    expect(toServerTree(tree)).toEqual({
      version: 2,
      root: {
        kind: 'group',
        op: 'OR',
        negate: false,
        children: [
          { kind: 'rule', type: 'mailingList', params: {}, negate: false },
          { kind: 'rule', type: 'transfer', params: {}, negate: true },
        ],
      },
    });
  });

  it('round-trips through withIds', () => {
    const server = toServerTree({ version: 2, root: makeGroup('AND', [makeRule('gradYear', { min: 2028 })]) });
    expect(toServerTree(withIds(server))).toEqual(server);
  });
});

describe('legacyToTree', () => {
  it('turns the old applicant filters into the same audience', () => {
    const tree = legacyToTree('applicants', {
      cycleIds: ['fall'],
      applicationStatus: 'REJECTED',
      interviewRound: 'ROUND_ONE',
      decision: 'no',
      eventAttendedId: 'e1',
    });
    const rules = toServerTree(tree).root.children;
    expect(rules.map((r) => r.type)).toEqual(['applied', 'decision', 'eventAttended']);
    expect(rules[0].params).toMatchObject({ scope: 'cycles', cycleIds: ['fall'], statuses: ['REJECTED'] });
    expect(rules[1].params).toMatchObject({ round: '3', decisions: ['no'] });
  });

  it('turns the old mailing-list audience into its rule', () => {
    expect(toServerTree(legacyToTree('mailing-list')).root.children).toEqual([
      { kind: 'rule', type: 'mailingList', params: {}, negate: false },
    ]);
  });

  it('leaves staff audiences alone', () => {
    expect(legacyToTree('members', { roles: ['MEMBER'] })).toBeNull();
  });
});

describe('presets', () => {
  it('only use rules the builder knows', () => {
    const types = new Set();
    const walk = (n) => (n.kind === 'rule' ? types.add(n.type) : n.children.forEach(walk));
    for (const p of presets({ activeCycleIds: ['fall'] })) walk(p.build());
    for (const t of types) expect(RULES[t]).toBeDefined();
  });

  it('keep members out of recruiting sends', () => {
    const kickoff = presets().find((p) => p.key === 'kickoff').build();
    expect(kickoff.children.at(-1)).toMatchObject({ type: 'account', negate: true, params: { roles: ['MEMBER', 'ADMIN'] } });
    expect(countRules(kickoff)).toBe(6);
  });
});

describe('currentGradYear', () => {
  it('rolls over after June', () => {
    expect(currentGradYear(new Date('2026-05-15'))).toBe(2026);
    expect(currentGradYear(new Date('2026-09-23'))).toBe(2027);
  });
});
