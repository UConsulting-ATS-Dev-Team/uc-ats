# ATS tutorial videos

Short tutorials on doing the work in the ATS, built with
[Remotion](https://www.remotion.dev). The app footage is the real client. It is
captured in Chromium as a series of still states and animated here with a
camera, a cursor and headlines. It does not rebuild the UI.

| id | Video |
|---|---|
| `grading` | Document Grading 101 |
| `coffee-chats` | Running a Coffee Chat |

## Rebuild one

Needs Node 22.18 or later: the scripts import the TypeScript timelines directly,
which relies on Node's built-in type stripping. Capture drives Chromium through
Playwright; on a machine without it, run `npx playwright@1.56.1 install chromium`
or set `CHROME_PATH` to a Chrome or Chromium binary.

```bash
cd video && npm install

# 1. The real client, with no server behind it.
(cd ../client && npx vite --port 5199)

# 2. Walk the flow and screenshot every state.
npm run capture -- grading     # writes public/shots/grading/ (+ states.json)

# 3. Compose the soundtrack from the same timeline.
npm run music -- grading       # writes public/music-grading.mp3

# 4. Render.
npm run render -- grading      # out/grading.mp4 + out/grading-thumb.png
```

`npm run studio` previews every video, and
`COMP=GradingTutorial npm run stills -- out/stills 500 900` renders single frames.

## How it fits together

- `src/kit/` is shared by every video: the timeline vocabulary
  (`walkBuilder`), the browser window, camera, cursor and rings, the intro and
  close, and the composition that plays a video's scenes in order.
- `src/videos/<id>/` is one video: `timeline.ts` (its walkthroughs, scene list,
  music plan and thumbnail frame), its explainer scenes and `index.tsx`, which
  is registered in `src/videos/index.ts`. The composition id is the id in
  PascalCase plus `Tutorial`.
- `scripts/flows/<id>.mjs` is the capture for that video. It answers every
  `/api` request itself from made-up sample data, so a capture never reaches a
  server or a database and no real applicant appears. Writes are stubbed.
- A video's `timeline.ts` is every click, keystroke, camera move and headline,
  in frames. The video and `scripts/make-music.mjs` both read it, so the click
  sounds and music hits stay on the cuts. If you change a scene length or move a
  click, re-run `npm run music -- <id>`.
- If the UI changes, re-run the capture. Timelines aim at element boxes
  recorded in `states.json`, not at hard-coded pixels, so most layout changes
  carry through on their own.
- Everything under `public/shots/`, the music and `out/` is generated and
  gitignored. `npm run render` refuses to run for a video with no captures, so a
  fresh checkout cannot render a placeholder by mistake.
- Copy the app owns (rubrics, the decision guide) is read from the server source by
  `scripts/server-source.mjs`, which checks its shape and stops the capture if it
  changed. Explainer scenes state shipped defaults; if an admin changes a rubric or
  the guide, the video still shows the defaults until it is re-rendered.

## Adding a video

1. `scripts/flows/<id>.mjs`: export `api({ path, req, json, route, url })`
   (answer with `json(...)` or `route.fulfill(...)`, leave the rest) and
   `run(kit)`, which drives the page and records states with `pageState`,
   `viewState` and `elState`. Optional `setup(kit)` runs before the first page.
2. `src/videos/<id>/timeline.ts`: `SCENES` (mark walkthrough scenes
   `walk: true`), `WALKS` (one builder per walkthrough scene), `music(walks)` and
   `THUMB_FRAME`.
3. `src/videos/<id>/index.tsx`: the explainer scenes and the bookends' copy,
   then add it to `src/videos/index.ts`.
