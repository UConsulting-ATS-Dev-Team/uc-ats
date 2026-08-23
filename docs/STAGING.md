# Staging environments for pull requests

Every pull request gets its own private copy of the ATS — its own URL, its own
database, its own sample data. Render posts the link on the PR. Nothing you do
in a staging environment can touch real applicant data.

---

## For reviewers (no setup, no technical knowledge needed)

1. Open the pull request on GitHub.
2. Wait for the Render bot to comment with a link (first build takes ~5 minutes).
3. Click it, log in with the shared staging credentials from the team password
   manager, and click around.
4. Leave your feedback as a PR comment.

The environment deletes itself after 7 days without activity, and is rebuilt
automatically every time the PR author pushes a change.

### What deliberately does not work in staging

These are switched off on purpose so a test environment can never affect a real
candidate. They are not bugs — don't report them:

| Area | Behaviour in staging |
| --- | --- |
| Emails (acceptances, rejections, password resets) | Never delivered. The action succeeds and the send is logged and skipped. |
| Google Forms sync | Never runs. Applications come only from the seeded sample data. |
| Resumes, cover letters, headshots | Placeholder links. Document viewers will look empty or broken. |
| Slack notifications | Not sent. |
| Feature-request submissions | No GitHub issue is filed. |

Everything else — logins, cycles, review teams, grading, interviews,
deliberations, events — behaves like the real thing.

---

## One-time setup (technical, once per Render workspace)

Preview environments require a **Pro workspace plan** on Render. Each running
preview bills the `starter` web service plus a `basic-256mb` Postgres, prorated
by the second, and expires after 7 idle days.

### 1. Create the shared secrets group

In the Render Dashboard: **Env Groups → New Environment Group**, named exactly
`uc-ats-staging-secrets`.

> Create it **in the Dashboard, not in `render.yaml`.** An env group declared in
> the same blueprint that manages previews gets duplicated — empty — into every
> preview environment, and the secrets silently arrive blank.

Add these keys:

| Key | Purpose |
| --- | --- |
| `SEED_ADMIN_EMAIL` | The login handed to reviewers |
| `SEED_ADMIN_PASSWORD` | Its password — store in the team password manager |
| `SUPABASE_URL` | Realtime interview chat (use a non-production project) |
| `SUPABASE_SERVICE_ROLE_KEY` | " |
| `VITE_SUPABASE_URL` | Browser-side Supabase; inlined into the bundle at build |
| `VITE_SUPABASE_ANON_KEY` | " — anon key only, never the service role key |

Leave AWS/SES, Google, Slack and GitHub keys **out** of this group. Their absence
is what disables the integrations listed in the table above.

### 2. Create the blueprint

**Blueprints → New Blueprint Instance**, select this repo, and Render reads
`render.yaml` from the root. Approve the plan and let the first deploy finish.

That's it. From then on, opening a PR creates an environment automatically.

### Controlling when environments are created

- Skip one PR: put `[skip preview]` in the PR title.
- Switch to opt-in for all PRs: set `previews.generation` to `manual` in
  `render.yaml`; environments are then created only for PRs whose title contains
  `[render preview]`.

---

## How it fits together

The blueprint deploys **one** web service that serves both the API and the built
React app, rather than mirroring the production Vercel-frontend/Render-API split.

That is a deliberate constraint, not a simplification: Render cannot template a
static site's rewrite rules per preview environment, so a split layout would
leave every preview's frontend calling whichever backend URL was hardcoded at
build time — the production one. Serving the SPA from Express keeps the client's
relative `/api` calls pointing at their own environment, removes CORS from the
picture, and gives reviewers one link instead of two.

Three things in the app support this, all inert outside a Render preview:

- `server/src/index.js` serves `client/dist` with an SPA fallback, but only when
  that directory exists — so local `npm run dev` is unaffected.
- `server/src/config.js` derives `BASE_URL`/`CLIENT_URL` from Render's
  `RENDER_EXTERNAL_URL`, guarded on `IS_PULL_REQUEST` so production keeps using
  its own explicit values.
- `server/scripts/seed-preview.js` runs once per environment via
  `initialDeployHook`. Render creates preview databases empty, so without it a
  reviewer would land on a login page with no account to log in with.

**Production is not managed by this blueprint.** The existing Vercel frontend and
`uc-ats.onrender.com` API are untouched by it.
