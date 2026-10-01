import type { VideoDef } from "../kit/Tutorial";
import { coffeeChats } from "./coffee-chats";
import { grading } from "./grading";

/** Every tutorial, in the order they appear in Help. */
export const VIDEOS: VideoDef[] = [grading, coffeeChats];
