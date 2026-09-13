# Interview slot signup — manual test plan

Written for a human clicking through the real UI. Automated tests cover the
allocation logic and the concurrency; what they cannot cover is whether the
screens tell the truth.

**Setup once before you start**

1. `npm run dev` from the repo root (client on 5173, server on 3001).
2. Sign in as an admin. You need at least one **active recruiting cycle**.
3. You need candidates sitting in the right round. Coffee chat sessions draw
   `currentRound = 2`; first round draws `currentRound = 3`. Staging is where
   you move people between rounds.
4. Have two candidate logins available. Two browsers, or one plus an incognito
   window — you will need them booking at the same time.

Legend: **A** = admin, **C** = candidate, **M** = member.

---

## 1. Creating sessions

| # | Do this | Expect |
|---|---|---|
| 1.1 | **A** → Assigned Interviews → expand a Coffee Chat interview | A "Roster" section appears above everything else, offering to set up sessions |
| 1.2 | Leave the day blank, press **Create sessions** | Refuses with "Pick the day these sessions run" — nothing is created |
| 1.3 | Pick a day **at least 2 days out**, keep the two default blocks, set seats to **2** each, create | Two columns appear: Morning Block and Afternoon Block, each `0 / 2` |
| 1.4 | Expand a **First Round** interview, switch to **Back-to-back sessions**, 11:00→17:00, 60 minutes, 4 candidates | The preview reads "6 sessions, 24 seats" before you commit |
| 1.5 | Create them | Six narrow columns appear, headed by **time ranges** rather than names |
| 1.6 | Compare the two interviews | Two wide columns vs six narrow ones — same component, different density |

> Use a day at least 2 days out. The 12-hour cutoff will block candidate
> changes on anything sooner, and you will think it is a bug.

## 2. A candidate books a time

| # | Do this | Expect |
|---|---|---|
| 2.1 | **C** (round 2) → sign in | "Interview Scheduling" is in the left nav |
| 2.2 | Open it | Both blocks listed, each showing `2 left` |
| 2.3 | Press **Book this time** on Morning | Green confirmation naming the block, the day and the time |
| 2.4 | Check the candidate's inbox | A confirmation email with the session, time and location |
| 2.5 | Reload the page | Still booked — a green "You are booked for…" banner, not a fresh picker |
| 2.6 | **A** → refresh the roster | That candidate is now a card in the Morning column, which reads `1 / 2` |

**Time zone.** The time on the candidate page, the time in the email, and the
time in the admin gallery must all be **the same Pacific time**. If your laptop
is on another zone, that is the case worth checking hardest.

## 3. The waitlist is an upgrade, not a downgrade

This is the heart of the feature. A candidate who misses out must never end up
with nothing.

| # | Do this | Expect |
|---|---|---|
| 3.1 | Fill Morning to `2 / 2` with two candidates | Morning shows **Full** on the candidate page — still listed, not hidden |
| 3.2 | **C3** (a third candidate) → press **Join waitlist** on Morning | A message saying they were booked into the next available session and waitlisted for their first choice |
| 3.3 | Read the banner on their page | Leads with **"You have a confirmed spot"**, then explains the waitlist and says the move happens automatically |
| 3.4 | **A** → roster | C3 appears **twice**: a confirmed card in Afternoon, and a card in Morning's "Waiting" tray marked **"Holding a seat elsewhere"** |
| 3.5 | **C1** (in Morning) → **Cancel this booking** | Cancels cleanly |
| 3.6 | **A** → refresh roster | C3 has been **promoted into Morning**, and their Afternoon card is gone. No admin action was needed |
| 3.7 | Check C3's inbox | An email telling them they got their preferred time |

> 3.6 is the single most important assertion in this document. If the promotion
> did not happen, the waitlist is decorative.

## 4. Everything is full

| # | Do this | Expect |
|---|---|---|
| 4.1 | Fill **both** blocks to capacity | Both show Full |
| 4.2 | A further candidate tries to book either one | A message that recruitment has been notified and will be in touch — **not** a dead end, and **not** a silent waitlist |
| 4.3 | Check the recruitment inbox (`RECRUITMENT_EMAIL`, or the reply-to address) | An alert naming the candidate and the interview |
| 4.4 | **A** → roster | A **red band at the top**: "1 candidate could not be scheduled" |
| 4.5 | Drag that candidate into a session, or use their card menu | Prompted that the session is full; confirm with **Move anyway** |
| 4.6 | After the move | They are a normal confirmed card, the session shows an **Over capacity** warning, and the red band is gone |

## 5. Admin overrides

| # | Do this | Expect |
|---|---|---|
| 5.1 | Drag a card from one column to another | It moves immediately, before the server replies |
| 5.2 | Open a card's **⋮** menu | "Move to …" for every other session, plus Remove |
| 5.3 | Move someone into a session that is already full | The "This session is full" dialog, naming the session and the counts |
| 5.4 | Press **Cancel** in that dialog | Nobody moves |
| 5.5 | Redo it and press **Move anyway** | The move lands and the session is flagged over capacity |
| 5.6 | Reload the whole page | The over-capacity warning is **still there** — it is a state, not a one-time toast |
| 5.7 | Remove a candidate from a session that has a waitlist | Confirm prompt, then the top of that waitlist is promoted automatically |
| 5.8 | Type a name into **Find a candidate** | Non-matching cards **fade but stay in place** — you can still see which session everyone is in |
| 5.9 | Try to move a candidate into a session **less than 12 hours away** | An admin is allowed to. (A candidate is not — test 7.2) |

