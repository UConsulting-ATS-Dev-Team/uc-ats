// Whether the signed-in candidate still owes us an applicant profile.
//
// Cached per user for the life of the tab. The gate in App.jsx blocks rendering
// on this answer, so without a cache every candidate navigation would show a
// spinner while re-asking a question whose answer changes exactly once - when
// they submit the form.
//
// It lives in its own module rather than inside App.jsx because the onboarding
// page has to be able to clear it on submit, and importing App from a page it
// imports would be a cycle. That clear is not optional: the page navigates to
// the dashboard, and a cache still reading "required" would bounce them
// straight back into the form they just completed.
let cache = { userId: null, required: null };

export const readOnboardingRequired = (userId) =>
  userId && cache.userId === userId ? cache.required : null;

export const cacheOnboardingRequired = (userId, required) => {
  cache = { userId, required };
};

export const clearOnboardingCache = () => {
  cache = { userId: null, required: null };
};

/**
 * Record that onboarding is done, without discarding who it is done for.
 *
 * Deliberately not `clearOnboardingCache`. Clearing sets the answer back to
 * "unknown", and the gate treats unknown as "still deciding" - so the redirect
 * that fires on the way to the dashboard would send the candidate back into the
 * form they just submitted. This says the answer is now no.
 */
export const markOnboardingComplete = () => {
  if (cache.userId) cache = { ...cache, required: false };
};
