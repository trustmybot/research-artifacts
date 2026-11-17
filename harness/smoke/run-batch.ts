import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { ARMS, ARMS_USAGE, CONTROL_ARM, parseArms, type Arm } from "../conditions/authornote/arms.ts";
import { CONDITION_REFUSAL, CONDITION_USAGE, parseCondition, resourceNames, type Condition } from "../gcp/common.ts";
import { EFFORTS, formatCell, MODELS_USAGE, parseModels, shortModel, type Model, type ModelCell } from "../models.ts";
import { openClosedNetwork, scrubber, type DockerHost } from "../network.ts";
import {
  CLI_VERSION,
  networkPreflight,
  patchPaths,
  type PreflightCheck,
} from "../preflight.ts";
import {
  dockerRunners,
  MODEL,
  reviewImageRefs,
  runReview,
  UsageError,
  type RunContext,
  type RunRecord,
} from "../run-review.ts";
import { LIMIT_RERUN_SUFFIX } from "../results-csv.ts";
import {
  API_KEY_ENV,
  dockerImageRemoveArgs,
  onSettled,
  RequestedModelStub,
  spawnCollect,
  StubContainer,
  type ContainerRunner,
  type ModelRunner,
} from "../runners.ts";
import { loadFakeSources, loadSources, REPO_ROOT, sha256, type Instance, type Sources } from "../sources.ts";
import { rollUpArms, writeDiscrepancies, type CompletedRun, type LabelStratum } from "./artifacts.ts";

export const REVIEW_BUDGET_USD = 4;
export const BATCH_BUDGET_USD = 20;
export const UNUSABLE_LIMIT = 2;
const MODEL_SIDE_FAILURE = "verdict_unusable";
const LIMIT_HIT_STOPS = new Set(["verdict_absent:timeout", "verdict_absent:error_max_budget_usd"]);
const PREFLIGHT_STOP = "preflight_failed:";
const SETUP_STOP = "setup_failed:";
const REPEAT_EFFORT = "high";
const ARMS_EFFORT = "medium";
const REPEAT_NUMBER = 1;
const CHECKPOINT_TIMEOUT_MS = 10 * 60_000;
const IMAGE_REMOVE_TIMEOUT_MS = 5 * 60_000;
const PATCHES_PATH = join(import.meta.dirname, "smoke-patches.json");
const FAKE_TRANSCRIPT_PATH = join(import.meta.dirname, "..", "fixtures", "transcript.jsonl");
const STUB_PROXY_URL = "http://stub-proxy.invalid:3128";
const PREFLIGHT_FILE = "preflight-report.json";
const SUMMARY_FILE = "summary.json";
const RUN_FILE = "run.json";
const TRANSCRIPT_FILE = "transcript.jsonl";
const USAGE =
  `usage: node harness/smoke/run-batch.ts --run-id <id> ${CONDITION_USAGE} --seed <int> --vm-type <type> --out <dir> [--checkpoint-cmd <cmd>] [--resume-from <dir>] [--patches <path>] [--batch-budget-usd <n>] [--review-reserve-usd <n>] [--pause-after-patches <n>] [--unusable-limit <n API or VM failures per cell, this shard only>] [--repeat <n>] [--arms <${ARMS.join(",")}>] [--models <model[:effort],...>] [--shard <k>/<n>] [--fake] [--fake-cost-usd <n>]`;

export type SmokePatch = Instance & { label_stratum: LabelStratum };

export interface BatchOptions {
  runId: string;
  condition: Condition;
  seed: number;
  vmType: string;
  outDir: string;
  checkpointCmd: string | null;
  fake: boolean;
  fakeCostUsd: number | null;
  resumeFrom: string | null;
  patchesPath: string;
  batchBudgetUsd: number;
  reviewReserveUsd: number;
  pauseAfterPatches: number | null;
  unusableLimit?: number;
  repeat: number | null;
  arms?: Arm[] | null;
  models?: ModelCell[] | null;
  shard: Shard | null;
}

export interface Shard {
  index: number;
  count: number;
}

export type PatchIdentity = Pick<Instance, "instance_id" | "agent_id"> & { patch_sha256?: string };

export interface PriorRun {
  runId: string;
  carriedUsd: number;
  reusedRuns: string[];
  patchesFile: string | null;
  shard: Shard | null;
  patches: PatchIdentity[];
}

export interface ReuseSelection {
  reused: Map<string, RunRecord>;
  rerun: Array<{ run: string; reason: string }>;
}

export interface PlannedRun {
  patch: SmokePatch;
  effort: string;
  arm: Arm;
  model: Model;
  runOrder: number;
  name: string;
}

export interface BatchRunners {
  container: ContainerRunner;
  model: ModelRunner;
}

export interface BatchNetwork {
  proxyUrl: string;
  createRunners(sources: Sources): BatchRunners;
  removeImage(instance: Instance): Promise<void>;
  close(): Promise<void>;
}

export interface BatchDeps {
  env: NodeJS.ProcessEnv;
  patches: SmokePatch[];
  loadSources(patch: SmokePatch): Promise<Sources>;
  openNetwork(): Promise<BatchNetwork>;
}

export type LimitRerunRecord = RunRecord & { limit_rerun_of: string };

export interface DispatchResult {
  records: RunRecord[];
  limitReruns: LimitRerunRecord[];
  stopReason: string;
  spentUsd: number;
}

