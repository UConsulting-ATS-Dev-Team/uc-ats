# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

UConsulting Application Tracking System (ATS) - A full-stack recruitment management platform for UConsulting's candidate evaluation process. The system manages the entire recruitment lifecycle from application submission through multiple interview rounds.

**Tech Stack:**
- Frontend: React 19 + Vite, Material-UI, React Router
- Backend: Node.js + Express, Prisma ORM, PostgreSQL (Supabase)
- External Integrations: Google Forms API, Google Drive API, email notifications

## Development Commands

### Initial Setup
```bash
# Install all dependencies (root, client, and server)
npm run install:all

# Set up environment variables
cp server/.env.example server/.env
# Edit server/.env with your credentials

# Run database migrations
cd server && npx prisma migrate deploy
```

### Running the Application
```bash
# Run both client and server concurrently (from root)
npm run dev

# Or run separately:
npm run dev:client   # Frontend on http://localhost:5173
npm run dev:server   # Backend on http://localhost:3001

# Individual directories:
cd client && npm run dev    # Vite dev server
cd server && npm run dev    # Nodemon with hot reload
cd server && npm start      # Production mode
```

### Build
```bash
# Build client for production
npm run build
# Or: cd client && npm run build
```

### Database Management
```bash
cd server

# Generate Prisma client after schema changes
npx prisma generate

# Create a new migration
npx prisma migrate dev --name <migration_name>

# Apply migrations
npx prisma migrate deploy

# Open Prisma Studio (database GUI)
npx prisma studio
```

#### Applying a migration (while `DIRECT_URL` is broken)

`prisma migrate dev` and `migrate deploy` both authenticate with `DIRECT_URL`, whose
password is stale (see Environment Variables). Until that is repaired, apply migrations
by hand with the *session pooler* — same host and credentials as `DATABASE_URL`, but on
port **5432** instead of 6543. Port 6543 is pgbouncer in transaction mode and the Prisma
CLI cannot use it at all; it fails with a misleading "can't reach database server".

```bash
cd server

# 1. Build the session-pooler URL: DATABASE_URL with port 5432 instead of 6543.
SESSION_URL=$(node -e '
  const u = new URL(require("fs").readFileSync(".env","utf8").match(/^DATABASE_URL=(.*)$/m)[1].trim());
  u.port = "5432"; process.stdout.write(u.toString());
')

# 2. Apply the SQL.
npx prisma db execute --url "$SESSION_URL" --file ./prisma/migrations/<name>/migration.sql

# 3. Record it so a future `migrate deploy` does not replay it.
DIRECT_URL="$SESSION_URL" npx prisma migrate resolve --applied <name>
```

Write the `migration.sql` by hand and make it re-runnable (`IF NOT EXISTS`,
`ON CONFLICT DO NOTHING`, `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`) — step 2 has
no transaction wrapper of its own, so a half-applied file has to be safe to re-run.

#### After switching branches

`prisma generate` writes the client into `node_modules/`, which git does not track and
nodemon does not watch. Checking out a branch whose `schema.prisma` differs therefore
leaves a **stale generated client**, and queries fail against columns that exist only in
the other branch's schema:

```
The column `recruiting_cycles.createdById` does not exist in the current database.  (P2022)
```

The fix is both steps, in order — regenerating alone does nothing to a server that is
already running, because the old client is already loaded in memory:

```bash
cd server && npx prisma generate   # rewrite the client from this branch's schema
touch src/index.js                 # force nodemon to restart and load it
```

### Utility Scripts
```bash
cd server

# Make a user an admin
node scripts/make-admin.js

# Backfill candidate data
npm run backfill-candidates

# Verify candidate data integrity
npm run verify-candidates

# Update schema relations
npm run update-schema-relations
npm run setup-candidate-relations
```

## Architecture

### Application Flow & Data Model

The system follows a **recruiting cycle-based workflow**:

1. **Recruiting Cycle** → Contains applications, events, interviews, and review teams
2. **Application Submission** → Google Forms responses are auto-synced every 5 minutes via cron job
3. **Candidate Creation** → Applications automatically create or link to Candidate records by `studentId` or `email`
4. **Document Review** → Review teams (Groups) evaluate resumes, cover letters, and videos with scoring rubrics
5. **Interview Rounds** → Coffee Chat → Round 1 → Round 2 → Final Round with evaluations
6. **Event Management** → Track RSVPs and attendance for recruitment events

