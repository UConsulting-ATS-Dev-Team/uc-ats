import { describe, it, expect, vi } from 'vitest';
import { fetchActiveCycle, slotsInCycleDates, slotsCreatedForCycle } from './activeCycle';

// What GET /api/active-cycle actually answers.
const response = {
  cycle: { id: 'cycle-2', name: 'Fall 2026', startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-10-15T00:00:00.000Z' }
};
const clientReturning = (body) => ({ get: vi.fn().mockResolvedValue(body) });

// One slot from last cycle, one opened just before this cycle, one during it.
const lastCycle = { id: 'old', createdAt: '2026-01-05T00:00:00.000Z', startTime: '2026-01-12T22:00:00.000Z' };
const openedEarly = { id: 'early', createdAt: '2026-08-20T00:00:00.000Z', startTime: '2026-09-03T20:00:00.000Z' };
const thisCycle = { id: 'new', createdAt: '2026-09-10T00:00:00.000Z', startTime: '2026-09-20T20:00:00.000Z' };
const slots = [lastCycle, openedEarly, thisCycle];
const ids = (list) => list.map((s) => s.id);

describe('fetchActiveCycle', () => {
  it('unwraps the cycle from the response', async () => {
    const client = clientReturning(response);
    await expect(fetchActiveCycle(client)).resolves.toEqual(response.cycle);
    expect(client.get).toHaveBeenCalledWith('/active-cycle');
  });

  it('returns null when no cycle is open', async () => {
    await expect(fetchActiveCycle(clientReturning({ cycle: null }))).resolves.toBeNull();
    await expect(fetchActiveCycle(clientReturning(null))).resolves.toBeNull();
  });
});

// The regression: pages read the response as the bare cycle, so these filters
// saw no dates and returned every slot or none. Run the real response through.
describe('scoping slots to the fetched cycle', () => {
  it('drops last cycle from the admin and member view', async () => {
    const cycle = await fetchActiveCycle(clientReturning(response));
    expect(ids(slotsCreatedForCycle(slots, cycle))).toEqual(['early', 'new']);
  });

  it('shows candidates only slots inside the cycle dates', async () => {
    const cycle = await fetchActiveCycle(clientReturning(response));
    expect(ids(slotsInCycleDates(slots, cycle))).toEqual(['early', 'new']);
  });
});

describe('slotsInCycleDates', () => {
  it('shows nothing without a cycle or without dates', () => {
    expect(slotsInCycleDates(slots, null)).toEqual([]);
    expect(slotsInCycleDates(slots, { id: 'c' })).toEqual([]);
  });

  it('honours an open-ended range', () => {
    expect(ids(slotsInCycleDates(slots, { startDate: '2026-09-10T00:00:00.000Z' }))).toEqual(['new']);
    expect(ids(slotsInCycleDates(slots, { endDate: '2026-02-01T00:00:00.000Z' }))).toEqual(['old']);
  });
});

describe('slotsCreatedForCycle', () => {
  it('returns every slot when the cycle cannot be scoped', () => {
    expect(slotsCreatedForCycle(slots, null)).toBe(slots);
    expect(slotsCreatedForCycle(slots, { id: 'c' })).toBe(slots);
  });

  it('keeps slots created in the month before the cycle starts', () => {
    const cycle = { startDate: '2026-09-15T12:00:00.000Z' };
    expect(ids(slotsCreatedForCycle(slots, cycle))).toEqual(['early', 'new']);
  });
});
