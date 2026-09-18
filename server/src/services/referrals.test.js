import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every function here takes its client explicitly; the default import only has
// to exist for the module to load.
vi.mock('../prismaClient.js', () => ({
  default: { referral: {}, candidate: {} }
}));

import { referralNameKey, referredDisplayName, claimReferralsForCandidate, createPreApplicationReferral } from './referrals.js';

const makeClient = () => ({
  referral: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn()
  },
  candidate: {
    findFirst: vi.fn()
  }
});

describe('referralNameKey', () => {
  it('is stable across the things people actually vary', () => {
    const canonical = referralNameKey('Maria', 'Rodriguez');
    expect(referralNameKey('  maria ', 'RODRIGUEZ')).toBe(canonical);
    expect(referralNameKey('María', 'Rodríguez')).toBe(canonical);
    expect(referralNameKey('Maria', 'Rodriguez ')).toBe(canonical);
  });

  it('ignores punctuation inside a name', () => {
    expect(referralNameKey("O'Brien", 'Smith-Jones')).toBe(referralNameKey('OBrien', 'Smith Jones'));
  });

  it('keeps different people apart', () => {
    expect(referralNameKey('Alex', 'Chen')).not.toBe(referralNameKey('Alexa', 'Chen'));
    expect(referralNameKey('Alex', 'Chen')).not.toBe(referralNameKey('Chen', 'Alex'));
  });

  it('refuses a half name rather than guessing', () => {
    expect(referralNameKey('Alex', '')).toBeNull();
    expect(referralNameKey('', 'Chen')).toBeNull();
    expect(referralNameKey(null, undefined)).toBeNull();
    // Punctuation alone normalizes to nothing, which is not a name.
    expect(referralNameKey('...', 'Chen')).toBeNull();
  });
});

describe('referredDisplayName', () => {
  it('prefers the real candidate once one is attached', () => {
    const referral = {
      referredFirstName: 'Mike',
      referredLastName: 'Scott',
      candidate: { firstName: 'Michael', lastName: 'Scott' }
    };
    expect(referredDisplayName(referral)).toBe('Michael Scott');
  });

  it('falls back to the submitted name while pending', () => {
    expect(referredDisplayName({ referredFirstName: 'Mike', referredLastName: 'Scott' })).toBe('Mike Scott');
  });

  it('never renders an empty label', () => {
    expect(referredDisplayName({})).toBe('Unknown');
    expect(referredDisplayName(null)).toBe('Unknown');
  });
});

describe('claimReferralsForCandidate', () => {
  let client;
  const candidate = { id: 'cand-1', firstName: 'María', lastName: "O'Brien" };

  beforeEach(() => {
    client = makeClient();
  });

  it('claims every pending referral that matches the name', async () => {
    client.referral.findMany.mockResolvedValue([{ id: 'ref-1' }, { id: 'ref-2' }]);
    client.referral.updateMany.mockResolvedValue({ count: 2 });

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
    expect(update.data.cycleId).toBe('cycle-1');
    expect(update.data.claimedAt).toBeInstanceOf(Date);
  });

  it('does not reach for a referral from another cycle', async () => {
    client.referral.findMany.mockResolvedValue([]);
    await claimReferralsForCandidate({ candidate, cycleId: 'cycle-2', client });

    const { where } = client.referral.findMany.mock.calls[0][0];
    expect(where.OR).toEqual([{ cycleId: 'cycle-2' }, { cycleId: null }]);
  });

  it('writes nothing when there is nothing to claim', async () => {
    client.referral.findMany.mockResolvedValue([]);
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

describe('createPreApplicationReferral', () => {
  let client;
  const input = {
    referrerName: 'Jim Halpert',
    relationship: 'Classmate',
    referredFirstName: 'Karen',
    referredLastName: 'Filippelli',
    cycleId: 'cycle-1',
    referredByUserId: 'user-1'
  };

  beforeEach(() => {
    client = makeClient();
    client.referral.findFirst.mockResolvedValue(null);
    client.candidate.findFirst.mockResolvedValue(null);
    client.referral.create.mockImplementation(({ data }) => ({ id: 'ref-new', ...data }));
  });

  it('stores the normalized key so sync can find it later', async () => {
    const { referral, duplicate } = await createPreApplicationReferral(input, client);

    expect(duplicate).toBe(false);
    expect(referral.referredNameKey).toBe(referralNameKey('Karen', 'Filippelli'));
    expect(referral.source).toBe('PRE_APPLICATION');
    expect(referral.candidateId).toBeNull();
    expect(referral.claimedAt).toBeNull();
  });

  it('attaches immediately when the person already exists', async () => {
    client.candidate.findFirst.mockResolvedValue({ id: 'cand-9' });

    const { referral } = await createPreApplicationReferral(input, client);

    expect(referral.candidateId).toBe('cand-9');
    expect(referral.claimedAt).toBeInstanceOf(Date);
  });

  it('refuses the same member referring the same person twice', async () => {
    client.referral.findFirst.mockResolvedValue({ id: 'ref-existing' });

    const { duplicate, referral } = await createPreApplicationReferral(input, client);

    expect(duplicate).toBe(true);
    expect(referral).toBeNull();
    expect(client.referral.create).not.toHaveBeenCalled();
  });

  it('scopes the duplicate check to this member, so two members can both refer someone', async () => {
    await createPreApplicationReferral(input, client);

    expect(client.referral.findFirst).toHaveBeenCalledWith({
      where: {
        referredNameKey: referralNameKey('Karen', 'Filippelli'),
        cycleId: 'cycle-1',
        referredByUserId: 'user-1'
      },
      select: { id: true }
    });
  });

  it('rejects a referral it could never match on', async () => {
    await expect(
      createPreApplicationReferral({ ...input, referredLastName: '  ' }, client)
    ).rejects.toThrow(/first and a last name/);
  });
});
