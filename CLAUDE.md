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

# One-time mailing-list import (dry run; add --apply to upload to Drive)
npm run import-mailing-list -- <csv>

# Link talent-portal accounts that belong to applicants (dry run; --apply links;
# --link=<userId>:<UID> --apply links one account an admin has identified)
node scripts/link-talent-accounts.js

# Fold a candidate's duplicate applications in a cycle into one
# (dry run; add --apply to merge; --cycle=<id> for a cycle other than the candidate one)
npm run merge-duplicate-applications
```

#### Web copies of application videos

`scripts/transcode-videos.js` (`npm run transcode-videos`) gives each video in a cycle
an H.264/AAC MP4 with its index first, at most 720p and 30 fps, uploaded beside the
original as `<name>.web.mp4`, and repoints `Application.videoUrl` at it. Dry run by
default (`--probe` downloads to decide for real); `--apply` writes; `--revert=<jsonl>`
undoes it. Needs `ffmpeg`/`ffprobe` on PATH. Originals are never deleted. Every run
appends to `scripts/output/video-transcode-<timestamp>.jsonl`, which is what `--revert`
reads; a `repointing` row is written before each database write, so a run killed
mid-write can still be reverted. `--limit=N` counts files that still needed a copy, so
repeating it works through the cycle in batches. A copy left by an interrupted run is
reused only if it was made from the original as it is now (matching `md5Checksum`).
What needs work and the ffmpeg command live in
[server/src/services/videoTranscode.js](server/src/services/videoTranscode.js); the
per-file steps in [videoTranscodeBatch.js](server/src/services/videoTranscodeBatch.js).

#### Mailing-list import

The recruiting-interest mailing list is being retired. Its export is deduped
against the ATS in two places, which share one service and differ only in where
the survivors go:

- **Master Communications → Mailing List** (admin-only). Upload the CSV, read the
  counts, download the survivors. The preview stores nothing: the server holds the
  file for the length of the request and returns the deduped CSV in the response.
  `POST /api/master-communications/mailing-list/dedupe`, 5 MB cap, `.csv` only.
  **Import** (`/mailing-list/import`) is a separate click that stores *every* valid
  address as a `MailingListContact` - survivors and already-known people alike -
  so the audience builder's "On the mailing list" means exactly that. Only rows
  from an earlier import are skipped, which makes re-importing a no-op.
- **`scripts/import-mailing-list-csv.js`**, which uploads to the Marketing Drive
  folder (`MARKETING_DRIVE_FOLDER_ID`, or `--folder=<id>`) instead of downloading.
  Dry run is the default; `--apply` is what uploads.

[server/src/services/mailingListDedup.js](server/src/services/mailingListDedup.js)
owns the operation and, with it, the answer to what counts as already known.
The route and the script each keep only their own presentation. Put changes to
the dedup there, not in either caller.

"Already in the ATS" means `User`, `Candidate`, `Application` or `MeetingSignup`,
compared case-insensitively, with `x@g.ucla.edu` and `x@ucla.edu` counted as the
same person (`emailIdentityKey` in `utils/mailingListImport.js`; both spellings stay
valid and are stored as written). `DecisionMessage.email` is excluded on purpose - it is
a copy of `Application.email` made when a decision is queued, so counting it would
double-count the same person.

The script and the preview are read-only against the database, so both are safe to re-run. Neither
silently discards a row: every dropped row keeps its line number and its reason,
in the console for the script and in the dropped-rows table for the UI, so a run
can be reconciled against the source spreadsheet. A run where nothing survives is
reported rather than treated as success - it is what a wrong email column looks
like, and it is indistinguishable from a list where everyone was already known.

## Architecture

### Application Flow & Data Model

The system follows a **recruiting cycle-based workflow**:

1. **Recruiting Cycle** → Contains applications, events, interviews, and review teams
2. **Application Submission** → Google Forms responses are auto-synced every 5 minutes via cron job
3. **Candidate Creation** → Applications automatically create or link to Candidate records,
   by `studentId` **first** and then `email` (see "Matching an application to a candidate")
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
- `/api/resume-uploads` - Resume replacement by PDF upload + version history. The
  applicant, inside the cycle's resume deadline, or an admin at any time from Edit
  Application (members cannot; a sealed application needs an exec unlock). Files go to
  the private Supabase `resumes` bucket, not Drive
- `/api/application-documents` - Blind resumes and videos uploaded with a manually added
  application: the video upload ticket (admin), signed links and the files themselves
- `/api/interview-resources` - Interview prep materials
- `/api/exec-access` - Executive-committee unlock for sealed records, manual seal/unseal,
  password rotation and the access log
- `/api/exec-access/gm-recaps` - Weekly general meeting recap emails (admin + live
  executive unlock)
- `/api/master-communications/decision-batches` - Decision emails queued by Staging's
  Process All Decisions, reviewed and sent by an admin
- `/api/master-communications/mailing-list/dedupe` - One-time import of the retiring
  recruiting-interest list: upload the CSV, get back what the ATS has never seen
- `/api/master-communications/audiences` - Saved audiences (named filter trees);
  `/audience-options` feeds the builder; `/suppressions` is the unsubscribe list
- `/api/admin/virtual-coffee-chats` - Video-call coffee chats an admin schedules by hand:
  create, edit, cancel, and add or remove applicants and interviewers
- `/api/admin/email-health` - Administration → Email Deliverability: the health report and
  `POST /test`, a real send to check end to end
- `/api/unsubscribe` - Public, token-gated: the footer link's page actions and the
  RFC 8058 one-click `POST /one-click`
- `/api/live-votes` - Live vote deliberations and per-round rubrics (ADMIN/MEMBER; running a
  session is admin-only)
- `/api/review-delibs` - Review team deliberations (admins, plus members of that team; running
  one is admin-only)
- `/api/decision-guides` - What each interview decision means, shown to reviewers
  (ADMIN/MEMBER read, admin-only write)
- `/api/document-rubrics` - The resume / cover letter / video grading rubrics
  (ADMIN/MEMBER read, admin-only write)
- `/api/integrations/luma` - The hourly Luma sync routine's three endpoints. No user
  session ever reaches these; the caller is a scheduled Claude agent holding
  `LUMA_SYNC_TOKEN` as a bearer token
- `/api/admin/luma` - The admin side of that sync: the guests it could not settle, and
  linking one to a candidate or member by hand
- `/api/admin/analytics` - Site Analytics read API and `POST /rollup` (admin only)
- `/api/analytics/events` - Public: browsers post page views, clicks, errors and web vitals
- `/api` (public) - Public endpoints (event RSVPs, meeting signups)

**Opening documents (signed links and ranges):**
- Sign-in is a bearer header, which a new tab or a `<video src>` never sends. Those open a
  document through a 15-minute link from `POST /api/files/:fileId/link` or
  `POST /api/resume-uploads/:uploadId/link`, used as `?access=`
  ([server/src/services/documentLinks.js](server/src/services/documentLinks.js)). A link names
  one document, is signed with a key derived from `JWT_SECRET` (never a sign-in token), and
  the route still runs its own access check. A new route serving a document that opens in a
  tab needs `acceptDocumentLink` before `requireAuth` and its own `/link`.
- `/api` reaches Render through Vercel's rewrite proxy, which cuts long responses off. A
  grading video is therefore never downloaded whole: the preview streams it, and
  `/api/files/:id/pdf` answers `Range` with slices of at most 4 MB
  ([server/src/services/byteRange.js](server/src/services/byteRange.js)).
- A link is reused while it has 3+ minutes left
  ([client/src/utils/documentLinks.js](client/src/utils/documentLinks.js), kept in
  sessionStorage under the sign-in it was issued to), so reopening a video uses the same URL
  and Chrome answers its ranges from cache. Every signed-link open goes through
  `getDocumentLink`; a direct `POST /link` makes a new URL and misses the cache. `/pdf` also
  sends Drive's `md5Checksum` as `ETag` and answers a matching `If-None-Match` with 304
  ([documentValidators.js](server/src/services/documentValidators.js)), so a copy past its
  hour is confirmed rather than sent again.
- Headshots are drawn as avatars from a small copy: `/api/files/:id/image?size=256` (or
  `640`) is a WebP whose short edge is that size, rendered on first request and kept in
  memory ([server/src/services/headshotThumbnails.js](server/src/services/headshotThumbnails.js));
  no `size` is the original. The client picks the size with `headshotSrc(url, cssPx)`
  ([client/src/utils/headshotUrl.js](client/src/utils/headshotUrl.js)), and a list that
  preloads headshots must preload that same URL. A bare `<img src>` carries no session
  and gets a 401, so draw headshots with `AuthenticatedImage`, `CandidateAvatar` or
  `liveVote/Headshot`.

**Adding an application by hand (uploads):**
- Applications → Add Application takes the resume, blind resume and video as files and
  the short answer as pasted text. `POST /api/applications/manual` accepts multipart
  (`resume`, `blindResume`, PDFs up to 10 MB) and still accepts JSON with links.
- The resume becomes the application's first `ResumeUpload`, so replacing it later keeps
  its history. The blind resume and video are "application documents"
  ([server/src/services/applicationDocuments.js](server/src/services/applicationDocuments.js)):
  files in the private `resumes` bucket with no table of their own. Like a Drive file, one
  is readable only while an application's `blindResumeUrl` or `videoUrl` names it.
- A document id is `<uuid>.<extension>`; the extension is the content type. Every id goes
  through `parseDocumentId` before it reaches storage.
- **The video never passes through `/api`.** The browser asks
  `POST /api/application-documents/video-uploads` for a signed upload URL, sends the file
  straight to Supabase Storage, and the manual route is given `videoDocumentId`, which it
  checks is really in storage. Playback reads it back in 4 MB ranges like a Drive video.
  Limit 500 MB here; the Supabase project's own upload limit applies first if it is lower.
- A sealed application's documents are sealed with it (423 for staff without an exec
  unlock). The unlock is a header a signed link cannot carry, so it is checked when the
  link is signed, and a request arriving on that link is not asked again.
- Closing the form mid-upload aborts the upload and creates nothing. A video uploaded for
  a save that failed is removed when the form closes
  (`DELETE /api/application-documents/video-uploads/:id`, which refuses one in use).
- The partner portal streams an uploaded resume or blind resume from storage
  (`applicationResumeSource` in `utils/clientVisibility.js`), not only Drive files.
- Video upload needs Supabase configured (503 `STORAGE_NOT_CONFIGURED` otherwise); there
  is no local-disk fallback for it. PDFs fall back to disk outside production as resumes do.
- `scripts/transcode-videos.js` only understands `/api/files/<id>` URLs, so it reports an
  uploaded video as unparsed and leaves it alone.

**Case book files:**
- Case page images and the original PDF live in the private Supabase bucket `cases`
  ([server/src/services/caseStorage.js](server/src/services/caseStorage.js)), read only
  through `GET /api/cases/:id/pages/:pageId/image`. They used to go to `server/storage/`,
  which Render wipes on deploy and does not share between instances, so pages showed
  "Page unavailable" depending on which instance answered. Production refuses an upload
  without Supabase (503 `STORAGE_NOT_CONFIGURED`); development falls back to disk.
- Each upload gets its own key (`cases/<caseId>/pages/<uuid>.<ext>`). Deleting a page
  renumbers the rest without renaming files, so a key per page number could be shared.
- A row whose file is gone answers 404 `CASE_PAGE_FILE_MISSING`. Cases page ->
  **Re-upload page images...** sends the same deck again by page number, which keeps each
  page's row and tags; **Replace PDF...** clears the pages and they must be tagged again.
- `npm run migrate-case-files` (dry run; `--apply` uploads) copies files still on a
  local disk into the bucket under the key their row already names.

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

**GM recaps:**
- Administration → GM Recaps (`/admin/gm-recaps`). The executive team's weekly general
  meeting recap: started from a template, edited, then sent now or scheduled to every
  active `MEMBER` and `ADMIN`, from "UConsulting Executive Team" <`EMAIL_FROM`> with
  replies to uconsultingla@gmail.com. Every route needs the admin role **and** a live
  executive unlock.
- Rules live in [server/src/services/gmRecaps.js](server/src/services/gmRecaps.js): the
  template, the email's look (logo, coloured banner with the title, Markdown body, photo,
  address), and the lifecycle `DRAFT → SCHEDULED → SENDING → SENT | FAILED`. A new recap
  numbers its week one past the latest of the season and carries the logo and photo over.
- The send is Master Communications' bulk email (`sendMasterCommunication` with `sender`
  and `wrapHtml`), so it has a campaign row in Logs → Bulk sends and a log row per person.
  `sendEmail` takes `fromName` in `meta`; the address never changes.
- "Send now" is a schedule for now. The request only queues it; the cron every minute
  (and a kick straight after the request) claims `SCHEDULED → SENDING`, so one server
  sends it and it outlives the proxy. An interrupted send is never resent: after 15 minutes
  without a heartbeat it shows as Interrupted and an exec marks it failed.
- Images are uploaded to the public Supabase bucket `email-images`
  ([emailImageStorage.js](server/src/services/emailImageStorage.js)); without Supabase the
  upload answers 503, since a local URL in a sent email is broken for everyone.

**Virtual coffee chats:**
- Interviews → Coffee Chats → Virtual coffee chats. An admin creates a call (day, Pacific
  start and end, meeting link, notes) and adds any number of applicants and interviewers,
  one-on-one or a group, at creation or later. Nobody else can put themselves in one.
- Each chat is a `COFFEE_CHAT` `Interview` with `isVirtual` set and exactly one session
  whose `candidateCapacity` is null. `Interview.location` holds the meeting link (or
  `NO_LINK_YET`), so the emails, the `.ics` and My Interviews show it unchanged, and
  interviewers run and evaluate it like any coffee chat session.
- Rules live in [server/src/services/virtualCoffeeChats.js](server/src/services/virtualCoffeeChats.js).
  Applicants must be in the coffee chat round of the admin cycle and not rejected. Seats go
  through `placeCandidate` / `moveSignup`, so somebody holding an in-person seat is **moved**
  into the chat, never given a second seat; `placeCandidate` checks the whole round, not
  just one interview, for exactly this.
- Candidates cannot book one, since its capacity is null. They cannot switch or cancel
  out of one either (`409 VIRTUAL_CHAT_LOCKED`), and see no in-person times while they
  hold one (`reason: SCHEDULED_BY_RECRUITMENT`). Members cannot claim or drop it. The
  generic interview and session endpoints refuse to add a session, give it seats, change
  its time, link or status, reschedule it, or delete it (`409`): only the chat's own
  routes email the people in it.
- Every change is scoped to the admin cycle, like the list, so a stale tab cannot edit
  last cycle's chats.
- Cancelling closes the interview under the round lock first (`closeInterviewToBookings`)
  and only then releases the seats it reports. `placeCandidate` and `moveSignup` refuse a
  cancelled interview, so nothing can join one mid-cancel. Each seat is released on its
  own; if any fail, the chat stays listed as "Cancelled · N still booked" and cancelling
  again releases what is left.
- Placing someone sends `CONFIRMATION` (or `MOVED_BY_ADMIN` if they were moved);
  interviewers get `INTERVIEWER_ASSIGNED`. Changing the time or link emails everyone;
  removing someone or cancelling emails those affected. A virtual chat's email adds a
  "Join the call" button. All of it is behind `SCHEDULING_EMAILS` like every slot email.
- Cancelling marks the interview `CANCELLED` after releasing every seat; evaluations
  already written are kept.

**Editing an in-person session's time or place:**
- Saving a session in Edit Interview never emails anyone. A save that changes the time,
  or the place people were told (the session's own location, else the interview's;
  `sessionChanged` in
  [server/src/services/sessionChangeNotices.js](server/src/services/sessionChangeNotices.js)),
  stamps `InterviewSlot.updatePendingSince`. So do Move every session
  (`POST /:id/reschedule`) for each session it shifts, and a change to the interview's
  location for each session that inherits it (in the same transaction as the location).
- A stamped session shows **Send update** in Edit Interview until someone presses it,
  across closing and reopening the dialog; the interview card shows "Update not sent".
  It is disabled while that row has unsaved edits.
- `POST /api/admin/interviews/slots/:slotId/send-update` runs `sendSessionUpdate`. It
  refuses an unstamped session (`409 NO_PENDING_UPDATE`), claims the send with a
  compare-and-swap on `updateSendingSince` (`409 SEND_IN_PROGRESS` while a live claim
  holds it, newer details included, since overlapping sends would email everyone twice),
  queues the notices, and only then clears the stamp, and only if it is still
  the one it read: a save landing mid-send restamps it, so its details get a button of
  their own. No transaction is held around the queueing (`interviewSlotComms.js` forbids
  it). A server dying mid-send leaves the stamp and a claim that stops blocking after 10
  minutes; pressing again may email some people twice, which is preferred to nobody
  being told.
- Confirmed candidates get `MOVED_BY_ADMIN` and current interviewers `INTERVIEWER_MOVED`,
  both with `sessionChanged` wording (the `*SessionChanged` fields on those templates), and
  an invite that updates the calendar entry they already have. Waitlisted candidates are
  not told. Who is in the session is read at send time. Behind `SCHEDULING_EMAILS` like
  every slot email.
- The response's `notified` says what happened (`candidates`, `interviewers`, `emailsOn`,
  and `failed` naming each half that could not be queued), and `pending` whether the
  button stays: only when nothing was queued and something failed. A half that did go out
  is not re-armed, or pressing again would send it twice. Candidates and interviewers are
  queued separately, through `queueInterviewerNotices` (which throws) rather than
  `notifyInterviewersBulk` (which logs and returns `[]`), so a failure in one is reported
  and does not hide the other.
- The wording choice is not stored on the notification, so pressing Resend on one renders
  the ordinary "moved" wording. Same limitation as `fromSlotName`.

**Final round availability (invite-only):**
- First round asks every member when they are free. Final round asks only the members an
  admin picks: Interviews → the round's coverage panel → **Choose members to ask** invites
  and emails them (`POST /api/admin/interviews/:id/request-availability` with `userIds`).
  The same button without `userIds` reminds the invited who have not answered.
- An `AvailabilityInvite` row is what lets a member see the round on My Interviews and
  read or save its form (`403 NOT_INVITED` otherwise). Only invited members' answers count
  towards the coverage grid, the suggestions and the session builder.
- Taking someone off (`DELETE /interviews/:id/availability-invites/:userId`) hides the form
  and stops their answer counting, but keeps it, so asking them again brings it back. It
  cancels their unsent requests (status `CANCELLED`, which the sender never claims) and
  leaves any session they are already on alone.
- Placement is not gated: an admin can still put anyone on a session; the picker lists the
  uninvited under "Not asked for this round".
- Which rounds are invite-only is `INVITE_ONLY_TYPES` in
  [server/src/services/availabilityInvites.js](server/src/services/availabilityInvites.js):
  every type that runs final round, the legacy `ROUND_TWO` included. The migration invited
  whoever had already answered on an existing final round, so nobody's answer was lost.

**Saving interview evaluations:**
- One evaluation per (interview, application, evaluator), unique on both tables
  (`interview_evaluations`, `first_round_interview_evaluations`). Both save routes
  (`POST /api/member/evaluations`, `POST /api/admin/interviews/:id/evaluations`) call
  `saveInterviewEvaluation` in
  [server/src/services/interviewEvaluations.js](server/src/services/interviewEvaluations.js),
  a single upsert on that key. It used to read and then create, so two first saves
  arriving together failed the second with a 500.
- The four interview pages save through `useEvaluationSaves`
  ([client/src/hooks/useEvaluationSaves.js](client/src/hooks/useEvaluationSaves.js)). It
  keeps one save per candidate in flight, and each save reads the evaluation when it goes
  out, so a slow save can never land after a newer one and put old notes back.
- A failed autosave or Save retries after 2s, 5s and 15s, unless a newer edit or Save has
  come in since or the page has closed. The page shows "Auto-save failed" until a save
  lands. A new write from these pages goes through `saveNow` or `runInQueue`, never a
  direct POST.
- `interviewEvaluations.concurrency.test.js` runs 40 interviewers saving at once against a
  real Postgres (`TEST_DATABASE_URL`).

**Decision processing:**
- The four `POST /api/admin/process-*-decisions` endpoints share
  [server/src/services/decisionProcessing.js](server/src/services/decisionProcessing.js).
  They advance, reject or accept (final round: promote/create the MEMBER account and seal
  the record) and **send no email**. Each run writes a `DecisionBatch` of
  `DecisionMessage`s that an admin reviews and sends in Master Communications → Decisions
  ([server/src/services/decisionBatches.js](server/src/services/decisionBatches.js)).
- Round order lives in [server/src/utils/roundProgression.js](server/src/utils/roundProgression.js).
- **Approving a send only queues it** (`PENDING → QUEUED`); the request answers at once.
  [decisionSendQueue.js](server/src/services/decisionSendQueue.js) sends, started by the
  approval and by a cron every minute, so a send outlives the tab, the Vercel proxy and a
  restart. On 2026-10-03 a restart under load killed an in-request send mid-batch and the
  leftovers had to be reconstructed from the database by hand.
- Each send writes its `communication_logs` row as a `SENDING` claim **before** calling SES,
  keyed `decision-message:<id>:<attempt>|<email>`. A message left `SENDING` for 10 minutes is
  settled from that row: no row is queued again (SES was never asked), `SENT`/`DELIVERED`/
  `BOUNCED` is marked sent, `FAILED` is retried (3 attempts, a minute apart, then `FAILED`),
  and a row still `SENDING` becomes `UNCONFIRMED`. Unconfirmed means it may have gone out;
  nothing resends it until an admin picks Mark sent or Send again on the batch page. The
  same split applies live: `sendEmail` returns `rejected: true` only when SES answered with
  an error, which is retried; a send that got no answer becomes `UNCONFIRMED`.
- An address that is not an address (a lone `d` was queued once) blocks the send until it
  is fixed on the batch page or left out. Fixing it changes only that email, not the application.

**Candidate interview sign-up under a burst:**
- A decision email sends a whole round to `/interview-signup` at once. Every booking in a
  round takes one row lock (`lockRoundSlots`), so they cannot run side by side anyway.
  `claimWithFallback` therefore queues claims per round in memory
  ([keyedBatchQueue.js](server/src/utils/keyedBatchQueue.js)) and books whoever is waiting
  in one transaction: one lock, one read of the round, one insert. Waiting claims hold no
  database connection. The lock still separates two server instances.
- Seats go first come, first served by the time a claim joins the queue. Each claim keeps
  its own `signedUpAt` / `waitlistedAt`, strictly increasing per process, so a batch never
  leaves waitlist order to a random id. A batch that fails outright is retried claim by
  claim, so one bad claim fails only itself.
- Production's server sits about 25ms from its database. Site Analytics puts an idle
  `GET /api/my-interview-signups` at ~500ms. At that latency, 90 simultaneous bookings
  used to fail 68 with 500s from pool and transaction timeouts. Batched, all 90 book.
  `interviewSignups.claim.test.js` pins capacity, FCFS, group labels and two instances
  racing, against a real Postgres (`TEST_DATABASE_URL`).
- Sign-in is what is left. `bcryptjs` at cost 12 burns CPU on the one Node thread, so
  `routes/auth.js` runs password work two at a time. People get through in arrival order
  instead of all finishing together at the end.

**iMessage (Master Communications):**
- Members only. An admin picks people by name and writes plain text; Send opens one group
  conversation in their own Messages app through an `sms://open?addresses=…&body=…` link
  ([client/src/utils/imessage.js](client/src/utils/imessage.js)). The server never delivers
  or schedules an iMessage — it lists reachable members (`GET /imessage/members`) and logs
  the send (`POST /imessage/log`).
