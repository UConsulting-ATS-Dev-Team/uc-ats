// Running a Coffee Chat: every click, camera move and headline, in frames.
// Captured by scripts/flows/coffee-chats.mjs.
import { mid, pad, sceneClock, walkBuilder, type MusicPlan, type States, type Walkthrough } from "../../kit/timeline.ts";

export { FPS } from "../../kit/timeline.ts";

const IFACE = "/member/interview-interface?interviewId=…&groupIds=…";

export function buildWalkthrough(S: States): Walkthrough {
  const k = walkBuilder(S, "/interview-rsvp");
  const { box, page, dialog, camOn, camZoom, camTo, camReset, scrollTo, scrollFor, move, ring, head, press, typePage, chime, done } = k;

  // ---------- 1. Claim a sitting ----------
  head(0, 195, "Step 1", "Claim a sitting in Interview RSVP", [4, 5]);
  page(0, "rsvp");
  ring(18, box("rsvp", "navRsvp"), 30);
  camZoom(56, box("rsvp", "cardPm"), 1.3, 30);
  ring(64, box("rsvp", "staffPm"), 30);
  press(100, box("rsvp", "claimPm"), "hand", undefined, 26);
  page(106, "rsvp-claimed");
  chime(106);
  // The success notice pushes the cards down; follow the card.
  camZoom(118, box("rsvp-claimed", "cardPm"), 1.3, 12);
  ring(122, pad(box("rsvp-claimed", "youChip"), 4), 34);
  camZoom(156, box("rsvp-claimed", "notice"), 1.2, 18);
  ring(160, box("rsvp-claimed", "notice"), 30);

  // ---------- 2. Find it in My Interviews ----------
  head(195, 375, "Step 2", "Then find it in My Interviews", [4, 5]);
  camReset(210, 14);
  press(222, box("rsvp-claimed", "navMine"), "hand", undefined, 20);
  page(228, "mine", "/assigned-interviews");
  ring(246, pad(box("mine", "badge"), 4), 30);
  camZoom(282, box("mine", "assignment"), 1.4, 26);
  move(290, { x: 1100, y: 520 });
  const toGroups = scrollFor("mine", "groups", 160);
  scrollTo(318, 352, toGroups);
  camReset(352, 34);

  // ---------- 3. Skim the resume ----------
  head(375, 600, "Step 3", "Skim each resume before you sit down", [2]);
  press(392, box("mine", "group1"), "hand", undefined, 20);
  page(398, "mine-group", "/assigned-interviews");
  camOn(430, pad(box("mine-group", "cand1"), 60), 1.6, 24);
  press(452, box("mine-group", "resume1"), "hand", undefined, 18);
  dialog(458, "resume");
  camReset(470, 12);
  const doc = box("resume", "close");
  camTo(500, 720, 470, 1.35, 24);
  camTo(560, 720, 600, 1.35, 50);
  press(584, doc, "hand", undefined, 18);
  dialog(590, null);
  camReset(596, 10);

  // ---------- 4. Start the interview ----------
  head(600, 810, "Step 4", "Hit Start Interview and pick your groups", [1, 2, 6]);
  const toStart = scrollFor("mine-group", "start", 640);
  scrollTo(604, 640, toStart);
  camZoom(652, box("mine-group", "start"), 1.4, 14);
  press(664, box("mine-group", "start"), "hand", undefined, 22);
  dialog(670, "pick");
  camReset(682, 12);
  camOn(700, pad(box("pick", "opt1"), 60), 1.5, 18);
  press(716, box("pick", "opt1"), "hand", undefined, 18);
  dialog(721, "pick-1");
  ring(730, pad(box("pick-1", "count"), 6), 34);
  camOn(752, pad(box("pick-1", "go"), 120), 1.4, 16);
  press(768, box("pick-1", "go"), "hand", undefined, 16);
  dialog(774, null);
  scrollTo(774, 775, 0);
  page(775, "face", IFACE);
  camReset(782, 8);

  // ---------- 5. Notes ----------
  head(810, 1035, "Step 5", "Take notes as you talk", [1]);
  ring(824, pad(box("face", "notice"), 4), 40);
  const cardX = mid(box("face", "card1")).x;
  camTo(870, cardX, mid(box("face", "notes1")).y, 1.35, 30);
  press(884, box("face", "notes1"), "text", undefined, 18);
  page(889, "face-n-focus", IFACE);
  const notes = (S["face-notes"] as unknown as { count: number }).count;
  for (let i = 0; i < notes; i++) typePage(896 + i * 3, `face-n${i}`, IFACE);
  const typed = `face-n${notes - 1}`;
  camTo(1000, cardX, mid(box(typed, "notes1")).y, 1.4, 22);

  // ---------- 6. Decide ----------
  head(1035, 1305, "Step 6", "Pick a decision. Unsure? Open the guide.", [2, 6]);
  camReset(1046, 14);
  press(1064, box(typed, "guideBtn"), "hand", undefined, 22);
  page(1070, "guide", IFACE);
  camOn(1094, pad(box("guide", "drawer"), -20), 1.25, 22);
  camTo(1170, 1210, 640, 1.25, 50);
  move(1176, { x: 1100, y: 500 });
  page(1196, typed, IFACE);
  camTo(1222, cardX, mid(box(typed, "decide1")).y, 1.4, 20);
  press(1240, box(typed, "yes1"), "hand", undefined, 18);
  page(1246, "face-yes", IFACE);
  ring(1250, box("face-yes", "yes1"), 36);

  // ---------- 7. Save All ----------
  head(1305, 1530, "Step 7", "Hit Save All when the chat ends", [1, 2]);
  page(1305, "face-all", IFACE);
  camReset(1312, 14);
  const toCards = scrollFor("face-all", "card2", 120);
  scrollTo(1316, 1356, toCards);
  scrollTo(1384, 1414, 0);
  camOn(1426, pad(box("face-all", "saveAll"), 160), 1.5, 14);
  press(1440, box("face-all", "saveAll"), "hand", undefined, 20);
  dialog(1446, "saved");
  chime(1446);
  camReset(1458, 12);
  press(1500, box("saved", "back"), "hand", undefined, 22);
  dialog(1506, null);
  page(1506, "mine-done", "/assigned-interviews");

  // ---------- 8. Finish line ----------
  head(1530, 1710, "Finish line", "Your calls land in My Evaluations", [4, 5]);
  const toEvals = scrollFor("mine-done", "evals", 140);
  scrollTo(1532, 1566, toEvals);
  ring(1576, pad(k.box("mine-done", "chip1"), 4), 34);
  ring(1592, pad(k.box("mine-done", "chip2"), 4), 34);
  const edit = k.box("mine-done", "edit1");
  move(1630, mid(edit), "hand", 26);
  ring(1636, pad(edit, 6), 40);
  camTo(1640, mid(k.box("mine-done", "ev1")).x, mid(edit).y + 60, 1.35, 26);
  camReset(1700, 14);

  return done(1710);
}

// ---------- the whole video ----------
export const SCENES = [
  { name: "Intro", frames: 150 },
  { name: "Sittings", frames: 210 },
  { name: "Walkthrough", frames: 1710, walk: true },
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

/** Drums step out while the guide is read, and under the closing explainer. */
export function music(walks: Record<string, Walkthrough>): MusicPlan {
  const W0 = sceneStart("Walkthrough");
  return {
    slams: [0, 60, 75, 90],
    breaks: [
      [W0 + 1070, W0 + 1196],
      [sceneStart("After"), sceneStart("Close")],
    ],
  };
}
