// The one place a Staging round decision is written, shared by the inline
// picker and the live vote.
import { describe, it, expect, vi } from 'vitest';
import { saveRoundDecision } from './stagingDecisions.js';

vi.mock('../prismaClient.js', () => ({ default: {} }));

const fakeClient = (application = { id: 'app-1' }) => ({
  application: {
    findFirst: vi.fn().mockResolvedValue(application),
    update: vi.fn(async ({ data }) => ({ id: 'app-1', ...data }))
  }
});

const save = (client, overrides) =>
  saveRoundDecision({ client, applicationId: 'app-1', cycleId: 'cycle-1', phase: 'coffee', decision: 'yes', userId: 'u1', ...overrides });

describe('saveRoundDecision', () => {
  it.each([
    ['resume', 'resumeDecision'],
    ['coffee', 'coffeeChatDecision'],
    ['firstRound', 'firstRoundDecision'],
    ['final', 'finalRoundDecision']
  ])('writes %s to %s', async (phase, field) => {
    const client = fakeClient();
    await save(client, { phase, decision: 'maybe_no' });
    expect(client.application.update.mock.calls[0][0].data[field]).toBe('maybe_no');
  });

  it.each([
    ['yes', true],
    ['no', false],
    ['maybe_yes', null],
    ['', null]
  ])('sets approved for %j to %s', async (decision, approved) => {
    const client = fakeClient();
    await save(client, { decision });
    expect(client.application.update.mock.calls[0][0].data.approved).toBe(approved);
  });

  it('leaves the same audit comment the inline picker always has', async () => {
    const client = fakeClient();
    await save(client, { phase: 'final', decision: 'maybe_yes' });
    expect(client.application.update.mock.calls[0][0].data.comments.create).toEqual({
      content: 'Final Round decision: Maybe - Yes (needs final decision)',
      userId: 'u1'
    });
  });

  it('only looks inside the given cycle', async () => {
    const client = fakeClient(null);
    await expect(save(client)).rejects.toMatchObject({ status: 404 });
    expect(client.application.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'app-1', cycleId: 'cycle-1' } }));
    expect(client.application.update).not.toHaveBeenCalled();
  });

  it('rejects unknown rounds and decisions', async () => {
    await expect(save(fakeClient(), { phase: 'lunch' })).rejects.toMatchObject({ status: 400, code: 'INVALID_PHASE' });
    await expect(save(fakeClient(), { decision: 'strong_yes' })).rejects.toMatchObject({ status: 400, code: 'INVALID_DECISION' });
  });
});
