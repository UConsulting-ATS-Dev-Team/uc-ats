// The recruiting cycle open to candidates, and the two ways GTKUC pages scope
// meeting slots to it.
//
// GET /api/active-cycle answers { cycle: { id, name, startDate, endDate } | null }.
// Pages used to read that response as the bare cycle, found no startDate, and
// showed either every slot ever created or none at all. Read it here.

export const fetchActiveCycle = async (client) => {
  const response = await client.get('/active-cycle');
  return response?.cycle || null;
};

// Slots whose start time falls inside the cycle's date range. What candidates
// may book, so no cycle or no dates means nothing is shown.
export const slotsInCycleDates = (slots, cycle) => {
  if (!cycle || (!cycle.startDate && !cycle.endDate)) return [];
  const startDate = cycle.startDate ? new Date(cycle.startDate) : null;
  const endDate = cycle.endDate ? new Date(cycle.endDate) : null;
  return slots.filter((slot) => {
    const slotDate = new Date(slot.startTime);
    if (startDate && slotDate < startDate) return false;
    if (endDate && slotDate > endDate) return false;
    return true;
  });
};

// Slots created from one month before the cycle started. Members open slots
// ahead of the cycle, so this keeps those and drops earlier cycles'. A cycle
// with no start date cannot be scoped and returns every slot.
export const slotsCreatedForCycle = (slots, cycle) => {
  if (!cycle?.startDate) return slots;
  const cutoff = new Date(cycle.startDate);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setMonth(cutoff.getMonth() - 1);
  return slots.filter((slot) => new Date(slot.createdAt) >= cutoff);
};
