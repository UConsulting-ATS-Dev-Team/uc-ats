import type { VideoDef } from "../kit/Tutorial";
import { coffeeChats } from "./coffee-chats";
import { firstRoundConduct } from "./first-round-conduct";
import { firstRoundSetup } from "./first-round-setup";
import { finalRoundConduct } from "./final-round-conduct";
import { finalRoundSetup } from "./final-round-setup";
import { finalRoundSetupMembers } from "./final-round-setup-members";
import { grading } from "./grading";
import { reviewDelibs } from "./review-delibs";

/** Every tutorial, in the order they appear in Help. */
export const VIDEOS: VideoDef[] = [grading, coffeeChats, firstRoundSetup, firstRoundConduct, finalRoundSetupMembers, finalRoundSetup, finalRoundConduct, reviewDelibs];
