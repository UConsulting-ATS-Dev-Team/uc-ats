import { Close, Intro } from "../../kit/Bookends";
import type { VideoDef } from "../../kit/Tutorial";
import { After, ThreeTabs } from "./Explainers";
import { SCENES, WALKS } from "./timeline.ts";

export const finalRoundConduct: VideoDef = {
  id: "final-round-conduct",
  composition: "FinalRoundConductTutorial",
  scenes: SCENES,
  walks: WALKS,
  components: {
    Intro: () => <Intro title="Running a Final Round" accent={[2, 3]} />,
    "Three tabs": ThreeTabs,
    After,
    Close: () => <Close text="Go find your next class!" accent={[4]} />,
  },
};
