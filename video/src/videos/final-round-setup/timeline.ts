// Setting Up a Final Round: every click, camera move and headline, in frames.
// Captured by scripts/flows/final-round-setup.mjs. The admin half runs on the Cases
// page, the interviewer half on My Interviews and the final round page.
import { mid, pad, sceneClock, walkBuilder, type MusicPlan, type States, type Walkthrough } from "../../kit/timeline.ts";

export { FPS } from "../../kit/timeline.ts";

const ROOM = "/member/final-round-interview?interviewId=…&groupIds=…";

export function buildWalkthrough(S: States): Walkthrough {
  const k = walkBuilder(S, "/cases");
  const { w, box, page, dialog, camOn, camZoom, camTo, camReset, scrollTo, scrollFor, move, ring, head, press, type, chime, done } = k;
  const count = (name: string) => (S[name] as unknown as { count: number }).count;
  /** Open an MUI menu from a select and pick its option; returns the frame the menu closes. */
  const pick = (f: number, field: ReturnType<typeof box>, menuState: string, after: string, url = "/cases") => {
    press(f, field, "hand", undefined, 16);
    w.menu.push({ f0: f + 6, f1: f + 30, state: menuState });
    press(f + 22, box(menuState, "option"), "hand", undefined, 12);
    page(f + 30, after, url);
    return f + 30;
  };

  // ---------- Admins 1. How early a case opens ----------
  head(0, 210, "Admins · Step 1", "Set how early members can open a case", [1, 2]);
  page(0, "lib");
  ring(16, box("lib", "navCases"), 30);
  camTo(60, mid(box("lib", "card")).x, mid(box("lib", "hours")).y, 1.5, 26);
  ring(72, pad(box("lib", "hours"), 6), 70);
  move(80, mid(box("lib", "hours")), "text", 22);
  camReset(150, 18);
  ring(168, pad(box("lib", "westwood"), 4), 34);

  // ---------- Admins 2. A case for each candidate ----------
  head(210, 480, "Admins · Step 2", "Give every candidate a case", [4]);
  press(222, box("lib", "tabAsg"), "hand", () => page(228, "asg"), 20);
  let f = pick(250, box("asg", "pickInterview"), "asg-menu", "asg-list");
  camOn(f + 14, pad(box("asg-list", "row1"), 30), 1.35, 16);
  f = pick(f + 40, box("asg-list", "case1"), "asg-case-menu1", "asg-1");
  ring(f + 4, pad(box("asg-1", "status1"), 4), 30);
  f = pick(f + 36, box("asg-1", "case2"), "asg-case-menu2", "asg-2");
  ring(f + 4, pad(box("asg-2", "status2"), 4), 30);
  chime(f + 4);
  camReset(470, 10);

  // ---------- Interviewers 3. Start the interview ----------
  head(480, 690, "Interviewers · Step 3", "Start Interview and pick your room", [0, 1, 5]);
  page(480, "mine", "/assigned-interviews");
  ring(496, pad(box("mine", "badge"), 4), 30);
  camZoom(520, box("mine", "title"), 1.3, 20);
  camReset(560, 14);
  const toStart = scrollFor("mine", "start", 640);
  scrollTo(564, 594, toStart);
  press(610, box("mine", "start"), "hand", () => dialog(616, "pick"), 20);
  press(640, box("pick", "opt1"), "hand", () => dialog(646, "pick-1"), 18);
  ring(652, pad(box("pick-1", "count"), 6), 26);
  press(676, box("pick-1", "go"), "hand", () => dialog(682, "setup", true), 16);

  // ---------- Interviewers 4. The shared questions ----------
  head(690, 1000, "Interviewers · Step 4", "Write the questions everyone gets", [3, 4]);
  const s0 = S.setup;
  camTo(700, (s0.x ?? 0) + s0.w / 2, (s0.y ?? 0) + s0.h / 2, 1.45, 14);
  f = 724;
  let prev = "setup";
  for (let i = 1; i <= 2; i++) {
    press(f, box(prev, "add"), "hand", undefined, 16);
    const n = count(`setup-q${i}-count`);
    for (let j = 0; j < n; j++) type(f + 10 + j * 3, `setup-q${i}-${j}`);
    prev = `setup-q${i}-${n - 1}`;
    f += 10 + n * 3 + 24;
  }

  // ---------- Interviewers 5. Round One history ----------
  head(1000, 1230, "Interviewers · Step 5", "Read what Round One wrote about them", [2, 3]);
  camReset(1002, 10);
  press(1012, box(prev, "go"), "hand", () => dialog(1018, null), 16);
  scrollTo(1018, 1019, 0);
  page(1019, "fr", ROOM);
  ring(1034, pad(box("fr", "tabs"), 4), 30);
  scrollTo(1060, 1090, scrollFor("fr", "history", 260));
  press(1104, box("fr", "history"), "hand", () => page(1110, "fr-history", ROOM), 18);
  camOn(1130, pad(box("fr-history", "historyBody"), 260), 1.4, 20);
  camReset(1212, 14);

  // ---------- Interviewers 6. The case stays locked ----------
  head(1230, 1470, "Interviewers · Step 6", "The case opens just before the interview", [2, 3, 4]);
  scrollTo(1232, 1262, 0);
  press(1278, box("fr-history", "tabCase"), "hand", () => page(1284, "fr-locked", ROOM), 18);
  scrollTo(1300, 1336, scrollFor("fr-locked", "locked", 380));
  camZoom(1356, box("fr-locked", "locked"), 1.5, 22);
  ring(1366, pad(box("fr-locked", "lockedWhen"), 6), 60);
  camReset(1452, 14);

  return done(1470);
}

// ---------- the whole video ----------
export const SCENES = [
  { name: "Intro", frames: 150 },
  { name: "Who does what", frames: 225 },
  { name: "Walkthrough", frames: 1470, walk: true },
  { name: "Close", frames: 150 },
] as const;

export type SceneName = (typeof SCENES)[number]["name"];
const clock = sceneClock(SCENES);
export const TOTAL_FRAMES = clock.total;
export const sceneStart = (name: SceneName) => clock.start(name);

/** The frame the thumbnail is taken from: the title, fully in. */
export const THUMB_FRAME = 110;

export const WALKS: Record<string, (S: States) => Walkthrough> = { Walkthrough: buildWalkthrough };

/** Drums step out while Round One history is read. */
export function music(): MusicPlan {
  const W0 = sceneStart("Walkthrough");
  return { slams: [0, 60, 75, 90], breaks: [[W0 + 1110, W0 + 1212]] };
}
