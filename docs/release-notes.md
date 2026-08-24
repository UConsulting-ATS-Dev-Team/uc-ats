# ATS release notes

## Storage choice and tradeoffs

The What's New pages use curated JSON content sources plus read-only APIs protected by role-based authorization:

- `server/data/release-notes.json` — admin audience (`/admin/release-notes`)
- `server/data/release-notes-member.json` — member audience (`/member/release-notes`)
- `server/data/release-notes-candidate.json` — candidate audience (`/candidate/release-notes`)

### Why a versioned JSON file

- **Cycle portability**: Release history is not tied to a single recruiting cycle. Entries can optionally reference a cycle, but the files live in source control and are deployed with the app, so the full history is available in every cycle.
- **No schema migrations**: Because the data is static JSON, adding a release note does not require a database migration or direct database access. This keeps the surface small and avoids touching live production data.
- **Curated by default**: Each entry is hand-written and reviewed before it ships, which prevents exposing internal implementation details, credentials, security fixes, or unfinished work.
- **Simple audit trail**: Git history shows who added or edited an entry and when.

### Tradeoffs

- **No admin UI for publishing**: Adding an entry requires editing a JSON file and committing it. This is intentional to keep the release-review gate explicit.
- **No per-user unread persistence across devices**: The "New" indicator is based on `releaseDate` within the last 14 days and is hidden when a user marks an entry as read. Read state is stored in `localStorage`, so it is device-specific. This was accepted as a practical minimum.

If the team later needs per-user read tracking across devices, a small `ReleaseNoteRead` table (userId + noteId + readAt) can be added without changing the JSON source.

## Content schema

Each entry in any release-notes JSON file must be an object with these fields:

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Stable, URL-safe identifier (e.g., `2026-07-28-admin-release-notes`). Must be unique within the file. |
| `releaseDate` | yes | ISO date string `YYYY-MM-DD`. Must be today or earlier; future dates are rejected. Used for sorting newest-first. |
| `title` | yes | Short, user-facing title. |
| `summary` | yes | One or two sentence operational summary. |
| `details` | no | Longer implementation or operational notes. Supports line breaks via `\n`. |
| `category` | no | One of `feature`, `enhancement`, `fix`, `policy/operations`, `breaking change`. |
| `affectedArea` | no | Free-text area such as "User management" or "Document grading". |
| `status` | no | One of `new`, `updated`, `resolved`. Helps distinguish active work. |
| `links` | no | Array of `{ label, url }` objects pointing to GitHub issues, docs, or process maps. URLs must be valid. |

## Audience classification

For every merged PR that ships a user-observable change, decide which audience(s) it affects. A single PR may affect more than one audience.

- **Admin** — changes visible only to `ADMIN` users (user management, cycle management, staging, review-team assignment, etc.).
- **Member** — changes visible to `MEMBER` users (document grading, review teams, interview scheduling, GTKUC, case management, member dashboard, etc.).
- **Candidate** — changes visible to `USER` (candidate) accounts (application status, events/RSVP, interview prep resources, candidate dashboard, etc.).
- **None** — pure backend/infra/refactor/dependency/CI change with no user-observable behavior. No What's New entry required.

Write one tailored entry per affected audience. Do not copy-paste the same engineering summary across files; each entry should be written for that audience.

## Files and routes

| Audience | Data file | API route | Page route | Nav location |
|----------|-----------|-----------|------------|--------------|
| Admin | `server/data/release-notes.json` | `GET /api/admin/release-notes` | `/admin/release-notes` | Admin sidebar |
| Member | `server/data/release-notes-member.json` | `GET /api/member/release-notes` | `/member/release-notes` | Member sidebar |
| Candidate | `server/data/release-notes-candidate.json` | `GET /api/candidate/release-notes` | `/candidate/release-notes` | Candidate sidebar |

## Process for adding a release entry

1. In the PR that ships the change, open the data file(s) for each affected audience.
2. Add a new object to the top of the relevant array(s).
   - Use the current or past ISO date for `releaseDate` (future dates are rejected by validation).
   - Choose the most specific `category` and `status` values.
   - Write the `summary` and `details` for the target audience, not an engineering audience. Avoid internal/security details.
   - Use the actual merged/deploy date of the change. If you cannot verify a date, do not seed it; add the entry after the change ships.
3. Validate the file(s) before committing:
   - `npx jsonlint server/data/release-notes.json`
   - `npx jsonlint server/data/release-notes-member.json`
   - `npx jsonlint server/data/release-notes-candidate.json`
   - `cd server && npx vitest run src/services/releaseNotes.test.js` validates schema, uniqueness, and dates.
   - `cd server && npx vitest run src/routes/releaseNotes.test.js` checks the API surface.
4. Commit the file(s) as part of the change PR.
5. After deployment, affected users will see the new entry at **What's new** in their sidebar.

Do not generate entries automatically from raw commit messages or pipeline logs. Release notes must be reviewed operational summaries.
