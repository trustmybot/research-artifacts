import { join } from "node:path";

import { NOTES } from "./authornote/arms.ts";

export interface ArmProfile {
  promptPath: string;
  tools: string;
  includeSpec: boolean;
  includeEnvironment: boolean;
  includeDiff: boolean;
  upstreamBase: boolean;
  authorsNote: string | null;
}

type ArmEntry = Omit<ArmProfile, "authorsNote">;

const CONTROL: ArmEntry = {
  promptPath: join(import.meta.dirname, "..", "review-prompt.md"),
  tools: "Read,Bash,Write",
  includeSpec: true,
  includeEnvironment: true,
  includeDiff: false,
  upstreamBase: false,
};

const PROFILES = {
  c: CONTROL,
  e1: CONTROL,
  e2b: CONTROL,
  e2g: CONTROL,
  a: {
    promptPath: join(import.meta.dirname, "repo","review-prompt.md"),
    tools: "Read,Grep,Glob",
    includeSpec: false,
    includeEnvironment: false,
    includeDiff: true,
    upstreamBase: false,
  },
  b: {
    promptPath: join(import.meta.dirname, "tests", "review-prompt.md"),
    tools: "Read,Bash,Write",
    includeSpec: false,
    includeEnvironment: true,
    includeDiff: false,
    upstreamBase: false,
  },
  skill: {
    promptPath: join(import.meta.dirname, "skill", "review-prompt.md"),
    tools: "Read,Bash,Grep,Glob,Agent,Skill,ReportFindings",
    includeSpec: true,
    includeEnvironment: true,
    includeDiff: false,
    upstreamBase: true,
  },
  tmbcr: {
    promptPath: join(import.meta.dirname, "tmbcr", "review-prompt.md"),
    tools: "Read,Bash,Grep,Glob",
    includeSpec: true,
    includeEnvironment: true,
    includeDiff: false,
    upstreamBase: true,
  },
} satisfies Record<string, ArmEntry>;

export type Arm = keyof typeof PROFILES;
export const ARMS = Object.keys(PROFILES) as readonly Arm[];
export const CONTROL_ARM: Arm = "c";
export const ARMS_USAGE = `a comma list of distinct arms from ${ARMS.join(", ")}`;

export function isArm(value: string): value is Arm {
  return Object.hasOwn(PROFILES, value);
}

export function authorsNote(arm: Arm): string | null {
  return NOTES[arm] ?? null;
}

export function armProfile(arm: Arm): ArmProfile {
  return { ...PROFILES[arm], authorsNote: authorsNote(arm) };
}

export function parseArms(value: string): Arm[] | null {
  const listed = value.split(",");
  if (!listed.every(isArm) || new Set(listed).size !== listed.length) return null;
  return ARMS.filter((arm) => listed.includes(arm));
}
