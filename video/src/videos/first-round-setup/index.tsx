import { Close, Intro } from "../../kit/Bookends";
import type { VideoDef } from "../../kit/Tutorial";
import { TwoKinds } from "./Explainers";
import { SCENES, WALKS } from "./timeline.ts";

export const firstRoundSetup: VideoDef = {
  id: "first-round-setup",
  composition: "FirstRoundSetupTutorial",
  scenes: SCENES,
  walks: WALKS,
  components: {
    Intro: () => <Intro title="Setting Up a First Round" accent={[3, 4]} />,
    "Two kinds": TwoKinds,
    Close: () => <Close text="Ready for the room!" accent={[3]} />,
  },
};
