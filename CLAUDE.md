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
- `/api/member` - Member role operations (interview assignments, document grading)
- `/api/applications` - Application CRUD and review
- `/api/review-teams` - Review team management and scoring
- `/api/files` - File upload/download via Google Drive
- `/api/interview-resources` - Interview prep materials
- `/api` (public) - Public endpoints (event RSVPs, meeting signups)

**Key Services:**
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
- Three roles: `USER` (candidate), `MEMBER` (interviewer/reviewer), `ADMIN`
- User cache with 5-minute TTL to reduce DB queries
- Use `requireAuth` middleware for protected routes, `requireAdmin` for admin-only

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
- `UserRole`: USER, ADMIN, MEMBER
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
- `DATABASE_URL` - PostgreSQL connection string (Supabase)
- `DIRECT_URL` - Direct database URL (bypasses connection pooler for migrations)
- `GOOGLE_CLOUD_KEY_PATH` - Path to Google Cloud service account JSON
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
- **Test Uploads:** `GET /api/test-uploads` - Checks file upload directory
- **Prisma Studio:** `npx prisma studio` - GUI for database inspection
- **Form Sync Logs:** Check server console for "Fetching new responses..." messages
- **Google Drive Permissions:** Files must be shared with service account email from `google-cloud-key.json`

## Git Workflow Notes

Modified files in current session:
- [server/src/utils/eventDataMapper.js](server/src/utils/eventDataMapper.js) - Event response mapping logic

Active branch: `main`


---

## Development Principles


0. **Create Worktrees and PRs** Create a gitworktree per session. In that worktree, modify Claude.MD to adapt to the specific task that the worktree is dedicated to. Once all work is done, submit a PR request resolving to the issue number given to you. 
1. **Ask before assuming.** If a requirement is ambiguous, ask a specific question before writing any code. Do NOT guess or pick a default silently.
2. **No assumptions.** If a UI behavior, field mapping, or flow step is unclear, stop and ask.
3. **No extra features.** Build exactly what is described. No added error handling, animations, helper abstractions, or UX improvements unless explicitly requested.
4. **No comments** unless the WHY is non-obvious.
5. **Never delete Limit records** — only update status.
6. **Config over hardcoding.** Backend URL and all external keys go in `Config.swift`.
7. **Test flows before declaring done.** Trace the full happy path before reporting complete.
8. **Keep this file current.** When you add a screen, change a model, or shift architecture, update the relevant section (Implementation Status, Next Steps, file structure, design system, business rules) in the same change. Use judgement — concise updates only, don't let it overinflate.
9. **Never write Django migrations by hand.** When a model changes, edit `models.py` and prompt the user to run `python manage.py makemigrations` (and then `migrate`). Do not author files under `Backend/stalemate/api/migrations/`.
10. **Don't run `xcodebuild` from the CLI** to verify a feature is "done". Xcode and CLI builds share the same DerivedData / `build.db` and will deadlock with `database is locked` whenever the user has Xcode open. Trust the in-editor build the user runs themselves; if a compile check is genuinely needed, use the linter / type-check tools, or ask the user to build and paste errors. Only acceptable exception: a one-off pre-flight build right after major scaffolding (e.g. adding a new target) where the user explicitly is not in Xcode.

# MUST FOLLOWS

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
