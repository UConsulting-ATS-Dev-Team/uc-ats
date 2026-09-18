# AGENTS.md

How agents work in this repo. For architecture, the data model, and route-by-route
detail, read [CLAUDE.md](CLAUDE.md) first. That file is the reference and it is kept
current; this file is the workflow and the repo-specific facts you need to execute it.
Do not copy architecture notes back into here. One stale mirror of CLAUDE.md already
lived at this path and every role, route, and env note in it had gone wrong.

## Workflow

Four beats, each backed by a skill.

1. **Isolate.** `/new-feature`. Fresh worktree branched from `origin/main`. Never build
   on `main`.
2. **Build.** `/code-structure`. Route handlers orchestrate the why and when, the
   service layer owns the reusable how. This repo already works that way: see
   `server/src/services/decisionProcessing.js`, which four admin endpoints share
   through one `processDecisionsForRound(n)` factory (`/process-decisions` is round 1,
   then `/process-coffee-decisions`, `/process-first-round-decisions`,
   `/process-final-decisions`), and `server/src/services/stagingDecisions.js`, which both the live
   vote and Staging's inline picker write through. Match that. A rule enforced in one
   route and not the other is the bug this beat exists to prevent.
3. **Prove.** `/evidence-driven-testing`. Capture the before state while the bug still
   reproduces, which is the cheapest moment you will get. Capture the after once it
   works. No claim in a PR body without evidence behind it.
4. **Ship.** `/before-and-after` builds the comparison table for anything with a visible
   surface. Then review, see below.

Run `/unslop` over anything a person reads: commit messages, PR title and body, doc
edits, code comments, the closing reply. Only over text you wrote or changed.

### The ship beat here

**Use `/greploop-apps`, not `/greploop`.** The Greptile app installed on this org is
`greptile-apps` (confirmed against `/orgs/UConsulting-ATS-Dev-Team/installations`).
`/greploop` posts `@greptile review`; `/greploop-apps` posts `@greptile-apps review`.
Only the second matches the installed app.

This matters more than a naming detail. GitHub linkifies any username-shaped string
whether or not it resolves, so a wrong handle renders as a mention, reaches nothing, and
the loop polls for a review that will never arrive until it times out. Rendering as a
mention proves nothing. `/greploop-apps` also carries a fallback that polls Greptile's
edited summary comment when no check run appears, so it degrades better here either way.

If someone verifies that plain `@greptile` also works on this install, record it here
with the evidence. Until then, treat `/greploop` as the wrong tool for this repo.

**Do not poll the Greptile check run.** Greptile auto-reviews a PR when it is
opened, and the skill's polling loop just burns a long-running command watching a
check that will finish on its own. Open the PR, let it review, then read the
findings where they land: the inline review comments on the PR, and the review
body. `gh api repos/{owner}/{repo}/pulls/<N>/comments` prints them.

The full review path on a PR:

1. `/code-review` locally, before you open the PR.
2. `/greploop-apps` until Greptile reports 5/5 with zero unresolved comments. Bounded at
   `--max-iterations` (default 10).
3. Oscar, each morning, against the Linear ticket that produced the PR. He reviews and
   cannot write code, by design. He works from the ticket, so a PR whose ticket is vague
   gets bounced as an intake defect rather than patched in review.

Greptile and Oscar are not redundant. Greptile reads the diff. Oscar reads the diff
against what the ticket asked for, which is the one thing a diff-level reviewer cannot
check. Run Greptile first so Oscar's pass is spent on that question and not on the
mechanical findings.

The Vercel bot posts the preview deployment on every PR. Use it for the `/before-and-after`
captures instead of running the app locally.

## Commands and checks

Run all three before opening a PR. From the repo root:

```bash
npm run install:all          # once, or after a dependency change
cd client && npm test        # vitest run
cd server && npm test        # vitest run
npm run build                # client production build
```

Database connectivity, when something looks like a connection problem:

```bash
cd server && npm run check-db
```

### Known-failing baseline

