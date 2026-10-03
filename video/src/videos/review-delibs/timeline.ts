// Running a Review Team Delib: every click, camera move and headline, in frames.
// Captured by scripts/flows/review-delibs.mjs.
import { pad, sceneClock, walkBuilder, type Box, type MusicPlan, type States, type Walkthrough } from "../../kit/timeline.ts";

export { FPS } from "../../kit/timeline.ts";

const SESSION = "/review-delib/…";

/** The control bar sits under the content; scroll so it is near the bottom of the window. */
const toBar = (S: States, state: string) => {
  const s = S[state];
  return Math.max(0, Math.min(s.boxes.bar.y - 700, s.h - 900));
};

/** The pencil sits at the right edge of a score cell, level with the grader's name. */
const pencil = (cell: Box): Box => ({ x: cell.x + cell.width - 46, y: cell.y + 14, width: 30, height: 30 });

export function buildWalkthrough(S: States): Walkthrough {
  const k = walkBuilder(S, "/review-teams");
  const { box, page, dialog, camOn, camZoom, camReset, scrollTo, scrollFor, ring, head, press, chime, done } = k;

  // ---------- 1. Start it ----------
  head(0, 210, "Step 1", "Start a delib from the team's card", [0, 2]);
  page(0, "teams");
  ring(24, pad(box("teams", "status"), 6), 32);
  camZoom(60, box("teams", "start"), 1.4, 26);
  press(92, box("teams", "start"), "hand", undefined, 24);
  dialog(98, "launch");
  camReset(108, 12);
  ring(124, pad(box("launch", "threshold"), 4), 34);
  press(166, box("launch", "go"), "hand", undefined, 24);
  dialog(172, null);
  page(172, "overview", SESSION);
  chime(172);

  // ---------- 2. The overview ----------
  head(210, 465, "Step 2", "Open on the numbers: what stands out", [4, 5, 6]);
  camOn(238, pad(box("overview", "insights"), 10), 1.45, 24);
  ring(250, pad(box("overview", "flags"), 8), 34);
  camOn(318, pad(box("overview", "comparison"), 10), 1.45, 26);
  camReset(372, 16);
  scrollTo(380, 410, scrollFor("overview", "graders", 160));
  ring(418, pad(box("overview", "graders"), 4), 34);

  // ---------- 3. The team joins ----------
  head(465, 615, "Meanwhile", "Your team gets a prompt to join", [1, 4, 6]);
  scrollTo(465, 466, 0);
  page(467, "member-prompt", "/document-grading");
  camOn(490, pad(box("member-prompt", "prompt"), 40), 1.5, 22);
  ring(500, pad(box("member-prompt", "join"), 6), 34);
  camReset(588, 14);
  page(605, "overview", SESSION);

  // ---------- 4. Outliers ----------
  head(615, 855, "Step 3", "Walk the outliers, widest gap first", [2, 3, 4]);
  scrollTo(618, 642, toBar(S, "overview"));
  press(664, box("overview", "stepOutliers"), "hand", undefined, 22);
  page(670, "outlier-1", SESSION);
  scrollTo(670, 671, 0);
  camZoom(696, box("outlier-1", "splitCell"), 1.6, 22);
  ring(706, pad(box("outlier-1", "splitCell"), 6), 40);
  camReset(774, 16);
  scrollTo(780, 806, toBar(S, "outlier-1"));
  press(828, box("outlier-1", "next"), "hand", undefined, 22);
  page(834, "outlier-2", SESSION);
  scrollTo(834, 835, 0);

  // ---------- 5. Override ----------
  head(855, 1110, "Step 4", "Override a grade while you talk", [0]);
  camZoom(866, box("outlier-2", "outlierCell"), 1.7, 20);
  ring(876, pad(box("outlier-2", "outlierCell"), 6), 34);
  press(918, pencil(box("outlier-2", "outlierCell")), "hand", undefined, 22);
  page(924, "outlier-2-edit", SESSION);
  press(952, box("outlier-2-edit", "input"), "text", undefined, 18);
  press(990, box("outlier-2-edit", "save"), "hand", undefined, 20);
  page(996, "outlier-2-done", SESSION);
  chime(996);
  ring(1004, pad(box("outlier-2-done", "cell"), 6), 44);
  camReset(1090, 16);

  // ---------- 6. Every candidate ----------
  head(1110, 1365, "Step 5", "Then the full list. Open anyone for the room.", [2, 3, 4, 5]);
  scrollTo(1114, 1138, toBar(S, "outlier-2-done"));
  press(1160, box("outlier-2-done", "stepAll"), "hand", undefined, 22);
  page(1166, "all", SESSION);
  scrollTo(1166, 1167, 0);
  ring(1186, pad(box("all", "table"), 4), 30);
  press(1222, box("all", "theo"), "hand", undefined, 24);
  page(1228, "all-open", SESSION);
  scrollTo(1240, 1270, scrollFor("all-open", "decision", 300));
  camZoom(1284, box("all-open", "decision"), 1.6, 18);
  press(1300, box("all-open", "decision"), "hand", undefined, 18);
  page(1318, "all-decided", SESSION);
  chime(1318);
  ring(1324, pad(box("all-decided", "decision"), 6), 36);

  // ---------- 7. The member's screen ----------
  head(1365, 1500, "On Priya's screen", "Same candidate, same decision, no controls", [0, 2, 4, 5]);
  camReset(1368, 12);
  scrollTo(1370, 1371, 0);
  page(1372, "member-card", SESSION);
  ring(1392, pad(box("member-card", "decision"), 8), 40);
  // The candidate's name and the decision chip, together: the same card the admin has open.
  const name = box("member-card", "card");
  const chip = box("member-card", "decision");
  camOn(1400, pad({ x: name.x, y: name.y, width: chip.x + chip.width - name.x, height: chip.y + chip.height - name.y }, 60), 1.4, 24);
  camReset(1480, 14);

  // ---------- 8. Wrap up ----------
  head(1500, 1710, "Step 6", "End it. The summary shows every change.", [0, 3, 5, 6]);
  page(1500, "all-decided", SESSION);
  scrollTo(1502, 1528, toBar(S, "all-decided"));
  press(1550, box("all-decided", "stepSummary"), "hand", undefined, 22);
  page(1556, "summary", SESSION);
  scrollTo(1556, 1557, 0);
  ring(1566, pad(box("summary", "summary"), 4), 30);
  press(1604, box("summary", "end"), "hand", undefined, 22);
  dialog(1610, "end-confirm");
  press(1640, box("end-confirm", "confirm"), "hand", undefined, 20);
  dialog(1646, null);
  page(1646, "ended", SESSION);
  chime(1646);
  ring(1654, pad(box("ended", "summary"), 4), 36);

  return done(1710);
}

// ---------- the whole video ----------
export const SCENES = [
  { name: "Intro", frames: 150 },
  { name: "HowItWorks", frames: 240 },
  { name: "Outliers", frames: 285 },
  { name: "Walkthrough", frames: 1710, walk: true },
  { name: "After", frames: 210 },
  { name: "Close", frames: 150 },
] as const;

export type SceneName = (typeof SCENES)[number]["name"];
const clock = sceneClock(SCENES);
export const TOTAL_FRAMES = clock.total;
export const sceneStart = (name: SceneName) => clock.start(name);

/** The frame the thumbnail is taken from: the title, fully in. */
export const THUMB_FRAME = 110;

export const WALKS: Record<string, (S: States) => Walkthrough> = { Walkthrough: buildWalkthrough };

/** Drums step out while the overview is read, and under the closing explainer. */
export function music(walks: Record<string, Walkthrough>): MusicPlan {
  const W0 = sceneStart("Walkthrough");
  return {
    slams: [0, 60, 75, 90],
    breaks: [
      [W0 + 238, W0 + 372],
      [sceneStart("After"), sceneStart("Close")],
    ],
  };
}
