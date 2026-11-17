import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  CORRECT_STRATUM,
  CORRECT_TIERS,
  DrawRefusal,
  drawStratum,
  mainFrames,
  PINNED_FRAME_SIZES,
  PINNED_VERDICTS_SHA256,
  WRONG_STRATUM,
  WRONG_TIERS,
  type CapTier,
  type DrawEntry,
  type FrameSizes,
} from "../draw.ts";
import { sha256 } from "../sources.ts";
import {
  checkAvailability,
  fetchDatasetEntries,
  loadPins,
  parseVerdictRecords,
  readVerdictFile,
  REAL_NET,
  requirePinnedRows,
  rowHashes,
  type DatasetEntry,
  type PilotNet,
  type PilotPatch,
  type PilotPin,
  type SkippedEntry,
} from "./draw-pilot.ts";

const USAGE = "usage: node harness/checks/draw-main.ts --verdicts <path> --seed <digits> --out <dir> [--exclude <path>]";

export const MAIN_WRONG_ENTRIES = 60;
export const EXTENSION_WRONG_ENTRIES = 15;
export const MAIN_CORRECT_ENTRIES = 30;
export const CHECK_CORRECT_RESERVES = 5;
export const MAIN_CORRECT_TIERS: readonly CapTier[] = [
  ...CORRECT_TIERS,
  { through: Number.POSITIVE_INFINITY, cap: 3, role: "reserve" },
];

const RESERVE_ROLE = "reserve";
const SEED_SHAPE = /^\d+$/;

export interface MainPatch extends PilotPatch {
  role: string;
}

export interface Exclusion {
  instance_id: string;
  agent_id: string;
  reason: string;
}

export interface Replacement {
  dropped: { instance_id: string; agent_id: string; role: string; reason: string };
  replacement: { instance_id: string; agent_id: string; draw_position: number };
}

export interface MainEntry extends DrawEntry {
  stratum: string;
}

export interface MainDraw {
  seed: string;
  verdicts_sha256: string;
  frame_sizes: FrameSizes;
  entries: MainEntry[];
  skipped: SkippedEntry[];
  replacements: Replacement[];
}

export interface MainDrawResult {
  draw: MainDraw;
  mainPatches: MainPatch[];
  checkPatches: MainPatch[];
  extensionPatches: MainPatch[];
}

export interface MainParams {
  verdictsPath: string;
  seed: string;
  outDir: string;
  exclude?: readonly Exclusion[];
  net?: PilotNet;
  pinnedSha256?: string;
  pins?: readonly PilotPin[];
}

interface StratumRequest {
  entries: readonly DrawEntry[];
  stratum: string;
  label: PilotPatch["label_stratum"];
  wanted: number;
}

interface StratumResolution {
  slots: MainPatch[];
  reserves: MainPatch[];
  skipped: SkippedEntry[];
  replacements: Replacement[];
}

interface EnrichContext {
  rows: ReadonlyMap<string, DatasetEntry>;
  shared: Pick<PilotPatch, "dataset" | "source_commits" | "swe_abs_verdicts_sha256">;
  exclusions: ReadonlyMap<string, string>;
  net: PilotNet;
}

function exclusionKey(instanceId: string, agentId: string): string {
  return `${instanceId}\u0000${agentId}`;
}

async function enrich(
  entry: DrawEntry,
  label: PilotPatch["label_stratum"],
  { rows, shared, exclusions, net }: EnrichContext,
): Promise<MainPatch | { reason: string }> {
  const excluded = exclusions.get(exclusionKey(entry.instance_id, entry.agent_id));
  if (excluded !== undefined) return { reason: `excluded: ${excluded}` };
  const outcome = await checkAvailability(entry, net);
  if ("reason" in outcome) return outcome;
  return {
    instance_id: entry.instance_id,
    agent_id: entry.agent_id,
    label_stratum: label,
    role: entry.role,
    patch_sha256: outcome.patch_sha256,
    patch_url: entry.patch_url,
    ...outcome.digests,
    ...rowHashes(entry.instance_id, rows),
    dataset: shared.dataset,
    source_commits: shared.source_commits,
    swe_abs_verdicts_sha256: shared.swe_abs_verdicts_sha256,
    excluded_from_draw: false,
    draw_position: entry.position,
  };
}

