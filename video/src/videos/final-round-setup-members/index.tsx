import { Close, Intro } from "../../kit/Bookends";
import type { VideoDef } from "../../kit/Tutorial";
import { SCENES, WALKS } from "./timeline.ts";

/** The member cut of final-round-setup: no admin steps. */
export const finalRoundSetupMembers: VideoDef = {
  id: "final-round-setup-members",
  composition: "FinalRoundSetupMembersTutorial",
  scenes: SCENES,
  walks: WALKS,
  components: {
    Intro: () => <Intro title="Setting Up Your Final Round" accent={[3, 4]} />,
    Close: () => <Close text="Ready for finals!" accent={[2]} />,
  },
};