export function parseBatchCli(args: string[], env: NodeJS.ProcessEnv): BatchOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        "run-id": { type: "string" },
        condition: { type: "string" },
        seed: { type: "string" },
        "vm-type": { type: "string" },
        out: { type: "string" },
        "checkpoint-cmd": { type: "string" },
        fake: { type: "boolean", default: false },
        "fake-cost-usd": { type: "string" },
        "resume-from": { type: "string" },
        patches: { type: "string" },
        "batch-budget-usd": { type: "string" },
        "review-reserve-usd": { type: "string" },
        "pause-after-patches": { type: "string" },
        "unusable-limit": { type: "string" },
        repeat: { type: "string" },
        arms: { type: "string" },
        models: { type: "string" },
        shard: { type: "string" },
      },
    }));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { "run-id": runId, seed, "vm-type": vmType, out, "fake-cost-usd": fakeCost } = values;
  if (!runId || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(runId)) {
    throw new UsageError("--run-id is required and may hold letters, digits, _, . and -");
  }
  const condition = parseCondition(values.condition);
  if (condition === null) {
    throw new UsageError(CONDITION_REFUSAL);
  }
  if (seed === undefined || !/^-?\d+$/.test(seed) || !Number.isSafeInteger(Number(seed))) {
    throw new UsageError("--seed is required and must be an integer");
  }
  if (!vmType) throw new UsageError("--vm-type is required");
  if (!out) throw new UsageError("--out is required");
  if (fakeCost !== undefined && !values.fake) {
    throw new UsageError("--fake-cost-usd needs --fake");
  }
  if (fakeCost !== undefined && !/^\d+(\.\d+)?$/.test(fakeCost)) {
    throw new UsageError("--fake-cost-usd must be a non-negative number");
  }
  const batchBudgetUsd = parseBatchBudget(values["batch-budget-usd"]);
  const reviewReserveUsd = parseReviewReserve(values["review-reserve-usd"]);
  const pauseAfterPatches = parsePauseAfterPatches(values["pause-after-patches"]);
  const unusableLimit = parseUnusableLimit(values["unusable-limit"]);
  const repeat = values.repeat === undefined ? null : parseRepeat(values.repeat);
  const arms = values.arms === undefined ? null : parseArmList(values.arms);
  if (arms !== null && repeat !== null) throw new UsageError("--arms and --repeat are mutually exclusive");
  const models = values.models === undefined ? null : parseModelList(values.models);
  if (models !== null && repeat !== null) throw new UsageError("--models and --repeat are mutually exclusive");
  const givenShard = values.shard === undefined ? null : parseShard(values.shard);
  const givenPatchesPath = values.patches === undefined ? null : resolve(values.patches);
  if (givenPatchesPath !== null && !existsSync(givenPatchesPath)) {
    throw new UsageError(`--patches: ${givenPatchesPath} does not exist`);
  }
  if (!values.fake && !env[API_KEY_ENV]) {
    throw new UsageError(`a real run requires ${API_KEY_ENV}`);
  }
  const outDir = resolve(out);
  if (existsSync(join(outDir, PREFLIGHT_FILE))) {
    throw new UsageError(`${outDir} already holds a batch; the budget meter starts at 0 for each --out`);
  }
  const resumeFrom = values["resume-from"] === undefined ? null : resolve(values["resume-from"]);
  const prior = resumeFrom === null ? null : readPriorRun(resumeFrom, Number(seed));
  const shard = values.shard === undefined ? (prior?.shard ?? null) : givenShard;
  const patchesPath = givenPatchesPath ?? priorPatchesPath(prior);
  if (!existsSync(patchesPath)) {
    throw new UsageError(`--resume-from: the prior run's patches file ${patchesPath} does not exist`);
  }
  return {
    runId,
    condition,
    seed: Number(seed),
    vmType,
    outDir,
    checkpointCmd: values["checkpoint-cmd"] ?? null,
    fake: values.fake,
    fakeCostUsd: fakeCost === undefined ? null : Number(fakeCost),
    resumeFrom,
    patchesPath,
    batchBudgetUsd,
    reviewReserveUsd,
    pauseAfterPatches,
    unusableLimit,
    repeat,
    arms,
    models,
    shard,
  };
}

export function parseRepeat(value: string): number {
  if (!/^([2-9]|[1-9]\d)$/.test(value)) {
    throw new UsageError("--repeat must be an integer from 2 to 99");
  }
  return Number(value);
}

export function parseArmList(value: string): Arm[] {
  const arms = parseArms(value);
  if (arms === null) throw new UsageError(`--arms must be ${ARMS_USAGE}`);
  return arms;
}

export function parseModelList(value: string): ModelCell[] {
  const models = parseModels(value);
  if (models === null) throw new UsageError(`--models must be ${MODELS_USAGE}`);
  return models;
}

function shardOf(value: string): Shard | null {
  const match = /^(0|[1-9]\d{0,5})\/([1-9]\d{0,5})$/.exec(value);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  return match === null || count < 2 || index >= count ? null : { index, count };
}

export function parseShard(value: string): Shard {
  const shard = shardOf(value);
  if (shard === null) throw new UsageError("--shard must be <k>/<n> with integers n >= 2 and 0 <= k < n");
  return shard;
}

function formatShard(shard: Shard | null): string | null {
  return shard === null ? null : `${shard.index}/${shard.count}`;
}

function parseBatchBudget(value: string | undefined): number {
  if (value === undefined) return BATCH_BUDGET_USD;
  const budget = Number(value);
  if (!/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(budget) || budget <= 0) {
    throw new UsageError("--batch-budget-usd must be a positive number");
  }
  return budget;
}

function parseReviewReserve(value: string | undefined): number {
  if (value === undefined) return REVIEW_BUDGET_USD;
  const reserve = Number(value);
  if (!/^\d+(\.\d+)?$/.test(value) || reserve <= 0 || reserve > REVIEW_BUDGET_USD) {
    throw new UsageError(`--review-reserve-usd must be above 0 and at most ${REVIEW_BUDGET_USD}`);
  }
  return reserve;
}

function parsePauseAfterPatches(value: string | undefined): number | null {
  if (value === undefined) return null;
  const patches = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(patches) || patches <= 0) {
    throw new UsageError("--pause-after-patches must be a positive integer");
  }
  return patches;
}

