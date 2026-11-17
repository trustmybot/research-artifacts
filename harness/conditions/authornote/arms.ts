import { readFileSync } from "node:fs";
import { join } from "node:path";

export { ARMS, ARMS_USAGE, CONTROL_ARM, authorsNote, isArm, parseArms, type Arm } from "../arms.ts";

export const NOTES = JSON.parse(readFileSync(join(import.meta.dirname, "notes.json"), "utf8")) as Record<string, string>;
