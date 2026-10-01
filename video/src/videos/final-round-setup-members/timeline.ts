// Setting Up a Final Round, member cut: the interviewer steps of final-round-setup
// only. Same walkthrough builder; captured by scripts/flows/final-round-setup-members.mjs.
import { sceneClock, type MusicPlan, type States, type Walkthrough } from "../../kit/timeline.ts";
import { buildWalkthrough } from "../final-round-setup/timeline.ts";

export { FPS } from "../../kit/timeline.ts";

export const SCENES = [
  { name: "Intro", frames: 150 },
  { name: "Walkthrough", frames: 990, walk: true },
  { name: "Close", frames: 150 },
] as const;

const clock = sceneClock(SCENES);
export const TOTAL_FRAMES = clock.total;

/** The frame the thumbnail is taken from: the title, fully in. */
export const THUMB_FRAME = 110;

export const WALKS: Record<string, (S: States) => Walkthrough> = {
  Walkthrough: (S) => buildWalkthrough(S, { admin: false }),
};

/** Drums step out while Round One history is read. */
export function music(): MusicPlan {
  const W0 = clock.start("Walkthrough");
  return { slams: [0, 60, 75, 90], breaks: [[W0 + 630, W0 + 732]] };
}
