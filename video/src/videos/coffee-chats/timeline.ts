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

  // ---------- 3. Start the interview with the groups on your nametags ----------
  head(375, 635, "Step 3", "Start Interview, then pick the groups on your nametags", [0, 1, 8]);
  const toStart = scrollFor("mine", "start", 640);
  scrollTo(379, 415, toStart);
  camZoom(427, box("mine", "start"), 1.4, 14);
  press(439, box("mine", "start"), "hand", undefined, 22);
  dialog(445, "pick");
  camReset(457, 12);
  camOn(475, pad(box("pick", "opt1"), 70), 1.5, 18);
  press(495, box("pick", "opt1"), "hand", undefined, 18);
  dialog(500, "pick-1");
  press(528, box("pick-1", "opt2"), "hand", undefined, 16);
  dialog(533, "pick-2");
  ring(546, pad(box("pick-2", "count"), 6), 34);
  camOn(580, pad(box("pick-2", "go"), 120), 1.4, 16);
  press(596, box("pick-2", "go"), "hand", undefined, 16);
  dialog(602, null);
  scrollTo(602, 603, 0);
  page(603, "face", IFACE);
  camReset(610, 8);

  // ---------- 4. Notes ----------
  head(635, 860, "Step 4", "Take notes as you talk", [1]);
  ring(649, pad(box("face", "notice"), 4), 40);
  const cardX = mid(box("face", "card1")).x;
  camTo(695, cardX, mid(box("face", "notes1")).y, 1.35, 30);
  press(709, box("face", "notes1"), "text", undefined, 18);
  page(714, "face-n-focus", IFACE);
  const notes = (S["face-notes"] as unknown as { count: number }).count;
  for (let i = 0; i < notes; i++) typePage(721 + i * 3, `face-n${i}`, IFACE);
  const typed = `face-n${notes - 1}`;
  camTo(825, cardX, mid(box(typed, "notes1")).y, 1.4, 22);

  // ---------- 5. Decide ----------
  head(860, 1130, "Step 5", "Pick a decision. Unsure? Open the guide.", [2, 6]);
  camReset(871, 14);
  press(889, box(typed, "guideBtn"), "hand", undefined, 22);
  page(895, "guide", IFACE);
  camOn(919, pad(box("guide", "drawer"), -20), 1.25, 22);
  camTo(995, 1210, 640, 1.25, 50);
  move(1001, { x: 1100, y: 500 });
  page(1021, typed, IFACE);
  camTo(1047, cardX, mid(box(typed, "decide1")).y, 1.4, 20);
  press(1065, box(typed, "yes1"), "hand", undefined, 18);
  page(1071, "face-yes", IFACE);
  ring(1075, box("face-yes", "yes1"), 36);

  // ---------- 6. The interview chat ----------
  head(1130, 1340, "Step 6 · Interview chat", "Message everyone running this interview", [0]);
  camReset(1135, 12);
  ring(1141, pad(box("face-yes", "chat"), 6), 30);
  press(1165, box("face-yes", "chat"), "hand", () => page(1171, "chat-open", IFACE), 22);
  camZoom(1187, box("chat-open", "panel"), 1.4, 18);
  ring(1197, pad(box("chat-open", "incoming"), 6), 40);
  press(1243, box("chat-open", "input"), "text", undefined, 16);
  const replies = (S["chat-count"] as unknown as { count: number }).count;
  for (let i = 0; i < replies; i++) typePage(1251 + i * 3, `chat-t${i}`, IFACE);
  const sendAt = 1251 + replies * 3 + 8;
  press(sendAt, box(`chat-t${replies - 1}`, "send"), "hand", () => page(sendAt + 6, "chat-sent", IFACE), 12);
  chime(sendAt + 6);
  ring(sendAt + 10, pad(box("chat-sent", "sent"), 6), 30);
  camReset(1325, 12);

  // ---------- 7. Save All ----------
  head(1340, 1565, "Step 7", "Hit Save All when you wrap up", [1, 2]);
  page(1340, "face-all", IFACE);
  camReset(1347, 14);
  const toCards = scrollFor("face-all", "card2", 120);
  scrollTo(1351, 1391, toCards);
  scrollTo(1419, 1449, 0);
  camOn(1461, pad(box("face-all", "saveAll"), 160), 1.5, 14);
  press(1475, box("face-all", "saveAll"), "hand", undefined, 20);
  dialog(1481, "saved");
  chime(1481);
  camReset(1493, 12);
  press(1535, box("saved", "back"), "hand", undefined, 22);
  dialog(1541, null);
  page(1541, "mine-done", "/assigned-interviews");

  // ---------- 8. Finish line ----------
  head(1565, 1745, "Finish line", "Your calls land in My Evaluations", [4, 5]);
  const toEvals = scrollFor("mine-done", "evals", 140);
  scrollTo(1567, 1601, toEvals);
  ring(1611, pad(k.box("mine-done", "chip1"), 4), 34);
  ring(1627, pad(k.box("mine-done", "chip2"), 4), 34);
  const edit = k.box("mine-done", "edit1");
  move(1665, mid(edit), "hand", 26);
  ring(1671, pad(edit, 6), 40);
  camTo(1675, mid(k.box("mine-done", "ev1")).x, mid(edit).y + 60, 1.35, 26);
  camReset(1735, 14);

  return done(1745);
}

// ---------- the whole video ----------
export const SCENES = [
  { name: "Intro", frames: 150 },
  { name: "Sittings", frames: 260 },
  { name: "Walkthrough", frames: 1745, walk: true },
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
      [W0 + 895, W0 + 1021],
      [sceneStart("After"), sceneStart("Close")],
    ],
  };
}
