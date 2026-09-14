import { describe, it, expect, vi } from 'vitest';
import {
  canonicalGroupIdFor,
  expandGroupIdsForQuestions,
  getRosterForInterview,
  interviewsAssignedTo,
  parseLegacyConfig,
  resolveGroupIds,
} from './interviewRoster.js';

/**
 * A client returning fixed slot rows plus one interview.
 *
 * Hand-rolled rather than a Prisma mock: what these tests care about is which
 * source an id resolves against, and that is decided by the service, not by the
 * query. The filters are applied here so a wrong `where` still shows up.
 */
const fakeClient = ({ slots = [], description = null } = {}) => ({
  interviewSlot: {
    findMany: vi.fn(({ where }) => {
      const wanted = new Set([
        ...(where.OR?.[0]?.id?.in ?? []),
        ...(where.OR?.[1]?.legacyGroupId?.in ?? []),
      ]);
      return Promise.resolve(
        slots.filter((slot) => wanted.has(slot.id) || wanted.has(slot.legacyGroupId))
      );
    }),
    findFirst: vi.fn(({ where }) => {
      const ids = [where.OR?.[0]?.id, where.OR?.[1]?.legacyGroupId].filter(Boolean);
      return Promise.resolve(
        slots.find((slot) => ids.includes(slot.id) || ids.includes(slot.legacyGroupId)) ?? null
      );
    }),
  },
  interview: {
    findUnique: vi.fn(() => Promise.resolve({ id: 'iv1', description, slots })),
  },
});

const slot = (over = {}) => ({
  id: 'slot-1',
  label: 'Morning Block',
  notes: '',
  legacyGroupId: null,
  startTime: new Date('2026-10-06T16:00:00Z'),
  endTime: new Date('2026-10-06T18:00:00Z'),
  candidateCapacity: 40,
  signups: [],
  assignments: [],
  ...over,
});

describe('parseLegacyConfig', () => {
  it('reads a stringified config', () => {
    expect(parseLegacyConfig({ description: '{"applicationGroups":[]}' })).toEqual({ applicationGroups: [] });
  });

  it('treats a plain description as no config rather than throwing', () => {
    // Interview.description doubles as a literal description on older rows, so
    // "Meet in Covel at 3" must resolve to {} and not blow up a live interview.
    expect(parseLegacyConfig({ description: 'Meet in Covel at 3' })).toEqual({});
    expect(parseLegacyConfig({ description: '[1,2,3]' })).toEqual({});
    expect(parseLegacyConfig({ description: null })).toEqual({});
    expect(parseLegacyConfig(null)).toEqual({});
  });
});

describe('resolveGroupIds', () => {
  it('resolves a slot id to its confirmed signups', async () => {
    const client = fakeClient({
      slots: [slot({ signups: [{ applicationId: 'app1' }, { applicationId: 'app2' }] })],
    });
    await expect(resolveGroupIds('iv1', 'slot-1', client)).resolves.toEqual(['app1', 'app2']);
  });

  it('resolves the legacy group id a slot was backfilled from', async () => {
    // The bookmarked-URL case: an admin opened a live interview before the
    // migration and the tab is still open afterwards.
    const client = fakeClient({
      slots: [slot({ legacyGroupId: 'old-group-1', signups: [{ applicationId: 'app1' }] })],
    });
    await expect(resolveGroupIds('iv1', 'old-group-1', client)).resolves.toEqual(['app1']);
  });

  it('falls back to the JSON blob for groups no slot claims', async () => {
    const client = fakeClient({
      description: JSON.stringify({
        applicationGroups: [{ id: 'blob-group', applicationIds: ['app9'] }],
      }),
    });
    await expect(resolveGroupIds('iv1', 'blob-group', client)).resolves.toEqual(['app9']);
  });

  it('handles a mixture of slot ids and blob-only ids', async () => {
    // A half-migrated interview, which is what a real cycle looks like mid-cutover.
    const client = fakeClient({
      slots: [slot({ id: 'slot-1', signups: [{ applicationId: 'app1' }] })],
      description: JSON.stringify({
        applicationGroups: [{ id: 'blob-group', applicationIds: ['app9'] }],
      }),
    });
    const ids = await resolveGroupIds('iv1', 'slot-1,blob-group', client);
    expect(ids.sort()).toEqual(['app1', 'app9']);
  });

  it('never returns the same application twice', async () => {
    const client = fakeClient({
      slots: [
        slot({ id: 'slot-1', signups: [{ applicationId: 'app1' }] }),
        slot({ id: 'slot-2', signups: [{ applicationId: 'app1' }] }),
      ],
    });
    await expect(resolveGroupIds('iv1', 'slot-1,slot-2', client)).resolves.toEqual(['app1']);
  });

  it('accepts an array, a string, and tolerates whitespace and blanks', async () => {
    const client = fakeClient({ slots: [slot({ signups: [{ applicationId: 'app1' }] })] });
    await expect(resolveGroupIds('iv1', ['slot-1'], client)).resolves.toEqual(['app1']);
    await expect(resolveGroupIds('iv1', ' slot-1 , ', client)).resolves.toEqual(['app1']);
    await expect(resolveGroupIds('iv1', '', client)).resolves.toEqual([]);
  });
});

