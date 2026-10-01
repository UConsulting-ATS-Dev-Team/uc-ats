import { loadFont as loadMontserrat } from "@remotion/google-fonts/Montserrat";
import { loadFont as loadRoboto } from "@remotion/google-fonts/Roboto";

// UConsulting brand, as on uconsultingla.com: navy #042742 and UC blue
// #0C74C1 on white. blueLight is the ATS's own tint of the blue
// (client/src/styles/variables.css).
export const C = {
  navy: "#042742",
  blue: "#0C74C1",
  blueLight: "#5ba3e8",
};

// Light stage, as in Coffee Chats 101: white fading to a cool grey.
export const LIGHT = {
  top: "#ffffff",
  bottom: "#e8ecf2",
  muted: "#7b8794",
};

// The ATS and the site set headings in Montserrat; the browser chrome uses Roboto.
const montserrat = loadMontserrat("normal", { weights: ["500", "600", "700", "800"], subsets: ["latin"] });
const roboto = loadRoboto("normal", { weights: ["400"], subsets: ["latin"] });

export const DISPLAY = montserrat.fontFamily;
export const BODY = roboto.fontFamily;