function parseUnusableLimit(value: string | undefined): number {
  if (value === undefined) return UNUSABLE_LIMIT;
  const limit = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new UsageError("--unusable-limit must be a positive integer; it counts each cell's API or VM failures in this shard only, never a missing or malformed verdict or a review that hit its $4 or 60-minute limit");
  }
  return limit;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function readPriorRun(dir: string, seed: number): PriorRun {
  const path = join(dir, PREFLIGHT_FILE);
  if (!existsSync(path)) throw new UsageError(`--resume-from: ${path} does not exist`);
  const report = readJsonFile(path) as {
    run_id?: unknown;
    seed?: unknown;
    carried_usd?: unknown;
    reused_runs?: unknown;
    patches_file?: unknown;
    shard?: unknown;
    patches?: unknown;
  } | null | undefined;
  if (typeof report !== "object" || report === null) {
    throw new UsageError(`--resume-from: ${path} is not a preflight report`);
  }
  if (report.seed !== seed) {
    throw new UsageError(`--resume-from: the prior run used seed ${report.seed}, this one uses ${seed}`);
  }
  const { run_id: runId, carried_usd: carried = 0, reused_runs: reused = [] } = report;
  const reusedIsValid = Array.isArray(reused) && reused.every((name) => typeof name === "string");
  if (typeof runId !== "string" || !isNonNegativeNumber(carried) || !reusedIsValid) {
    throw new UsageError(`--resume-from: ${path} has an invalid run_id, carried_usd or reused_runs`);
  }
  const { patches_file: patchesFile = null, shard = null, patches = [] } = report;
  const shardIsValid = shard === null || (typeof shard === "string" && shardOf(shard) !== null);
  const patchesFileIsValid = patchesFile === null || (typeof patchesFile === "string" && patchesFile !== "");
  if (!shardIsValid || !patchesFileIsValid || !Array.isArray(patches) || !patches.every(isPatchIdentity)) {
    throw new UsageError(`--resume-from: ${path} has an invalid shard, patches_file or patches`);
  }
  return {
    runId,
    carriedUsd: carried,
    reusedRuns: reused,
    patchesFile: patchesFile === null ? null : patchesFileOf(resolve(REPO_ROOT, patchesFile)),
    shard: shard === null ? null : shardOf(shard),
    patches: patches.map(({ instance_id, agent_id, patch_sha256 }) => ({ instance_id, agent_id, patch_sha256 })),
  };
}

function isPatchIdentity(value: unknown): value is PatchIdentity {
  if (typeof value !== "object" || value === null) return false;
  const { instance_id, agent_id, patch_sha256 } = value as Record<string, unknown>;
  const shaIsValid = patch_sha256 === undefined || typeof patch_sha256 === "string";
  return typeof instance_id === "string" && typeof agent_id === "string" && shaIsValid;
}

function patchesFileOf(patchesPath: string): string {
  return relative(REPO_ROOT, patchesPath);
}

function priorPatchesPath(prior: PriorRun | null): string {
  return prior === null || prior.patchesFile === null ? PATCHES_PATH : resolve(REPO_ROOT, prior.patchesFile);
}

function identityKey({ instance_id, agent_id, patch_sha256 }: PatchIdentity): string {
  return JSON.stringify([instance_id, agent_id, patch_sha256 ?? null]);
}

function describeIdentities(keys: string[]): string {
  if (keys.length === 0) return "none";
  const shown = keys.slice(0, 5).map((key) => {
    const [instanceId, agentId] = JSON.parse(key) as string[];
    return `${instanceId} (${agentId})`;
  });
  return keys.length > shown.length ? `${shown.join(", ")} and ${keys.length - shown.length} more` : shown.join(", ");
}

export function verifyResumePlan(
  prior: PriorRun,
  options: Pick<BatchOptions, "patchesPath" | "shard">,
  patches: PatchIdentity[],
): void {
  const shard = formatShard(options.shard) ?? "none";
  const priorShard = formatShard(prior.shard) ?? "none";
  if (shard !== priorShard) {
    throw new UsageError(`--resume-from: this run uses --shard ${shard}, the prior run used ${priorShard}`);
  }
  const patchesFile = patchesFileOf(options.patchesPath);
  if (prior.patchesFile !== null && patchesFile !== prior.patchesFile) {
    throw new UsageError(`--resume-from: this run uses --patches ${patchesFile}, the prior run used ${prior.patchesFile}`);
  }
  const planned = patches.map(identityKey).sort();
  const priorPlanned = prior.patches.map(identityKey).sort();
  if (planned.length === priorPlanned.length && planned.every((key, index) => key === priorPlanned[index])) return;
  const onlyHere = planned.filter((key) => !priorPlanned.includes(key));
  const onlyPrior = priorPlanned.filter((key) => !planned.includes(key));
  throw new UsageError(
    `--resume-from: this run plans ${planned.length} patches from ${patchesFile}, the prior run planned ${priorPlanned.length}; ` +
      `only in this run: ${describeIdentities(onlyHere)}; only in the prior run: ${describeIdentities(onlyPrior)}`,
  );
}

type ChargeableRecord = { stop_reason?: unknown; cost_usd?: unknown; command?: unknown };

export function chargedUsd(record: ChargeableRecord): number {
  const stop = typeof record.stop_reason === "string" ? record.stop_reason : "";
  if (stop.startsWith(PREFLIGHT_STOP)) return 0;
  if (stop.startsWith(SETUP_STOP) && (record.command ?? null) === null) return 0;
  return isNonNegativeNumber(record.cost_usd) ? record.cost_usd : REVIEW_BUDGET_USD;
}