- Numbers live on `User.phoneNumber` (E.164). Bulk-load them from a roster CSV with
  `node scripts/import-member-phones-from-csv.js <csv>` (dry run; add `--apply` to write),
  or edit one in User Management.

**Master Communications audiences:**
- Email's "Filtered audience" (`audience: 'custom'`) is an AND/OR tree of rules, any
  node negatable, stored as `{ version: 2, root }`. Members and Admins stay as the flat
  audiences they were (Slack uses only those). Old drafts with `applicants` /
  `mailing-list` filters still resolve server-side and open in the builder as the
  equivalent tree (`legacyToTree` in the client).
- [audienceFilters.js](server/src/services/audiences/audienceFilters.js) validates a
  tree and folds rule results; [audiencePeople.js](server/src/services/audiences/audiencePeople.js)
  builds the people and answers each rule. **A new rule goes in `RULE_TYPES`, in
  `MATCHERS`, and in the client's `RULES`** ([audienceRules.js](client/src/components/communications/audienceRules.js)).
- A person is one lowercased address (`x@g.ucla.edu` and `x@ucla.edu` are one inbox
  and merge; so does an unsubscribe from either), merged across accounts, applications,
  candidates, mailing-list contacts, meeting signups and Luma guests. A candidate's
  addresses merge into one person, represented by their active account's address if
  any (so staff are recognised), else their latest application's.
