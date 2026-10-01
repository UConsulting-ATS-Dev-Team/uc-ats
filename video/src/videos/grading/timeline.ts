// Document Grading 101: every click, camera move and headline, in frames.
// Self-contained apart from the kit, which Node can also run directly.
import { APP_H, APP_W, mid, pad, sceneClock, walkBuilder, type MusicPlan, type States, type Walkthrough } from "../../kit/timeline.ts";

export { FPS } from "../../kit/timeline.ts";

/** How far the Document Grading page scrolls to put the table in view. */
const TABLE_SCROLL = 804;

export function buildWalkthrough(S: States): Walkthrough {
  const { w, box, page, dialog, camTo, scrollTo, move, ring, head, type, press, chime, done } = walkBuilder(S, "/document-grading");

  // ---------- 1. Open Document Grading ----------
  head(0, 150, "Step 1", "Open Document Grading", [1, 2]);
  page(0, "dashboard", "/dashboard");
  camTo(44, 330, 250, 1.7, 30);
  press(52, box("dashboard", "navGrading"), "hand", undefined, 26);
  ring(56, box("dashboard", "navGrading"), 22);
  page(58, "grading");
  camTo(82, APP_W / 2, APP_H / 2, 1, 20);
  move(108, { x: 1240, y: 600 });
  camTo(114, 850, 560, 1.22, 28);
  ring(116, box("grading", "progress"), 34);

  // ---------- 2. Pick a document ----------
  head(150, 300, "Step 2", "Pick a document to grade", [3, 4]);
  scrollTo(152, 186, TABLE_SCROLL);
  camTo(196, 800, 420, 1.35, 40);
  press(232, box("grading", "doc1"), "hand", undefined, 28);
  dialog(240, "resume-open");
  camTo(262, APP_W / 2, APP_H / 2, 1, 20);

  // ---------- 3. Read it ----------
  head(300, 390, "Step 3", "Read it start to finish", [2, 3, 4]);
  move(312, { x: 880, y: 520 });
  camTo(326, 470, 330, 1.75, 26);
  camTo(386, 470, 640, 1.75, 58);

  // ---------- 4. Score it ----------
  head(390, 630, "Step 4", "Type a score. The rubric lights up.", [5, 6]);
  camTo(420, 1029, 330, 1.75, 28);
  press(440, box("resume-open", "field1"), "text", undefined, 22);
  dialog(445, "resume-f1");
  type(462, "resume-v1");
  ring(464, box("resume-v1", "hl0"), 34);
  camTo(500, 1029, 560, 1.75, 24);
  press(505, box("resume-v1", "field2"), "text");
  dialog(510, "resume-f2");
  type(526, "resume-v2");
  ring(528, box("resume-v2", "hl1"), 34);
  camTo(562, 1029, 643, 1.75, 24);
  ring(568, pad(box("resume-v2", "footer"), 10), 40);

  // ---------- 5. Note and save ----------
  head(630, 840, "Step 5", "Add a note, then hit Save", [4, 5]);
  dialog(636, "resume-ns", true);
  camTo(650, 1029, 600, 1.6, 18);
  press(656, box("resume-ns", "notes"), "text");
  dialog(661, "resume-nf");
  const notes = (S["resume-notes"] as unknown as { count: number }).count;
  for (let i = 0; i < notes; i++) type(666 + i * 3, `resume-n${i}`);
  press(716, box("resume-n0", "save"), "hand");
  dialog(722, "resume-saved");
  chime(722);
  camTo(740, APP_W / 2, APP_H / 2, 1, 16);
  ring(742, pad(box("resume-saved", "alert"), 8), 30);
  dialog(772, null);
  page(772, "grading-r1done");
  move(790, { x: 1300, y: 560 });
  camTo(796, 1174, 413, 2, 22);
  ring(798, pad(box("grading-r1done", "status1"), 6), 36);

  // ---------- 6. Short answers ----------
  head(840, 1050, "Step 6 · Short answers", "Same moves, three scores", [2, 3]);
  camTo(862, 720, 330, 1.3, 20);
  press(868, box("grading", "tabShort"), "hand");
  page(873, "short");
  press(894, box("short", "doc1"), "hand");
  dialog(902, "short-open");
  camTo(918, APP_W / 2, APP_H / 2, 1, 12);
  camTo(936, 1029, 330, 1.6, 16);
  press(940, box("short-open", "field1"), "text", undefined, 14);
  dialog(945, "short-f1");
  type(952, "short-v1");
  press(960, box("short-v1", "field2"), "text", undefined, 12);
  dialog(965, "short-f2");
  type(971, "short-v2");
  dialog(977, "short-f3", true);
  camTo(984, 1029, 450, 1.6, 10);
  press(980, box("short-f3", "field3"), "text", undefined, 10);
  type(990, "short-v3");
  ring(992, box("short-v3", "hl2"), 26);
  camTo(1000, 1029, 643, 1.6, 10);
  ring(1002, pad(box("short-v3", "footer"), 10), 30);
  press(1010, box("short-v3", "save"), "hand", undefined, 12);
  dialog(1015, "short-saved");
  chime(1015);
  dialog(1036, null);
  page(1036, "short-done");
  camTo(1046, APP_W / 2, APP_H / 2, 1, 12);

  // ---------- 7. Videos ----------
  head(1050, 1230, "Step 7 · Videos", "Watch it, then score 0 to 2", [3, 4, 5, 6]);
  camTo(1062, 720, 330, 1.3, 12);
  press(1064, box("short-done", "tabVideos"), "hand", undefined, 14);
  page(1069, "video");
  press(1086, box("video", "doc1"), "hand");
  dialog(1094, "video-open");
  camTo(1106, APP_W / 2, APP_H / 2, 1, 10);
  const player = box("video-open", "player");
  camTo(1120, 470, 470, 1.45, 14);
  press(1118, { x: player.x + 10, y: player.y + player.height - 40, width: 30, height: 30 }, "hand", undefined, 14);
  w.play = { f0: 1123, f1: 1196, box: player };
  camTo(1160, 1029, 330, 1.7, 18);
  press(1164, box("video-open", "field1"), "text");
  dialog(1169, "video-f1");
  type(1176, "video-v1");
  ring(1178, box("video-v1", "hl0"), 28);
  camTo(1192, 1029, 643, 1.6, 10);
  press(1194, box("video-v1", "save"), "hand", undefined, 12);
  dialog(1199, "video-saved");
  chime(1199);
  dialog(1218, null);
  page(1218, "video-done");
  camTo(1228, APP_W / 2, APP_H / 2, 1, 10);

  // ---------- 8. Broken or off? Flag it ----------
  head(1230, 1470, "Step 8 · Won't load? Looks off?", "Flag it. An admin takes it from there.", [0, 1]);
  press(1234, box("video-done", "tabResumes"), "hand", undefined, 10);
  page(1239, "flagtab");
  camTo(1250, 800, 470, 1.3, 12);
  press(1252, box("flagtab", "doc3"), "hand", undefined, 14);
  dialog(1258, "broken-open");
  camTo(1270, 520, 480, 1.5, 12);
  ring(1274, pad(box("broken-open", "failed"), 10), 26);
  ring(1290, pad(box("broken-open", "newtab"), 6), 26);
  move(1290, mid(box("broken-open", "newtab")), "hand", 14);
  camTo(1312, APP_W / 2, APP_H / 2, 1, 12);
  press(1314, box("broken-open", "close"), "hand", undefined, 16);
  dialog(1320, null);
  camTo(1330, 880, 520, 1.4, 12);
  press(1334, box("flagtab", "flag3"), "hand", undefined, 14);
  dialog(1340, "flag-open");
  camTo(1352, APP_W / 2, 450, 1.3, 12);
  press(1356, box("flag-open", "select"), "hand", undefined, 12);
  w.menu.push({ f0: 1361, f1: 1378, state: "flag-menu" });
  press(1372, box("flag-menu", "option"), "hand", undefined, 12);
  dialog(1377, "flag-picked");
  press(1392, box("flag-picked", "submit"), "hand", undefined, 14);
  dialog(1397, "flag-done");
  chime(1397);
  dialog(1420, null);
  page(1420, "flagged");
  camTo(1436, 883, 560, 2, 16);
  ring(1438, pad(box("flagged", "flag3"), 4), 30);

  // ---------- 9. Finish line ----------
  head(1470, 1650, "Finish line", "Grade them all and you get this", [5, 6]);
  camTo(1484, APP_W / 2, APP_H / 2, 1, 14);
  page(1472, "alldone");
  scrollTo(1474, 1502, 0);
  ring(1506, box("alldone", "progress"), 30);
  dialog(1524, "celebrate");
  w.confetti = 1524;
  camTo(1540, APP_W / 2, 450, 1.15, 14);
  press(1590, box("celebrate", "button"), "hand", undefined, 24);
  dialog(1606, null);
  camTo(1640, APP_W / 2, APP_H / 2, 1, 20);

  return done(1650);
}

// ---------- the whole video ----------
export const SCENES = [
  { name: "Intro", frames: 150 },
  { name: "Documents", frames: 165 },
  { name: "Teams", frames: 180 },
  { name: "Walkthrough", frames: 1650, walk: true },
  { name: "Adds up", frames: 255 },
  { name: "Delibs", frames: 165 },
  { name: "Close", frames: 150 },
] as const;

/** The frame the thumbnail is taken from: the title, fully in. */
export const THUMB_FRAME = 110;

export type SceneName = (typeof SCENES)[number]["name"];
const clock = sceneClock(SCENES);
export const TOTAL_FRAMES = clock.total;
export const sceneStart = (name: SceneName) => clock.start(name);

export const WALKS: Record<string, (S: States) => Walkthrough> = { Walkthrough: buildWalkthrough };

/** Drums step out while the resume is read, and under the two closing explainers. */
export function music(walks: Record<string, Walkthrough>): MusicPlan {
  const W0 = sceneStart("Walkthrough");
  const heads = walks.Walkthrough.heads;
  return {
    slams: [0, 60, 75, 90],
    breaks: [
      [W0 + heads[2].f0, W0 + heads[3].f0],
      [sceneStart("Adds up"), sceneStart("Close")],
    ],
  };
}
