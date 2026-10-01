import { Close, Intro } from "../../kit/Bookends";
import type { VideoDef } from "../../kit/Tutorial";
import { AddsUp, Delibs, Documents, Teams } from "./Explainers";
import { SCENES, WALKS } from "./timeline.ts";

export const grading: VideoDef = {
  id: "grading",
  composition: "GradingTutorial",
  scenes: SCENES,
  walks: WALKS,
  components: {
    Intro: () => <Intro title="Document Grading 101" accent={[2]} />,
    Documents,
    Teams,
    "Adds up": AddsUp,
    Delibs,
    Close: () => <Close text="Happy grading!" accent={[1]} />,
  },
};