describe('expandGroupIdsForQuestions', () => {
  it('reads under both the slot id and the id it was backfilled from', async () => {
    // Questions written before the migration are keyed on the old id and ones
    // written after on the slot id. Reading one key would make half of a
    // group's questions disappear, and groupId has no foreign key to complain.
    const client = fakeClient({ slots: [slot({ id: 'slot-1', legacyGroupId: 'old-group-1' })] });
    const expanded = await expandGroupIdsForQuestions('iv1', 'slot-1', client);
    expect(expanded.sort()).toEqual(['old-group-1', 'slot-1']);
  });

  it('leaves an unknown id alone so blob-only groups still resolve', async () => {
    const client = fakeClient({ slots: [] });
    await expect(expandGroupIdsForQuestions('iv1', 'blob-group', client)).resolves.toEqual(['blob-group']);
  });
});

describe('canonicalGroupIdFor', () => {
  it('keeps writing under the legacy id so a group\'s questions stay together', async () => {
    const client = fakeClient({ slots: [slot({ id: 'slot-1', legacyGroupId: 'old-group-1' })] });
    await expect(canonicalGroupIdFor('iv1', 'slot-1', client)).resolves.toBe('old-group-1');
  });

  it('uses its own id for a slot that was never backfilled', async () => {
    const client = fakeClient({ slots: [slot({ id: 'slot-1', legacyGroupId: null })] });
    await expect(canonicalGroupIdFor('iv1', 'slot-1', client)).resolves.toBe('slot-1');
  });

  it('passes an unknown id straight through', async () => {
    const client = fakeClient({ slots: [] });
    await expect(canonicalGroupIdFor('iv1', 'blob-group', client)).resolves.toBe('blob-group');
  });
});

describe('getRosterForInterview', () => {
  it('answers in the legacy shape when the interview has slots', async () => {
    // Returning the blob's own shape is what lets the source of truth flip
    // server-side with no client change - the whole point of this seam.
    const client = fakeClient({
      slots: [
        slot({
          id: 'slot-1',
          label: 'Morning Block',
          signups: [{ applicationId: 'app1' }, { applicationId: 'app2' }],
          assignments: [{ userId: 'user1', role: 'INTERVIEWER' }],
        }),
      ],
    });

    const roster = await getRosterForInterview('iv1', client);
    expect(roster.source).toBe('slots');
    expect(roster.applicationGroups).toEqual([
      expect.objectContaining({ id: 'slot-1', name: 'Morning Block', applicationIds: ['app1', 'app2'] }),
    ]);
    expect(roster.memberGroups[0].memberIds).toEqual(['user1']);
    // Co-membership in a slot IS the assignment, so this mapping is derived
    // rather than maintained by hand.
    expect(roster.groupAssignments).toEqual({ 'members-slot-1': ['slot-1'] });
  });

  it('exposes a backfilled slot under its legacy id', async () => {
    const client = fakeClient({
      slots: [slot({ id: 'slot-1', legacyGroupId: 'old-group-1', signups: [{ applicationId: 'app1' }] })],
    });
    const roster = await getRosterForInterview('iv1', client);
    expect(roster.applicationGroups[0].id).toBe('old-group-1');
    expect(roster.applicationGroups[0].slotId).toBe('slot-1');
  });

  it('reads the blob untouched for an interview with no slots', async () => {
    // Final round, deliberations and every past cycle live here. Slots replace
    // groups only for interviews that have slots.
    const client = fakeClient({
      slots: [],
      description: JSON.stringify({
        memberGroups: [{ id: 'mg1', memberIds: ['u1'] }],
        applicationGroups: [{ id: 'ag1', applicationIds: ['app1'] }],
        groupAssignments: { mg1: ['ag1'] },
      }),
    });
    const roster = await getRosterForInterview('iv1', client);
    expect(roster.source).toBe('legacy');
    expect(roster.applicationGroups).toEqual([{ id: 'ag1', applicationIds: ['app1'] }]);
    expect(roster.groupAssignments).toEqual({ mg1: ['ag1'] });
  });

  it('omits a member group for a slot nobody is staffing', async () => {
    const client = fakeClient({ slots: [slot({ assignments: [] })] });
    const roster = await getRosterForInterview('iv1', client);
    expect(roster.memberGroups).toEqual([]);
    expect(roster.groupAssignments).toEqual({});
  });
});

