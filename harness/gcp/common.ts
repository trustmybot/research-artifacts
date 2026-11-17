import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ARMS, parseArms } from "../conditions/authornote/arms.ts";
import { formatCell, parseModels, shortModel } from "../models.ts";

export interface Infra {
  project: string;
  account: string;
  vaultRepo: string;
}
export type InfraField = keyof Infra;

const INFRA_FIELDS: readonly InfraField[] = ["project", "account", "vaultRepo"];
export const INFRA_LOCAL_FILE = join(import.meta.dirname, "infra.local.json");
export const INFRA_ENV: Readonly<Record<InfraField, string>> = {
  project: "TMB_GCP_PROJECT",
  account: "TMB_GCP_ACCOUNT",
  vaultRepo: "TMB_VAULT_REPO",
};
export const INFRA_PLACEHOLDERS: Readonly<Infra> = {
  project: "example-gcp-project",
  account: "you@example.com",
  vaultRepo: "example-org/example-vault",
};
const INFRA_PATTERNS: Readonly<Record<InfraField, RegExp>> = {
  project: /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,
  account: /^[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/,
  vaultRepo: /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/,
};

function readInfraFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must hold a JSON object with ${INFRA_FIELDS.join(", ")}`);
  }
  return parsed as Record<string, unknown>;
}

// Each field comes from the untracked local file, else its environment variable, else a placeholder, so a fresh clone
// still imports this module and only the commands that would reach GCP or GitHub refuse.
export function loadInfra(env: NodeJS.ProcessEnv, path: string): Infra {
  const file = readInfraFile(path);
  const field = (key: InfraField): string => {
    const fromFile = file[key];
    const value = fromFile ?? (env[INFRA_ENV[key]] || undefined) ?? INFRA_PLACEHOLDERS[key];
    if (typeof value !== "string" || !INFRA_PATTERNS[key].test(value)) {
      const source = fromFile === undefined ? INFRA_ENV[key] : `${key} in ${path}`;
      throw new Error(`${source} is not a valid ${key}: ${JSON.stringify(value)}`);
    }
    return value;
  };
  return { project: field("project"), account: field("account"), vaultRepo: field("vaultRepo") };
}

export function placeholderFields(infra: Infra): InfraField[] {
  return INFRA_FIELDS.filter((key) => infra[key] === INFRA_PLACEHOLDERS[key]);
}

export function infraRefusal(infra: Infra): string | null {
  const fields = placeholderFields(infra);
  if (fields.length === 0) return null;
  return (
    `${fields.join(", ")} still ${fields.length === 1 ? "holds its" : "hold their"} placeholder; ` +
    "copy harness/gcp/infra.example.json to harness/gcp/infra.local.json and fill it in, " +
    `or set ${fields.map((key) => INFRA_ENV[key]).join(", ")}`
  );
}

export const INFRA = loadInfra(process.env, INFRA_LOCAL_FILE);
export const PROJECT = INFRA.project;
export const ACCOUNT = INFRA.account;
export const BUCKET_NAME = `${PROJECT}-c4-smoke`;
export const SERVICE_ACCOUNT_ID = "c4-smoke";
export const SERVICE_ACCOUNT = `${SERVICE_ACCOUNT_ID}@${PROJECT}.iam.gserviceaccount.com`;
export const API_KEY_SECRET = "c4-anthropic-api-key";
export const DEPLOY_KEY_SECRET = "c4-vault-deploy-key";
export const LABEL = "purpose=c4-smoke";
export const REGION = "us-central1";
export const ZONE = `${REGION}-a`;
export const MACHINE_TYPE = "e2-standard-4";
export const VAULT_REPO = INFRA.vaultRepo;
export const VM_WORK_DIR = "/opt/c4";

export const DEFAULT_BOOT_DISK_SIZE = "100GB";
export const CHECKS_BOOT_DISK_SIZE = "200GB";

const ARM_TOKEN = `(?:${ARMS.join("|")})`;
// The lookahead refuses an arms list that names one arm twice, such as -arms-skill-skill.
const ARMS_SUFFIX = String.raw`-arms(?!(?:-${ARM_TOKEN})*-(?<repeated>${ARM_TOKEN})(?:-${ARM_TOKEN})*-\k<repeated>(?![^-]))(?:-${ARM_TOKEN}){1,${ARMS.length}}`;
export const RUN_ID_PATTERN = new RegExp(
  String.raw`^\d{8}t\d{6}z-[0-9a-f]{7,40}(-r([2-9]|[1-9]\d)|(${ARMS_SUFFIX})?(-models(-(opus|sonnet|haiku)[lmh]?){1,3})?)(-s\d{1,3}of\d{1,3})?$`,
);
export const SHARDED_RUN_ID_PATTERN = /-s\d{1,3}of\d{1,3}$/;
export const SEED_PATTERN = /^\d+$/;
export const PAUSE_AFTER_PATCHES_PATTERN = /^[1-9]\d{0,5}$/;
export const UNUSABLE_LIMIT_PATTERN = /^[1-9]\d{0,5}$/;
export const PATCHES_PATTERN = /^harness\/checks\/[a-z0-9-]+\.json$/;
export const ZONE_PATTERN = /^[a-z]+-[a-z]+\d-[a-z]$/;
export const MACHINE_TYPE_PATTERN = /^e2-standard-[1-9]\d{0,2}$/;
export const REPEAT_PATTERN = /^([2-9]|[1-9]\d)$/;

const SHARD_PATTERN = /^(0|[1-9]\d{0,2})\/([1-9]\d{0,2})$/;
const BOOT_DISK_SIZE_PATTERN = /^([1-9]\d{1,2})GB$/;
const MIN_BOOT_DISK_GB = 50;
const MAX_BOOT_DISK_GB = 500;

export interface Shard {
  index: number;
  count: number;
}

export function parseShard(value: string): Shard | null {
  const match = SHARD_PATTERN.exec(value);
  if (match === null) return null;
  const index = Number(match[1]);
  const count = Number(match[2]);
  return count >= 2 && index < count ? { index, count } : null;
}

export function isShard(value: string): boolean {
  return parseShard(value) !== null;
}

export function formatShard(shard: Shard): string {
  return `${shard.index}/${shard.count}`;
}

export function shardRunIdSuffix(shard: Shard): string {
  return `-s${shard.index}of${shard.count}`;
}

export function repeatRunIdSuffix(repeat: string): string {
  return `-r${repeat}`;
}

export function canonicalArms(value: string): string | null {
  return parseArms(value)?.join(",") ?? null;
}

export function isArmList(value: string): boolean {
  return canonicalArms(value) !== null;
}

export function armsRunIdSuffix(arms: string): string {
  return `-arms-${arms.replaceAll(",", "-")}`;
}

export function canonicalModels(value: string): string | null {
  return parseModels(value)?.map(formatCell).join(",") ?? null;
}

export function isModelList(value: string): boolean {
  return canonicalModels(value) !== null;
}

export function modelsRunIdSuffix(models: string): string {
  const tokens = (parseModels(models) ?? []).map(({ model, effort }) => `${shortModel(model)}${effort?.[0] ?? ""}`);
  return `-models-${tokens.join("-")}`;
}

export function isBootDiskSize(value: string): boolean {
  const match = BOOT_DISK_SIZE_PATTERN.exec(value);
  const gb = Number(match?.[1]);
  return match !== null && gb >= MIN_BOOT_DISK_GB && gb <= MAX_BOOT_DISK_GB;
}

export function patchesFlags(patches: string | null | undefined): string[] {
  return patches ? ["--patches", patches] : [];
}

export function shardFlags(shard: string | null | undefined): string[] {
  return shard ? ["--shard", shard] : [];
}

export function repeatFlags(repeat: string | null | undefined): string[] {
  return repeat ? ["--repeat", repeat] : [];
}

export function armsFlags(arms: string | null | undefined): string[] {
  return arms ? ["--arms", arms] : [];
}

export function modelsFlags(models: string | null | undefined): string[] {
  return models ? ["--models", models] : [];
}

export function isPositiveUsd(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value) && Number(value) > 0;
}

const MAX_REVIEW_RESERVE_USD = 4;

export function isReviewReserveUsd(value: string): boolean {
  return isPositiveUsd(value) && Number(value) <= MAX_REVIEW_RESERVE_USD;
}

export interface BatchLimits {
  pauseAfterPatches?: string | null;
  batchBudgetUsd?: string | null;
  reviewReserveUsd?: string | null;
  unusableLimit?: string | null;
}

export function batchLimitFlags(limits: BatchLimits): string[] {
  return [
    ...(limits.pauseAfterPatches ? ["--pause-after-patches", limits.pauseAfterPatches] : []),
    ...(limits.batchBudgetUsd ? ["--batch-budget-usd", limits.batchBudgetUsd] : []),
    ...(limits.reviewReserveUsd ? ["--review-reserve-usd", limits.reviewReserveUsd] : []),
    ...(limits.unusableLimit ? ["--unusable-limit", limits.unusableLimit] : []),
  ];
}

export const BATCH_ENTRY = "harness/smoke/run-batch.ts";
export const CHECKS_ENTRY = "harness/checks/run-all.ts";
const ENTRY_ALLOWLIST: readonly string[] = [BATCH_ENTRY, CHECKS_ENTRY];

export function isAllowedEntry(entry: string): boolean {
  return ENTRY_ALLOWLIST.includes(entry);
}

export const CONDITIONS = [
  "cr-repo-claude-opus-5.5",
  "cr-tests-claude-opus-5.5",
  "cr-tests-claude-haiku-5.5",
  "cr-tests-claude-sonnet-5.5",
  "cr-effort-claude-opus-5.5",
  "cr-effort-claude-sonnet-5.5",
  "cr-effort-claude-haiku-5.5",
  "cr-effort-claude-haiku-5.5-equiv",
  "cr-codegraph",
  "cr-authornote-claude-opus-5.5",
  "cr-skilltmb",
  "cr-spec",
  "cr-testresults",
  "cr-vote-claude-haiku-5.5",
  "cr-vote-claude-opus-5.5",
  "cr-escalate",
  "cr-skill",
  "cr-skill-claude-opus-5.5",
] as const;
export type Condition = (typeof CONDITIONS)[number];
export const CONDITION_USAGE = `--condition <${CONDITIONS.join("|")}>`;
export const CONDITION_REFUSAL = `--condition is required and must be one of ${CONDITIONS.join(", ")}`;

export const LEGACY_CONDITION: Condition = "cr-effort-claude-opus-5.5";
export const LEGACY_SMOKE_NAME = "c4-c-smoke";
export const LEGACY_VAULT_ROOT = "c4-effort";
const PRE_CONDITION_SMOKE_NAME = "c4-smoke";
const STUDY_LABEL_KEY = "study";
const LEGACY_LOCAL_PREFIX = "cr";

export function gcpId(condition: string): string {
  return condition.replaceAll(".", "-");
}

function vmPrefix(condition: Condition): string {
  return condition === LEGACY_CONDITION ? LEGACY_SMOKE_NAME : condition.split("-").slice(0, 2).join("-");
}

export function parseCondition(value: string | undefined): Condition | null {
  return CONDITIONS.find((condition) => condition === value) ?? null;
}

export function conditionFlags(condition: Condition): string[] {
  return ["--condition", condition];
}

export const DNS_LABEL_MAX_LENGTH = 63;
const DNS_LABEL = new RegExp(`^[a-z]([-a-z0-9]{0,${DNS_LABEL_MAX_LENGTH - 2}}[a-z0-9])?$`);
const RUN_ID_HEAD = /^\d{8}t\d{6}z-[0-9a-f]+/;
const RUN_ID_HASH_LENGTH = 6;

export function isDnsLabel(name: string): boolean {
  return DNS_LABEL.test(name);
}

export function proxyName(network: string): string {
  return `${network}-proxy`;
}

// Keeps the timestamp, commit and shard (blockingVms reads the shard off the VM name) and hashes the condition with
// the full run ID in place of its repeat, arms and models suffixes, so same-second launches with different flags, and
// studies sharing a VM prefix on one Docker host, still get distinct names.
function compactRunId(condition: Condition, runId: string): string {
  const head = RUN_ID_HEAD.exec(runId)?.[0];
  return `${head === undefined ? "" : `${head}-`}${hashedRunId(condition, runId)}`;
}

function hashedRunId(condition: Condition, runId: string): string {
  const shard = SHARDED_RUN_ID_PATTERN.exec(runId)?.[0] ?? "";
  const hash = createHash("sha256").update(`${condition}\n${runId}`).digest("hex").slice(0, RUN_ID_HASH_LENGTH);
  return `${hash}${shard}`;
}

export interface ResourceNames {
  vm: string;
  studyLabel: string;
  batchNetwork: string;
  batchProxy: string;
  vaultBranch: string;
  vaultPath: string;
  vaultAuthor: string;
  vaultCommitMessage: string;
  reviewOutDir(mode: string): string;
  reviewContainer(suffix: string): string;
  reviewNetwork(suffix: string): string;
  reviewImage(instanceId: string, digest: string): string;
}

export function resourceNames(condition: Condition, runId: string): ResourceNames {
  const gcp = gcpId(condition);
  const legacy = condition === LEGACY_CONDITION;
  const local = legacy ? LEGACY_LOCAL_PREFIX : gcp;
  const smoke = legacy ? LEGACY_SMOKE_NAME : `${gcp}-smoke`;
  const mvp = `${local}-mvp`;
  const fullVm = `${vmPrefix(condition)}-${runId}`;
  const fullNetwork = `${local}-smoke-${runId}`;
  const compact = `${vmPrefix(condition)}-${compactRunId(condition, runId)}`;
  const vm = fullVm.length <= DNS_LABEL_MAX_LENGTH ? fullVm : compact;
  const batchNetwork = proxyName(fullNetwork).length <= DNS_LABEL_MAX_LENGTH ? fullNetwork : compact;
  return {
    vm,
    studyLabel: `${STUDY_LABEL_KEY}=${gcp}`,
    batchNetwork,
    batchProxy: proxyName(batchNetwork),
    vaultBranch: legacy ? `${smoke}/${runId}` : `${condition}/smoke/${runId}`,
    vaultPath: legacy ? `${LEGACY_VAULT_ROOT}/${smoke}/${runId}` : `${condition}/smoke/${runId}`,
    vaultAuthor: smoke,
    vaultCommitMessage: `${legacy ? LEGACY_LOCAL_PREFIX : condition} smoke results for ${runId}`,
    reviewOutDir: (mode) => `runs/${mvp}-${mode}-${runId}`,
    reviewContainer: (suffix) => `${mvp}-${suffix}`,
    reviewNetwork: (suffix) => `${mvp}-net-${suffix}`,
    reviewImage: (instanceId, digest) => `${mvp}-review:${reviewImageTag(condition, runId, instanceId, digest)}`,
  };
}

const DOCKER_TAG_MAX_LENGTH = 128;
const DOCKER_TAG = /^[a-z0-9_][a-z0-9_.-]*$/;

// Long GCP run IDs (commit, arms, models, shard) pass Docker's 128 characters, so the run ID part falls back to the
// same hashed forms the VM name uses, which stay distinct per run ID instead of truncating two runs onto one tag.
function reviewImageTag(condition: Condition, runId: string, instanceId: string, digest: string): string {
  const runIdForms = [runId, compactRunId(condition, runId), hashedRunId(condition, runId)];
  const tags = runIdForms.map((form) => `${form}-${instanceId}-${digest}`.toLowerCase());
  const tag = tags.find((candidate) => candidate.length <= DOCKER_TAG_MAX_LENGTH);
  if (tag === undefined) {
    throw new Error(
      `instance ID ${instanceId} makes the review image tag ${tags.at(-1)?.length} characters, over Docker's ${DOCKER_TAG_MAX_LENGTH}`,
    );
  }
  if (!DOCKER_TAG.test(tag)) throw new Error(`run ID ${runId} makes the review image tag ${tag} an invalid Docker tag`);
  return tag;
}

const VM_PREFIXES = [...new Set(CONDITIONS.map(vmPrefix)), PRE_CONDITION_SMOKE_NAME];
const VM_NAME_PATTERN = new RegExp(`^(?:${VM_PREFIXES.join("|")})-(.+)$`);

export function runIdOfVm(name: string): string {
  return VM_NAME_PATTERN.exec(name)?.[1] ?? name;
}

const MAX_CAPTURED_BYTES = 64 * 1024 * 1024;
const SHELL_SAFE = /^[\w@%+=:,./-]+$/;
const SIGNAL_EXIT_CODE = 128;
const NOT_FOUND_EXIT_CODE = 127;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inheritStdio?: boolean;
  timeoutMs?: number;
}

export type Exec = (argv: string[], options?: ExecOptions) => ExecResult;

export const realExec: Exec = (argv, options = {}) => {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: MAX_CAPTURED_BYTES,
    timeout: options.timeoutMs,
    stdio: options.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error && result.status === null && result.signal === null) {
    return { code: NOT_FOUND_EXIT_CODE, stdout: "", stderr: result.error.message };
  }
  return {
    code: result.status ?? SIGNAL_EXIT_CODE,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

export function shellQuote(value: string): string {
  return SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function formatCommand(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
