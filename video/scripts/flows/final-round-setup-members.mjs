// Setting Up a Final Round, for members: the interviewer half of final-round-setup
// only (Start Interview with the room, the behavioral questions, Round One history,
// the locked case). The full video keeps the admin half for recruitment committees.
import { setupFlow } from "./final-round-setup.mjs";

export const { setup, api, run } = setupFlow({ admin: false });
