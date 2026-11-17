import { join } from "node:path";

import { drawCli, runStratifiedDraw, type RepeatDrawParams, type RepeatStratum } from "./draw-repeats.ts";

export const DEFAULT_PATCHES_PATH = join(import.meta.dirname, "checks", "pilot-patches.json");
export const E_PILOT_STRATA: readonly RepeatStratum[] = [
  { label: "swe_abs_wrong", stream: "e-pilot-wrong", frame: 14, take: 7 },
  { label: "swe_abs_correct", stream: "e-pilot-correct", frame: 6, take: 3 },
];

const USAGE = "usage: node harness/draw-e-pilot.ts [--patches <path>] --seed <digits> --out <path>";

export function runEPilotDraw(params: RepeatDrawParams): void {
  runStratifiedDraw(params, E_PILOT_STRATA);
}

if (import.meta.main) {
  process.exitCode = drawCli(process.argv.slice(2), {
    defaultPatchesPath: DEFAULT_PATCHES_PATH,
    plan: E_PILOT_STRATA,
    usage: USAGE,
  });
}
