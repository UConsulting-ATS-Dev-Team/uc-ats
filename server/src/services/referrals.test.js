import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every function here takes its client explicitly; the default import only has
// to exist for the module to load.
vi.mock('../prismaClient.js', () => ({
  default: { referral: {}, candidate: {} }
}));

import {
  referralNameKey,
  referredDisplayName,
  claimReferralsForCandidate,
  createMemberReferral,
  attachReferralToCandidate,
  candidateIdsMatchingName
} from './referrals.js';

const makeClient = () => ({
  referral: {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    update: vi.fn(),
    create: vi.fn()
  },
  candidate: {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null)
  }
});

describe('referralNameKey', () => {
  it('is stable across the things people actually vary', () => {
    const canonical = referralNameKey('Maria', 'Rodriguez');
    expect(referralNameKey('  maria ', 'RODRIGUEZ')).toBe(canonical);
    expect(referralNameKey('María', 'Rodríguez')).toBe(canonical);
  });

  it('ignores punctuation and spacing inside a name', () => {
    expect(referralNameKey("O'Brien", 'Smith-Jones')).toBe(referralNameKey('OBrien', 'Smith Jones'));
    expect(referralNameKey('Ann Marie', 'Lee')).toBe(referralNameKey('Annmarie', 'Lee'));
  });

  it('keeps names in non-Latin scripts, which would otherwise normalize to nothing', () => {
    // Stripping to a-z would make all of these empty, and a person whose name
    // normalizes to nothing cannot be referred at all - the service throws and
    // the route answers 500.
    for (const [first, last] of [
      ['Юрий', 'Гагарин'],
      ['美玲', '陳'],
      ['محمد', 'علي']
    ]) {
      const key = referralNameKey(first, last);
      expect(key).not.toBeNull();
      expect(key.split('|').every((part) => part.length > 0)).toBe(true);
      expect(referralNameKey(first, last)).toBe(key); // stable
    }
  });

  it('still tells two non-Latin names apart', () => {
    expect(referralNameKey('美玲', '陳')).not.toBe(referralNameKey('志明', '陳'));
    expect(referralNameKey('Юрий', 'Гагарин')).not.toBe(referralNameKey('Борис', 'Гагарин'));
  });

  it('folds accents, including combining marks in non-Latin scripts', () => {
    // NFKD decomposes Cyrillic й into и plus a breve, which the accent strip
    // then removes. That merges й and и, the same tradeoff that makes José and
    // Jose the same person. It is deterministic, and both writes and lookups
    // derive the key the same way, so the two can never disagree.
    expect(referralNameKey('Юрий', 'Гагарин')).toBe(referralNameKey('Юрии', 'Гагарин'));
  });

  it('keeps different people apart', () => {
    expect(referralNameKey('Alex', 'Chen')).not.toBe(referralNameKey('Alexa', 'Chen'));
    expect(referralNameKey('Alex', 'Chen')).not.toBe(referralNameKey('Chen', 'Alex'));
  });

  it('refuses a half name rather than guessing', () => {
    expect(referralNameKey('Alex', '')).toBeNull();
    expect(referralNameKey('', 'Chen')).toBeNull();
    expect(referralNameKey(null, undefined)).toBeNull();
    expect(referralNameKey('...', 'Chen')).toBeNull();
  });
});

describe('referredDisplayName', () => {
  it('prefers the real candidate once one is attached', () => {
    expect(
      referredDisplayName({
        referredFirstName: 'Mike',
        referredLastName: 'Scott',
        candidate: { firstName: 'Michael', lastName: 'Scott' }
      })
    ).toBe('Michael Scott');
  });

  it('falls back to the submitted name while pending', () => {
    expect(referredDisplayName({ referredFirstName: 'Mike', referredLastName: 'Scott' })).toBe('Mike Scott');
  });

  it('never renders an empty label', () => {
    expect(referredDisplayName({})).toBe('Unknown');
    expect(referredDisplayName(null)).toBe('Unknown');
  });
});

describe('candidateIdsMatchingName', () => {
  it('compares on the normalized key, not the raw columns', async () => {
    const client = makeClient();
    client.candidate.findMany.mockResolvedValue([
      { id: 'c1', firstName: "María", lastName: "O'Brien" },
      { id: 'c2', firstName: 'Mario', lastName: 'Obrien' }
    ]);

    // A database-side equals on the raw names would miss c1 entirely.
    expect(await candidateIdsMatchingName({ nameKey: 'maria|obrien', cycleId: 'cycle-1', client })).toEqual(['c1']);
  });

  it('is scoped to candidates who applied in the cycle', async () => {
    const client = makeClient();
    await candidateIdsMatchingName({ nameKey: 'a|b', cycleId: 'cycle-1', client });
    expect(client.candidate.findMany.mock.calls[0][0].where).toEqual({
      applications: { some: { cycleId: 'cycle-1' } }
    });
  });

  it('returns nothing for a key it cannot build', async () => {
    const client = makeClient();
    expect(await candidateIdsMatchingName({ nameKey: null, cycleId: 'cycle-1', client })).toEqual([]);
    expect(client.candidate.findMany).not.toHaveBeenCalled();
  });
});