- Sealed records are identity only to an audience, even with an exec unlock: a sealed
  application still counts as "applied" (cycle, status, date) but its decisions,
  rounds, answers, onboarding and referrals are never read, or a decision filter would
  list exactly who the seal hides. A new rule reading application content must respect
  the `locked` marker `redactApplication` leaves.
- NOT is taken against everyone known, so a tree with no positive rule is refused -
  it would reach everybody. Deactivated accounts and `CLIENT` accounts are never in
  the universe at all.
- Saved audiences (`SavedAudience`) keep the tree, never the people, and are re-run
  at send time. A draft or schedule with `savedAudienceId` follows later edits to it;
  a schedule also keeps a copy of the filters in case the audience is deleted.
  "Exactly who got send X" is the `receivedCampaign` rule, not a snapshot.

**Unsubscribes:**
- `EmailSuppression` holds addresses opted out of Master Communications *marketing*
  mail: any bulk email send to someone who is not active staff. Staff mail carries no
  link and ignores the list. Nothing outside Master Communications reads it - decision
  letters, account and interview emails still go out.
- Marketing mail gets a footer link to the public `/unsubscribe` page (a button; a GET
  never acts, since scanners open every link) and `List-Unsubscribe` +
  `List-Unsubscribe-Post` headers for Gmail/Yahoo one-click. Links carry an HMAC of the
  address under `UNSUBSCRIBE_SECRET` (falls back to `JWT_SECRET`).
- SES complaints and **permanent** bounces add a row automatically; soft bounces do not.
- A row is never deleted: resubscribing sets `resubscribedAt`. Previews and sends
  report held-back people as `skipped` rather than dropping them silently.

**Communications log:**
- `CommunicationLog` (`communication_logs`) records every outbound message, one row per
  recipient, read back in Master Communications → Logs → All messages.
- Written at the three points anything leaves the server:
  [`sendEmail`](server/src/services/emailNotifications.js) for all mail,
  [`sendSlackMessage`](server/src/services/slackService.js), and `logImessageSend` in
  [masterCommunications.js](server/src/services/masterCommunications.js). Nothing else may
  send. A new email must go through `sendEmail`, or it will not be logged.
- Both senders take an optional trailing `meta` ({ category, trigger, recipientName,
  triggeredById, cycleId, messageLogId }). Omitting it still logs the send, as an
  automated `OTHER`, so a new caller can never silently drop out of the log.
- Recording is best-effort and never fails a send: the mail is already gone by the time
  the row is written, so a logging error reported as a send error would get it sent twice.
- `MessageLog` is unchanged and still the campaign-level record of a bulk send (Logs →
  Bulk sends). A bulk send's per-recipient rows point back at it via `messageLogId`, which
  is why `sendMasterCommunication` writes the campaign row *before* the first email.
- An iMessage row is `OPENED`, not `SENT`: the server hands the conversation to the
  admin's Messages app and cannot observe what happens after.
- A `SENDING` row is a claim written just before a send that must not repeat
  (`applicationReceipts.js`) and overwritten with the outcome. The UI shows one older
  than 10 minutes as **Interrupted**, and Email Deliverability counts it. The sender
  retries it as a new row only while it is still owed (three attempts at most, and only
  while the application awaits a first decision), so an interrupted row is not proof of
  a retry.