describe('interviewsAssignedTo', () => {
  const client = (over = {}) => ({
    interviewSlotAssignment: { findMany: vi.fn().mockResolvedValue(over.slots ?? []) },
    interviewAssignment: { findMany: vi.fn().mockResolvedValue(over.legacy ?? []) },
  });
  const iv = (id, description = null) => ({ id, description });

  it('keeps an interview the member is on a session for', async () => {
    const c = client({ slots: [{ interviewId: 'iv1' }] });
    const kept = await interviewsAssignedTo('u1', [iv('iv1'), iv('iv2')], c);
    expect(kept.map((i) => i.id)).toEqual(['iv1']);
  });

  it('keeps one from the older assignment table', async () => {
    // Past cycles were arranged before slots existed; hiding those would take
    // an interview off a member who genuinely ran it.
    const c = client({ legacy: [{ interviewId: 'iv2' }] });
    const kept = await interviewsAssignedTo('u1', [iv('iv1'), iv('iv2')], c);
    expect(kept.map((i) => i.id)).toEqual(['iv2']);
  });

  it('keeps one where the member is in a group in the old JSON config', async () => {
    const blob = JSON.stringify({ memberGroups: [{ id: 'mg1', memberIds: ['u1', 'u9'] }] });
    const kept = await interviewsAssignedTo('u1', [iv('iv1', blob), iv('iv2')], client());
    expect(kept.map((i) => i.id)).toEqual(['iv1']);
  });

  it('drops everything the member is on no part of', async () => {
    const blob = JSON.stringify({ memberGroups: [{ id: 'mg1', memberIds: ['someone-else'] }] });
    const kept = await interviewsAssignedTo('u1', [iv('iv1', blob), iv('iv2')], client());
    expect(kept).toEqual([]);
  });

  it('ignores an assignment that was removed', async () => {
    // The query filters removedAt, so a dropped session returns nothing here.
    const c = client({ slots: [] });
    expect(await interviewsAssignedTo('u1', [iv('iv1')], c)).toEqual([]);
    expect(c.interviewSlotAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ removedAt: null }) })
    );
  });

  it('handles an interview with nothing to parse', async () => {
    const kept = await interviewsAssignedTo('u1', [iv('iv1', 'Meet in Covel')], client());
    expect(kept).toEqual([]);
  });
});

describe('getRosterForInterview — rotation groups', () => {
  const withSignups = (signups, over = {}) =>
    fakeClient({ slots: [slot({ id: 'morning', label: 'Morning Session', signups, ...over })] });

  it('offers each rotation group, not the whole session', async () => {
    // An interviewer at a table sees two pairs, not forty people. Offering
    // "Morning Session, 8 applications" gives them no way to pick their table.
    const client = withSignups([
      { applicationId: 'a1', groupLabel: '1A' },
      { applicationId: 'a2', groupLabel: '1A' },
      { applicationId: 'a3', groupLabel: '1B' },
      { applicationId: 'a4', groupLabel: '1B' },
    ]);
    const roster = await getRosterForInterview('iv1', client);

    expect(roster.applicationGroups.map((g) => g.name)).toEqual([
      'Morning Session · 1A',
      'Morning Session · 1B',
    ]);
    expect(roster.applicationGroups[0].applicationIds).toEqual(['a1', 'a2']);
    // The id the picker sends back, which resolveGroupIds understands.
    expect(roster.applicationGroups[0].id).toBe('morning:1A');
  });

  it('orders groups the way a person counts them', async () => {
    const client = withSignups([
      { applicationId: 'a1', groupLabel: '10A' },
      { applicationId: 'a2', groupLabel: '2A' },
      { applicationId: 'a3', groupLabel: '1A' },
    ]);
    const roster = await getRosterForInterview('iv1', client);
    expect(roster.applicationGroups.map((g) => g.groupLabel)).toEqual(['1A', '2A', '10A']);
  });

  it('keeps the session as one group when nobody is in a rotation group', async () => {
    // First round: the session already is the group of four.
    const client = withSignups([{ applicationId: 'a1', groupLabel: null }, { applicationId: 'a2', groupLabel: null }]);
    const roster = await getRosterForInterview('iv1', client);
    expect(roster.applicationGroups).toHaveLength(1);
    expect(roster.applicationGroups[0].name).toBe('Morning Session');
    expect(roster.applicationGroups[0].id).toBe('morning');
  });

  it('still reaches somebody who has not been put in a group yet', async () => {
    // Otherwise a late booking becomes uninterviewable until an admin notices.
    const client = withSignups([
      { applicationId: 'a1', groupLabel: '1A' },
      { applicationId: 'late', groupLabel: null },
    ]);
    const roster = await getRosterForInterview('iv1', client);
    const leftover = roster.applicationGroups.find((g) => g.name.includes('not in a group'));
    expect(leftover.applicationIds).toEqual(['late']);
  });

  it('lets an interviewer on the session reach every group in it', async () => {
    // The groups rotate to them, so being on the session means all of them.
    const client = withSignups(
      [
        { applicationId: 'a1', groupLabel: '1A' },
        { applicationId: 'a2', groupLabel: '1B' },
      ],
      { assignments: [{ userId: 'u1', role: 'INTERVIEWER' }] }
    );
    const roster = await getRosterForInterview('iv1', client);
    expect(roster.groupAssignments['members-morning']).toEqual(['morning:1A', 'morning:1B']);
  });
});
