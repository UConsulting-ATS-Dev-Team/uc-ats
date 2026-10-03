import { Close, Intro } from "../../kit/Bookends";
import type { VideoDef } from "../../kit/Tutorial";
import { After, HowItWorks, Outliers } from "./Explainers";
import { SCENES, WALKS } from "./timeline.ts";

export const reviewDelibs: VideoDef = {
  id: "review-delibs",
  composition: "ReviewDelibsTutorial",
  scenes: SCENES,
  walks: WALKS,
  components: {
    Intro: () => <Intro title="Running a Review Team Delib" accent={[3, 4]} />,
    HowItWorks,
    Outliers,
    After,
    Close: () => <Close text="Ten minutes well spent." accent={[0, 1]} />,
  },
};