- Candidates list and Candidate Detail show a person's history (admin only,
  `/api/admin/candidate-communications`,
  [candidateCommunications.js](server/src/services/candidateCommunications.js)). Rows
  carry no candidate id, so they are matched on every address the candidate is known by
  (their own and each application's, both UCLA spellings) and, for iMessage, on the last
  ten digits of each application's, onboarding's and account's number. An address two
  candidates share shows its rows on both. Shown for sealed candidates too: it is the
  same log every admin can already read.
- An email row's `SENT` only means SES accepted it. What happened next arrives from SES
  (configuration set `SES_CONFIGURATION_SET` → SNS topic `SES_SNS_TOPIC_ARN` →
  `POST /api/webhooks/ses`) and moves the row to `DELIVERED`, `DELAYED`, `BOUNCED`,
  `COMPLAINED` or `FAILED`, with the reason in `error`. Rows are matched by the SES id
  inside `providerMessageId` plus recipient, and only ever move forward — SNS does not
  guarantee order. The route has no auth; the SNS signature and topic ARN are its auth
  ([server/src/services/sesEvents.js](server/src/services/sesEvents.js)). Unset topic ARN
  means it refuses everything.

**Email deliverability page:**
- Administration → Email Deliverability (`/admin/email-health`) answers "is our mail getting
  through?" from four places, each checked on its own so one failing never hides the rest:
  env config, the SES account/identity/configuration set (read with the sending credentials),
  public DNS for the From domain, and `communication_logs` over 1/7/30 days.
- All judgement lives in [server/src/services/emailHealth.js](server/src/services/emailHealth.js);
  the page only lays it out. `unknown` means the check could not look (IAM without
  `ses:Get*`, DNS timeout, database down), never that something is broken.
- Bounce and complaint rates are not graded under 50 sends. "Delivery reports arriving"
  fails when most mail over an hour old is still `SENT` - the SNS subscription is broken.
- "Send test" goes through `sendEmail` as a `MANUAL` `TEST`, so its log row turning
  `DELIVERED` proves SES and the webhook work together.

**How automatic emails look:**
- Every automatic email is drawn by one renderer,
  [server/src/services/emailLayout.js](server/src/services/emailLayout.js). A builder
  never writes layout HTML: it hands `composeEmail(key, { subject, values, parts })` a
  list of parts (`heading`, `greeting`, `copy`, `card`, `button`, `link`, `signOff`,
  and `html` for the decision letters' rendered Markdown). **A new automatic email must
  go through `composeEmail`**, or it will ignore the theme and have no Plain version.
- The look is layered like the wording: shipped defaults, then the one-row `EmailTheme`
  (brand, logo, header colours, accent, font, footer;
  [emailTheme.js](server/src/services/emailTheme.js)), then the per-email
  `EmailTemplateStyle` (Designed/Plain, header colour;
  [emailTemplateStyle.js](server/src/services/emailTemplateStyle.js)), keyed by the same
  keys as `EmailTemplateCopy`. Style lives in its own table so restoring the wording does
  not restore the colour. Admins edit both on the Automatic Emails page (Theme tab, and
  each email's Style tab).
- Theme values end up inside `style` attributes and `<img src>`, so they are validated to
  a narrow shape (hex colours, a font from `EMAIL_FONTS`, an https logo) rather than
  escaped. Free text (brand name, footer) is escaped by the layout.
- Plain has no header, card boxes or footer, and carries the same information: a card
  becomes "Label: value" lines and a button becomes a link. Decision letters start Plain,
  which is how they always looked; everything else starts Designed.
- A missing theme or style table reads as the shipped look, and so does an unapplied
  migration: a send never fails on presentation.
- `sendEmail` adds a `text/plain` part to every message, derived from the HTML with
  `htmlToPlainText`, so the two can never disagree. That includes Master Communications.
- Previews can render an unsaved theme or style (`POST /:key/preview` with
  `{ theme, style }`), validated as a save would be. The draft reaches the builders
  through `withDraftPresentation` (AsyncLocalStorage), never on a send path.

**Decision guide:**
- The copy a reviewer reads while picking YES / MAYBE_YES / MAYBE_NO / NO after an
  interview: a note on what deliberation is for, plus one description per decision. Admins
  edit it from Staging ("Edit decision guide"); nothing about it is hard-coded in the pages.
- [server/src/services/decisionGuides.js](server/src/services/decisionGuides.js) resolves it in
  layers, field by field: built-in defaults, then the `general` guide, then the round's own.
  An empty field falls through rather than showing a blank, so a round can override one
  decision without restating the rest. `source` on each decision says which layer answered.
- Phases are the four rounds from `roundProgression.js` plus `general`. An interview with no
  round of its own (DELIBERATIONS) reads `general` - see `guidePhaseForInterviewType` in
  [client/src/utils/decisionOptions.js](client/src/utils/decisionOptions.js), which is also
  the one place the four decision options are defined for the interview pages.
- `InterviewDecision` also has `UNSURE`, which no picker offers and the guide deliberately
  does not document. Adding it to the form means adding it to `DECISION_VALUES` in the
  service and `DECISION_OPTIONS` in the client.

**Document grading rubrics:**
- What a grader scores a resume, cover letter / short answer or video against. Admins edit
  them from Admin Document Grading → "Edit rubrics": per category, the title, description,
  whole-number range (min..max) and the criteria rows, and they can remove a category (one
  must be left) or add a new one, up to three per type. Nothing about them is hard-coded
  in the pages any more.
- [server/src/services/documentRubrics.js](server/src/services/documentRubrics.js) owns the
  defaults, validation, the overall-score rules and every range check. A type with no
  `document_rubrics` row (or no table yet) reads as the shipped default.
- **Three categories at most, one per column.** Every score table has exactly three `Int`
  columns (`scoreOne/Two/Three`), and a category lives in one of them; "Add category" takes
  the first free one. A fourth would need a schema change. A save naming anything but those
  three columns is refused, never read as a removal.
- **Not editable:** how a type's categories fold into the overall - resume and video sum,
  cover letter averages. Staging reads `overallScore` with those meanings. Video ships with
  one category, where its sum is that score as before.
- **A removed category's column is not read.** Graders are not asked for it, new overalls
  are folded from what remains, and a re-saved grade stores it as null. Already-graded
  documents keep their stored overall until re-saved. Removing from an average keeps the
  type's max (one 1–3 category is still worth 3); removing from a sum lowers it.
- **A range is a weight.** Staging's Resume Review ranking adds the three documents' raw
  overall scores plus up to `PARTICIPATION_MAX` (3). Raising one type's max gives it more
  say in the ranking; the editor says so as the range changes.
- Scores are checked server-side on every grader save (`scoreFromRubric`) and admin edit
  (`adminScorePatch`), `400 SCORE_OUT_OF_RANGE` otherwise. An admin edit checks only the
  values it changes, so a score graded under an older, wider range stays editable.
- Changing a range never rescales existing scores. Save previews first
  (`POST /:type/preview`) and warns with how many of the admin cycle's scores would fall
  outside it.
- A blank category is `null`, not 0: 0 can be a real score, and a blank must not pull a
  cover letter average down.
- The grading dialog shows the short answer's question above the answer. Nothing stores
  it. `GET /api/review-teams/question-prompts/:cycleId` reads it from the cycle's Google
  Form (the question `form-config.json` maps to `shortAnswer`), cached 10 minutes
  ([applicationFormPrompts.js](server/src/services/applicationFormPrompts.js)). A cycle
  whose form cannot be read answers null and the answer shows alone. Without `:cycleId`
  it answers for the requester's cycle, because admin queue rows have no `cycleId`.
- Every denominator on the client (`/13`, `/21`, the Staging bar) reads
  [client/src/utils/documentRubrics.js](client/src/utils/documentRubrics.js), which shares one
  fetch across the page and falls back to the shipped maxima until it arrives.

**Grading tutorial gate:**
- The first document a member or admin opens to grade each cycle, on Document Grading or
  Admin Document Grading, waits behind an unskippable popup of the Help page's
  `DOCUMENT_GRADING` tutorials. There is no close button and Escape does nothing; ticking
  "I watched the whole tutorial" and continuing records a `TutorialCompletion` (user,
  cycle, category) and opens the document they clicked. Opening the page and flagging a
  document are not gated.
- The tutorials are whatever admins publish in Help Management with category Document
  Grading. **No published tutorial means no gate**, so nothing blocks grading until one
  exists.
- The cycle is `resolveCycleForRequest`, so an admin's completion is for the admin cycle.
- Rules live in [server/src/services/tutorialGate.js](server/src/services/tutorialGate.js)
  (`GATED_CATEGORIES`); the client side is `useTutorialGate` in
  [client/src/components/TutorialGate.jsx](client/src/components/TutorialGate.jsx). To gate
  another kind of work, add its category to `GATED_CATEGORIES` and wrap the action in
  `gate.run(...)`.
- `gate.run` asks the server on every click instead of caching the answer, so a page
  left open across a cycle change still gates the next document.
- Only YouTube, Loom and Vimeo links are framed (`getKnownVideoEmbedUrl`); any other
  tutorial link is a button that opens it in a new tab.
- It fails open: no cycle, an unapplied migration or a failed status check lets the
  grader through. Only a failed *save* keeps the popup up, with the error shown.

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

**Review team deliberations:**
- After document grading, admins meet each review team to go over its grades. An admin starts
  a session from that team's card on Review Teams; the team's members get a join prompt and
  join at `/review-delib/:id`, which has Overview → Outliers → All candidates → Summary.
  Rules live in
  [server/src/services/reviewDelibs/reviewDelibs.js](server/src/services/reviewDelibs/reviewDelibs.js);
  every number is computed in [teamStats.js](server/src/services/reviewDelibs/teamStats.js),
  which is pure and imports nothing (the tutorial capture runs it outside the server).
- **Everyone moves around on their own.** Nobody follows the admin: each viewer, member or
  admin, picks their own step and candidate, kept in their URL (`?step=outliers&c=<id>`) so
  a refresh keeps their place. The server keeps no shared place and has no navigate
  endpoint. What is shared is the data: the threshold, overrides and decisions are admin
  actions, and their results reach everyone through the version bump. Ending the session
  is admin-only and puts everyone on the summary.
- **Admins and the team's current members can join.** Membership is re-checked on every
  request, so someone moved off the team mid-session loses access. Members of other teams get
  403 `NOT_ON_TEAM` and never see the prompt. A partial unique index allows one ACTIVE session
  per team; different teams run in parallel.
- **A grade's score is `adminScore ?? overallScore`**, the same rule Staging ranks on.
- **An outlier is a grade far from the other graders on the same document**, far meaning at
  least `thresholdPct` (default 30%) of the document type's max from their mean, and it must
  be further from them than anyone else's grade. Without that second rule, 2 / 10 / 10 flags
  the two 10s as well, because the 2 drags their "others' mean" down. When no single grade is
  furthest (two graders, or 2 / 6 / 10) a wide gap is a **split**. It shows on everyone
  involved and counts against nobody.
- The walkthrough (`outlierApplicationIds`) is shared and server-owned, because it follows
  the shared threshold. Its order (widest disagreement first) is fixed at launch so resolving
  one does not reshuffle it. Changing the threshold (`rethresholdWalkthrough` in teamStats.js)
  keeps the entries that still have an outlier or split at the new threshold, in their order,
  and appends newly qualifying ones; so raising it drops candidates and lowering it adds them.
  An entry still counts if its *graded* scores qualify, so one an override resolved stays.
  Sealed or moved candidates are left in. The scores are read before the session lock, which
  is held only to apply them to the list as it stands. If the session's version moved in
  between (an override, decision or other threshold change), the read is redone, up to three
  attempts; the third is applied regardless.
- On the page, `walkthroughPosition` in
  [client/src/utils/reviewDelib.js](client/src/utils/reviewDelib.js) keeps a viewer on the
  Outliers step on a candidate the walkthrough lists: the first when they arrive or the list
  fills, and the next one after theirs (else the last) when a threshold change drops theirs.
  Previous, Next and the arrow keys skip sealed and moved candidates, which have no card.
- **Overall is Staging's number**: the documents total plus participation points (one per
  cycle event attended, one for Get to Know UC inside the cycle's dates matched on the
  application's UID, capped at `PARTICIPATION_MAX`), rounded to one place as Staging rounds
  it. `loadTeamInput` reads the points in bulk (`loadParticipationPoints` in
  applicationParticipation.js, whose `participationPoints` Staging also uses); teamStats.js
  only adds them up. Sealed candidates are not asked about.
- **Rank is Staging's Resume Review rank**: by overall against every applicant in the cycle,
  on any review team or none (ties share a rank and the next skips, 1, 2, 2, 4; an overall
  of 0 is unranked), as `rankByScore` in client/src/utils/stagingRank.js does. Applicants on
  no team are loaded only for this (`outsideTeams` from `loadTeamInput`) and kept out of the
  table, comparison, gaps and outliers. Sealed candidates are unranked here and their scores
  never read. Staging also leaves them unscored, except for an admin with the executive
  unlock open, whose Staging ranks them; that admin can see a worse rank there than here.
  Other teams' grades bump no version, so a rank can lag by the team cache (5 s) plus the
  page's 30 s team refresh.
- **Edits are ordinary edits.** An override writes only the score row's `adminScore` through
  `adminScorePatch`; the grader's own score stays, and clearing the override restores it. A
  decision is `saveRoundDecision` with phase `resume`, the same write as Staging's picker.
  Both are logged in `review_delib_changes` for the summary and leave an audit comment.
- **Sealed candidates are identity only, and the exec unlock is ignored** (`sealedRowPredicate`,
  not `lockedRowPredicate`): one admin's unlock says nothing about who else is on the screen.
- **The card also shows events attended and referrals** for the cycle, read through
  [server/src/services/applicationParticipation.js](server/src/services/applicationParticipation.js),
  the same lookups behind Application Detail's `/:id/events` and `/:id/referrals`. The whole
  room sees them, so a referral carries the referrer's name, relationship and reason, never
  an email or user id. A referrer name that is an address (a member with no full name is
  stored by address) shows as "A member", or "Name not given" on a manual referral. They are read only after the seal and team checks pass, and never
  cached with the team bundle. The "n of m" counts the cycle's own events; Get to Know UC
  is listed but counted in neither number.
- Concurrency works as in live votes. `withVersionLock`
  ([server/src/services/versionLock.js](server/src/services/versionLock.js), shared by both)
  bumps the session's version first and holds the row lock. Clients poll the light state (the
  shared settings and who is here) and refetch the team view and their own open card when the
  version moves. Supabase channels are
  `review-delib:<id>` and `review-delibs`. A channel name can be subscribed once per page, so
  anything else that wants to know about launches reads `useReviewDelibs()` instead of joining
  `review-delibs` itself.

**Referrals:**
- A `Referral` arrives one of two ways, tracked by `Referral.source`. `MANUAL` is added on
  an application page (`/api/applications/:id/referral`) and has a `candidateId` from the
  start. `PRE_APPLICATION` is submitted by a member at `POST /api/member/referrals`.
- The member-facing form is a typeahead over this cycle's applicants
  (`GET /api/member/referral-candidates?q=`). **Picking a person sets `candidateId`
  outright, so there is no name matching at all** — that is the path to prefer. A member
  who cannot find them picks "Other" and types a name, and only then does the referral wait
  with `candidateId` null. A submitted `candidateId` is re-checked against the cycle
  server-side; it arrives in a request body, so it need not be one the typeahead offered.
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
- An "Other" submission never attaches at submit time, even when the typed name matches an
  applicant exactly. The member just said that person was not in the list, so a match is
  either someone they scrolled past or a different person with the same name.
- The whole claim (ambiguity check, read, update) runs in one transaction under
  `pg_advisory_xact_lock(hashtext(nameKey))`. Sync runs every five minutes and a slow run
  can overlap the next; without the lock two same-named applicants can each be checked
  before the other's application commits, and both pass a check that should fail for both.
- **An admin's manual match outranks sync.** The claim's `updateMany` stays conditional on
  `candidateId` still being null, so a referral placed by hand between the read and the
  write is never quietly moved.
- A referral is only claimed within its own cycle (or if filed without one). If the person
  never applies it stays pending forever, which is the intended end state. Admins work the
  queue at `/admin/referrals` (`GET /api/admin/referrals?status=PENDING`) and attach one by
  hand with `PATCH /api/admin/referrals/:id`.
- One member cannot refer the same person twice in a cycle. The unique index on
  (`referredByUserId`, `cycleId`, `referredNameKey`) is what enforces it; the service's
  lookup races with itself, so it also treats `P2002` as the duplicate it is.
- A member's referral also carries `reason` (why they are vouching, required, up to 1000
  characters) for admins to weigh. It is null on `MANUAL` referrals and on ones made
  before the question existed. The admin queue withholds it on a sealed candidate.
- Both kinds coexist on a candidate. The application page reads `GET /:id/referrals`
  (plural) for the whole list, while the manual add and remove still own exactly one
  `MANUAL` referral per candidate per cycle and never touch a member's submission.

**Member event RSVPs:**
- Members RSVP in the app from the Events page: `PUT` / `DELETE
  /api/member/events/:eventId/rsvp` (ADMIN/MEMBER, only before the event starts). There is
  no member form to fill in; going is a `member_event_rsvp` row with `source = IN_APP`.
  Admins RSVP for themselves from Event Management's Member RSVP column, through the same
  endpoints.
- Cancelling removes only an `IN_APP` row. An RSVP from Luma or the legacy Google Form is
  shown as made but answers `409 RSVP_EXTERNAL` - it has to change where it was made.
- Google Form, Luma and in-app rows coexist under the one-per-member-per-event index;
  whichever wrote first stands, and neither sync ever removes another source's row.
- A new in-app RSVP sends the RSVP confirmation (with calendar invite) best-effort.
- `Events.memberRsvpEnabled` (default on) is the admin's switch in Edit Event for events
  that need no member RSVP. Off means no RSVP button, no dashboard RSVP task, an "Off"
  Member RSVP column, and `409 RSVP_DISABLED` on a new in-app RSVP. Existing rows are
  kept and an in-app RSVP made before it was turned off can still be cancelled. Luma and
  Google Form syncs ignore the switch. Copying an event to another cycle keeps its setting.
- Admins mark who actually came in Accountability Tracker → an event's Manage dialog,
  which opens on the RSVP'd members (any source). An RSVP never counts as attendance by
  itself; attendance is still only a `member_event_attendance` row, and a walk-in without
  an RSVP is one switch away.

**Get to Know UC host reminders and contact:**
- A cron every 15 minutes emails each host about 24 hours before a slot that has signups:
  who is coming, and a nudge to tell them exactly where to meet and how to find the host
  ([server/src/services/meetingHostReminders.js](server/src/services/meetingHostReminders.js)).
  It is logged as a `REMINDER` `MeetingCommunication` with no signup, and that row is the
  dedupe: one `SENT` since the slot entered its 24-hour window means done, so a slot moved
  to a later day is reminded again. Failed sends retry, three attempts at most.
- Every server on the database runs this cron on the same tick, so each send takes
  `pg_try_advisory_xact_lock` on the slot and re-checks the log once it holds it (the
  attendance reminder does the same). Without the lock, five servers sent five copies.
- **Attendance is "done" or "outstanding" per slot**, decided in one place
  ([server/src/services/meetingAttendance.js](server/src/services/meetingAttendance.js),
  mirrored for the pages in [client/src/utils/gtkucAttendance.js](client/src/utils/gtkucAttendance.js)).
  `MeetingSignup.attended` defaults to false, so it cannot tell a no-show from someone
  never marked. A slot is done when a host or admin pressed **Attendance done**
  (`MeetingSlot.attendanceMarkedAt`) or every signup is checked; an ended slot with
  anyone unchecked and no such press is outstanding. Moving a slot clears the mark.
- The attendance reminder cron only looks back 24 hours past the end, so older slots are
  reminded by hand: Get to Know UC → Time Slots → **Attendance overdue**, per row or in
  bulk (`POST /api/admin/meeting-slots/attendance-reminders`). A manual send has no
  once-only rule, re-checks the slot under the cron's lock, and logs the same
  `ATTENDANCE_REMINDER` row, which is where "last reminded" comes from.
- The member and admin slot pages have an "iMessage / email signups" button: one group
  iMessage (`sms://open?addresses=…`) in Messages, or one email as a Gmail compose tab
  (`mail.google.com/mail/?view=cm`, not `mailto:`, which opens whatever desktop mail app
  is the default), logged as `OPENED` in the communications log.
- `MeetingSignup` has no phone, so a number is found by email
  ([server/src/services/meetingSignupContacts.js](server/src/services/meetingSignupContacts.js)):
  `User.phoneNumber`, then candidate onboarding, then the latest application. The last
  two are read only when an account with that address has verified it: booking does not
  require verification, so otherwise anyone could book under someone else's address and
  hand their number to the host. A sealed candidate's onboarding and applications are
  never read.

**Interview signup reminders:**
- An admin emails the people in a round who have not booked a session. Rules live in
  [server/src/services/signupReminders.js](server/src/services/signupReminders.js); the route
  is `POST /api/admin/scheduling/rounds/:round/signup-reminders` (rounds 2-4).
- Not booked means `currentRound` is the round, not `REJECTED`, and no `CONFIRMED`,
  `WAITLISTED` or `NEEDS_PLACEMENT` signup on a session of a non-cancelled interview of that
  round in the cycle. `findUnbookedApplications` is the one definition; the overview's
  `unassigned` reads it too. It is recomputed at send time and again for each person just
  before their email, so anyone who booked in between is `skipped`.
- Refuses with `409 NO_OPEN_SESSIONS` when no session of the round is bookable right now:
  the email's only job is the link to `/interview-signup`. "Bookable" is
  `isSelfBookableNow` in [interviewSignupPolicy.js](server/src/services/interviewSignupPolicy.js)
  (interview not cancelled or completed, inside the signup window, outside the 12-hour
  cutoff) - the same rule booking refuses on and the candidate page marks slots open by.
  The overview's `stats.openSessions` counts by it too.
- There is no reminders table. Each send is a `SIGNUP_REMINDER` row in `communication_logs`
  with `attemptKey` `signup-reminder:<round>:<applicationId>:<sendId>`, and "last reminded"
  is read back from that key, per round (on `unassigned` and on booked `signups` alike).
  `FAILED`, `BOUNCED` and `COMPLAINED` rows do not count. A leftover `SENDING` row (the
  process died between claim and send) does, on purpose: nobody can tell whether it went
  out, and a double send is worse than a missed one.
- Each person's send is claimed first, the `applicationReceipts.js` pattern: under
  `pg_try_advisory_xact_lock` on (round, application) it re-checks they are unbooked,
  refuses if they were reminded for that round within `REMINDER_COOLDOWN_MS` (1 hour), and
  writes a `SENDING` row that `sendEmail` overwrites. The email is rendered before the
  claim, and a throw after it marks the claim `FAILED`, so neither blocks the next attempt
  for an hour. A retry after the proxy cut the
  response off, or two admins at once, skips instead of sending twice. Five sends run at
  once (`utils/concurrency.js`) to keep the response short in the first place.
- Not gated on `SCHEDULING_EMAILS`: that switch holds back the automatic slot mail, and this
  is an admin sending copy they wrote, like accountability reminders.

**Accountability points:**
- Every member needs a target number of points per cycle (3 by default), earned from nine
  types of participation. **Each type counts once**, so the member's view reads as a
  checklist of what is left. Admins edit the target and what each type is worth from the
  Accountability page; members see their own standing on the dashboard
  (`GET /api/member/accountability`).
- [server/src/services/accountabilityPoints.js](server/src/services/accountabilityPoints.js)
  owns the types, where each one's credit comes from, and the scoring. The types, labels
  and credit sources are code; only the values live in the database
  (`accountability_point_values`, `accountability_settings`), and a type with no row is
  worth its default.
- Credit is read from records the ATS already keeps, never entered twice: GTKUC is a
  hosted slot somebody attended within the cycle's dates (from its `createdAt` when it
  has no start date); Application Screen is any resume, cover letter or video score
  this cycle, or a cycle-less legacy score written during it on a candidate who applied
  in it; Coffee
  Chats, First Round and Final
  Round are sitting on a started session of that interview type (all three roster
  sources, via `interviewersWhoHaveSat` in `interviewRoster.js`); Info Sesh, Women's Night,
  Case Workshop and Case Buddies are check-ins to an event an admin tagged with that
  `Events.pointType`.
