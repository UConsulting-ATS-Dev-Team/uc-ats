## Summary

<!-- One or two sentences describing what this PR changes. -->

## Audience classification

<!-- Check every audience this PR affects. A change can affect multiple audiences. -->

- [ ] Admin
- [ ] Member
- [ ] Candidate
- [ ] None / not user-facing

## What's New entry

<!-- If the PR is user-facing, add a tailored release note entry for each checked audience above. -->

- [ ] I added/updated `server/data/release-notes.json` for Admin changes
- [ ] I added/updated `server/data/release-notes-member.json` for Member changes
- [ ] I added/updated `server/data/release-notes-candidate.json` for Candidate changes
- [ ] N/A — no user-observable change

## Validation

- [ ] `npx jsonlint server/data/release-notes.json` (if Admin checked)
- [ ] `npx jsonlint server/data/release-notes-member.json` (if Member checked)
- [ ] `npx jsonlint server/data/release-notes-candidate.json` (if Candidate checked)
- [ ] Server and client tests pass (`cd server && npm test`, `cd client && npm test`)

## Notes

<!-- Any additional context, risks, or follow-up work. -->
