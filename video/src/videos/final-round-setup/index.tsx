import { Close, Intro } from "../../kit/Bookends";
import type { VideoDef } from "../../kit/Tutorial";
import { WhoDoesWhat } from "./Explainers";
import { SCENES, WALKS } from "./timeline.ts";

export const finalRoundSetup: VideoDef = {
  id: "final-round-setup",
  composition: "FinalRoundSetupTutorial",
  scenes: SCENES,
  walks: WALKS,
  components: {
    Intro: () => <Intro title="Setting Up a Final Round" accent={[3, 4]} />,
    "Who does what": WhoDoesWhat,
    Close: () => <Close text="Ready for finals!" accent={[2]} />,
  },
};
