// Setting Up a Final Round: every click, camera move and headline, in frames.
// Captured by scripts/flows/final-round-setup.mjs. The admin half runs on the Cases
// page, the interviewer half on My Interviews and the final round page.
import { mid, pad, sceneClock, walkBuilder, type MusicPlan, type States, type Walkthrough } from "../../kit/timeline.ts";

export { FPS } from "../../kit/timeline.ts";

const ROOM = "/member/final-round-interview?interviewId=…&groupIds=…";

/**
 * `admin: false` is the member cut (final-round-setup-members): the interviewer steps
 * only, from frame 0, numbered from 1.
 */
export function buildWalkthrough(S: States, { admin = true }: { admin?: boolean } = {}): Walkthrough {
  const k = walkBuilder(S, admin ? "/cases" : "/assigned-interviews");
  /** An interviewer-half frame: 480 frames later in the full video, behind the admin steps. */
  const at = (f: number) => (admin ? f : f - 480);
  const step = (n: number) => (admin ? `Interviewers · Step ${n}` : `Step ${n - 2}`);
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

  let f = 0;
  if (admin) {
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
    f = pick(250, box("asg", "pickInterview"), "asg-menu", "asg-list");
    camOn(f + 14, pad(box("asg-list", "row1"), 30), 1.35, 16);
    f = pick(f + 40, box("asg-list", "case1"), "asg-case-menu1", "asg-1");
    ring(f + 4, pad(box("asg-1", "status1"), 4), 30);
    f = pick(f + 36, box("asg-1", "case2"), "asg-case-menu2", "asg-2");
    ring(f + 4, pad(box("asg-2", "status2"), 4), 30);
    chime(f + 4);
    camReset(470, 10);
  }

  // ---------- Interviewers 3. Start the interview ----------
  head(at(480), at(690), step(3), "Start Interview and pick your room", [0, 1, 5]);
  page(at(480), "mine", "/assigned-interviews");
  ring(at(496), pad(box("mine", "badge"), 4), 30);
  camZoom(at(520), box("mine", "title"), 1.3, 20);
  camReset(at(560), 14);
  const toStart = scrollFor("mine", "start", 640);
  scrollTo(at(564), at(594), toStart);
  press(at(610), box("mine", "start"), "hand", () => dialog(at(616), "pick"), 20);
  press(at(640), box("pick", "opt1"), "hand", () => dialog(at(646), "pick-1"), 18);
  ring(at(652), pad(box("pick-1", "count"), 6), 26);
  press(at(676), box("pick-1", "go"), "hand", () => dialog(at(682), "setup", true), 16);

  // ---------- Interviewers 4. The shared questions ----------
  head(at(690), at(1000), step(4), "Write the behavioral questions", [2, 3]);
  const s0 = S.setup;
  camTo(at(700), (s0.x ?? 0) + s0.w / 2, (s0.y ?? 0) + s0.h / 2, 1.45, 14);
  f = at(724);
  let prev = "setup";
  for (let i = 1; i <= 2; i++) {
    press(f, box(prev, "add"), "hand", undefined, 16);
    const n = count(`setup-q${i}-count`);
    for (let j = 0; j < n; j++) type(f + 10 + j * 3, `setup-q${i}-${j}`);
    prev = `setup-q${i}-${n - 1}`;
    f += 10 + n * 3 + 24;
  }

  // ---------- Interviewers 5. Round One history ----------
  head(at(1000), at(1230), step(5), "Read what Round One wrote about them", [2, 3]);
  camReset(at(1002), 10);
  press(at(1012), box(prev, "go"), "hand", () => dialog(at(1018), null), 16);
  scrollTo(at(1018), at(1019), 0);
  page(at(1019), "fr", ROOM);
  ring(at(1034), pad(box("fr", "tabs"), 4), 30);
  scrollTo(at(1060), at(1090), scrollFor("fr", "history", 260));
  press(at(1104), box("fr", "history"), "hand", () => page(at(1110), "fr-history", ROOM), 18);
  camOn(at(1130), pad(box("fr-history", "historyBody"), 260), 1.4, 20);
  camReset(at(1212), 14);

  // ---------- Interviewers 6. The case stays locked ----------
  head(at(1230), at(1470), step(6), "The case opens just before the interview", [2, 3, 4]);
  scrollTo(at(1232), at(1262), 0);
  press(at(1278), box("fr-history", "tabCase"), "hand", () => page(at(1284), "fr-locked", ROOM), 18);
  scrollTo(at(1300), at(1336), scrollFor("fr-locked", "locked", 380));
  camZoom(at(1356), box("fr-locked", "locked"), 1.5, 22);
  ring(at(1366), pad(box("fr-locked", "lockedWhen"), 6), 60);
  camReset(at(1452), 14);

  return done(at(1470));
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
