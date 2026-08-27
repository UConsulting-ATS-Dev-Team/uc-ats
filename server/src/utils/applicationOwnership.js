// Who owns an application, and who is staff.
//
// Applications arrive from the Google Form before the applicant has an account,
// so there is no foreign key from Application to User to lean on. Ownership is
// therefore matched on the two identifiers the form collects: student ID and
// email, either directly on the Application row or on the Candidate it was
// linked to during sync.
//
// This lives here rather than in a route because more than one candidate
// self-service endpoint depends on it (resume replacement, applicant info), and
// the whole point is that they agree on the answer.

export function isOwnedBy(application, user) {
  if (!user) return false;

  const emails = [application.email, application.candidate?.email]
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  if (user.email && emails.includes(user.email.toLowerCase())) return true;

  const studentIds = [application.studentId, application.candidate?.studentId]
    .filter(Boolean)
    .map(String);
  if (user.studentId && studentIds.includes(String(user.studentId))) return true;

  return false;
}

export const isStaff = (user) => user?.role === 'ADMIN' || user?.role === 'MEMBER';