describe('claimReferralsForCandidate', () => {
  let client;
  const candidate = { id: 'cand-1', firstName: 'María', lastName: "O'Brien" };

  beforeEach(() => {
    client = makeClient();
    client.candidate.findMany.mockResolvedValue([{ id: 'cand-1', firstName: 'María', lastName: "O'Brien" }]);
  });

  it('claims every pending referral that matches the name', async () => {
    client.referral.findMany.mockResolvedValue([{ id: 'ref-1' }, { id: 'ref-2' }]);

    const claimed = await claimReferralsForCandidate({ candidate, cycleId: 'cycle-1', client });

    expect(claimed).toEqual(['ref-1', 'ref-2']);
    expect(client.referral.findMany).toHaveBeenCalledWith({
      where: {
        candidateId: null,
        referredNameKey: referralNameKey('maria', 'obrien'),
        OR: [{ cycleId: 'cycle-1' }, { cycleId: null }]
      },
      select: { id: true }
    });
    const update = client.referral.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({ id: { in: ['ref-1', 'ref-2'] } });
    expect(update.data.candidateId).toBe('cand-1');
    expect(update.data.claimedAt).toBeInstanceOf(Date);
  });

  it('claims nothing when another applicant in the cycle shares the name', async () => {
    // Two people called María O'Brien. A name is all a pre-application referral
    // has, so guessing would silently endorse the wrong one.
    client.candidate.findMany.mockResolvedValue([
      { id: 'cand-1', firstName: 'María', lastName: "O'Brien" },
      { id: 'cand-2', firstName: 'Maria', lastName: 'OBrien' }
    ]);
    client.referral.findMany.mockResolvedValue([{ id: 'ref-1' }]);

    const claimed = await claimReferralsForCandidate({ candidate, cycleId: 'cycle-1', client });

    expect(claimed).toEqual([]);
    expect(client.referral.updateMany).not.toHaveBeenCalled();
  });

  it('does not reach for a referral from another cycle', async () => {
    await claimReferralsForCandidate({ candidate, cycleId: 'cycle-2', client });
    const { where } = client.referral.findMany.mock.calls[0][0];
    expect(where.OR).toEqual([{ cycleId: 'cycle-2' }, { cycleId: null }]);
  });

  it('writes nothing when there is nothing to claim', async () => {
    const claimed = await claimReferralsForCandidate({ candidate, cycleId: 'cycle-1', client });
    expect(claimed).toEqual([]);
    expect(client.referral.updateMany).not.toHaveBeenCalled();
  });

  it('does not query on a candidate it cannot name', async () => {
    const claimed = await claimReferralsForCandidate({
      candidate: { id: 'cand-2', firstName: 'Cher', lastName: '' },
      cycleId: 'cycle-1',
      client
    });

    expect(claimed).toEqual([]);
    expect(client.referral.findMany).not.toHaveBeenCalled();
  });
});