**Key Data Relationships:**
- `Application` → belongs to `Candidate` and `RecruitingCycle`
- `Candidate` → can have multiple `Applications` across different cycles
- `Groups` (review teams) → assigned to evaluate candidates via `ResumeScore`, `CoverLetterScore`, `VideoScore`
- `Interview` → has `InterviewAssignment` (interviewers), `InterviewEvaluation` (candidate feedback), and `InterviewActionItem` (prep tasks)
- `Events` → track `EventRsvp` and `EventAttendance` separately

### Backend Architecture

**Entry Point:** [server/src/index.js](server/src/index.js)
- Initializes Express app, registers routes, starts cron jobs
- Auto-syncs Google Forms responses on startup and every 5 minutes

**Route Organization:**
- `/api/auth` - Authentication (login, signup, password reset)
- `/api/admin` - Admin-only operations (cycle mgmt, interviews, user mgmt, document grading)
- `/api/member` - Member role operations (interview assignments, document grading, referrals)
- `/api/talent` - External talent portal: a self-registered UCLA student's own profile,
  resume and Talent Partner Network consent. Gated on `role === 'USER' &&
  isExternalTalent`; the upload and consent routes additionally require
  `User.emailVerifiedAt`.
- `/api/applications` - Application CRUD and review
- `/api/review-teams` - Review team management and scoring (ADMIN/MEMBER only)
- `/api/files` - File upload/download via Google Drive
- `/api/resume-uploads` - Candidate self-service resume replacement + version history
- `/api/interview-resources` - Interview prep materials
- `/api/exec-access` - Executive-committee unlock for sealed records, manual seal/unseal,
  password rotation and the access log
- `/api/master-communications/decision-batches` - Decision emails queued by Staging's
  Process All Decisions, reviewed and sent by an admin
- `/api/live-votes` - Live vote deliberations and per-round rubrics (ADMIN/MEMBER; running a
  session is admin-only)
- `/api` (public) - Public endpoints (event RSVPs, meeting signups)

**Sealed recruiting records:**
- `Candidate.recordsLockedAt` seals a person's scores, evaluations, comments and
  application. Set automatically when final-round processing makes them a member (they
  may later be promoted onto recruitment), by hand from the application page, or by
  `scripts/backfill-exec-locks.js`.
- Enforced server-side in [server/src/utils/lockedRecords.js](server/src/utils/lockedRecords.js):
  single-record routes answer `423 RECORD_LOCKED`, list routes redact the row to identity
  and mark it `locked: true`. A request carrying a valid `X-Exec-Unlock` token (30 minutes,
  from `POST /api/exec-access/unlock`) sees everything. Any new route that returns scores,
  evaluations, comments or application content must go through these helpers.
- The first executive password is set with `node scripts/set-exec-password.js`.

**Decision processing:**
- The four `POST /api/admin/process-*-decisions` endpoints share
  [server/src/services/decisionProcessing.js](server/src/services/decisionProcessing.js).
  They advance, reject or accept (final round: promote/create the MEMBER account and seal
  the record) and **send no email**. Each run writes a `DecisionBatch` of
  `DecisionMessage`s that an admin reviews and sends in Master Communications → Decisions
  ([server/src/services/decisionBatches.js](server/src/services/decisionBatches.js)).
- Round order lives in [server/src/utils/roundProgression.js](server/src/utils/roundProgression.js).

**iMessage (Master Communications):**
- Members only. An admin picks people by name and writes plain text; Send opens one group
  conversation in their own Messages app through an `sms://open?addresses=…&body=…` link
  ([client/src/utils/imessage.js](client/src/utils/imessage.js)). The server never delivers
  or schedules an iMessage — it lists reachable members (`GET /imessage/members`) and logs
  the send (`POST /imessage/log`).
- Numbers live on `User.phoneNumber` (E.164). Bulk-load them from a roster CSV with
  `node scripts/import-member-phones-from-csv.js <csv>` (dry run; add `--apply` to write),
  or edit one in User Management.

**Live votes:**
- An admin starts a session from any Staging tab. Admins and members join from anywhere in
  the app (`LiveVoteProvider` in [client/src/context/LiveVoteContext.jsx](client/src/context/LiveVoteContext.jsx)
  shows the join popup), vote yes/no one candidate at a time, and any admin who has joined
  closes votes and sets the round decision. Rules live in
  [server/src/services/liveVotes.js](server/src/services/liveVotes.js); what a viewer may see
  lives in [server/src/services/liveVoteState.js](server/src/services/liveVoteState.js).
