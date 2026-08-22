// The only events candidates actually get credit/points for attending. Everything else in the
// Events table (interview rounds, delibs, application deadlines) is internal pipeline scheduling,
// not a candidate-facing event, so it shouldn't show up in "did they attend our events" filters.
const POINT_EVENT_NAME_PATTERNS = ['case workshop', "women's night", 'info session'];

export function isPointEligibleEvent(eventName) {
  const name = (eventName || '').toLowerCase();
  return POINT_EVENT_NAME_PATTERNS.some((pattern) => name.includes(pattern));
}
