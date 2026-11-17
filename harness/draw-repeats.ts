import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { randomStream } from "./draw.ts";

export const DEFAULT_PATCHES_PATH = join(import.meta.dirname, "checks", "main-patches.json");
export const REPEAT_STRATA: readonly RepeatStratum[] = [
  { label: "swe_abs_wrong", stream: "repeat-wrong", frame: 60, take: 14 },
  { label: "swe_abs_correct", stream: "repeat-correct", frame: 30, take: 6 },
];

const USAGE = "usage: node harness/draw-repeats.ts [--patches <path>] --seed <digits> --out <path>";

export interface RepeatStratum {
  label: string;
  stream: string;
  frame: number;
  take: number;
}

export interface RepeatDrawParams {
  patchesPath: string;
  seed: string | undefined;
  outPath: string;
}

type PatchEntry = Record<string, unknown> & { instance_id: string; agent_id: string; label_stratum: string };

export class RepeatDrawRefusal extends Error {}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function readPatches(path: string): PatchEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new RepeatDrawRefusal(`cannot read patches file: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new RepeatDrawRefusal("patches file is not a JSON array");
  return parsed as PatchEntry[];
}

export function drawRepeatStratum(entries: readonly PatchEntry[], seed: string, stream: string, take: number): PatchEntry[] {
  const random = randomStream(seed, stream);
  const queue = [...entries].sort(
    (a, b) => compareCodeUnits(a.instance_id, b.instance_id) || compareCodeUnits(a.agent_id, b.agent_id),
  );
  for (let i = queue.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }
  return queue.slice(0, take);
}

export function selectStrata(patches: readonly PatchEntry[], seed: string, plan: readonly RepeatStratum[]): PatchEntry[] {
  const strata = plan.map((stratum) => ({
    ...stratum,
    entries: patches.filter((patch) => patch.label_stratum === stratum.label),
  }));
  const misfit = strata.find(({ entries, frame }) => entries.length !== frame);
  if (misfit !== undefined) {
    const counts = strata.map(({ label, entries, frame }) => `${label}=${entries.length} (needs ${frame})`).join(" ");
    throw new RepeatDrawRefusal(`patches file stratum counts differ from the expected: ${counts}`);
  }
  return strata.flatMap(({ entries, stream, take }) => drawRepeatStratum(entries, seed, stream, take));
}

export function selectRepeats(patches: readonly PatchEntry[], seed: string): PatchEntry[] {
  return selectStrata(patches, seed, REPEAT_STRATA);
}

export function runStratifiedDraw({ patchesPath, seed, outPath }: RepeatDrawParams, plan: readonly RepeatStratum[]): void {
  if (!seed) throw new RepeatDrawRefusal("--seed is required; the draw has no default seed");
  if (!/^\d+$/.test(seed)) throw new RepeatDrawRefusal("--seed must be digits");
  const selected = selectStrata(readPatches(patchesPath), seed, plan);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(selected, null, 2)}\n`);
}

export function runRepeatDraw(params: RepeatDrawParams): void {
  runStratifiedDraw(params, REPEAT_STRATA);
}

function parseCli(args: string[], defaultPatchesPath: string): RepeatDrawParams {
  const { values } = parseArgs({
    args,
    options: {
      patches: { type: "string", default: defaultPatchesPath },
      seed: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.out) throw new RepeatDrawRefusal("--out is required");
  return { patchesPath: values.patches, seed: values.seed, outPath: values.out };
}

export function drawCli(
  args: string[],
  { defaultPatchesPath, plan, usage }: { defaultPatchesPath: string; plan: readonly RepeatStratum[]; usage: string },
): number {
  try {
    const params = parseCli(args, defaultPatchesPath);
    runStratifiedDraw(params, plan);
    console.log(params.outPath);
    return 0;
  } catch (error) {
    const isUsage =
      error instanceof RepeatDrawRefusal || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    if (!isUsage) throw error;
    console.error(`${(error as Error).message}\n${usage}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = drawCli(process.argv.slice(2), {
    defaultPatchesPath: DEFAULT_PATCHES_PATH,
    plan: REPEAT_STRATA,
    usage: USAGE,
  });
}