`server/src/services/offerLetter.test.js` has **2 tests that fail on any machine where
Supabase is configured**. They assert that the code throws when `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are absent, and they do not stub the environment, so a
populated `server/.env` makes them fail locally while they pass in CI.

A clean local run is therefore:

| Suite | Expected |
|---|---|
| client | 567 passed, 0 failed |
| server | 1066 passed, 2 failed, 9 skipped |

Two failures in that file are the baseline, not your regression. Anything else is yours.
Do not "fix" them by deleting the assertions; the fix is to stub the env in the test.

### The client suite is flaky in parallel

On a loaded machine the client suite fails a handful of tests per run, in
*different files each time* and never the same count. Observed in one sitting: 5
failures, then 0, then 1, then 23, then 2, all from the same unchanged tree, in
files such as `TalentPoolClients`, `AdminQuestionBank`, and `CandidateOnboarding`.
Every one of them passes in isolation. It is worker contention, not your change.

Before concluding you broke something, rerun without parallelism:

```bash
cd client && npx vitest run --no-file-parallelism
```

That run is the one to trust and it is green at 568/568. Never chase a client
failure without reproducing it that way first, and never "fix" a test that passes
alone.

## Hard invariants

Breaking one of these is a security or correctness defect, not a style disagreement.

- **Sealed records.** `Candidate.recordsLockedAt` seals a person's scores, evaluations,
  comments, and application. Any route returning any of that must go through
  `server/src/utils/lockedRecords.js`: single records answer `423 RECORD_LOCKED`, list
  rows redact to identity and set `locked: true`. A valid `X-Exec-Unlock` token is the
  only way past. A new route that reads those tables directly silently unseals them.
- **`USER` is two different people.** An applicant has a `Candidate` row. A talent-portal
  student does not. Both hold `role: 'USER'`. Branch on `User.isExternalTalent`, never on
  the role alone, on the server and in `ProtectedRoute` alike.
- **`User.password` is nullable.** Null means the account signs in with Google. Any code
  reading `password` must handle null, or Google accounts get told their password is
  wrong.
- **Email is stored lowercased**, with a unique index on `lower(email)`. Look users up
  case-insensitively. Two older routes used to store raw case; do not add a third.
- **Google sign-in refuses `email_verified !== true`.** Honouring an unverified Google
  email links whoever can assert an address into the account that holds it.
- **Decision processing sends no email.** The four decision endpoints advance,
  reject, or accept, and write a `DecisionBatch` an admin reviews and sends from Master
  Communications. Do not add a send call into that path.
- **Live votes are anonymous to everyone.** `live_vote_votes` stores an HMAC of ballot
  plus user, never a user id. An open ballot's yes/no split never goes to the client,
  only the count of who has voted. Every session change bumps `version` under a row lock.
- **The server never sends an iMessage.** It lists reachable members and logs the send.
  Delivery happens in the admin's own Messages app through an `sms://` link.

## Environment

- `DATABASE_URL` is the Supabase session pooler on **port 6543** and the app runs on it
  fine.
- `DIRECT_URL` **carries a stale password.** This is why `prisma migrate dev` and
  `migrate deploy` both fail here while the app works. Prisma reports it as invalid
  credentials, not as a network error.
- **Port 6543 is pgbouncer in transaction mode and the Prisma CLI cannot use it at all.**
  It fails with a misleading "can't reach database server". Use port **5432** for CLI
  work.
- Applying a migration by hand, and writing `migration.sql` so it is safe to re-run
  (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, `DROP TRIGGER IF EXISTS`), is documented
  step by step in CLAUDE.md. Step 2 has no transaction wrapper, so a half-applied file
  has to survive a second run.
- **After switching branches, both commands, in order:**
  ```bash
  cd server && npx prisma generate   # rewrite the client from this branch's schema
  touch src/index.js                 # force nodemon to reload it
  ```
  Regenerating alone does nothing to a running server. The symptom is `P2022`, a column
  that exists only in the other branch's schema.
- `GOOGLE_OAUTH_CLIENT_ID` must equal `VITE_GOOGLE_CLIENT_ID` in `client/.env`. The
  server checks it as the ID token audience. Unset means `/api/auth/google` answers 503
  and the button does not render; password sign-in still works.

## What cannot be tested locally

Cover these with unit tests against stubs and say plainly in the PR that the live path
was not exercised.

- Google Forms and Drive sync. Needs the service account, and Drive files must be shared
  with the address in `google-cloud-key.json`.
- Outbound email through nodemailer.
- iMessage send, which opens the local Messages app and cannot run headless.
- Supabase storage paths, including the offer-letter upload above.
- The 5-minute sync cron, which only runs on a started server.

## Multi-agent rules

- Never commit to `main`. Never force-push to `main`.
- Only `--force-with-lease`, only on your own task branch.
- One worktree and one branch per task. Never touch another agent's worktree, branch, or
  uncommitted work.
- **Scope check before starting.** Skim open PRs' changed files (`gh pr list`,
  `gh pr diff <n> --name-only`) and look for uncommitted work in shared checkouts. On
  overlap, stop and ask.
- Resolve lockfile conflicts by regenerating, never by hand-merging.
- Worktrees do not isolate shared resources. Confirm a dev server port answers *your*
  process before trusting it, and never run schema experiments against the shared
  database. There is one database and it is the real one.
- If a conflict cannot be resolved confidently, stop and report instead of guessing.

## Completing a task

1. Keep changes to the assigned task.
2. Run the three checks above. Compare against the known-failing baseline.
3. Assemble the evidence you captured into before/after pairs.
4. Commit, rebase onto the latest `origin/main`, rerun the checks.
5. Push (`git push -u origin <branch>`; after rebasing an already-pushed branch,
   `--force-with-lease`).
6. Open the PR. The body explains what changed, how it was tested with evidence behind
   each claim, before/after proof, and any risk or follow-up. Run the title and body
   through `/unslop` first.
7. Run `/greploop-apps` until Greptile reports 5/5 with zero unresolved comments.
8. End by presenting the PR URL.

Do not merge unless told to. Keep the worktree until the PR is merged or closed.