## 6. The unscheduled tray

| # | Do this | Expect |
|---|---|---|
| 6.1 | Ensure a candidate in the round has booked nothing | **A** → roster shows them under **"Not scheduled"** at the bottom |
| 6.2 | Click their chip | They are placed into the first session with room |
| 6.3 | After they book themselves | They disappear from "Not scheduled" |

> This is the question the old page could not answer at all. If the count looks
> wrong, check the candidate's `currentRound` matches the interview type —
> coffee chat draws round 2, first round draws round 3.

## 7. Changing and cancelling

| # | Do this | Expect |
|---|---|---|
| 7.1 | **C** → press **Switch to this time** on another session | Moves atomically — at no point are they unbooked |
| 7.2 | Move a session to **under 12 hours away** (admin), then load the candidate page | Buttons disabled, and a note saying changes are locked within 12 hours |
| 7.3 | **C** → cancel a booking | Confirm prompt, then the picker returns |
| 7.4 | Book again after cancelling | **Allowed.** A cancel must not lock someone out of the interview |

## 8. Decision emails

| # | Do this | Expect |
|---|---|---|
| 8.1 | **A** → Staging → process decisions for a round that advances people | A decision batch is created; no email is sent yet |
| 8.2 | Master Communications → Decisions → open the ADVANCED wording | The merge-field list includes `{{schedulingLink}}` with a note about the fallback |
| 8.3 | **Preview** an advancing email | A link is shown, not a dead one and not raw Markdown |
| 8.4 | Send a test to yourself, with sessions configured for that round | "Choose your time now" links to the signup page |
| 8.5 | Delete every slot for that round, then preview again | Falls back to "Scheduling details are on their way." — never a link to an empty page |
| 8.6 | Follow the link while signed out | Login, then land on the scheduling page |

> **Known and intended:** a batch created *before* this release keeps its old
> wording, because templates are copied into the batch when it is created.
> Process a fresh batch to see the link.

## 9. Members staffing sessions

| # | Do this | Expect |
|---|---|---|
| 9.1 | **M** → Member Dashboard, scroll to the bottom | "Interview Signup" listing sessions with candidate counts |
| 9.2 | **Sign up to run this** | Marked "You're on this"; your name appears as a chip |
| 9.3 | Try to take a session that **overlaps** one you already have | Refused — nobody can be in two rooms at once |
| 9.4 | Take a session past its interviewer target | Allowed, with a note that it now has more interviewers than it needs |
| 9.5 | **A** → roster for the same interview | Your name shows against that session |
| 9.6 | **Drop this session** | Confirm prompt, then you are removed |

## 10. Nothing else broke

The riskiest part of this change is the roster moving out of the JSON blob.
These are the regressions to watch for.

| # | Do this | Expect |
|---|---|---|
| 10.1 | **A** → expand a **Final Round** interview | The **old** group editor — member groups, application groups, assignments. Unchanged |
| 10.2 | Add and save a group there | Saves as before |
| 10.3 | Open a **past cycle's** interview | Its groups still render |
| 10.4 | Start a first round interview from the page and add **behavioral questions** to a group | They save |
| 10.5 | Leave and re-enter that interview | **The questions are still there.** This is the one that fails silently if the group-id mapping is wrong |
| 10.6 | **C** → Get to Know UC | GTKUC booking still works, and the 12-hour copy reads correctly |

## 11. Two people, one seat

Worth doing once by hand even though it is covered by automated tests.

| # | Do this | Expect |
|---|---|---|
| 11.1 | Make a session with **exactly 1 seat** | Shows `1 left` |
| 11.2 | Two candidates in two browsers, both on the page, click **Book** as close to simultaneously as you can | Exactly one succeeds. The other is told it is full, or is waitlisted and given a fallback seat |
| 11.3 | **A** → roster | The session holds **exactly one** candidate. Never two |
| 11.4 | `GET /api/admin/interviews/<id>/roster/integrity` as an admin | `{"ok": true, "problems": []}` |

---

## If something looks wrong

- **Roster empty for an interview that should have people** — its existing
  roster is still in the JSON blob. The backfill has not been run:
  `cd server && node scripts/backfill-interview-slots.js --dry-run`
- **Candidate sees no sessions** — check their `currentRound` against the
  interview type (coffee chat ← round 2, first round ← round 3).
- **Times look an hour off** — report it with your machine's time zone. The
  whole app renders `America/Los_Angeles` on purpose.
- **An email never arrived** — the booking still succeeded; check the roster.
  Failed sends are recorded rather than lost, and can be resent.
- **Anything about seats not adding up** — run 11.4 first and paste the result.