- Points add up in hundredths, so 0.5 six times is exactly 3.
- Reminders (`POST /api/admin/accountability/reminders`) re-score at send time and skip
  anyone who reached the target since the page loaded. They go through `sendEmail` as
  `ACCOUNTABILITY_REMINDER`, with the admin's subject and message (merge fields
  `REMINDER_MERGE_FIELDS`) above a generated checklist.
- `eventCopy.js` does not carry `pointType`; a copied event has to be tagged again.

**Case book time restriction:**
- A member may open a case only once they are close to the interview they run it in.
  The window is one global number of hours, held in the `CaseVisibilitySetting`
  singleton and edited by an admin on the Cases page.
- Every read of case content goes through `authorizeCaseRead()` in
  [server/src/services/caseVisibility.js](server/src/services/caseVisibility.js), which
  answers `{ allowed }`, `FORBIDDEN` or `LOCKED` with the unlock time. The routes turn
  that into 403 for a case that is not theirs and **423 `CASE_LOCKED`** for one that is
  theirs but early. Any new route serving case pages or detail must go through it.
- Admins are exempt, so they can build and assign cases ahead of time. Case *titles* are
  not gated: the assignment picker still lists them.
- Larger numbers mean earlier access. 0 opens the case exactly at the interview start;
  720 (30 days) is effectively no restriction.