export function carriedUsd(dir: string, prior: PriorRun): number {
  const summary = readJsonFile(join(dir, SUMMARY_FILE)) as { spent_usd?: unknown } | null | undefined;
  if (isNonNegativeNumber(summary?.spent_usd)) return summary.spent_usd;
  const runsDir = join(dir, "runs");
  const names = existsSync(runsDir)
    ? readdirSync(runsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
  let carried = prior.carriedUsd;
  for (const name of names) {
    if (prior.reusedRuns.includes(name)) continue;
    const path = join(runsDir, name, RUN_FILE);
    carried += existsSync(path) ? chargedUsd((readJsonFile(path) ?? {}) as ChargeableRecord) : REVIEW_BUDGET_USD;
  }
  return carried;
}

export function readSmokePatches(path = PATCHES_PATH): SmokePatch[] {
  return JSON.parse(readFileSync(path, "utf8")) as SmokePatch[];
}

function seededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function planRuns(
  patches: SmokePatch[],
  seed: number,
  repeat: number | null = null,
  arms: Arm[] | null = null,
  models: ModelCell[] | null = null,
): PlannedRun[] {
  const random = seededRandom(seed);
  let runs: Array<{ patch: SmokePatch; effort: string; arm: Arm; model?: Model; suffix: string }>;
  if (models !== null && arms !== null) {
    const cells = arms.flatMap((arm) =>
      models.map(({ model, effort }) => ({ arm, model, effort: effort ?? ARMS_EFFORT })),
    );
    runs = patches.flatMap((patch) =>
      shuffled(cells, random).map(({ arm, model, effort }) => ({
        patch,
        effort,
        arm,
        model,
        suffix: `-${arm}-${shortModel(model)}`,
      })),
    );
  } else if (models !== null) {
    const cells = models.flatMap(({ model, effort }) =>
      (effort === null ? EFFORTS : [effort]).map((cellEffort) => ({ model, effort: cellEffort })),
    );
    runs = patches.flatMap((patch) =>
      shuffled(cells, random).map(({ model, effort }) => ({
        patch,
        effort,
        arm: CONTROL_ARM,
        model,
        suffix: `-${shortModel(model)}`,
      })),
    );
  } else if (arms !== null) {
    runs = patches.flatMap((patch) =>
      shuffled(arms, random).map((arm) => ({ patch, effort: ARMS_EFFORT, arm, suffix: `-${arm}` })),
    );
  } else if (repeat !== null) {
    runs = patches.map((patch) => ({ patch, effort: REPEAT_EFFORT, arm: CONTROL_ARM, suffix: `-r${repeat}` }));
  } else {
    runs = patches.flatMap((patch) =>
      shuffled(EFFORTS, random).map((effort) => ({ patch, effort, arm: CONTROL_ARM, suffix: "" })),
    );
  }
  return runs.map(({ patch, effort, arm, model = MODEL, suffix }, index) => {
    const runOrder = index + 1;
    const number = String(runOrder).padStart(2, "0");
    return { patch, effort, arm, model, runOrder, name: `${number}-${patch.instance_id}-${effort}${suffix}` };
  });
}

export function limitRerun(run: PlannedRun): PlannedRun {
  return { ...run, name: `${run.name}${LIMIT_RERUN_SUFFIX}` };
}

export function shardPatches(patches: SmokePatch[], shard: Shard | null): SmokePatch[] {
  return shard === null ? patches : patches.filter((_, index) => index % shard.count === shard.index);
}

export function planShard(
  patches: SmokePatch[],
  seed: number,
  shard: Shard | null,
  repeat: number | null = null,
  arms: Arm[] | null = null,
  models: ModelCell[] | null = null,
): PlannedRun[] {
  const kept = new Set(shardPatches(patches, shard));
  return planRuns(patches, seed, repeat, arms, models).filter((run) => kept.has(run.patch));
}

export class BudgetMeter {
  spentUsd: number;
  private readonly budgetUsd: number;
  private readonly reserveUsd: number;

  constructor(startUsd = 0, budgetUsd = BATCH_BUDGET_USD, reserveUsd = REVIEW_BUDGET_USD) {
    this.spentUsd = startUsd;
    this.budgetUsd = budgetUsd;
    this.reserveUsd = reserveUsd;
  }

  canDispatch(): boolean {
    return this.spentUsd + this.reserveUsd <= this.budgetUsd;
  }

  charge(costUsd: number | null): void {
    this.spentUsd += costUsd ?? REVIEW_BUDGET_USD;
  }
}

function stoppedRunFailure(stopReason: string): string | null {
  if (stopReason.startsWith("model_mismatch:")) return "model_mismatch";
  if (stopReason.startsWith("verdict_malformed:") || stopReason.startsWith("verdict_missing:")) {
    return MODEL_SIDE_FAILURE;
  }
  if (!stopReason.startsWith("verdict_absent:") || LIMIT_HIT_STOPS.has(stopReason)) return null;
  const reportsApiError =
    stopReason === "verdict_absent:is_error" ||
    stopReason.startsWith("verdict_absent:no_result_event");
  return reportsApiError ? "api_error" : "run_error";
}

function captureFailure(run: PlannedRun, record: RunRecord, expected: Instance): string | null {
  return stoppedRunFailure(record.stop_reason) ?? recordFailure(run, record, expected);
}

function isModelSide(record: RunRecord): boolean {
  return stoppedRunFailure(record.stop_reason) === MODEL_SIDE_FAILURE;
}

function isLimitHit(record: RunRecord): boolean {
  return LIMIT_HIT_STOPS.has(record.stop_reason);
}

function isApiOrVmFailure(run: PlannedRun, record: RunRecord, expected: Instance): boolean {
  if (isModelSide(record) || isLimitHit(record)) return false;
  return captureFailure(run, record, expected) !== null;
}

function harnessFailure(run: PlannedRun, record: RunRecord, expected: Instance): string | null {
  return isModelSide(record) ? recordFailure(run, record, expected) : captureFailure(run, record, expected);
}

function recordFailure(run: PlannedRun, record: RunRecord, expected: Instance): string | null {
  const limitHit = isLimitHit(record);
  const matches = (actual: unknown, pinned: unknown): boolean => actual === pinned || (limitHit && actual === null);
  if (!limitHit && (record.transcript_path === null || record.turns === null || record.model === null)) {
    return "transcript_not_parsed";
  }
  if (!matches(record.instance_id, expected.instance_id)) return "instance_id_mismatch";
  if (!matches(record.patch_sha256, expected.patch_sha256)) return "patch_sha256_mismatch";
  if (!limitHit) {
    const tokens = [
      record.input_tokens,
      record.output_tokens,
      record.cache_read_tokens,
      record.cache_write_tokens,
    ];
    if (tokens.includes(null)) return "tokens_null";
    if (record.cost_usd === null) return "cost_null";
  }
  const commandEffort = record.command === null ? null : record.command[record.command.indexOf("--effort") + 1];
  const effortMatches =
    matches(record.effort, run.effort) &&
    matches(commandEffort, run.effort) &&
    (record.effective_effort === null || record.effective_effort === run.effort);
  return effortMatches ? null : "effort_mismatch";
}

function isIntactRecord(value: unknown): value is RunRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const usageIsIntact = ["turns", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd"].every(
    (field) => record[field] === null || isNonNegativeNumber(record[field]),
  );
  return usageIsIntact && typeof record.stop_reason === "string" && (record.command === null || Array.isArray(record.command));
}