describe('createMemberReferral', () => {
  let client;
  const typedName = {
    referrerName: 'Jim Halpert',
    relationship: 'Classmate',
    referredFirstName: 'Karen',
    referredLastName: 'Filippelli',
    cycleId: 'cycle-1',
    referredByUserId: 'user-1'
  };

  beforeEach(() => {
    client = makeClient();
    client.referral.create.mockImplementation(({ data }) => ({ id: 'ref-new', ...data }));
  });

  describe('the member picked someone out of the list', () => {
    beforeEach(() => {
      client.candidate.findUnique.mockResolvedValue({
        id: 'cand-7',
        firstName: 'Karen',
        lastName: 'Filippelli',
        recordsLockedAt: null
      });
    });

    it('attaches on the spot, with no name matching at all', async () => {
      const { referral } = await createMemberReferral({ ...typedName, candidateId: 'cand-7' }, client);

      expect(referral.candidateId).toBe('cand-7');
      expect(referral.claimedAt).toBeInstanceOf(Date);
      // Picking a person settles it; there is nothing to search for.
      expect(client.candidate.findMany).not.toHaveBeenCalled();
    });

    it('stores the candidate\'s own name, not whatever was typed', async () => {
      const { referral } = await createMemberReferral(
        { ...typedName, referredFirstName: 'kare', referredLastName: 'filipeli', candidateId: 'cand-7' },
        client
      );

      expect(referral.referredFirstName).toBe('Karen');
      expect(referral.referredLastName).toBe('Filippelli');
    });

    it('reports a candidate that has since been deleted', async () => {
      client.candidate.findUnique.mockResolvedValue(null);
      const { notFound } = await createMemberReferral({ ...typedName, candidateId: 'gone' }, client);
      expect(notFound).toBe(true);
      expect(client.referral.create).not.toHaveBeenCalled();
    });

    it('refuses a sealed record, who is already a member', async () => {
      client.candidate.findUnique.mockResolvedValue({
        id: 'cand-8',
        firstName: 'Michael',
        lastName: 'Scott',
        recordsLockedAt: new Date()
      });

      const { sealed } = await createMemberReferral({ ...typedName, candidateId: 'cand-8' }, client);
      expect(sealed).toBe(true);
      expect(client.referral.create).not.toHaveBeenCalled();
    });
  });

  describe('the member chose "Other" and typed a name', () => {
    it('stores the normalized key so sync can find it later', async () => {
      const { referral, duplicate } = await createMemberReferral(typedName, client);

      expect(duplicate).toBe(false);
      expect(referral.referredNameKey).toBe(referralNameKey('Karen', 'Filippelli'));
      expect(referral.source).toBe('PRE_APPLICATION');
      expect(referral.candidateId).toBeNull();
      expect(referral.claimedAt).toBeNull();
    });

    it('does not attach even when a name happens to match somebody', async () => {
      // The member just said this person was not in the list. A match here is
      // either someone they scrolled past or a different person with the same
      // name, and attaching would be picking one at random.
      client.candidate.findMany.mockResolvedValue([
        { id: 'cand-9', firstName: 'Karen', lastName: 'Filippelli' }
      ]);

      const { referral } = await createMemberReferral(typedName, client);

      expect(referral.candidateId).toBeNull();
      expect(referral.claimedAt).toBeNull();
    });

    it('rejects a referral it could never match on', async () => {
      await expect(
        createMemberReferral({ ...typedName, referredLastName: '  ' }, client)
      ).rejects.toThrow(/first and a last name/);
    });
  });

  describe('duplicates', () => {
    it('refuses the same member referring the same person twice', async () => {
      client.referral.findFirst.mockResolvedValue({ id: 'ref-existing' });

      const { duplicate, referral } = await createMemberReferral(typedName, client);

      expect(duplicate).toBe(true);
      expect(referral).toBeNull();
      expect(client.referral.create).not.toHaveBeenCalled();
    });

    it('scopes the check to this member, so two members can both refer someone', async () => {
      await createMemberReferral(typedName, client);

      expect(client.referral.findFirst).toHaveBeenCalledWith({
        where: {
          referredNameKey: referralNameKey('Karen', 'Filippelli'),
          cycleId: 'cycle-1',
          referredByUserId: 'user-1'
        },
        select: { id: true }
      });
    });

    it('treats a lost race with the unique index as the duplicate it is', async () => {
      // Two concurrent submissions can both clear findFirst; the index is what
      // actually holds, and a caller should not see a 500 for it.
      client.referral.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

      const { duplicate, referral } = await createMemberReferral(typedName, client);

      expect(duplicate).toBe(true);
      expect(referral).toBeNull();
    });

    it('does not swallow an unrelated database error', async () => {
      client.referral.create.mockRejectedValue(Object.assign(new Error('boom'), { code: 'P1001' }));
      await expect(createMemberReferral(typedName, client)).rejects.toThrow('boom');
    });
  });
});

describe('attachReferralToCandidate', () => {
  let client;

  beforeEach(() => {
    client = makeClient();
    client.referral.findUnique.mockResolvedValue({ id: 'ref-1', candidateId: null });
    client.candidate.findUnique.mockResolvedValue({ id: 'cand-1', recordsLockedAt: null });
    client.referral.update.mockImplementation(({ data }) => ({ id: 'ref-1', ...data }));
  });

  it('attaches the referral an admin resolved by hand', async () => {
    const { referral } = await attachReferralToCandidate({
      referralId: 'ref-1',
      candidateId: 'cand-1',
      client
    });

    expect(referral.candidateId).toBe('cand-1');
    expect(referral.claimedAt).toBeInstanceOf(Date);
  });

  it('reports a missing referral and a missing candidate separately', async () => {
    client.referral.findUnique.mockResolvedValue(null);
    expect((await attachReferralToCandidate({ referralId: 'x', candidateId: 'cand-1', client })).notFound).toBe(
      'referral'
    );

    client.referral.findUnique.mockResolvedValue({ id: 'ref-1', candidateId: null });
    client.candidate.findUnique.mockResolvedValue(null);
    expect((await attachReferralToCandidate({ referralId: 'ref-1', candidateId: 'x', client })).notFound).toBe(
      'candidate'
    );
  });

  it('refuses to attach to a sealed record', async () => {
    client.candidate.findUnique.mockResolvedValue({ id: 'cand-1', recordsLockedAt: new Date() });

    const { sealed } = await attachReferralToCandidate({
      referralId: 'ref-1',
      candidateId: 'cand-1',
      client
    });

    expect(sealed).toBe(true);
    expect(client.referral.update).not.toHaveBeenCalled();
  });
});
