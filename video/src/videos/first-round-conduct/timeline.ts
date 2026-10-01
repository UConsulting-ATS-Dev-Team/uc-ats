// Running a First Round: every click, camera move and headline, in frames.
// Captured by scripts/flows/first-round-conduct.mjs. Edits in the grid are viewport
// shots at one scroll position (gridScroll); each rotation's page states are full pages,
// so the camera can scroll back up to Next Rotation and Save All.
import { pad, sceneClock, walkBuilder, type MusicPlan, type States, type Walkthrough } from "../../kit/timeline.ts";

export { FPS } from "../../kit/timeline.ts";

const ROOM = "/member/first-round-interview?interviewId=…&groupIds=…";

export function buildWalkthrough(S: States): Walkthrough {
  const k = walkBuilder(S, ROOM);
  const { box, page, camOn, camZoom, camReset, scrollTo, ring, head, press, typePage, chime, done } = k;
  const count = (name: string) => (S[name] as unknown as { count: number }).count;
  const grid = (S.gridScroll as unknown as { y: number }).y;
  /** Type into a field, one captured view per keystroke batch; returns the last state. */
  const typing = (f: number, prefix: string, step = 3) => {
    const n = count(`${prefix}count`);
    for (let i = 0; i < n; i++) typePage(f + i * step, `${prefix}${i}`);
    return { last: `${prefix}${n - 1}`, end: f + n * step };
  };

  // ---------- 1. The room ----------
  head(0, 180, "Step 1", "Your room opens on Behaviorals", [4]);
  page(0, "r1");
  ring(20, pad(box("r1", "tracker"), 4), 40);
  camOn(70, pad(box("r1", "itinerary"), 30), 1.4, 26);
  ring(80, box("r1", "itinerary"), 60);
  camReset(160, 16);

  // ---------- 2. Notes on each answer ----------
  head(180, 420, "Step 2", "Take notes on every answer", [1]);
  scrollTo(186, 222, grid);
  page(223, "r1-c0");
  camZoom(240, box("r1-c0", "q1"), 1.5, 18);
  const c = typing(256, "r1-c");
  ring(c.end + 6, box(c.last, "q1"), 30);

  // ---------- 3. Their own question ----------
  head(420, 620, "Step 3", "Their own question sits on their row", [1, 2]);
  camZoom(432, box(c.last, "own"), 1.5, 18);
  ring(440, pad(box(c.last, "ownQ"), 6), 40);
  press(476, box(c.last, "own"), "text", undefined, 16);
  const kq = typing(486, "r1-k");
  ring(kq.end + 6, box(kq.last, "own"), 30);

  // ---------- 4. Scores ----------
  head(620, 830, "Step 4", "Score 1 to 5. The total adds itself.", [0, 5]);
  camReset(626, 10);
  page(632, "r1-scores");
  camZoom(650, box("r1-scores", "s2"), 1.4, 18);
  press(672, box("r1-scores", "s1"), "hand", () => page(678, "r1-s1"), 18);
  press(702, box("r1-s1", "s2"), "hand", () => page(708, "r1-s2"), 16);
  press(732, box("r1-s2", "s3"), "hand", () => page(738, "r1-s3"), 16);
  chime(740);
  ring(744, pad(box("r1-s3", "total"), 6), 50);

  // ---------- 5. The question bank ----------
  head(830, 1060, "Step 5", "Stuck? Pull one from the question bank", [5, 6]);
  camReset(836, 14);
  press(856, box("r1-s3", "qtab"), "hand", () => page(862, "panel"), 22);
  camOn(880, pad(box("panel", "panel"), -10), 1.25, 20);
  press(900, box("panel", "bankTab"), "hand", () => page(906, "panel-bank"), 16);
  press(952, box("panel-bank", "add1"), "hand", () => page(958, "panel-added"), 20);
  chime(958);
  ring(962, pad(box("panel-added", "added1"), 6), 40);
  camReset(1020, 16);
  press(1040, box("panel-added", "close"), "hand", () => page(1046, "r1-done"), 18);

  // ---------- 6. Market Sizing ----------
  head(1060, 1310, "Step 6", "Next Rotation: Market Sizing", [0, 1, 2, 3]);
  scrollTo(1062, 1094, 0);
  camZoom(1100, box("r1-done", "next"), 1.5, 12);
  press(1110, box("r1-done", "next"), "hand", () => page(1116, "r2"), 16);
  camReset(1124, 10);
  scrollTo(1130, 1162, grid);
  page(1163, "r2-m0");
  camZoom(1172, box("r2-m0", "market"), 1.25, 14);
  const m = typing(1180, "r2-m");
  page(m.end + 8, "r2-scores");
  camZoom(m.end + 18, box("r2-scores", "s2"), 1.4, 14);
  press(m.end + 30, box("r2-scores", "s1"), "hand", () => page(m.end + 36, "r2-s1"), 14);
  press(m.end + 52, box("r2-s1", "s2"), "hand", () => page(m.end + 58, "r2-s2"), 14);
  press(m.end + 74, box("r2-s2", "s3"), "hand", () => page(m.end + 80, "r2-s3"), 14);
  ring(m.end + 84, pad(box("r2-s3", "total"), 6), 30);
  page(1302, "r2-done");

  // ---------- 7. Post Grading ----------
  head(1310, 1620, "Step 7", "Post Grading: decide, then say why", [2, 5]);
  camReset(1310, 10);
  scrollTo(1312, 1344, 0);
  press(1358, box("r2-done", "next"), "hand", () => page(1364, "r3"), 18);
  scrollTo(1372, 1404, grid);
  page(1405, "r3-grid");
  ring(1410, pad(box("r3-grid", "notice"), 4), 34);
  press(1432, box("r3-grid", "guideBtn"), "hand", () => page(1438, "guide"), 18);
  camOn(1452, box("guide", "drawer"), 1.2, 16);
  camReset(1512, 14);
  page(1516, "r3-grid");
  camZoom(1530, box("r3-grid", "myes"), 1.45, 14);
  press(1542, box("r3-grid", "myes"), "hand", () => page(1548, "r3-decided"), 14);
  camZoom(1560, box("r3-decided", "post"), 1.4, 12);
  press(1566, box("r3-decided", "post"), "text", undefined, 12);
  typing(1574, "r3-p", 3);

  // ---------- 8. Save All ----------
  head(1620, 1770, "Step 8", "Save All before you leave the room", [0, 1]);
  page(1620, "r3-done");
  camReset(1622, 12);
  scrollTo(1626, 1660, 0);
  camZoom(1672, box("r3-done", "saveAll"), 1.35, 16);
  press(1688, box("r3-done", "saveAll"), "hand", undefined, 20);
  chime(1694);
  ring(1694, pad(box("r3-done", "saveAll"), 6), 50);
  camReset(1756, 14);

  return done(1770);
}

// ---------- the whole video ----------
export const SCENES = [
  { name: "Intro", frames: 150 },
  { name: "The hour", frames: 210 },
  { name: "Walkthrough", frames: 1770, walk: true },
  { name: "After", frames: 195 },
  { name: "Close", frames: 150 },
] as const;

export type SceneName = (typeof SCENES)[number]["name"];
const clock = sceneClock(SCENES);
export const TOTAL_FRAMES = clock.total;
export const sceneStart = (name: SceneName) => clock.start(name);

/** The frame the thumbnail is taken from: the title, fully in. */
export const THUMB_FRAME = 110;

export const WALKS: Record<string, (S: States) => Walkthrough> = { Walkthrough: buildWalkthrough };

/** Drums step out while the decision guide is read, and under the closing explainer. */
export function music(): MusicPlan {
  const W0 = sceneStart("Walkthrough");
  return {
    slams: [0, 60, 75, 90],
    breaks: [
      [W0 + 1438, W0 + 1516],
      [sceneStart("After"), sceneStart("Close")],
    ],
  };
}