export function reuseRejection(
  run: PlannedRun,
  record: unknown,
  expected: Instance,
  options: Pick<BatchOptions, "seed"> & Partial<Pick<BatchOptions, "repeat">>,
): string | null {
  if (!isIntactRecord(record)) return "record_malformed";
  const failure = harnessFailure(run, record, expected);
  if (failure !== null) return failure;
  const finalWithoutVerdict = isModelSide(record) || isLimitHit(record);
  if (!finalWithoutVerdict && record.verdict !== "pass" && record.verdict !== "fail") return "verdict_not_parsed";
  const pins: Array<[string, unknown, unknown]> = [
    ["label_stratum", record.label_stratum, run.patch.label_stratum],
    ["run_order", record.run_order, run.runOrder],
    ["seed", record.seed, options.seed],
    ["repeat_number", record.repeat_number ?? REPEAT_NUMBER, options.repeat ?? REPEAT_NUMBER],
    ["arm", record.arm ?? CONTROL_ARM, run.arm],
    ["model", record.model, run.model],
    ["cli_version", record.cli_version, CLI_VERSION],
    ["image_digest", record.image_digest, expected.image_digest],
  ];
  const mismatch = pins.find(([, actual, pinned]) => actual !== pinned);
  return mismatch ? `${mismatch[0]}_mismatch` : null;
}

export function selectReusable(
  plan: PlannedRun[],
  expected: (patch: SmokePatch) => Instance,
  priorDir: string,
  options: Pick<BatchOptions, "seed" | "outDir"> & Partial<Pick<BatchOptions, "repeat">>,
  scrub: (text: string) => string,
): ReuseSelection {
  const selection: ReuseSelection = { reused: new Map(), rerun: [] };
  const reuse = (run: PlannedRun, marks: Partial<LimitRerunRecord> = {}): RunRecord | null => {
    const priorRunDir = join(priorDir, "runs", run.name);
    const outRunDir = join(options.outDir, "runs", run.name);
    const record = readJsonFile(join(priorRunDir, RUN_FILE));
    const reason = existsSync(join(priorRunDir, TRANSCRIPT_FILE))
      ? reuseRejection(run, record, expected(run.patch), options)
      : "transcript_missing";
    if (reason !== null) {
      selection.rerun.push({ run: run.name, reason });
      return null;
    }
    try {
      cpSync(priorRunDir, outRunDir, { recursive: true });
      const reused = { ...(record as RunRecord), ...marks, transcript_path: join(outRunDir, TRANSCRIPT_FILE) };
      writeFileSync(join(outRunDir, RUN_FILE), scrub(`${JSON.stringify(reused, null, 2)}\n`));
      selection.reused.set(run.name, reused);
      return reused;
    } catch (error) {
      rmSync(outRunDir, { recursive: true, force: true });
      selection.rerun.push({ run: run.name, reason: `copy_failed:${(error as Error).message}` });
      return null;
    }
  };
  for (const run of plan) {
    const reused = reuse(run);
    if (reused !== null && isLimitHit(reused)) reuse(limitRerun(run), { limit_rerun_of: run.name });
  }
  return selection;
}

export function patchOneGate(
  runs: PlannedRun[],
  records: RunRecord[],
  expected: Instance,
): string | null {
  for (const [index, run] of runs.entries()) {
    const failure = harnessFailure(run, records[index], expected);
    if (failure !== null) return `gate_patch1_failed:harness:${run.name}:${failure}`;
  }
  return null;
}

function cellName(run: PlannedRun): string {
  return `${run.model}:${run.effort}:${run.arm}`;
}

export interface DispatchControls {
  unusableLimit?: number;
  releaseInstance?: (patch: SmokePatch) => Promise<void>;
}

