# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

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
- `/api/resume-uploads` - Candidate self-service resume replacement + version history
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
