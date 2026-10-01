// A Document Grading row as the server will report it once `userId`'s grade for
// `documentType` ('resume' | 'coverLetter' | 'video') is saved. The pages show
// this straight after a save and refetch behind it, rather than blanking the
// table until the whole list comes back.
//
// `teamWide` matches what the list's has*Score flag means: the admin's
// all-applications view reports whether the whole team has graded, every
// member-queue view whether this grader has.
export function withOwnGrade(application, documentType, userId, { teamWide = false } = {}) {
  const evaluatorsKey = `${documentType}CompletedEvaluators`;
  const missingKey = `${documentType}MissingGrades`;
  const totalKey = `${documentType}TotalMembers`;
  const flagKey = `has${documentType[0].toUpperCase()}${documentType.slice(1)}Score`;

  // With no team the server reports no evaluators and nothing missing, and a
  // team-wide flag can never be set.
  if (!application[totalKey]) {
    return { ...application, [flagKey]: !teamWide };
  }

  const before = application[evaluatorsKey] || [];
  const completed = before.includes(userId) ? before : [...before, userId];
  const team = application.groupMembers || [];

  return {
    ...application,
    [evaluatorsKey]: completed,
    [missingKey]: application[totalKey] - completed.length,
    [flagKey]: teamWide
      ? team.length > 0 && team.every(member => completed.includes(member.id))
      : true
  };
}
