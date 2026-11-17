import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

export const PINNED_VERDICTS_SHA256 = "8c9d31cca70b02852144111e85f72bfe749d6a95745556b156b984c5d650228d";
export const PINNED_FRAME_SIZES: FrameSizes = { wrong: 83, correct: 70 };
export const EXCLUDED_INSTANCES: ReadonlySet<string> = new Set([
  "django__django-10097",
  "django__django-10973",
  "django__django-10880",
]);
export const PILOT_WRONG_INSTANCES: ReadonlySet<string> = new Set([
  "django__django-15375",
  "django__django-13279",
  "django__django-15098",
  "django__django-11141",
  "django__django-13417",
  "django__django-11211",
  "django__django-16116",
  "django__django-15741",
  "django__django-13410",
  "django__django-11603",
  "django__django-16100",
  "django__django-14631",
  "django__django-13121",
  "django__django-11292",
]);
export const PILOT_CORRECT_INSTANCES: ReadonlySet<string> = new Set([
  "django__django-15930",
  "django__django-16950",
  "django__django-15467",
  "django__django-13516",
  "django__django-15103",
  "django__django-11555",
]);
export const EXCLUDED_AGENTS: ReadonlySet<string> = new Set([
  "20250929_mini-v1.13.3_sonnet-4-5-20250929",
  "20251118_mini-v1.15.0_gemini-3-pro-preview-20251118",
  "20251124_mini-v1.16.0_claude-opus-4-5-20251101",
  "20251211_mini-v1.17.2_gpt-5.2-2025-12-11-high",
  "20260217_mini-v2.0.0_claude-4-5-opus-high",
  "20260217_mini-v2.0.0_claude-4-6-opus",
  "20260217_mini-v2.0.0_gemini-3-flash-high",
  "20260217_mini-v2.0.0_glm-5-high",
  "20260217_mini-v2.0.0_gpt-5-2-high",
  "20260217_mini-v2.0.0_minimax-2-5-high",
  "20260219_mini-v2.0.0_gpt-5-2-codex",
]);

export const WRONG_STRATUM = "wrong";
export const CORRECT_STRATUM = "correct";
export const WRONG_TIERS: readonly CapTier[] = [
  { through: 60, cap: 6, role: "main" },
  { through: 75, cap: 7, role: "extension" },
  { through: Number.POSITIVE_INFINITY, cap: 7, role: "reserve" },
];
export const CORRECT_TIERS: readonly CapTier[] = [{ through: 30, cap: 3, role: "correct" }];

const REQUIRED_WRONG_ENTRIES = 75;
const REQUIRED_CORRECT_ENTRIES = 30;
const RANDOM_RANGE = 2 ** 48;
const RANDOM_BYTES = 6;

const USAGE = "usage: node harness/draw.ts --verdicts <path> --seed <seed> --out <path>";

export interface VerdictRecord {
  agent_id: string;
  instance_id: string;
  original_tests_passed: boolean;
  swe_abs_tests_passed: boolean;
}

export interface FrameInstance {
  instance_id: string;
  agents: string[];
}

export type Frame = FrameInstance[];

export interface CapTier {
  through: number;
  cap: number;
  role: string;
}

export interface DrawEntry {
  position: number;
  instance_id: string;
  agent_id: string;
  role: string;
  patch_url: string;
}

export interface StratumDraw {
  entries: DrawEntry[];
  cap_deferred: string[];
  unplaced: string[];
}

export interface FrameSizes {
  wrong: number;
  correct: number;
}

export interface DrawParams {
  verdictsPath: string;
  seed: string | undefined;
  outPath: string;
  pinnedSha256?: string;
  frameSizes?: FrameSizes;
}

export class DrawRefusal extends Error {}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function randomStream(seed: string, stratum: string): (bound: number) => number {
  let counter = 0;
  return (bound) => {
    const limit = RANDOM_RANGE - RANDOM_RANGE % bound;
    for (;;) {
      const digest = createHash("sha256").update(`${seed}:${stratum}:${counter}`).digest();
      counter += 1;
      const value = digest.readUIntBE(0, RANDOM_BYTES);
      if (value < limit) return value % bound;
    }
  };
}

function buildFrame(records: readonly VerdictRecord[], qualifies: (record: VerdictRecord) => boolean): Frame {
  const agentsByInstance = new Map<string, Set<string>>();
  for (const record of records) {
    if (!record.instance_id.startsWith("django__")) continue;
    if (EXCLUDED_INSTANCES.has(record.instance_id)) continue;
    if (EXCLUDED_AGENTS.has(record.agent_id)) continue;
    if (!qualifies(record)) continue;
    const agents = agentsByInstance.get(record.instance_id) ?? new Set<string>();
    agents.add(record.agent_id);
    agentsByInstance.set(record.instance_id, agents);
  }
  return [...agentsByInstance]
    .map(([instance_id, agents]) => ({ instance_id, agents: [...agents].sort(compareCodeUnits) }))
    .sort((a, b) => compareCodeUnits(a.instance_id, b.instance_id));
}

export function wrongFrame(records: readonly VerdictRecord[]): Frame {
  return buildFrame(records, (r) => r.original_tests_passed === true && r.swe_abs_tests_passed === false);
}

export function correctFrame(records: readonly VerdictRecord[]): Frame {
  const wrongInstances = new Set(wrongFrame(records).map((instance) => instance.instance_id));
  return buildFrame(records, (r) => r.original_tests_passed === true && r.swe_abs_tests_passed === true)
    .filter((instance) => wrongInstances.has(instance.instance_id));
}