export async function dispatchRuns(
  plan: PlannedRun[],
  expected: (patch: SmokePatch) => Instance,
  review: (run: PlannedRun) => Promise<RunRecord>,
  afterReview: () => Promise<void> = async () => {},
  resume: { carriedUsd: number; reused: Map<string, RunRecord> } = { carriedUsd: 0, reused: new Map() },
  batchBudgetUsd = BATCH_BUDGET_USD,
  reviewReserveUsd = REVIEW_BUDGET_USD,
  pauseAfterPatches: number | null = null,
  { unusableLimit = UNUSABLE_LIMIT, releaseInstance = async () => {} }: DispatchControls = {},
): Promise<DispatchResult> {
  const meter = new BudgetMeter(resume.carriedUsd, batchBudgetUsd, reviewReserveUsd);
  const records: RunRecord[] = [];
  const limitReruns: LimitRerunRecord[] = [];
  const stop = (stopReason: string): DispatchResult => ({ records, limitReruns, stopReason, spentUsd: meter.spentUsd });
  const firstPatchRuns = plan.filter((run) => run.patch === plan[0].patch);
  const dispatchedPatches = new Set<SmokePatch>();
  const dispatchedInstances = new Set<string>();
  const lastRunOf = new Map(plan.map((run, index) => [run.patch.instance_id, index]));
  const apiOrVmFailuresByCell = new Map<string, number>();
  const dispatch = async (run: PlannedRun): Promise<RunRecord> => {
    const record = await review(run);
    dispatchedPatches.add(run.patch);
    dispatchedInstances.add(run.patch.instance_id);
    meter.charge(chargedUsd(record));
    await afterReview();
    return record;
  };
  for (const [index, run] of plan.entries()) {
    const reused = resume.reused.get(run.name);
    if (reused === undefined && !meter.canDispatch()) return stop("budget_stop");
    const record = reused ?? (await dispatch(run));
    records.push(record);
    if (isLimitHit(record)) {
      const companion = limitRerun(run);
      const reusedCompanion = resume.reused.get(companion.name);
      if (reusedCompanion === undefined && !meter.canDispatch()) return stop("budget_stop");
      const rerun = reusedCompanion ?? (await dispatch(companion));
      limitReruns.push(Object.assign(rerun, { limit_rerun_of: run.name }));
    }
    if (lastRunOf.get(run.patch.instance_id) === index && dispatchedInstances.has(run.patch.instance_id)) {
      await releaseInstance(run.patch);
    }
    if (record.stop_reason.startsWith("preflight_failed:")) return stop(record.stop_reason);
    if (records.length === firstPatchRuns.length) {
      const gate = patchOneGate(firstPatchRuns, records, expected(plan[0].patch));
      if (gate !== null) return stop(gate);
    }
    if (isApiOrVmFailure(run, record, expected(run.patch))) {
      const cell = cellName(run);
      const failures = (apiOrVmFailuresByCell.get(cell) ?? 0) + 1;
      apiOrVmFailuresByCell.set(cell, failures);
      if (failures >= unusableLimit) return stop(`unusable_limit:${cell}`);
    }
    const next = plan[index + 1];
    const pauses =
      pauseAfterPatches !== null &&
      next !== undefined &&
      next.patch !== run.patch &&
      dispatchedPatches.size >= pauseAfterPatches;
    if (pauses) return stop("pause_after_patches");
  }
  return stop("completed");
}

export function transcriptWithCost(transcript: string, costUsd: number): string {
  return transcript
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      const event = JSON.parse(line) as Record<string, unknown>;
      return event.type === "result" ? JSON.stringify({ ...event, total_cost_usd: costUsd }) : line;
    })
    .join("\n");
}

function fakeSources(patch: SmokePatch): Sources {
  const fixture = loadFakeSources();
  return {
    ...fixture,
    instance: {
      ...patch,
      patch_sha256: sha256(fixture.patch),
      base_commit: fixture.instance.base_commit,
    },
  };
}

function stubRunners(sources: Sources, transcript: string): BatchRunners {
  return {
    container: new StubContainer(sources.instance.base_commit, patchPaths(sources.patch), [], sources.patch),
    model: new RequestedModelStub(transcript),
  };
}

function fakeNetwork(fakeCostUsd: number | null): BatchNetwork {
  const fixture = readFileSync(FAKE_TRANSCRIPT_PATH, "utf8");
  const transcript = fakeCostUsd === null ? fixture : transcriptWithCost(fixture, fakeCostUsd);
  return {
    proxyUrl: STUB_PROXY_URL,
    createRunners: (sources) => stubRunners(sources, transcript),
    removeImage: async () => {},
    close: async () => {},
  };
}

function runContext(run: PlannedRun, options: Pick<BatchOptions, "vmType" | "seed" | "repeat">): RunContext {
  return {
    label_stratum: run.patch.label_stratum,
    run_order: run.runOrder,
    repeat_number: options.repeat ?? REPEAT_NUMBER,
    vm_type: options.vmType,
    seed: options.seed,
  };
}