**Luma event sync:**
- Luma is replacing the per-event Google Forms for RSVP and attendance. There is no Luma
  API on our plan, so an **hourly Claude routine** reads guests through the Luma MCP
  connector and posts them to `/api/integrations/luma`. The routine only relays; every
  decision about who a guest is happens in
  [server/src/services/luma/ingestGuests.js](server/src/services/luma/ingestGuests.js).
- The full design is [docs/luma-integration-plan.md](docs/luma-integration-plan.md), and the
  routine's prompt and setup are [docs/luma-sync-routine.md](docs/luma-sync-routine.md).
  **Read the plan before touching event sync code.**
- Setting it up is **Event Management → Luma Sync Setup**: it generates the sync token
  ([server/src/services/luma/syncToken.js](server/src/services/luma/syncToken.js)) and
  renders the routine prompt with the token inlined
  ([syncPrompt.js](server/src/services/luma/syncPrompt.js)). The token is stored in plain
  text on purpose — it exists to be read back and pasted — so that prompt is a secret, and
  `GET /api/admin/luma/sync-token` is the one endpoint here that returns a live one.
- Rows carry `source` (`GOOGLE_FORM | LUMA`) and, for Luma, a unique `lumaGuestId`. The
  sync **reconciles rather than appends**: declining in Luma removes that guest's Luma RSVP,
  an undone check-in removes their attendance, and re-posting the same page changes nothing.
  It never touches a `GOOGLE_FORM` row, and a person who answered both counts once.
- A guest matched on a typed UID alone, and an `approval_status` it cannot read as going
  or not going, are **held and reported**, never guessed at. What counts as held is
  [server/src/services/luma/heldGuests.js](server/src/services/luma/heldGuests.js), one
  definition read by both the panel and the per-event badge on the event list.
- A guest the ATS cannot resolve (`UNMATCHED`) is **not** a hold: it is someone with no
  profile yet. Form sync links them when their application lands
  (`claimLumaGuestsForCandidate`, by address or UID), and the panel does not count them.
- The UID question is found by label: "UID", "Student ID" or "UCLA ID" all count
  (`UID_LABEL`). An address matches in either UCLA spelling, and an application's own
  address counts as well as the candidate's.
- **A guest's history follows them into the ATS through the UID.** Someone can attend an
  event months before applying: the sync creates a Candidate keyed on the UID they typed,
  and their RSVP and attendance rows point at it. When their application arrives, form
  sync finds that same candidate by `studentId` and the history is already attached - the
  address they used on Luma is usually not the one on their application, which is why the
  UID question is required per event. `syncResponses.lumaHandoff.test.js` pins that seam.
- An unmatched guest is retried every sync while the event is on the routine's list
  (three days after it starts), and after that when their application arrives, so
  someone who applies weeks later still gets their RSVP and attendance.
- Admins settle a held guest in Event Management → an event's Luma column → the guests
  panel. Linking runs
  [server/src/services/luma/linkGuest.js](server/src/services/luma/linkGuest.js), which
  re-runs the same reconcile a sync would, so the RSVP and attendance follow immediately -
  an event leaves the routine's list three days after it starts, so a later link would
  otherwise never be applied. Unlinking is the undo, and the only one: a match that exists
  is never re-decided by a sync.
- An event's `lumaUrl` is what an admin pastes; `lumaEventId` is what the routine resolves
  it to. **Changing `lumaUrl` clears both `lumaEventId` and `lumaLastSyncedAt`** - a stale
  id makes the routine's next resolve fail with a conflict, and a stale timestamp reports a
  never-read link as freshly synced. Guests already ingested are kept.
- A Luma link satisfies `formStatus` on its own (it covers RSVP and the door), so
  `resolveFormStatus` reads `lumaUrl OR (rsvpForm AND attendanceForm)`.
- `eventCopy.js` deliberately does **not** copy `lumaUrl`: `lumaEventId` is unique, so two
  ATS events on one Luma event would make the second one's sync fail.

**Event sign-up confirmation emails:**
- The Google Form event sync's own RSVP and attendance confirmations are behind an admin
  switch ([server/src/services/eventEmailSettings.js](server/src/services/eventEmailSettings.js),
  toggled on the Events page) and are **off**. Luma emails its own confirmation and calendar
  invite the moment somebody registers, so ours would be a second message about the same
  sign-up. It is a switch rather than deleted code because the Forms path survives until
  Phase 4; turn it on if events ever move back.
- **Off is the default in all three places** - the column, the service fallback and the
  migration. A missing settings row and an unapplied migration both read as off, because an
  unexpected duplicate to everyone who signs up is worse than an expected missing one.
- The setting is read once per sync run, not per response, so a run agrees with itself.
- The **member in-app RSVP confirmation is not covered by this switch** and still sends: a
  member who RSVPs in the app never touched Luma, so nothing else has written to them.

**Matching an application to a candidate:**
- [syncResponses.js](server/src/services/syncResponses.js) resolves the candidate a new
  application belongs to by **`studentId` first, then `email`** - two lookups, in that
  order, never one `OR`. Both columns are unique, so each answers at most one row, but an
  `OR` across them can match two *different* people: the UID's owner and the address's
  owner. That happens whenever somebody registered on Luma under a personal address, or a
  UID was mistyped somewhere.
- The UID wins because it is what the Luma sync keys a candidate on, so it is the row
  carrying any `event_rsvp` / `event_attendance` history - **and nothing re-points those
  rows afterwards.** Matching on the address instead would strand a person's RSVPs and
  door scans on a record no application, and no candidate account, ever reaches.
