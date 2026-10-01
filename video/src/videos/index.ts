import type { VideoDef } from "../kit/Tutorial";
import { coffeeChats } from "./coffee-chats";
import { firstRoundSetup } from "./first-round-setup";
import { grading } from "./grading";

/** Every tutorial, in the order they appear in Help. */
export const VIDEOS: VideoDef[] = [grading, coffeeChats, firstRoundSetup];
