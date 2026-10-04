// The row lock that keeps a talent account's mode and its talent-portal
// resumes in step. The resume upload takes it before storing a resume, and
// Google sign-in takes it before turning a talent account into an applicant's,
// so neither can act on the other half-done.

/**
 * Lock this user's row until `tx` ends and return its account mode, or null
 * when there is no such user. Must run inside an interactive transaction.
 */
export const lockTalentAccount = async (tx, userId) => {
  const [row] = await tx.$queryRaw`
    SELECT "isExternalTalent", "studentId", "isActive" FROM users WHERE id = ${userId} FOR UPDATE`;
  return row || null;
};