async function resolveStratum(
  { entries, stratum, label, wanted }: StratumRequest,
  context: EnrichContext,
): Promise<StratumResolution> {
  const slotEntries = entries.filter((entry) => entry.role !== RESERVE_ROLE);
  if (slotEntries.length !== wanted) {
    throw new DrawRefusal(`${stratum} stratum drew ${slotEntries.length} non-reserve entries, needs ${wanted}`);
  }
  const accepted = new Map<DrawEntry, MainPatch>();
  const reasons = new Map<DrawEntry, string>();
  const skipped: SkippedEntry[] = [];
  for (const entry of entries) {
    const outcome = await enrich(entry, label, context);
    if ("reason" in outcome) {
      reasons.set(entry, outcome.reason);
      skipped.push({
        stratum,
        draw_position: entry.position,
        instance_id: entry.instance_id,
        agent_id: entry.agent_id,
        reason: outcome.reason,
      });
      continue;
    }
    accepted.set(entry, outcome);
  }

  const pool = entries.filter((entry) => entry.role === RESERVE_ROLE && accepted.has(entry));
  const slots: MainPatch[] = [];
  const replacements: Replacement[] = [];
  for (const entry of slotEntries) {
    const patch = accepted.get(entry);
    if (patch) {
      slots.push(patch);
      continue;
    }
    const reserve = pool.shift();
    if (reserve === undefined) {
      throw new DrawRefusal(`${stratum} stratum ran out of reserves replacing position ${entry.position}`);
    }
    const replacement = accepted.get(reserve) as MainPatch;
    slots.push({ ...replacement, role: entry.role });
    replacements.push({
      dropped: {
        instance_id: entry.instance_id,
        agent_id: entry.agent_id,
        role: entry.role,
        reason: reasons.get(entry) as string,
      },
      replacement: { instance_id: reserve.instance_id, agent_id: reserve.agent_id, draw_position: reserve.position },
    });
  }
  return { slots, reserves: pool.map((entry) => accepted.get(entry) as MainPatch), skipped, replacements };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function runMainDraw({
  verdictsPath,
  seed,
  outDir,
  exclude = [],
  net = REAL_NET,
  pinnedSha256 = PINNED_VERDICTS_SHA256,
  pins = loadPins(),
}: MainParams): Promise<MainDrawResult> {
  if (!SEED_SHAPE.test(seed)) throw new DrawRefusal(`--seed must be digits only, got ${JSON.stringify(seed)}`);
  const raw = readVerdictFile(verdictsPath);
  const verdictsSha256 = sha256(raw);
  if (verdictsSha256 !== pinnedSha256) {
    throw new DrawRefusal(`verdict file sha256 ${verdictsSha256} differs from the pinned ${pinnedSha256}`);
  }
  const { wrong, correct } = mainFrames(parseVerdictRecords(raw));
  if (wrong.length !== PINNED_FRAME_SIZES.wrong || correct.length !== PINNED_FRAME_SIZES.correct) {
    throw new DrawRefusal(
      `frame sizes wrong=${wrong.length} correct=${correct.length} differ from the expected wrong=${PINNED_FRAME_SIZES.wrong} correct=${PINNED_FRAME_SIZES.correct}`,
    );
  }

  const wrongEntries = drawStratum(wrong, { seed, stratum: WRONG_STRATUM, caps: WRONG_TIERS }).entries;
  const correctEntries = drawStratum(correct, { seed, stratum: CORRECT_STRATUM, caps: MAIN_CORRECT_TIERS }).entries;

  const [{ dataset, source_commits }] = pins;
  const rows = await fetchDatasetEntries(dataset, net);
  requirePinnedRows(pins, rows);
  const context: EnrichContext = {
    rows,
    shared: { dataset, source_commits, swe_abs_verdicts_sha256: verdictsSha256 },
    exclusions: new Map(exclude.map((entry) => [exclusionKey(entry.instance_id, entry.agent_id), entry.reason])),
    net,
  };
  const wrongResolution = await resolveStratum(
    {
      entries: wrongEntries,
      stratum: WRONG_STRATUM,
      label: "swe_abs_wrong",
      wanted: MAIN_WRONG_ENTRIES + EXTENSION_WRONG_ENTRIES,
    },
    context,
  );
  const correctResolution = await resolveStratum(
    { entries: correctEntries, stratum: CORRECT_STRATUM, label: "swe_abs_correct", wanted: MAIN_CORRECT_ENTRIES },
    context,
  );

  const mainPatches = [
    ...wrongResolution.slots.filter((patch) => patch.role === "main"),
    ...correctResolution.slots,
  ];
  const extensionPatches = wrongResolution.slots.filter((patch) => patch.role === "extension");
  const checkPatches = [
    ...mainPatches,
    ...wrongResolution.reserves,
    ...correctResolution.reserves.slice(0, CHECK_CORRECT_RESERVES),
  ];
  const draw: MainDraw = {
    seed,
    verdicts_sha256: verdictsSha256,
    frame_sizes: { wrong: wrong.length, correct: correct.length },
    entries: [
      ...wrongEntries.map((entry) => ({ stratum: WRONG_STRATUM, ...entry })),
      ...correctEntries.map((entry) => ({ stratum: CORRECT_STRATUM, ...entry })),
    ],
    skipped: [...wrongResolution.skipped, ...correctResolution.skipped],
    replacements: [...wrongResolution.replacements, ...correctResolution.replacements],
  };

  mkdirSync(outDir, { recursive: true });
  writeJson(join(outDir, "main-draw.json"), draw);
  writeJson(join(outDir, "main-patches.json"), mainPatches);
  writeJson(join(outDir, "check-patches.json"), checkPatches);
  writeJson(join(outDir, "extension-patches.json"), extensionPatches);
  return { draw, mainPatches, checkPatches, extensionPatches };
}

function readExclusions(path: string): Exclusion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new DrawRefusal(`cannot read exclude file: ${(error as Error).message}`);
  }
  const valid =
    Array.isArray(parsed) &&
    parsed.every(
      (entry) =>
        typeof entry?.instance_id === "string" && typeof entry.agent_id === "string" && typeof entry.reason === "string",
    );
  if (!valid) throw new DrawRefusal("exclude file must be a JSON array of {instance_id, agent_id, reason}");
  return parsed as Exclusion[];
}

function parseCli(args: string[]): MainParams {
  const { values } = parseArgs({
    args,
    options: {
      verdicts: { type: "string" },
      seed: { type: "string" },
      out: { type: "string" },
      exclude: { type: "string" },
    },
  });
  if (!values.verdicts) throw new DrawRefusal("--verdicts is required");
  if (!values.seed) throw new DrawRefusal("--seed is required; the draw has no default seed");
  if (!values.out) throw new DrawRefusal("--out is required");
  return {
    verdictsPath: values.verdicts,
    seed: values.seed,
    outDir: values.out,
    exclude: values.exclude === undefined ? [] : readExclusions(values.exclude),
  };
}

export async function main(args: string[], overrides: Partial<MainParams> = {}): Promise<number> {
  try {
    const params = { ...parseCli(args), ...overrides };
    await runMainDraw(params);
    console.log(params.outDir);
    return 0;
  } catch (error) {
    const isUsage = error instanceof DrawRefusal || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    if (!isUsage) throw error;
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