- **When the two point at different people the UID still wins, and the conflict is
  logged.** Resolving to the address instead looks safer from one direction (a stolen UID
  files your application onto its owner's record) and is worse from the other (your own
  UID with someone else's address files it onto *theirs*) - mirror images, with no safe
  choice at this layer. Only the UID keeps the event history attached, so that is what it
  resolves to; the disagreement is logged for an admin.
- The address is compared case-insensitively, exact row first. Luma emails are stored
  lowercased and a Google Form answer is stored as typed, so an exact compare makes
  `Maria@ucla.edu` a second person. `Candidate.email` is unique but case-sensitive, so two
  rows differing only in case can both exist and both match: the **oldest wins**, and the
  collision is logged for someone to merge.
- A candidate found this way is **backfilled, never overwritten**: only fields that are
  empty on the existing row are filled in from the application.
- **Known hole, and the reason the conflict above is only bad data rather than a leak:**
  `GET /api/applications/:id` treats `application.studentId` - the UID as typed on the
  form - as proof of ownership, and then loads prior applications by the linked
  `candidateId`. So someone who types another person's UID can open the application *and*
  see that candidate's history. It is the ownership check that has to be fixed; no choice
  of candidate resolution closes it, because both directions of the conflict leak through
  the same door.

**One application per candidate per cycle:**
- People submit twice: once to a replaced form and again to the new one, or the same form
  twice. Sync used to dedupe only by Google's response id, so each became a second
  `Application`, Staging showed the person twice, and their decisions, comments,
  evaluations and signups split across the two rows. The rule now lives in
  [server/src/services/applicationResubmissions.js](server/src/services/applicationResubmissions.js);
  form sync and the cleanup script both call it and neither decides anything itself.
- Once the candidate is resolved, sync hands the response to `fileSubmission`, which takes
  `pg_advisory_xact_lock(hashtext(candidateId|cycleId))`, reads the candidate's
  application in the cycle inside the lock, and then either creates it or folds the
  response into it, all in one transaction. Every server runs sync on the same tick, and
  without the lock two first submissions from one person could both create. A folded
  response gets no second row, no referral or Luma claim (those ran for the first
  submission), and no second receipt. New responses are processed oldest first.
- **An identity conflict is never folded.** When the UID resolves to one candidate and the
  address belongs to another (`emailTaken` in `resolveCandidate`), the response is filed
  as its own application, as before, and a warning is logged. It may be someone else's
  submission under a mistyped UID; a duplicate an admin can see beats an application lost
  into the wrong person's row.
- A resubmission **replaces** the answers (every column `transformFormResponse` produces)
  only when it is later than the one on file and review has not started. Review has
  started when any review field is written (round past `1`, status past `SUBMITTED`,
  `approved`, any decision), when a resume, cover letter or video score exists for the
  candidate in the cycle (a cycle-less legacy score counts if written after the
  submission), when any `APPLICATION_DEPENDENTS` row points at the application (comment,
  flag, evaluation, case or client assignment, signup, live vote, decision email, review
  deliberation), or when the record is sealed. `resume_uploads` does not count: a portal
  resume replacement is the candidate's own act. The advisory lock does not stop a
  reviewer, so before `findReviewEvidence` reads this, `applyResubmission` takes
  `SELECT ... FOR UPDATE` on the application row and then the candidate row (always that
  order). A score, comment, flag, evaluation, assignment or signup inserted meanwhile
  needs FOR KEY SHARE on one of those rows for its foreign key, so it waits until the
  replacement commits. `decision_messages`, `review_delib_changes` and
  `review_delib_sessions` have no foreign key and are not held back; that gap is
  accepted. The write is still conditional on the review fields, so a decision written
  before the row lock is seen. Otherwise the response is **only recorded**: the
  application keeps its answers, because a reviewer must never find the resume they
  scored swapped underneath them.
- `Application.supersededResponseIds` holds every response a row absorbed or ignored;
  `responseID` is the one whose answers it holds. Sync treats both as already filed, and
  writes to it only with `push`. A replacement clears optional answers the new response
  left out, so an old `blindResumeUrl` (a form upload, not derived) never outlives the
  resume it matches. When a replacement lands on an application filed earlier in the same
  run, the receipt sweep's response id follows it, so that receipt still goes out once.
- Duplicates made before this are folded by
  `npm run merge-duplicate-applications` (`scripts/merge-duplicate-applications.js`).
  Dry run is the default and reads only; `--apply` writes. It touches one cycle
  (`--cycle=<id>`, default the candidate cycle), keeps the oldest row, and merges every
  review field onto it. Whose answers it keeps is `chooseContent`, and the dry run prints
  which branch decided:
  - a. Rows with review of their own (a written review field, or any dependent row other
    than `resume_uploads`). One: its answers. Several: the latest of them.
  - b. Otherwise, if documents were graded, the latest submission made before the first
    score's `createdAt` (the version graders opened), or the oldest row if every
    submission came after it.
  - c. Otherwise the latest submission.
- A group is skipped whole, and listed, when merging means choosing between two people's
  work or might fold in someone else: different values for one review field
  (`REVIEW_CONFLICT`), dependent rows a unique constraint would merge
  (`UNIQUE_COLLISION`), a portal resume history on a row whose answers are not kept
  (`RESUME_VERSIONS`), a client resume assignment on such a row (`CLIENT_RESUME`, since
  the client PDF route reads the linked application's resume), a row submitted under an
  address that is another candidate's `Candidate.email`, compared with `emailIdentityKey`
  (`IDENTITY_CONFLICT`), or a sealed candidate (`RECORD_LOCKED`).
- **A new table with an application id must be added to `APPLICATION_DEPENDENTS`** in the
  same change, with its unique constraints. The merge re-points those tables and then
  deletes the duplicate, so a missing one is orphaned or cascade-deleted. It also counts
  as review evidence unless it is the candidate's own data.
  `applicationResubmissions.schema.test.js` fails when `schema.prisma` has one the list
  lacks, and `--apply` refuses to start when the live database does.

**Site analytics:**
- Administration → Site Analytics (`/admin/analytics`): speed per user type, errors, and
  what needs attention. Everything lives in
  [server/src/services/analytics/](server/src/services/analytics/) and
  [client/src/analytics/](client/src/analytics/).
- User types are `roleOf()` in `roles.js`: ADMIN, MEMBER, CANDIDATE, TALENT (a `USER` with
  `isExternalTalent`), CLIENT, ANON. Every table and chart uses these, not `UserRole`.
- Four raw tables, written in batches by in-memory buffers (`buffer.js`, every 10s or 200
  rows, capped, never throwing): `analytics_request_samples` (14 days),
  `analytics_client_events` (30), `server_error_logs` (30), `security_events` (180).
  Retention is `RETENTION_DAYS` in `constants.js`. A failed write drops the batch and says
  so on the Errors tab; it never retries and never fails a request.
- `requestMetrics` is mounted right after `externalContainment`, so `req.user` is already
  known. It times every `/api` request (not `/api/health` or `/api/analytics`) and turns
  401-with-a-token, 403, 423, 429, scanner paths and impossible successes into security
  events.
- **Impossible successes come from `GUARD_TABLE` in `guardBypass.js`**: which user types may
  ever get a 2xx from each router. A success outside it is `GUARD_BYPASS_SUSPECT`,
  CRITICAL. Add a row, and a test, whenever you mount a new role-gated router. Only list a
  prefix whose router gates every route. Mixed-gate routers (`member.js` serves candidates
  on bare `requireAuth`) are anonymous-only rows at WARN.
- `installErrorCapture()` wraps `console.error` from `index.js` only, so the 500+ existing
  `console.error` calls feed the Errors tab without changing. Tests never get the wrapper.
  Code under `services/analytics/` logs through `logError` (the unwrapped original), or a
  failed analytics write would capture itself. `unhandledRejection` / `uncaughtException`
  record, flush for up to 1.5s, then exit(1) exactly as Node would.
- `expressErrorHandler` is the last middleware: uncaught route errors, body-parse and CORS
  failures now answer JSON (a 5xx never carries the message) instead of Express's HTML.
- Sign-in attempts are recorded by `routes/auth.js`; five failures for one address or one
  IP inside 15 minutes is one `BRUTE_FORCE` CRITICAL. Detected and shown, **not blocked**:
  there is still no rate limit on `/api/auth/login`.
- The browser tracker batches to `/api/analytics/events` with `fetch({ keepalive })`, which
  carries the bearer token even on page close; identity comes only from that token, never
  the body. A batch never spans a change of token, so views from before a sign-in are not
  handed to the new account. Clicks are one document listener, and **page text is treated
  as data**: names and votes are inside the buttons people click. The label is
  `data-track` if present; a link's normalized destination, never its text; nothing but
  the element kind inside a table row, list item or option; otherwise `aria-label` or text
  only if `looksLikeUiCopy` passes (short, no digits or `@`, no "Jane Doe"-shaped pair).
  Add `data-track="…"` to a button worth counting whose text is data, and `data-no-track`
  to anything that must not be recorded at all. Paths are
  normalized (ids, tokens, addresses replaced) on both ends and the query string is never
  read. `apiClient` reports failed and slow (>2s) calls; `ErrorBoundary` in `main.jsx`
  reports render crashes.
- Nightly at 02:15 Los Angeles (inside the `runCrons` block) `runRollup` rolls up yesterday
  **and** the day before into `analytics_daily_summaries` / `analytics_daily_facts`, then
  prunes. It is idempotent (delete then insert per day). `POST /api/admin/analytics/rollup`
  and the page's "Run rollup now" run the same thing. Today is always computed live.
- Raw SQL against these `timestamp(3)` columns must pass times as
  `${ts(date)}::timestamp` (`aggregate.js`). A JS `Date` is compared in the session's time
  zone: fine on Supabase (UTC), hours off on any other database.
- Kill switches: `ANALYTICS_DISABLED=1` (server), `VITE_ANALYTICS_DISABLED=1` (client).
- **Engagement tab** (`engagementQueries.js`): daily active users and 7/30-day reach per
  user type, sessions, top pages and clicks, and pages nobody opened. That last list is
  `KNOWN_PAGES` in `knownPages.js`, and `knownPages.test.js` fails when it falls behind
  the routes in `App.jsx`.
- **Security tab** (`securityQueries.js`): the live `posture.js` checklist, critical
  events first, suspicious activity grouped by source, every executive unlock and failed
  attempt (read from `exec_access_logs`), sign-ins per day, a filterable and paged access
  log, and the top offending IPs.

**Email click and open tracking (SES):**
- Uses SES's own tracking on the configuration set, not a redirect of ours, so
  deliverability is SES's concern. **One-time AWS setup:** SES → Configuration sets → the
  `SES_CONFIGURATION_SET` set → Event destinations → the SNS destination that already
  points at `SES_SNS_TOPIC_ARN` → tick **Click** and **Open**. Nothing changes on the
  webhook. Until then the Email tab says tracking is not reporting yet.
- `sendEmail` runs every message through `markUntrackedLinks`
  ([server/src/services/emailLinkTracking.js](server/src/services/emailLinkTracking.js)),
  which adds `ses:no-track` to any link that is itself a credential. That means the same
  `SECRET_PARAMS` the log redacts (reset, verify, invite tokens) plus unsubscribe links,
  so they never pass through `awstrack.me`. A new credential link needs no change, as long
  as its token is in one of those parameters.
- Every send carries an SES message tag `category` (the `COMMUNICATION_CATEGORIES` value),
  so events group by kind of email even when the log row is gone.
- `applySesEvent` writes each Click and Open to `email_engagement_events` (365 days). The
  row id is derived from the event, so SNS redelivering a notification counts once. A click
  moves the log row to `CLICKED`, which ranks above DELIVERED and below BOUNCED/COMPLAINED.
  An open never changes status, because `OPENED` already means an iMessage handed to
  Messages.
- Mail scanners (Proofpoint, SafeLinks, …) open every link on arrival. `isSuspectedBot`
  (`analytics/emailEngagement.js`) flags non-browser agents, known scanners and clicks
  within 3s of sending. Those clicks are stored, counted apart, and **do not** set
  `CLICKED`. Apple Mail prefetches open pixels, so treat opens as a floor and clicks as the
  signal.

**Key Services:**
- [server/src/services/referrals.js](server/src/services/referrals.js) - Referral name matching and claiming
- [server/src/services/documentGradingQueue.js](server/src/services/documentGradingQueue.js) - The Document Grading lists (member queue and admin view): who has graded what, read in parallel
- [server/src/services/syncResponses.js](server/src/services/syncResponses.js) - Syncs Google Forms → Applications table
- [server/src/services/syncEventResponses.js](server/src/services/syncEventResponses.js) - Syncs event RSVP/attendance forms
- [server/src/services/luma/ingestGuests.js](server/src/services/luma/ingestGuests.js) - Turns Luma guests into event rows; owns all Luma matching
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

**Talent accounts that belong to applicants:**
- A talent account has no UID, and `ProtectedRoute` sends it to `/talent/profile` from every
  page, interview sign-up included. An applicant ends up with one by signing up on the
  talent form, or by signing in with Google under an address their application does not use.
- Every rule is in [server/src/services/applicantAccounts.js](server/src/services/applicantAccounts.js).
  A talent account becomes the applicant's (`isExternalTalent: false`, `studentId` set) when
  an address it has **verified** is the applicant's, and every application under that UID
  is from that address (either UCLA spelling). This runs on Google sign-in, password
  sign-in and email verification. It does not run when another account already holds the
  UID, or when the talent account holds a talent-portal resume.
- The talent profile also asks for a UID ("Applied to UConsulting?"). A typed UID goes into
  `User.claimedStudentId` and **never** into `studentId`, which the candidate pages trust.
  It becomes `studentId` only once the 8-digit code mailed to the address on that
  application is entered (`POST /api/talent/uid`, `/uid/confirm`: 15 minutes, five tries).
  An account may try one UID a minute whatever the answer, and no answer names an
  address, so the endpoint is a slow way to learn which UIDs have applied. The code is
  left out of the communications log's preview.
- Every hand-over re-reads the addresses under the UID with the candidate row locked
  (`FOR UPDATE`), so an application filed from another address after the proof stops it.
- Changing the stored address (`PATCH /api/users/:id`) clears `emailVerifiedAt` and any
  pending verification link: verification proves one address, not whatever is stored later.
- `scripts/link-talent-accounts.js` links existing accounts by the same rule. Accounts it
  cannot link are listed with their reason, any applicant with the same name, and any
  typed UID. A name is not proof, so those are linked one at a time with `--link`.

**Ending a dead session:**
- `requireAuth` answers an expired or malformed token, a deleted user and a deactivated
  user with `401` + `code: 'SESSION_INVALID'`. That code is the only thing the client
  signs out on (`setSessionExpiredHandler` in [api.js](client/src/utils/api.js), registered
  by `AuthContext`), landing on `/login` with router state `{ sessionEnded }`. It acts
  only if the failed request carried the token still in use, so a late 401 from an old
  session never signs out a new one. A 401 without the code changes nothing, which is
  also how a new client behaves against an old server.
- Beside the code, `reason` (`expired`, `invalid`, `not-found`, `deactivated`) picks the
  login notice: `not-found` and `deactivated` say the account is no longer active, since
  signing in again cannot help; anything else, including no reason from an older server,
  says the session expired. `reason` never decides whether to sign out.
- `no-token` 401s and every `/api/auth/*` 401 (wrong password, `/verify`) carry **no**
  code on purpose: a request with no header has no session to end, and a wrong password
  must never look like a dead session.
- A user lookup that throws is `503 AUTH_UNAVAILABLE`, never a 401. A database blip must
  not sign out everyone mid-work.
- An expired token is expected and is not `console.error`ed (it would land in
  `server_error_logs` once per poll); any other bad token still is.
- A new route that answers 401 for any reason other than a dead session must not use
  `SESSION_INVALID`.

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

### Replacing a Cycle's Application Form

A cycle can take applications through more than one version of its form (e.g. the
first one ran out of space). Put the new form's editor link in **Form URL** and move
the old one to **Earlier form versions** in Cycle Management. `formUrl` is the
current version and the only one "Apply Here" links to; sync reads every link in
`previousFormUrls` too, so late submissions to the old form still arrive.

1. Share the new form with the service account as an **Editor**, or sync cannot read it.
2. Run `node scripts/inspect-form.js <editor link>`. Any question id not already in
   `form-config.json` needs a mapping there. Until both email and UID are mapped,
   sync skips that form's responses without storing them, so nothing is lost.

### Creating a New Interview Round

1. Admin creates `Interview` via Staging page or EventManagement
2. Assigns interviewers via `InterviewAssignment` (role: LEAD_INTERVIEWER, INTERVIEWER, OBSERVER)
3. Interviewers access via AssignedInterviews page
4. During interview, create `InterviewEvaluation` (or `FirstRoundInterviewEvaluation` for Round 1) with rubric scores
5. Deliberations: review all evaluations, make final decisions

### Email Notifications

Configured via environment variables `EMAIL_USER` and `EMAIL_PASS` (Gmail app-specific password).

Key notification types in [emailNotifications.js](server/src/services/emailNotifications.js):
- Application received (`application-received`): after each run, form sync sweeps the
  last 7 days of the cycle (by `submittedAt`) and sends it, without waiting, to everyone
  still owed one. [applicationReceipts.js](server/src/services/applicationReceipts.js)
  decides who that is and sends each one under an advisory lock. The communications log
  is the record: a person is owed one until an `APPLICATION_RECEIVED` row for their
  address in that cycle is not `FAILED`, or three have failed. That way a send lost to a
  deploy goes out on the next tick, and servers running at the same moment send one copy.
  The applications that run filed are passed by id as well, so one that syncs more than a
  week after it was submitted is still covered. The row is written *before* the send, as
  a FAILED "not sent yet" claim that `sendEmail` overwrites through its per-attempt
  `attemptKey`: a claim that cannot be written stops the send, because a row written
  only afterwards can be lost (`recordCommunication` swallows errors) and cause a resend.
  Only applications still waiting on a first decision (SUBMITTED/UNDER_REVIEW, round 1)
  are owed one.
  People who applied before it existed are sent it with
  `node scripts/send-application-received-backfill.js` (dry run; `--apply` sends). It
  goes through the same service, so it is safe to re-run or run beside sync.
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
- `LUMA_SYNC_TOKEN` - (Optional, and no longer the usual way) A bearer token the hourly
  Luma sync routine may authenticate with. The normal path is to generate one in
  **Event Management → Luma Sync Setup**, which stores it in `luma_sync_settings` and
  hands back the routine prompt with the token in it. Both are accepted, so a deployment
  set up the old way keeps working and generating one does not switch this off. Must be
  random and **at least 32 characters**: a shorter value, here or in the database, is
  treated as a placeholder somebody meant to replace, and `/api/integrations/luma` answers
  503 exactly as if it were unset. Read per request, so neither needs a redeploy.
- `UNSUBSCRIBE_SECRET` - (Optional) Signs Master Communications unsubscribe links;
  falls back to `JWT_SECRET`. Rotating it breaks every link already in an inbox.
- `MARKETING_DRIVE_FOLDER_ID` - (Optional) Drive folder the one-time mailing-list
  import uploads to. Share it with the service account as an **Editor**; read
  access is enough for every other Drive call this server makes, so a folder
  that works elsewhere can still fail here with `ACCESS_DENIED`.
- `DATABASE_CONNECTION_LIMIT` - (Optional, default 20) Prisma's pool size per server
  process. Against the Supabase transaction pooler each query holds a connection for
  several Render-to-Supabase round trips while Postgres itself is idle, so this, not
  the database, is what caps throughput under a burst. Every process on the database
  (each Render instance, each laptop) takes this many pooler client connections.
- `ANALYTICS_DISABLED` - (Optional) `1` stops Site Analytics recording anything on the
  server. The client's equivalent is `VITE_ANALYTICS_DISABLED=1` in `client/.env`.
- `RUN_CRONS` - (Optional) Scheduled jobs (form sync, scheduled sends, GTKUC reminders)
  run only where `CLIENT_URL` is not localhost and `IS_PULL_REQUEST` is not set, so a
  laptop or preview on the shared database never emails anyone its own links. `true`
  forces them on, `false` forces them off.

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
- **Tests never touch real services.** `server/vitest.setup.js` points `DATABASE_URL`, SES
  and Slack at addresses that refuse, before `config.js` loads `.env` (dotenv never
  overrides a set variable). A local `.env` is production's database and live SES keys,
  so a test that mocks only part of a send path used to write fake `SENT` rows into
  production's `communication_logs`. Mock what a test needs; do not undo the setup.
- **Scheduled sends are claimed before they send.** `processScheduledMessages` moves a
  schedule `PENDING → SENDING` with a conditional update and only the run whose claim
  lands sends it; every server on the database runs that cron each minute. While it
  sends it refreshes the schedule's `updatedAt` about once a minute; one silent for 15
  minutes shows as **Interrupted** and an admin may mark it failed. It is deliberately
  never resent automatically, and the campaign is linked first so Logs show who got it.

## Git Workflow Notes

**Vercel deploys `main` only.** `client/vercel.json` turns off automatic deployments for
every other branch (`deploymentEnabled`), so a PR gets no preview URL. Every push to every
branch used to build a preview, and on 2026-10-03 that used up the plan's 100 deployments
a day: Vercel then refused production deploys of `main` too, for 24 hours. A branch that
matches several patterns deploys if any one of them is `true`, which is how `main`
survives the two catch-alls (`*` does not match a branch name with a slash; `**` does).
To preview one branch, add it there as `true`.

Modified files in current session:
- [server/src/utils/eventDataMapper.js](server/src/utils/eventDataMapper.js) - Event response mapping logic

Active branch: `main`