export async function simulateBudgetStop(
  patches: SmokePatch[],
  seed: number,
  workDir: string,
  batchBudgetUsd = BATCH_BUDGET_USD,
  reviewReserveUsd = REVIEW_BUDGET_USD,
) {
  const outDir = mkdtempSync(join(workDir, "budget-simulation-"));
  const network = fakeNetwork(REVIEW_BUDGET_USD);
  try {
    const plan = planRuns(patches, seed);
    const sources = new Map(patches.map((patch) => [patch, fakeSources(patch)]));
    const { records, stopReason, spentUsd } = await dispatchRuns(
      plan,
      (patch) => (sources.get(patch) as Sources).instance,
      async (run) => {
        const source = sources.get(run.patch) as Sources;
        const { record } = await runReview(
          {
            mode: "fake",
            effort: run.effort,
            budgetUsd: String(REVIEW_BUDGET_USD),
            outDir: join(outDir, run.name),
          },
          {
            env: {},
            proxyUrl: network.proxyUrl,
            loadSources: async () => source,
            createRunners: () => network.createRunners(source),
          },
        );
        return record;
      },
      undefined,
      undefined,
      Math.min(batchBudgetUsd, BATCH_BUDGET_USD),
      reviewReserveUsd,
    );
    return {
      stop_reason: stopReason,
      dispatched: records.length,
      planned: plan.length,
      spent_usd: spentUsd,
      cost_per_review_usd: REVIEW_BUDGET_USD,
    };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

export async function openDockerNetwork(
  options: Pick<BatchOptions, "runId" | "condition" | "outDir">,
  env: NodeJS.ProcessEnv,
  host?: DockerHost,
): Promise<BatchNetwork> {
  const names = resourceNames(options.condition, options.runId);
  const name = names.batchNetwork;
  const { proxyUrl, modelEnv, close } = await openClosedNetwork(
    { name, outDir: options.outDir, env },
    host,
  );
  const docker = host?.docker ?? ((args: string[]) => spawnCollect("docker", args, { timeoutMs: IMAGE_REMOVE_TIMEOUT_MS }));
  const removeImage = async (instance: Instance): Promise<void> => {
    const { tag, baseImage } = reviewImageRefs(names, instance);
    try {
      const result = await docker(dockerImageRemoveArgs(tag, baseImage));
      if (result.code !== 0) throw new Error(`docker image rm exited ${result.code}: ${result.stderr.slice(-500)}`);
    } catch (error) {
      console.error(scrubber(env)(`review image removal for ${instance.instance_id} failed: ${(error as Error).message}`));
    }
  };
  return {
    proxyUrl,
    createRunners: ({ instance }) => dockerRunners(names, instance, name, modelEnv),
    removeImage,
    close,
  };
}

export function runCheckpoint(command: string, scrub: (text: string) => string): Promise<void> {
  const { [API_KEY_ENV]: _key, ...env } = process.env;
  return new Promise((done) => {
    const child = spawn("sh", ["-c", command], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: CHECKPOINT_TIMEOUT_MS,
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      console.error(scrub(`checkpoint failed to start: ${error.message}`));
      done();
    });
    onSettled(child, (code, signal) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").slice(-500);
        console.error(scrub(`checkpoint exited ${code ?? signal}: ${detail}`));
      }
      done();
    });
  });
}

