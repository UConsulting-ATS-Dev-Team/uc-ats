import { Close, Intro } from "../../kit/Bookends";
import type { VideoDef } from "../../kit/Tutorial";
import { After, Sittings } from "./Explainers";
import { SCENES, WALKS } from "./timeline.ts";

export const coffeeChats: VideoDef = {
  id: "coffee-chats",
  composition: "CoffeeChatsTutorial",
  scenes: SCENES,
  walks: WALKS,
  components: {
    Intro: () => <Intro title="Running a Coffee Chat" accent={[2, 3]} />,
    Sittings,
    After,
    Close: () => <Close text="Enjoy the chats!" accent={[2]} />,
  },
};
