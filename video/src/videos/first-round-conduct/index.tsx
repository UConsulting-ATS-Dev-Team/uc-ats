import { Close, Intro } from "../../kit/Bookends";
import type { VideoDef } from "../../kit/Tutorial";
import { After, TheHour } from "./Explainers";
import { SCENES, WALKS } from "./timeline.ts";

export const firstRoundConduct: VideoDef = {
  id: "first-round-conduct",
  composition: "FirstRoundConductTutorial",
  scenes: SCENES,
  walks: WALKS,
  components: {
    Intro: () => <Intro title="Running a First Round" accent={[2, 3]} />,
    "The hour": TheHour,
    After,
    Close: () => <Close text="Go get 'em!" accent={[2]} />,
  },
};
