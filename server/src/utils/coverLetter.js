// The cover letter slot on an application is filled one of two ways: an uploaded
// file (`coverLetterUrl`, through Winter 2026) or a short written answer
// (`shortAnswer`, Fall 2026 onward). Both are graded as a CoverLetterScore with
// the same rubric, so anything asking "is there a cover letter to grade" must
// accept either.
export function hasCoverLetter(application) {
  return Boolean(application?.coverLetterUrl || application?.shortAnswer?.trim());
}
