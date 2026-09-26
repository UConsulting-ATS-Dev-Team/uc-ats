// The logic of an audience: which trees are accepted, and how AND, OR and NOT
// combine what each rule matched. What a rule matches is audiencePeople's job
// and is stubbed here.
import { describe, it, expect, vi } from 'vitest';
import { evaluateAudienceTree, normalizeAudienceTree } from './audienceFilters.js';

const rule = (type, params = {}, negate = false) => ({ kind: 'rule', type, params, negate });
const group = (op, children, negate = false) => ({ kind: 'group', op, children, negate });
const tree = (root) => ({ version: 2, root });

describe('normalizeAudienceTree', () => {
  it('refuses an audience with no rules, because an empty AND is everyone', () => {
    expect(() => normalizeAudienceTree(tree(group('AND', [])))).toThrow(/at least one filter/);
  });

  it('drops groups left empty rather than refusing the audience', () => {
    const out = normalizeAudienceTree(tree(group('AND', [rule('mailingList'), group('OR', [])])));
    expect(out.root.children).toHaveLength(1);
  });

  it('refuses an audience made only of negations', () => {
    expect(() => normalizeAudienceTree(tree(group('AND', [rule('account', { roles: ['MEMBER'] }, true)]))))
      .toThrow(/not negated/);
  });

  it('accepts a negated group of negations, which is a plain OR', () => {
    expect(() => normalizeAudienceTree(tree(group('AND', [rule('transfer', {}, true), rule('firstGen', {}, true)], true))))
      .not.toThrow();
  });

  it('refuses a rule it does not know, with a 400', () => {
    try {
      normalizeAudienceTree(tree(rule('everyone')));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/Unknown audience filter: everyone/);
    }
  });

  it('cleans parameters: dedupes lists, fills defaults, coerces numbers', () => {
    const out = normalizeAudienceTree(tree(group('AND', [
      rule('gradYear', { min: '2027' }),
      rule('eventAttended', { eventIds: ['e1', 'e1'] }),
    ])));
    expect(out.root.children[0].params).toEqual({ years: [], min: 2027, max: undefined });
    expect(out.root.children[1].params).toEqual({ eventIds: ['e1'], minCount: 1 });
  });

  it('names the rule when a parameter is wrong', () => {
    expect(() => normalizeAudienceTree(tree(rule('applied', { scope: 'cycles', cycleIds: [] }))))
      .toThrow(/Applied: choose at least one cycle/);
    expect(() => normalizeAudienceTree(tree(rule('gradYear', { min: 2030, max: 2026 }))))
      .toThrow(/earliest year is after the latest/);
    expect(() => normalizeAudienceTree(tree(rule('decision', { round: '1', decisions: ['perhaps'] }))))
      .toThrow(/"perhaps" is not a valid decision/);
  });

  it('refuses a version it does not understand', () => {
    expect(() => normalizeAudienceTree({ version: 3, root: rule('mailingList') })).toThrow(/version/);
  });
});

describe('evaluateAudienceTree', () => {
  const universe = new Set(['a', 'b', 'c', 'd']);
  const matches = { mailingList: ['a', 'b'], transfer: ['b', 'c'], firstGen: ['c'] };
  const matchRule = vi.fn(async (r) => new Set(matches[r.type]));
  const run = (root) => evaluateAudienceTree(normalizeAudienceTree(tree(root)), { universe, matchRule });

  it('intersects AND', async () => {
    expect(await run(group('AND', [rule('mailingList'), rule('transfer')]))).toEqual(new Set(['b']));
  });

  it('unions OR', async () => {
    expect(await run(group('OR', [rule('mailingList'), rule('firstGen')]))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('takes NOT against everyone known', async () => {
    expect(await run(group('AND', [rule('mailingList'), rule('transfer', {}, true)]))).toEqual(new Set(['a']));
  });

  it('nests', async () => {
    // mailing list AND NOT (transfer OR first-gen)
    const result = await run(group('AND', [
      rule('mailingList'),
      group('OR', [rule('transfer'), rule('firstGen')], true),
    ]));
    expect(result).toEqual(new Set(['a']));
  });

  it('asks for each distinct rule once', async () => {
    matchRule.mockClear();
    await run(group('OR', [rule('mailingList'), group('AND', [rule('mailingList'), rule('transfer')])]));
    expect(matchRule).toHaveBeenCalledTimes(2);
  });

  it('never returns someone outside the universe', async () => {
    const result = await evaluateAudienceTree(normalizeAudienceTree(tree(rule('mailingList'))), {
      universe: new Set(['a']),
      matchRule: async () => new Set(['a', 'ghost']),
    });
    expect(result).toEqual(new Set(['a']));
  });
});