- Votes are anonymous to everyone: `live_vote_votes` stores an HMAC of (ballot, user) under
  `LIVE_VOTE_SECRET` (falls back to `JWT_SECRET`), never a user id. An open ballot's yes/no
  split is never sent to the client, only how many have voted.
- Every session change bumps `LiveVoteSession.version` under a row lock. Clients poll state
  and compare versions; a Supabase broadcast is only a content-free nudge to refetch, so
  realtime is optional and polling alone works.
- A decision set in a live vote goes through
  [server/src/services/stagingDecisions.js](server/src/services/stagingDecisions.js), the same
  write as Staging's inline decision picker, so it feeds decision processing unchanged.

**Referrals:**
- A `Referral` arrives one of two ways, tracked by `Referral.source`. `MANUAL` is added on
  an application page (`/api/applications/:id/referral`) and has a `candidateId` from the
  start. `PRE_APPLICATION` is submitted by a member at `POST /api/member/referrals`.
- The member-facing form is a typeahead over this cycle's applicants
  (`GET /api/member/referral-candidates?q=`). **Picking a person sets `candidateId`
  outright, so there is no name matching at all** — that is the path to prefer. A member
  who cannot find them picks "Other" and types a name, and only then does the referral wait
  with `candidateId` null.
- For the "Other" path, matching is by **name only**, because a first and last name is all
  a referring member is expected to know. `referralNameKey()` in
  [server/src/services/referrals.js](server/src/services/referrals.js) stores a normalized
  `first|last` key with accents, case, spacing and punctuation stripped, so "O'Brien",
  "OBrien" and "o brien" all match. It uses `\p{L}`/`\p{N}`, not `a-z`, so a name in a
  non-Latin script does not normalize to nothing. Both writes and lookups go through it;
  nothing else should reimplement the normalization.
- Form sync claims pending referrals in
  [server/src/services/syncResponses.js](server/src/services/syncResponses.js), **after**
  `application.create` succeeds — a response that fails to insert must not leave a referral
  claiming someone applied. A claim failure is logged and swallowed; losing an application
  to a referral bug is not acceptable. So a referral attaches within one cron tick (≤5 min)
  of the person applying, not instantly.
- **Nothing is claimed when two applicants in the cycle share a normalized name.** A name
  is all the "Other" path has, so the referral is left pending for an admin rather than
  guessed at. A referral sitting unclaimed is a question someone can answer; one stapled to
  the wrong applicant is a false endorsement nobody notices.
- A referral is only claimed within its own cycle (or if filed without one). If the person
  never applies it stays pending forever, which is the intended end state. Admins work the
  queue at `/admin/referrals` (`GET /api/admin/referrals?status=PENDING`) and attach one by
  hand with `PATCH /api/admin/referrals/:id`.
- One member cannot refer the same person twice in a cycle. The unique index on
  (`referredByUserId`, `cycleId`, `referredNameKey`) is what enforces it; the service's
  lookup races with itself, so it also treats `P2002` as the duplicate it is.
- Both kinds coexist on a candidate. The application page reads `GET /:id/referrals`
  (plural) for the whole list, while the manual add and remove still own exactly one
  `MANUAL` referral per candidate per cycle and never touch a member's submission.

**Key Services:**
- [server/src/services/referrals.js](server/src/services/referrals.js) - Referral name matching and claiming
- [server/src/services/syncResponses.js](server/src/services/syncResponses.js) - Syncs Google Forms → Applications table
- [server/src/services/syncEventResponses.js](server/src/services/syncEventResponses.js) - Syncs event RSVP/attendance forms
- [server/src/services/emailNotifications.js](server/src/services/emailNotifications.js) - Nodemailer integration for notifications
- [server/src/services/google/forms.js](server/src/services/google/forms.js) - Google Forms API wrapper
- [server/src/services/google/drive.js](server/src/services/google/drive.js) - Google Drive file operations

**Data Mappers:**
- [server/src/utils/dataMapper.js](server/src/utils/dataMapper.js) - Maps Google Forms responses to Application schema
- [server/src/utils/eventDataMapper.js](server/src/utils/eventDataMapper.js) - Maps event form responses
- [server/src/utils/timezoneUtils.js](server/src/utils/timezoneUtils.js) - Handles PST/EST timezone conversions

**Authentication:**
- JWT-based auth with [server/src/middleware/auth.js](server/src/middleware/auth.js)
- Three roles: `USER` (candidate), `MEMBER` (interviewer/reviewer), `ADMIN`, plus
  `CLIENT` (Talent Partner Network buyer, contained to `/api/client/*`)
