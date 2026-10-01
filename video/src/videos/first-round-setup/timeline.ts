// Setting Up a First Round: every click, camera move and headline, in frames.
// Captured by scripts/flows/first-round-setup.mjs.
import { APP_W, SIDEBAR_W, mid, pad, sceneClock, walkBuilder, type Box, type MusicPlan, type States, type Walkthrough } from "../../kit/timeline.ts";

export { FPS } from "../../kit/timeline.ts";

const ROOM = "/member/first-round-interview?interviewId=…&groupIds=…";

/**
 * The resume bullet the candidate question comes from ("…cutting restocking time
 * from 3 days to 1"), inside the preview. The PDF is drawn by Chromium's viewer, so
 * there is no DOM box to record; this is measured off the capture, and the sample
 * resume and pinned Chromium render it in the same place every time.
 */
const PANTRY_LINE = { x: 318, y: 334, width: 590, height: 32 };

export function buildWalkthrough(S: States): Walkthrough {
  const k = walkBuilder(S, "/assigned-interviews");
  const { box, st, page, dialog, camOn, camZoom, camTo, camReset, scrollTo, scrollFor, move, ring, head, press, type, chime, done } = k;
  const count = (name: string) => (S[name] as unknown as { count: number }).count;
  const modalZoom = (f: number, state: string, z = 1.45, dur = 16) => {
    const s = st(state);
    camTo(f, (s.x ?? 0) + s.w / 2, (s.y ?? 0) + s.h / 2, z, dur);
  };

  // ---------- 1. My Interviews ----------
  head(0, 165, "Step 1", "Open it in My Interviews", [3, 4]);
  page(0, "mine");
  ring(16, box("mine", "navMine"), 30);
  ring(50, pad(box("mine", "badge"), 4), 30);
  // The page column, not the title: centring on the title crops the card's left edge.
  camTo(84, (SIDEBAR_W + APP_W) / 2, mid(box("mine", "title")).y + 40, 1.35, 26);
  move(92, { x: 1100, y: 420 });
  camReset(150, 16);

  // ---------- 2. Read the resume ----------
  head(165, 435, "Step 2", "Read each resume before you write anything", [2]);
  scrollTo(170, 204, scrollFor("mine", "groups", 160));
  press(222, box("mine", "group1"), "hand", undefined, 22);
  page(228, "mine-group");
  camOn(254, pad(box("mine-group", "cand1"), 60), 1.6, 22);
  press(276, box("mine-group", "resume1"), "hand", undefined, 18);
  dialog(282, "resume");
  camReset(292, 10);
  const r = st("resume");
  const line: Box = { ...PANTRY_LINE, x: PANTRY_LINE.x + (r.x ?? 0), y: PANTRY_LINE.y + (r.y ?? 0) };
  camTo(330, mid(line).x, mid(line).y + 40, 1.6, 34);
  ring(340, line, 80);
  move(346, { x: line.x + line.width - 40, y: line.y + line.height + 14 });
  camReset(410, 18);
  press(424, box("resume", "close"), "hand", undefined, 14);
  dialog(430, null);

  // ---------- 3. Start Interview ----------
  head(435, 615, "Step 3", "Start Interview and pick your room", [0, 1, 5]);
  scrollTo(440, 470, scrollFor("mine-group", "start", 640));
  camZoom(484, box("mine-group", "start"), 1.4, 14);
  press(496, box("mine-group", "start"), "hand", undefined, 20);
  dialog(502, "pick");
  camReset(510, 10);
  modalZoom(526, "pick", 1.5);
  press(544, box("pick", "opt1"), "hand", undefined, 18);
  dialog(549, "pick-1");
  press(586, box("pick-1", "go"), "hand", undefined, 18);
  dialog(592, "setup", true);
  modalZoom(604, "setup", 1.45, 12);

  // ---------- 4. Shared questions ----------
  head(615, 945, "Step 4", "Add the questions everyone in the room gets", [2, 3]);
  ring(624, box("setup", "intro"), 40);
  let f = 676;
  let prev = "setup";
  for (let i = 1; i <= 2; i++) {
    press(f, box(prev, "add"), "hand", undefined, 18);
    dialog(f + 5, `setup-q${i}-focus`);
    const n = count(`setup-q${i}-count`);
    for (let j = 0; j < n; j++) type(f + 14 + j * 3, `setup-q${i}-${j}`);
    prev = `setup-q${i}-${n - 1}`;
    f += 14 + n * 3 + 26;
  }
  ring(f - 10, box(prev, "q2"), 30);

  // ---------- 5. One for a single candidate ----------
  head(945, 1290, "Step 5", "Then one just for them, from their resume", [7]);
  press(960, box(prev, "taylor"), "hand", undefined, 20);
  dialog(966, "setup-taylor", true);
  ring(980, box("setup-taylor", "perHead"), 36);
  press(1024, box("setup-taylor", "taylorInput"), "text", undefined, 18);
  const nt = count("setup-t-count");
  for (let j = 0; j < nt; j++) type(1032 + j * 3, `setup-t-${j}`);
  const lastT = `setup-t-${nt - 1}`;
  press(1032 + nt * 3 + 18, box(lastT, "taylorAdd"), "hand", undefined, 16);
  const saved = 1032 + nt * 3 + 24;
  dialog(saved, "setup-taylor-saved");
  chime(saved);
  ring(saved + 6, pad(box("setup-taylor-saved", "taylorSaved"), 4), 50);

  // ---------- 6. Into the room ----------
  head(1290, 1530, "Step 6", "Configure Questions takes you in", [0, 1]);
  press(1300, box("setup-taylor-saved", "go"), "hand", undefined, 20);
  dialog(1306, null);
  scrollTo(1306, 1307, 0);
  page(1307, "room", ROOM);
  camReset(1312, 8);
  scrollTo(1336, 1376, scrollFor("room", "q1Head", 260));
  ring(1390, pad(box("room", "q1Head"), 6), 40);
  ring(1420, pad(box("room", "candHead"), 6), 40);
  camZoom(1440, box("room", "taylorQ"), 1.6, 24);
  ring(1446, pad(box("room", "taylorQ"), 6), 50);
  camReset(1516, 14);

  return done(1530);
}

// ---------- the whole video ----------
export const SCENES = [
  { name: "Intro", frames: 150 },
  { name: "Two kinds", frames: 225 },
  { name: "Walkthrough", frames: 1530, walk: true },
  { name: "Close", frames: 150 },
] as const;

export type SceneName = (typeof SCENES)[number]["name"];
const clock = sceneClock(SCENES);
export const TOTAL_FRAMES = clock.total;
export const sceneStart = (name: SceneName) => clock.start(name);

/** The frame the thumbnail is taken from: the title, fully in. */
export const THUMB_FRAME = 110;

export const WALKS: Record<string, (S: States) => Walkthrough> = { Walkthrough: buildWalkthrough };

/** Drums step out while the resume is read and the candidate question is typed. */
export function music(): MusicPlan {
  const W0 = sceneStart("Walkthrough");
  return {
    slams: [0, 60, 75, 90],
    breaks: [
      [W0 + 282, W0 + 430],
      [W0 + 1024, W0 + 1110],
    ],
  };
}
