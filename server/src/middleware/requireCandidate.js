// Gate for the candidate portal.
//
// Role alone is not enough: USER covers two different people. An applicant
// tracking an application has a Candidate row and reaches the portal; a
// self-registered UCLA student in the talent portal has no Candidate row and
// lives at /talent. Both are role USER, and isExternalTalent is what separates
// them - the same flag ProtectedRoute branches on client-side.
//
// Without this check an external talent account falls through to whatever
// candidate lookup follows and 404s, which reads as a broken account rather than
// as "wrong door".
//
// Extracted from routes/candidateOnboarding.js so every candidate router agrees
// on who is allowed through.

export const requireCandidate = (req, res, next) => {
  if (req.user?.role !== 'USER' || req.user?.isExternalTalent === true) {
    return res.status(403).json({ error: 'Candidate access required' });
  }
  next();
};

export default requireCandidate;