async function probeNetwork(
  network: BatchNetwork,
  sources: Sources,
  env: NodeJS.ProcessEnv,
): Promise<PreflightCheck[]> {
  const { container } = network.createRunners(sources);
  try {
    await container.start();
    return await networkPreflight(container, network.proxyUrl);
  } finally {
    try {
      await container.stop();
    } catch (error) {
      console.error(scrubber(env)(`probe container cleanup failed: ${(error as Error).message}`));
    }
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function runBatch(
  options: BatchOptions,
  deps: BatchDeps,
): Promise<{ stopReason: string; exitCode: number }> {
  const { outDir } = options;
  const prior = options.resumeFrom === null ? null : readPriorRun(options.resumeFrom, options.seed);
  const patches = shardPatches(deps.patches, options.shard);
  if (patches.length === 0) {
    const source = patchesFileOf(options.patchesPath);
    throw new UsageError(
      options.shard === null
        ? `--patches: ${source} holds no patch`
        : `--shard ${formatShard(options.shard)} selects no patch from ${source}, which holds ${deps.patches.length}`,
    );
  }
  if (prior !== null) verifyResumePlan(prior, options, patches);
  const scrub = scrubber(deps.env);
  const checkpoint = async (): Promise<void> => {
    if (options.checkpointCmd !== null) await runCheckpoint(options.checkpointCmd, scrub);
  };
  mkdirSync(join(outDir, "runs"), { recursive: true });
  writeFileSync(join(outDir, "proxy.log"), "");

  const repeat = options.repeat ?? null;
  const unusableLimit = options.unusableLimit ?? UNUSABLE_LIMIT;
  const arms = options.arms ?? null;
  const cells = options.models ?? null;
  const models = cells?.map(formatCell) ?? null;
  const plan = planShard(deps.patches, options.seed, options.shard, repeat, arms, cells);
  const sources = new Map<SmokePatch, Sources>();
  const completed = new Map<string, CompletedRun>();
  const expected = (patch: SmokePatch): Instance => (sources.get(patch) as Sources).instance;
  const carried = prior === null ? 0 : carriedUsd(options.resumeFrom as string, prior);
  let selection: ReuseSelection = { reused: new Map(), rerun: [] };
  let stopReason = "not_started";
  let network: BatchNetwork | null = null;
  let simulated: Awaited<ReturnType<typeof simulateBudgetStop>> | null = null;
  let probes: PreflightCheck[] = [];

  try {
    simulated = await simulateBudgetStop(
      deps.patches,
      options.seed,
      outDir,
      options.batchBudgetUsd,
      options.reviewReserveUsd,
    );
    for (const patch of patches) sources.set(patch, await deps.loadSources(patch));
    network = await deps.openNetwork();
    probes = await probeNetwork(network, sources.get(patches[0]) as Sources, deps.env);
    const failedProbe = probes.find((check) => !check.passed);
    if (simulated.stop_reason !== "budget_stop") {
      stopReason = `simulated_budget_stop_failed:${simulated.stop_reason}`;
    } else if (failedProbe) {
      stopReason = `preflight_failed:${failedProbe.id}`;
    }
  } catch (error) {
    stopReason = `setup_failed:${(error as Error).message}`;
  }

  if (prior !== null && stopReason === "not_started") {
    selection = selectReusable(plan, expected, options.resumeFrom as string, options, scrub);
    for (const run of plan.flatMap((main) => [main, limitRerun(main)])) {
      const record = selection.reused.get(run.name);
      if (record) completed.set(run.name, { run: run.name, record, sources: sources.get(run.patch) as Sources });
    }
  }
  const reusedRuns = [...selection.reused.keys()];

  writeJson(join(outDir, PREFLIGHT_FILE), {
    run_id: options.runId,
    mode: options.fake ? "fake" : "real",
    seed: options.seed,
    vm_type: options.vmType,
    model: MODEL,
    cli_version: CLI_VERSION,
    review_budget_usd: REVIEW_BUDGET_USD,
    batch_budget_usd: options.batchBudgetUsd,
    review_reserve_usd: options.reviewReserveUsd,
    pause_after_patches: options.pauseAfterPatches,
    unusable_limit: unusableLimit,
    repeat,
    condition_arms: arms,
    models,
    shard: formatShard(options.shard),
    patches_file: patchesFileOf(options.patchesPath),
    resumed_from: prior?.runId ?? null,
    carried_usd: carried,
    reused_runs: reusedRuns,
    rerun_runs: selection.rerun.map(({ run, reason }) => ({ run, reason: scrub(reason) })),
    patches: patches.map((patch) => ({
      instance_id: patch.instance_id,
      agent_id: patch.agent_id,
      label_stratum: patch.label_stratum,
      patch_sha256: patch.patch_sha256,
      image: patch.image,
      image_digest: patch.image_digest,
    })),
    runs: plan.map(({ name, effort, runOrder }) => ({ name, effort, run_order: runOrder })),
    simulated_budget_stop: simulated,
    network_probes: probes,
    blocked: stopReason === "not_started" ? null : scrub(stopReason),
  });
  await checkpoint();

  if (stopReason === "not_started") {
    const activeNetwork = network as BatchNetwork;
    try {
      const result = await dispatchRuns(
        plan,
        expected,
        async (run) => {
          const source = sources.get(run.patch) as Sources;
          const { record } = await runReview(
            {
              mode: options.fake ? "fake" : "real",
              effort: run.effort,
              budgetUsd: String(REVIEW_BUDGET_USD),
              outDir: join(outDir, "runs", run.name),
              arm: run.arm,
              model: run.model,
              context: runContext(run, options),
            },
            {
              env: deps.env,
              proxyUrl: activeNetwork.proxyUrl,
              loadSources: async () => source,
              createRunners: () => activeNetwork.createRunners(source),
            },
          );
          completed.set(run.name, { run: run.name, record, sources: source });
          return record;
        },
        checkpoint,
        { carriedUsd: carried, reused: selection.reused },
        options.batchBudgetUsd,
        options.reviewReserveUsd,
        options.pauseAfterPatches,
        { unusableLimit, releaseInstance: (patch) => activeNetwork.removeImage(expected(patch)) },
      );
      stopReason = result.stopReason;
    } catch (error) {
      stopReason = `dispatch_failed:${(error as Error).message}`;
    }
  }

  try {
    await network?.close();
  } catch (error) {
    console.error(scrub(`network cleanup failed: ${(error as Error).message}`));
  }

  const finished = plan.flatMap(({ name }) => completed.get(name) ?? []);
  const reruns = plan.flatMap((main) => {
    const companion = completed.get(limitRerun(main).name);
    return companion === undefined ? [] : [{ ...companion, main: main.name }];
  });
  for (const { run, record, main } of reruns) {
    if (selection.reused.has(run)) continue;
    const marked = { ...record, limit_rerun_of: main };
    writeFileSync(join(outDir, "runs", run, RUN_FILE), scrub(`${JSON.stringify(marked, null, 2)}\n`));
  }
  const records = finished.map(({ record }) => record);
  const dispatchedRuns = [...finished, ...reruns].filter(({ run }) => !selection.reused.has(run));
  const meter = new BudgetMeter(carried, options.batchBudgetUsd);
  for (const { record } of dispatchedRuns) meter.charge(chargedUsd(record));
  if (stopReason.startsWith("dispatch_failed:")) meter.charge(null);
  writeDiscrepancies(outDir, finished);
  const unverified = finished.filter(({ record }) => record.effective_effort === null);
  writeJson(join(outDir, SUMMARY_FILE), {
    run_id: options.runId,
    mode: options.fake ? "fake" : "real",
    seed: options.seed,
    vm_type: options.vmType,
    stop_reason: scrub(stopReason),
    planned: plan.length,
    dispatched: dispatchedRuns.length,
    spent_usd: meter.spentUsd,
    batch_budget_usd: options.batchBudgetUsd,
    review_reserve_usd: options.reviewReserveUsd,
    pause_after_patches: options.pauseAfterPatches,
    unusable_limit: unusableLimit,
    repeat,
    condition_arms: arms,
    models,
    shard: formatShard(options.shard),
    resumed_from: prior?.runId ?? null,
    reused_runs: reusedRuns,
    carried_usd: carried,
    effort_unverified: unverified.length > 0,
    effort_unverified_runs: unverified.map(({ run }) => run),
    arms: rollUpArms(records),
    runs: finished.map(({ run, record }) => ({
      run,
      arm: record.arm,
      model: record.model,
      reused: selection.reused.has(run),
      verdict: record.verdict,
      stop_reason: record.stop_reason,
      cost_usd: record.cost_usd,
    })),
    limit_reruns: reruns.map(({ run, record, main }) => ({
      run: main,
      rerun_run: run,
      stop_reason: record.stop_reason,
      verdict: record.verdict,
      cost_usd: record.cost_usd,
      reused: selection.reused.has(run),
    })),
  });
  await checkpoint();

  return { stopReason: scrub(stopReason), exitCode: stopReason === "completed" ? 0 : 1 };
}

function batchDeps(options: BatchOptions, env: NodeJS.ProcessEnv): BatchDeps {
  if (options.fake) {
    return {
      env: {},
      patches: readSmokePatches(options.patchesPath),
      loadSources: async (patch) => fakeSources(patch),
      openNetwork: async () => fakeNetwork(options.fakeCostUsd),
    };
  }
  return {
    env,
    patches: readSmokePatches(options.patchesPath),
    loadSources: (patch) => loadSources(patch),
    openNetwork: () => openDockerNetwork(options, env),
  };
}

async function main(): Promise<number> {
  try {
    const options = parseBatchCli(process.argv.slice(2), process.env);
    const { stopReason, exitCode } = await runBatch(options, batchDeps(options, process.env));
    console.log(`${join(options.outDir, SUMMARY_FILE)} stop_reason=${stopReason}`);
    return exitCode;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
