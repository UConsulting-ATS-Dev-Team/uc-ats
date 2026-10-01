// Running a Final Round: every click, camera move and headline, in frames.
// Captured by scripts/flows/final-round-conduct.mjs. Edits are viewport shots at the
// recorded scroll positions (notesScroll, caseScroll, detailsScroll); each tab is also
// a full page, so the camera can scroll back up to the tabs and Save All.
import { mid, pad, sceneClock, walkBuilder, type MusicPlan, type States, type Walkthrough } from "../../kit/timeline.ts";

export { FPS } from "../../kit/timeline.ts";

const ROOM = "/member/final-round-interview?interviewId=…&groupIds=…";

export function buildWalkthrough(S: States): Walkthrough {
  const k = walkBuilder(S, ROOM);
  const { box, page, dialog, camOn, camZoom, camReset, scrollTo, scrollFor, ring, head, press, typePage, chime, done } = k;
  const y = (name: string) => (S[name] as unknown as { y: number }).y;
  const typing = (f: number, prefix: string, step = 3) => {
    const n = (S[`${prefix}count`] as unknown as { count: number }).count;
    for (let i = 0; i < n; i++) typePage(f + i * step, `${prefix}${i}`);
    return { last: `${prefix}${n - 1}`, end: f + n * step };
  };

  // ---------- 1. The interview chat ----------
  head(0, 240, "Step 1 · Interview chat", "Split the work in the chat first", [5]);
  page(0, "b");
  ring(16, pad(box("b", "tabs"), 4), 40);
  ring(64, pad(box("b", "launcher"), 6), 30);
  press(84, box("b", "launcher"), "hand", () => page(90, "chat-open"), 22);
  camZoom(104, box("chat-open", "chatPanel"), 1.4, 16);
  ring(112, pad(box("chat-open", "incoming"), 6), 40);
  press(150, box("chat-open", "input"), "text", undefined, 14);
  const ch = typing(158, "chat-t");
  press(ch.end + 8, box(ch.last, "send"), "hand", () => page(ch.end + 14, "chat-sent"), 12);
  chime(ch.end + 14);
  ring(ch.end + 18, pad(box("chat-sent", "sent"), 6), 30);
  camReset(222, 12);
  page(232, "b");

  // ---------- 2. Behavioral notes ----------
  head(240, 470, "Step 2", "Note how they answer each question", [0]);
  scrollTo(242, 272, y("notesScroll"));
  page(273, "b-notes");
  camZoom(286, box("b-notes", "q1"), 1.5, 16);
  press(300, box("b-notes", "q1"), "text", undefined, 14);
  const bn = typing(308, "b-n");
  ring(bn.end + 4, box(bn.last, "q1"), 30);
  camReset(450, 12);
  page(462, "b-done");

  // ---------- 3. The case ----------
  head(470, 770, "Step 3 · Case Interview", "Run the case from its own tab", [2]);
  scrollTo(472, 500, 0);
  press(516, box("b-done", "tabCase"), "hand", () => page(522, "c"), 18);
  scrollTo(532, 562, y("caseScroll"));
  page(563, "c-1");
  camZoom(576, box("c-1", "viewer"), 1.25, 18);
  press(608, box("c-1", "ex1"), "hand", () => page(614, "c-ex1"), 18);
  ring(618, pad(box("c-ex1", "ex1"), 4), 30);
  press(656, box("c-ex1", "next"), "hand", () => page(662, "c-ex2"), 16);
  press(694, box("c-ex2", "next"), "hand", () => page(700, "c-io"), 14);
  ring(706, pad(box("c-io", "ioBadge"), 6), 60);

  // ---------- 4. Candidate View ----------
  head(770, 960, "Step 4", "Candidate View hides your guide pages", [0, 1]);
  camReset(774, 12);
  press(796, box("c-io", "candidateView"), "hand", () => page(802, "c-cand"), 20);
  press(910, box("c-cand", "exit"), "hand", () => page(916, "c-ex1"), 22);

  // ---------- 5. The casing rubric ----------
  head(960, 1200, "Step 5", "Write your notes in the casing rubric", [5, 6]);
  camZoom(972, box("c-ex1", "rubric"), 1.3, 18);
  press(992, box("c-ex1", "framework"), "text", undefined, 16);
  const cf = typing(1000, "c-f");
  ring(cf.end + 4, box(cf.last, "framework"), 30);
  camReset(1180, 12);
  page(1192, "c-done");

  // ---------- 6. Candidate details ----------
  head(1200, 1440, "Step 6", "Confirm the details with them", [0]);
  scrollTo(1202, 1230, 0);
  press(1246, box("c-done", "tabDetails"), "hand", () => page(1252, "d"), 18);
  scrollTo(1262, 1292, y("detailsScroll"));
  page(1293, "d-0");
  camZoom(1304, box("d-0", "list"), 1.3, 16);
  press(1330, box("d-0", "phone"), "hand", () => page(1336, "d-1"), 16);
  press(1360, box("d-1", "tonight"), "hand", () => page(1366, "d-2"), 14);
  press(1390, box("d-2", "meetings"), "hand", () => page(1396, "d-3"), 14);
  camReset(1420, 12);
  page(1432, "d-done");

  // ---------- 7. Save All ----------
  head(1440, 1600, "Step 7", "Save All before they leave", [0, 1]);
  scrollTo(1442, 1472, 0);
  camZoom(1488, box("d-done", "saveAll"), 1.35, 14);
  press(1506, box("d-done", "saveAll"), "hand", undefined, 18);
  chime(1512);
  ring(1512, pad(box("d-done", "saveAll"), 6), 50);
  camReset(1584, 14);

  // ---------- 8. The decision ----------
  head(1600, 2010, "Step 8", "Then record your decision in My Interviews", [5, 6]);
  page(1600, "m", "/assigned-interviews");
  scrollTo(1604, 1640, scrollFor("m", "row1", 260));
  ring(1652, pad(box("m", "chip1"), 4), 34);
  press(1690, box("m", "edit1"), "hand", () => dialog(1696, "m-edit"), 20);
  ring(1716, pad(box("m-edit", "help"), 6), 30);
  // The decision guide: a drawer over the dialog, captured as one viewport shot.
  press(1744, box("m-edit", "help"), "hand", () => {
    dialog(1750, null);
    page(1750, "m-guide", "/assigned-interviews");
  }, 16);
  camOn(1770, pad(box("m-guide", "drawer"), -20), 1.25, 20);
  camReset(1820, 14);
  page(1830, "m", "/assigned-interviews");
  dialog(1830, "m-edit");
  press(1850, box("m-edit", "yes"), "hand", () => dialog(1856, "m-yes", true), 18);
  press(1890, box("m-yes", "save"), "hand", () => dialog(1896, null), 18);
  page(1896, "m-done", "/assigned-interviews");
  chime(1896);
  const chip = box("m-done", "chip1");
  ring(1912, pad(chip, 4), 40);
  k.camTo(1926, mid(box("m-done", "row1")).x, mid(chip).y + 60, 1.35, 22);
  camReset(1994, 14);

  return done(2010);
}

// ---------- the whole video ----------
export const SCENES = [
  { name: "Intro", frames: 150 },
  { name: "Three tabs", frames: 210 },
  { name: "Walkthrough", frames: 2010, walk: true },
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

/** Drums step out under Candidate View and the closing explainer. */
export function music(): MusicPlan {
  const W0 = sceneStart("Walkthrough");
  return {
    slams: [0, 60, 75, 90],
    breaks: [
      [W0 + 802, W0 + 916],
      [sceneStart("After"), sceneStart("Close")],
    ],
  };
}