- `USER` covers two different people, distinguished by `User.isExternalTalent`: an
  applicant tracking an application (has a `Candidate` row, created by
  `POST /api/auth/register`) and a self-registered UCLA student in the talent portal
  (no `Candidate` row, created by `POST /api/auth/register-external`). Both the
  server gate and `ProtectedRoute` branch on that flag, not on the role.
- User cache with 5-minute TTL to reduce DB queries
- Use `requireAuth` middleware for protected routes, `requireAdmin` for admin-only

**Sign in with Google:**
- `POST /api/auth/google` takes a Google Identity Services ID token and is resolved by
  [server/src/services/googleAuth.js](server/src/services/googleAuth.js). No redirect leg,
  no code exchange, and therefore no client secret.
- Resolution order is `googleId` (Google's `sub`), then a **case-insensitive** email match,
  then create. An unverified Google email (`email_verified !== true`) is refused outright —
  honouring it would link anyone who can assert an address into the account holding it.
- No match creates a talent-portal account (`role: USER`, `isExternalTalent: true`, no
  `Candidate` row, `password: null`, pre-verified). Deliberately **not** gated on a ucla.edu
  address, unlike `/register-external` — so a `source: 'PORTAL'` resume no longer implies a
  verified UCLA student.
- `User.password` is nullable: null means "signs in with Google", which is what lets `/login`
  say so instead of "invalid password". Any new code reading `password` must handle null.
- Email is stored lowercased everywhere, enforced by a unique index on `lower(email)`. Look
  users up case-insensitively; `/register` and `/register-member` used to store raw case.

### Frontend Architecture

**Entry Point:** [client/src/main.jsx](client/src/main.jsx) → [client/src/App.jsx](client/src/App.jsx)

**Routing Structure:**
- Admin routes wrapped in `<Layout>` (nav sidebar)
- Member routes wrapped in `<Layout>` (limited nav)
- Candidate routes wrapped in `<CandidateLayout>` (candidate-specific nav)
- Public routes (no auth): Login, Signup, ForgotPassword, ResetPassword, CoffeeChatsPublic

**Context:**
- `AuthContext` ([client/src/context/AuthContext.js](client/src/context/AuthContext.js)) - Global user state, role-based access

**Key Pages:**
- **Admin:** Dashboard, CandidateManagement, CycleManagement, EventManagement, UserManagement, ReviewTeams, Staging (interview scheduling), AdminDocumentGrading, AdminAssignedInterviews
- **Member:** MemberDashboard, DocumentGrading, AssignedInterviews, MemberEvents, MemberMeetingSlots
- **Candidate:** CandidateDashboard, CandidateApplications, CandidateEvents, InterviewPreparation

**Grading Modals:**
- [DocumentGradingModal.jsx](client/src/components/DocumentGradingModal.jsx) - Resume/cover letter/video scoring
- [ResumeGradingModal.jsx](client/src/components/ResumeGradingModal.jsx) - Detailed resume rubric
- Interview evaluation forms embedded in interview pages

### Database Schema Notes

**Important Enum Values:**
- `UserRole`: USER, ADMIN, MEMBER, CLIENT
- `ApplicationStatus`: SUBMITTED, UNDER_REVIEW, ACCEPTED, REJECTED, WAITLISTED
- `InterviewType`: COFFEE_CHAT, ROUND_ONE, ROUND_TWO, FINAL_ROUND, DELIBERATIONS
- `InterviewStatus`: DRAFT, UPCOMING, ACTIVE, COMPLETED, CANCELLED
- `InterviewDecision`: YES, MAYBE_YES, UNSURE, MAYBE_NO, NO

**Decimal Precision:**
- GPA fields: `Decimal(3, 2)` (e.g., 3.85)
- Scores: `Decimal(5, 2)` (e.g., 87.50)

**Critical Relations:**
- `Application.candidateId` links to `Candidate` - auto-created/matched on form sync
- `Application.cycleId` links to active `RecruitingCycle`
- `Groups` has three members (`memberOne`, `memberTwo`, `memberThree`) - all optional foreign keys to `User`
- `Interview.cycleId` determines which applications are available for evaluation

## Important Workflows

### Adding a New Google Form Field

When the application form changes:

1. Update [server/src/utils/dataMapper.js](server/src/utils/dataMapper.js) `transformFormResponse()` to extract the new field
2. Add corresponding column to `Application` model in [server/prisma/schema.prisma](server/prisma/schema.prisma)
3. Run `npx prisma migrate dev --name add_new_field`
4. Update frontend application detail/edit forms if needed
5. Test by triggering form sync: restart server or wait for cron

### Creating a New Interview Round

1. Admin creates `Interview` via Staging page or EventManagement
2. Assigns interviewers via `InterviewAssignment` (role: LEAD_INTERVIEWER, INTERVIEWER, OBSERVER)
3. Interviewers access via AssignedInterviews page
4. During interview, create `InterviewEvaluation` (or `FirstRoundInterviewEvaluation` for Round 1) with rubric scores
5. Deliberations: review all evaluations, make final decisions

### Email Notifications

Configured via environment variables `EMAIL_USER` and `EMAIL_PASS` (Gmail app-specific password).

Key notification types in [emailNotifications.js](server/src/services/emailNotifications.js):
- Password reset emails
- Event reminder emails (upcoming events, RSVPs)
- Interview assignment notifications (future)

## Environment Variables

Required in `server/.env`:
- `DATABASE_URL` - PostgreSQL connection string (Supabase). Use the IPv4 session pooler on port 5432 with username `postgres.<project-ref>`; the direct `db.<project-ref>.supabase.co` host is IPv6-only and will fail from IPv4-only environments.
- `DIRECT_URL` - Direct database URL for Prisma migrations/introspection. In this setup it should also be the session pooler on port 5432; never use port 6543 (transaction mode) for migrations.

> **Known drift (verified 2026-08-23):** the `DIRECT_URL` in `server/.env` carries a
> *stale password* — same username as `DATABASE_URL`, different secret. Port 5432 is
> reachable and the host is correct, so Prisma reports it as
> `Please make sure to provide valid database credentials`, not as a network error.
> This is why `prisma migrate dev` / `migrate deploy` fail here while the app itself
> runs fine: the runtime uses `DATABASE_URL` (port 6543), which has the good password.
>
> The real fix is to repair `DIRECT_URL` with the current password. Until someone does,
> see "Applying a migration" below.
- `GOOGLE_CLOUD_KEY_PATH` - Path to Google Cloud service account JSON
- `GOOGLE_OAUTH_CLIENT_ID` - (Optional) OAuth client id for Sign in with Google. A
  *different* credential from `GOOGLE_CLOUD_KEY_PATH`: that is a service account this
  server acts as, this is the browser-facing client a person signs in through. Must
  equal `VITE_GOOGLE_CLIENT_ID` in `client/.env` — the server checks it as the ID
  token's audience. Unset means `POST /api/auth/google` answers 503 and the Google
  button never renders; password sign-in is unaffected.
- `JWT_SECRET` - Secret for JWT signing
- `BASE_URL` - Server URL (http://localhost:3001 in dev)
- `CLIENT_URL` - Frontend URL (http://localhost:5173 in dev)
- `EMAIL_USER`, `EMAIL_PASS` - Gmail credentials for nodemailer
- `SLACK_WEBHOOK_URL` - (Optional) Slack webhook for admin notifications

## Common Patterns

### API Request Pattern (Frontend)
```javascript
const response = await fetch('/api/endpoint', {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(data)
});
```

### Protected Route Pattern (Backend)
```javascript
router.get('/endpoint', requireAuth, requireAdmin, async (req, res) => {
  // req.user contains authenticated user
});
```

### Prisma Query Pattern
```javascript
// Always include relations you need explicitly
const application = await prisma.application.findUnique({
  where: { id },
  include: {
    candidate: true,
    cycle: true,
    comments: { include: { user: true } }
  }
});
```

## Testing & Debugging

- **Health Check:** `GET /api/health` - Verifies DB connection
- **Database Preflight:** `cd server && npm run check-db` - Diagnoses DATABASE_URL connection failures (IPv6 vs pooler, auth, missing project-ref, wrong port)
- **Test Uploads:** `GET /api/test-uploads` - Checks file upload directory
- **Prisma Studio:** `npx prisma studio` - GUI for database inspection
- **Form Sync Logs:** Check server console for "Fetching new responses..." messages
- **Google Drive Permissions:** Files must be shared with service account email from `google-cloud-key.json`

## Git Workflow Notes

Modified files in current session:
- [server/src/utils/eventDataMapper.js](server/src/utils/eventDataMapper.js) - Event response mapping logic

Active branch: `main`
