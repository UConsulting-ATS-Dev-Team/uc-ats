// The cover letter slot on an application is filled one of two ways: an uploaded
// file (`coverLetterUrl`, through Winter 2026) or a short written answer
// (`shortAnswer`, Fall 2026 onward). Both are graded as the `coverLetter`
// document type with the same rubric, so "is there one to grade" accepts either.
// Mirrors server/src/utils/coverLetter.js.
export function hasCoverLetter(application) {
  return Boolean(application?.coverLetterUrl || application?.shortAnswer?.trim());
}

// What to call this application's submission. An uploaded file is still a cover
// letter; everything else, including generic labels, is the short answer.
export function coverLetterLabel(application) {
  return application?.coverLetterUrl ? 'Cover Letter' : 'Short Answer';
}