export function mainFrames(records: readonly VerdictRecord[]): { wrong: Frame; correct: Frame } {
  return {
    wrong: wrongFrame(records).filter((instance) => !PILOT_WRONG_INSTANCES.has(instance.instance_id)),
    correct: correctFrame(records).filter(
      (instance) => !PILOT_WRONG_INSTANCES.has(instance.instance_id) && !PILOT_CORRECT_INSTANCES.has(instance.instance_id),
    ),
  };
}

export function patchUrl(agentId: string, instanceId: string): string {
  return `https://swe-bench-submissions.s3.amazonaws.com/verified/${agentId}/logs/${instanceId}/patch.diff`;
}

function tierAt(tiers: readonly CapTier[], position: number): CapTier | undefined {
  return tiers.find((tier) => position <= tier.through);
}

export function drawStratum(
  frame: Frame,
  { seed, stratum, caps }: { seed: string; stratum: string; caps: readonly CapTier[] },
): StratumDraw {
  const random = randomStream(seed, stratum);
  const queue = frame
    .map((instance) => ({
      instance_id: instance.instance_id,
      agents: [...instance.agents].sort(compareCodeUnits),
    }))
    .sort((a, b) => compareCodeUnits(a.instance_id, b.instance_id));
  for (let i = queue.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }

  const agentCounts = new Map<string, number>();
  const entries: DrawEntry[] = [];
  const deferred = new Set<string>();
  let passedOver = 0;
  while (passedOver < queue.length) {
    const position = entries.length + 1;
    const tier = tierAt(caps, position);
    if (tier === undefined) break;
    const instance = queue.shift();
    if (instance === undefined) break;
    const underCap = instance.agents.filter((agent) => (agentCounts.get(agent) ?? 0) < tier.cap);
    if (underCap.length === 0) {
      deferred.add(instance.instance_id);
      queue.push(instance);
      passedOver += 1;
      continue;
    }
    passedOver = 0;
    const agent_id = underCap[random(underCap.length)];
    agentCounts.set(agent_id, (agentCounts.get(agent_id) ?? 0) + 1);
    entries.push({
      position,
      instance_id: instance.instance_id,
      agent_id,
      role: tier.role,
      patch_url: patchUrl(agent_id, instance.instance_id),
    });
  }

  const placed = new Set(entries.map((entry) => entry.instance_id));
  return {
    entries,
    cap_deferred: [...deferred],
    unplaced: [...deferred].filter((instanceId) => !placed.has(instanceId)),
  };
}

function parseVerdictRecords(raw: Buffer): VerdictRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new DrawRefusal(`verdict file is not JSON: ${(error as Error).message}`);
  }
  const records = (parsed as { records?: unknown } | null)?.records;
  if (!Array.isArray(records)) throw new DrawRefusal("verdict file has no records[] array");
  return records as VerdictRecord[];
}

function readVerdictFile(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new DrawRefusal(`cannot read verdict file: ${(error as Error).message}`);
  }
}

export function runDraw({
  verdictsPath,
  seed,
  outPath,
  pinnedSha256 = PINNED_VERDICTS_SHA256,
  frameSizes = PINNED_FRAME_SIZES,
}: DrawParams): void {
  if (!seed) throw new DrawRefusal("--seed is required; the draw has no default seed");

  const raw = readVerdictFile(verdictsPath);
  const verdictsSha256 = createHash("sha256").update(raw).digest("hex");
  if (verdictsSha256 !== pinnedSha256) {
    throw new DrawRefusal(`verdict file sha256 ${verdictsSha256} differs from the pinned ${pinnedSha256}`);
  }

  const records = parseVerdictRecords(raw);
  const { wrong, correct } = mainFrames(records);
  if (wrong.length !== frameSizes.wrong || correct.length !== frameSizes.correct) {
    throw new DrawRefusal(
      `frame sizes wrong=${wrong.length} correct=${correct.length} differ from the expected wrong=${frameSizes.wrong} correct=${frameSizes.correct}`,
    );
  }

  const wrongDraw = drawStratum(wrong, { seed, stratum: WRONG_STRATUM, caps: WRONG_TIERS });
  const correctDraw = drawStratum(correct, { seed, stratum: CORRECT_STRATUM, caps: CORRECT_TIERS });
  if (wrongDraw.entries.length < REQUIRED_WRONG_ENTRIES || correctDraw.entries.length !== REQUIRED_CORRECT_ENTRIES) {
    throw new DrawRefusal(
      `caps left too few positions: wrong=${wrongDraw.entries.length} (needs ${REQUIRED_WRONG_ENTRIES}) correct=${correctDraw.entries.length} (needs ${REQUIRED_CORRECT_ENTRIES})`,
    );
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        seed,
        verdicts_sha256: verdictsSha256,
        frame_sizes: { wrong: wrong.length, correct: correct.length },
        cap_deferred: { wrong: wrongDraw.cap_deferred, correct: correctDraw.cap_deferred },
        unplaced: { wrong: wrongDraw.unplaced, correct: correctDraw.unplaced },
        wrong: wrongDraw.entries,
        correct: correctDraw.entries,
      },
      null,
      2,
    )}\n`,
  );
}

function parseCli(args: string[]): DrawParams {
  const { values } = parseArgs({
    args,
    options: {
      verdicts: { type: "string" },
      seed: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.verdicts) throw new DrawRefusal("--verdicts is required");
  if (!values.out) throw new DrawRefusal("--out is required");
  return { verdictsPath: values.verdicts, seed: values.seed, outPath: values.out };
}

function main(): number {
  try {
    const params = parseCli(process.argv.slice(2));
    runDraw(params);
    console.log(params.outPath);
    return 0;
  } catch (error) {
    const isUsage = error instanceof DrawRefusal || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    if (!isUsage) throw error;
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = main();
}
