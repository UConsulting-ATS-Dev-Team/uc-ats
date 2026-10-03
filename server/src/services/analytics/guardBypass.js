// Which user types may ever get a successful answer from each part of the API.
//
// requestMetrics.js checks every 2xx against this table. A success the table
// says is impossible means a route answered someone its gate should have
// turned away: a missing requireAdmin, a router mounted without its gate, a
// role check that stopped working. That is the one signal here worth waking
// somebody up for, so a row only goes in when the router applies its gate to
// every route it serves. A false CRITICAL teaches people to ignore the tab.
//
// Add a row when you mount a new role-gated router in index.js, and a case in
// guardBypass.test.js next to it.

const STAFF = ['ADMIN', 'MEMBER'];

export const GUARD_TABLE = Object.freeze([
  // guardFor takes the first match, so a sub-prefix of /api/admin goes above it.
  // index.js mounts routes/emailHealth.js behind requireAuth, requireAdmin.
  { prefix: '/api/admin/email-health', allowed: ['ADMIN'], severity: 'CRITICAL' },
  // routes/admin.js L137 router.use(requireAuth, requireAdmin); every other
  // /api/admin mount in index.js is itself behind requireAdmin.
  { prefix: '/api/admin', allowed: ['ADMIN'], severity: 'CRITICAL' },
  // routes/client.js L46 router.use(requireAuth, requireClient)
  { prefix: '/api/client', allowed: ['CLIENT'], severity: 'CRITICAL' },
  // routes/talent.js L79 router.use(requireAuth, requireExternalTalent)
  { prefix: '/api/talent', allowed: ['TALENT'], severity: 'CRITICAL' },
  // routes/candidateOnboarding.js L88 router.use(requireAuth, requireCandidate)
  { prefix: '/api/candidate/onboarding', allowed: ['CANDIDATE'], severity: 'CRITICAL' },
  // routes/candidateInterviewSignups.js L41 router.use(requireAuth, requireCandidate)
  { prefix: '/api/my-interview-signups', allowed: ['CANDIDATE'], severity: 'CRITICAL' },
  // routes/execAccess.js L25 router.use(requireAuth, requireAdminOrMember)
  { prefix: '/api/exec-access', allowed: STAFF, severity: 'CRITICAL' },
  // routes/liveVotes.js L27 router.use(requireAuth, requireAdminOrMember)
  { prefix: '/api/live-votes', allowed: STAFF, severity: 'CRITICAL' },
  // routes/reviewDelibs.js L27 router.use(requireAuth, requireAdminOrMember)
  { prefix: '/api/review-delibs', allowed: STAFF, severity: 'CRITICAL' },
  // routes/decisionGuides.js L13 router.use(requireAuth, requireAdminOrMember)
  { prefix: '/api/decision-guides', allowed: STAFF, severity: 'CRITICAL' },
  // routes/documentRubrics.js L12 router.use(requireAuth, requireAdminOrMember)
  { prefix: '/api/document-rubrics', allowed: STAFF, severity: 'CRITICAL' },
  // routes/reviewTeams.js L29 router.use(requireAuth, requireAdminOrMember)
  { prefix: '/api/review-teams', allowed: STAFF, severity: 'CRITICAL' },
  // routes/conversations.js: requireAdminOrMember on every route
  { prefix: '/api/conversations', allowed: STAFF, severity: 'CRITICAL' },
  // routes/masterCommunications.js: requireAdmin on every route
  { prefix: '/api/master-communications', allowed: ['ADMIN'], severity: 'CRITICAL' },

  // Mixed gates: some routes are open to any signed-in user, so only an
  // anonymous success is out of place here. routes/member.js serves candidates
  // on bare requireAuth; cases.js, files.js and users.js are requireAuth only.
  { prefix: '/api/member', allowed: ['ADMIN', 'MEMBER', 'CANDIDATE', 'TALENT', 'CLIENT'], severity: 'WARN' },
  { prefix: '/api/cases', allowed: ['ADMIN', 'MEMBER', 'CANDIDATE', 'TALENT', 'CLIENT'], severity: 'WARN' },
  { prefix: '/api/files', allowed: ['ADMIN', 'MEMBER', 'CANDIDATE', 'TALENT', 'CLIENT'], severity: 'WARN' },
  { prefix: '/api/users', allowed: ['ADMIN', 'MEMBER', 'CANDIDATE', 'TALENT', 'CLIENT'], severity: 'WARN' },
]);

// Deliberately absent: /api/auth, /api/applications (a public route sits above
// its gate), /api/uploads, /api/webhooks, /api/unsubscribe,
// /api/integrations/luma (bearer token, no user), /api/health, /api/analytics,
// /api/interview-resources (public reads) and the /api catch-all routers.

const matches = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

export function guardFor(path) {
  if (typeof path !== 'string') return null;
  return GUARD_TABLE.find((row) => matches(path, row.prefix)) || null;
}

/** A prefix only staff may use (every CRITICAL row whose allowed list is staff-only). */
export function isStaffOnlyPath(path) {
  const row = guardFor(path);
  return Boolean(row && row.severity === 'CRITICAL' && row.allowed.every((r) => STAFF.includes(r)));
}

/**
 * null when nothing is wrong, else { severity, detail } for a success the
 * table says this role should never get.
 */
export function evaluateGuardBypass({ method, path, status, role }) {
  if (method === 'OPTIONS' || method === 'HEAD') return null;
  if (!(status >= 200 && status < 300)) return null;
  const row = guardFor(path);
  if (!row || row.allowed.includes(role)) return null;
  return {
    severity: row.severity,
    detail: { prefix: row.prefix, allowed: row.allowed, reason: `${role} got ${status} from a ${row.prefix} route` },
  };
}
