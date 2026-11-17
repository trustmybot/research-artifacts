import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { ARMS } from "../conditions/authornote/arms.ts";

import {
  armsFlags,
  API_KEY_SECRET,
  BATCH_ENTRY,
  batchLimitFlags,
  CONDITION_USAGE,
  conditionFlags,
  DEPLOY_KEY_SECRET,
  errorMessage,
  isAllowedEntry,
  isArmList,
  isModelList,
  isPositiveUsd,
  isReviewReserveUsd,
  isShard,
  modelsFlags,
  parseCondition,
  PATCHES_PATTERN,
  patchesFlags,
  PAUSE_AFTER_PATCHES_PATTERN,
  PROJECT,
  realExec,
  REPEAT_PATTERN,
  resourceNames,
  repeatFlags,
  RUN_ID_PATTERN,
  SEED_PATTERN,
  SERVICE_ACCOUNT,
  shardFlags,
  shellQuote,
  UNUSABLE_LIMIT_PATTERN,
  VAULT_REPO,
  type BatchLimits,
  type Condition,
  type Exec,
} from "./common.ts";

const API_KEY_ENV = "ANTHROPIC_API_KEY";
const OWNER_ONLY = 0o600;
const BYTES_PER_GB = 1e9;
const GITHUB_KNOWN_HOST =
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n";
const USAGE =
  `usage: node harness/gcp/vm-run.ts <run --seed <int> --vm-type <type> [--resume-from <run_id>] [--entry <harness/smoke/run-batch.ts|harness/checks/run-all.ts>] [--pause-after-patches <n>] [--batch-budget-usd <n>] [--review-reserve-usd <n>] [--unusable-limit <n API or VM failures per cell, per shard>] [--patches <harness/checks/name.json>] [--models <model[:effort],...>] [--arms <${ARMS.join(",")}>] [--repeat <n>] [--shard <k>/<n>] | sync> --run-id <id> ${CONDITION_USAGE} --bucket <name> --work <dir>`;

export const STATS_FILE = "vm-stats.json";
export const DONE_FILE = "DONE.json";

export interface VmDeps {
  exec: Exec;
  log(line: string): void;
  now(): Date;
  shmDir: string;
  codeDir: string;
  nodePath: string;
  scriptPath: string;
}

export interface SyncParams {
  condition: Condition;
  runId: string;
  bucket: string;
  work: string;
}

export interface RunParams extends SyncParams, BatchLimits {
  seed: string;
  vmType: string;
  resumeFrom?: string | null;
  entry?: string;
  patches?: string | null;
  repeat?: string | null;
  arms?: string | null;
  models?: string | null;
  shard?: string | null;
}

export interface SyncOutcome {
  refused: boolean;
  gcsCopyOk: boolean;
  vaultPushOk: boolean;
  peakDiskGb: number | null;
}

function resultsDir(params: SyncParams): string {
  return join(params.work, "results");
}

function keyPath(params: SyncParams, deps: VmDeps): string {
  return join(deps.shmDir, `cr-vault-key-${params.runId}`);
}

function accessSecret(deps: VmDeps, secret: string): string {
  const result = deps.exec([
    "gcloud",
    "secrets",
    "versions",
    "access",
    "latest",
    `--secret=${secret}`,
    `--project=${PROJECT}`,
  ]);
  if (result.code !== 0 || result.stdout.trim() === "") {
    throw new Error(`cannot read secret ${secret} (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function writeOwnerOnly(path: string, content: string): void {
  writeFileSync(path, content, { mode: OWNER_ONLY });
  chmodSync(path, OWNER_ONLY);
}

function ensureDeployKey(params: SyncParams, deps: VmDeps): string {
  const path = keyPath(params, deps);
  if (!existsSync(path)) writeOwnerOnly(path, `${accessSecret(deps, DEPLOY_KEY_SECRET).trim()}\n`);
  return path;
}

function removeDeployKey(params: SyncParams, deps: VmDeps): void {
  const path = keyPath(params, deps);
  rmSync(path, { force: true });
  rmSync(`${path}.known_hosts`, { force: true });
}

function filesContaining(dir: string, needle: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => readFileSync(path).includes(needle));
}

function publishRefusal(params: SyncParams, deps: VmDeps): string | null {
  try {
    const apiKey = accessSecret(deps, API_KEY_SECRET).trim();
    const hits = filesContaining(resultsDir(params), apiKey);
    return hits.length > 0 ? `API key value found in ${hits.join(", ")}` : null;
  } catch (error) {
    return `results could not be checked for the API key: ${errorMessage(error)}`;
  }
}

function usedDiskBytes(deps: VmDeps): number | null {
  const df = deps.exec(["df", "-B1", "--output=used", "/"]);
  const lines = df.stdout.trim().split("\n");
  const bytes = Number(lines.at(-1));
  return df.code === 0 && lines.length > 1 && Number.isFinite(bytes) ? bytes : null;
}

function recordDiskUsage(params: SyncParams, deps: VmDeps): number | null {
  const path = join(resultsDir(params), STATS_FILE);
  const previous: number | null = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).peak_disk_gb : null;
  const bytes = usedDiskBytes(deps);
  if (bytes === null) deps.log("df gave no usable reading; keeping the previous peak");
  const lastDiskGb = bytes === null ? null : Number((bytes / BYTES_PER_GB).toFixed(3));
  const peakDiskGb = lastDiskGb === null ? previous : Math.max(previous ?? 0, lastDiskGb);
  const stats = {
    run_id: params.runId,
    peak_disk_gb: peakDiskGb,
    last_disk_gb: lastDiskGb,
    sampled_at: deps.now().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(stats, null, 2)}\n`);
  return peakDiskGb;
}

function copyToGcs(params: SyncParams, deps: VmDeps): boolean {
  const result = deps.exec([
    "gcloud",
    "storage",
    "rsync",
    resultsDir(params),
    `gs://${params.bucket}/runs/${params.runId}`,
    "--recursive",
    `--project=${PROJECT}`,
  ]);
  if (result.code !== 0) deps.log(`GCS copy failed (exit ${result.code}): ${result.stderr.trim()}`);
  return result.code === 0;
}

function pushToVault(params: SyncParams, deps: VmDeps): void {
  const deployKey = ensureDeployKey(params, deps);
  const knownHosts = `${deployKey}.known_hosts`;
  writeOwnerOnly(knownHosts, GITHUB_KNOWN_HOST);
  const env = {
    ...process.env,
    GIT_SSH_COMMAND: `ssh -i ${shellQuote(deployKey)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${shellQuote(knownHosts)}`,
  };
  const vaultDir = join(params.work, "vault");
  const names = resourceNames(params.condition, params.runId);
  const branch = names.vaultBranch;
  const relativeDest = names.vaultPath;
  const git = (...args: string[]) => deps.exec(["git", "-C", vaultDir, ...args], { env });
  const must = (...args: string[]) => {
    const result = git(...args);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${result.code}): ${result.stderr.trim()}`);
  };

  mkdirSync(vaultDir, { recursive: true });
  if (!existsSync(join(vaultDir, ".git"))) {
    must("init", "-q");
    must("remote", "add", "origin", `git@github.com:${VAULT_REPO}.git`);
  }
  if (git("rev-parse", "-q", "--verify", "HEAD").code !== 0) {
    must("fetch", "-q", "--depth=1", "origin", "refs/heads/main");
    must("checkout", "-q", "-b", branch, "FETCH_HEAD");
  }
  const dest = join(vaultDir, relativeDest);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(resultsDir(params), dest, { recursive: true, verbatimSymlinks: true });
  must("add", "-f", relativeDest);
  if (git("diff", "--cached", "--quiet").code !== 0) {
    must(
      "-c",
      `user.name=${names.vaultAuthor}`,
      "-c",
      `user.email=${SERVICE_ACCOUNT}`,
      "commit",
      "-q",
      "--no-gpg-sign",
      "-m",
      names.vaultCommitMessage,
    );
  }
  must("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
}

function tryPushToVault(params: SyncParams, deps: VmDeps): boolean {
  try {
    pushToVault(params, deps);
    return true;
  } catch (error) {
    deps.log(`vault push failed, continuing: ${errorMessage(error)}`);
    return false;
  }
}

export function sync(params: SyncParams, deps: VmDeps): SyncOutcome {
  mkdirSync(resultsDir(params), { recursive: true });
  const refusal = publishRefusal(params, deps);
  const peakDiskGb = recordDiskUsage(params, deps);
  if (refusal) {
    deps.log(`publish refused: ${refusal}`);
    return { refused: true, gcsCopyOk: false, vaultPushOk: false, peakDiskGb };
  }
  const gcsCopyOk = copyToGcs(params, deps);
  const vaultPushOk = tryPushToVault(params, deps);
  return { refused: false, gcsCopyOk, vaultPushOk, peakDiskGb };
}

function trySync(params: SyncParams, deps: VmDeps): SyncOutcome {
  try {
    return sync(params, deps);
  } catch (error) {
    deps.log(`sync failed: ${errorMessage(error)}`);
    return { refused: false, gcsCopyOk: false, vaultPushOk: false, peakDiskGb: null };
  }
}

function checkpointCommand(params: RunParams, deps: VmDeps): string {
  const { runId, condition, bucket, work } = params;
  return [deps.nodePath, deps.scriptPath, "sync", "--run-id", runId, ...conditionFlags(condition), "--bucket", bucket, "--work", work]
    .map(shellQuote)
    .join(" ");
}

function downloadPriorRun(params: SyncParams, priorRunId: string, deps: VmDeps): string {
  const priorDir = join(params.work, "prior");
  mkdirSync(priorDir, { recursive: true });
  const result = deps.exec([
    "gcloud",
    "storage",
    "rsync",
    `gs://${params.bucket}/runs/${priorRunId}`,
    priorDir,
    "--recursive",
    `--project=${PROJECT}`,
  ]);
  if (result.code !== 0) {
    throw new Error(`cannot download prior run ${priorRunId} (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return priorDir;
}

function seedSourceCache(params: RunParams, deps: VmDeps): void {
  const cacheDir = join(deps.codeDir, "runs", "cache");
  try {
    mkdirSync(cacheDir, { recursive: true });
    const result = deps.exec([
      "gcloud",
      "storage",
      "rsync",
      `gs://${params.bucket}/cache`,
      cacheDir,
      "--recursive",
      `--project=${PROJECT}`,
    ]);
    if (result.code !== 0) {
      deps.log(`source cache seed failed (exit ${result.code}): ${result.stderr.trim()}`);
    }
  } catch (error) {
    deps.log(`source cache seed failed: ${errorMessage(error)}`);
  }
}

function runBatch(params: RunParams, deps: VmDeps): number | null {
  try {
    const apiKey = accessSecret(deps, API_KEY_SECRET).trim();
    ensureDeployKey(params, deps);
    mkdirSync(resultsDir(params), { recursive: true });
    seedSourceCache(params, deps);
    const resumeArgs = params.resumeFrom
      ? ["--resume-from", downloadPriorRun(params, params.resumeFrom, deps)]
      : [];
    const result = deps.exec(
      [
        deps.nodePath,
        params.entry ?? BATCH_ENTRY,
        "--run-id",
        params.runId,
        ...conditionFlags(params.condition),
        "--seed",
        params.seed,
        "--vm-type",
        params.vmType,
        "--out",
        resultsDir(params),
        "--checkpoint-cmd",
        checkpointCommand(params, deps),
        ...resumeArgs,
        ...batchLimitFlags(params),
        ...patchesFlags(params.patches),
        ...repeatFlags(params.repeat),
        ...armsFlags(params.arms),
        ...modelsFlags(params.models),
        ...shardFlags(params.shard),
      ],
      { cwd: deps.codeDir, env: { ...process.env, [API_KEY_ENV]: apiKey }, inheritStdio: true },
    );
    deps.log(`batch exited with ${result.code}`);
    return result.code;
  } catch (error) {
    deps.log(`batch did not finish: ${errorMessage(error)}`);
    return null;
  }
}

function writeDone(params: SyncParams, batchExitCode: number | null, finishedAt: string, outcome: SyncOutcome): void {
  const done = {
    run_id: params.runId,
    batch_exit_code: batchExitCode,
    finished_at: finishedAt,
    vault_push_ok: outcome.vaultPushOk,
    gcs_copy_ok: outcome.gcsCopyOk,
    peak_disk_gb: outcome.peakDiskGb,
  };
  mkdirSync(resultsDir(params), { recursive: true });
  writeFileSync(join(resultsDir(params), DONE_FILE), `${JSON.stringify(done, null, 2)}\n`);
}

function sameFlags(a: SyncOutcome, b: SyncOutcome): boolean {
  return a.gcsCopyOk === b.gcsCopyOk && a.vaultPushOk === b.vaultPushOk;
}

export function runVm(params: RunParams, deps: VmDeps): number {
  try {
    const batchExitCode = runBatch(params, deps);
    const finishedAt = deps.now().toISOString();
    const beforeDone = trySync(params, deps);
    writeDone(params, batchExitCode, finishedAt, beforeDone);
    const finalSync = trySync(params, deps);
    if (!sameFlags(beforeDone, finalSync)) {
      writeDone(params, batchExitCode, finishedAt, finalSync);
      trySync(params, deps);
    }
    return batchExitCode ?? 1;
  } finally {
    removeDeployKey(params, deps);
  }
}

function parseCli(argv: string[]): { command: string; params: RunParams } | null {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "run-id": { type: "string", default: "" },
        condition: { type: "string" },
        bucket: { type: "string", default: "" },
        work: { type: "string", default: "" },
        seed: { type: "string", default: "" },
        "vm-type": { type: "string", default: "" },
        "resume-from": { type: "string" },
        entry: { type: "string" },
        "pause-after-patches": { type: "string" },
        "batch-budget-usd": { type: "string" },
        "review-reserve-usd": { type: "string" },
        "unusable-limit": { type: "string" },
        patches: { type: "string" },
        repeat: { type: "string" },
        arms: { type: "string" },
        models: { type: "string" },
        shard: { type: "string" },
      },
    });
  } catch {
    return null;
  }
  const [command, ...rest] = parsed.positionals;
  const { "run-id": runId, bucket, work, seed, "vm-type": vmType, "resume-from": resumeFrom, entry } = parsed.values;
  const { "pause-after-patches": pauseAfterPatches, "batch-budget-usd": batchBudgetUsd, patches, repeat, arms, shard } = parsed.values;
  const { "review-reserve-usd": reviewReserveUsd, "unusable-limit": unusableLimit, models, condition } = parsed.values;
  if ((command !== "run" && command !== "sync") || rest.length > 0) return null;
  const parsedCondition = parseCondition(condition);
  if (!RUN_ID_PATTERN.test(runId) || parsedCondition === null || bucket === "" || work === "") return null;
  if (command === "run" && (!SEED_PATTERN.test(seed) || vmType === "")) return null;
  if (resumeFrom !== undefined && (command !== "run" || !RUN_ID_PATTERN.test(resumeFrom))) return null;
  if (entry !== undefined && (command !== "run" || !isAllowedEntry(entry))) return null;
  const limitsAllowed = command === "run" && (entry ?? BATCH_ENTRY) === BATCH_ENTRY;
  if (pauseAfterPatches !== undefined && (!limitsAllowed || !PAUSE_AFTER_PATCHES_PATTERN.test(pauseAfterPatches))) return null;
  if (batchBudgetUsd !== undefined && (!limitsAllowed || !isPositiveUsd(batchBudgetUsd))) return null;
  if (reviewReserveUsd !== undefined && (!limitsAllowed || !isReviewReserveUsd(reviewReserveUsd))) return null;
  if (unusableLimit !== undefined && (!limitsAllowed || !UNUSABLE_LIMIT_PATTERN.test(unusableLimit))) return null;
  if (patches !== undefined && (command !== "run" || !PATCHES_PATTERN.test(patches))) return null;
  if (repeat !== undefined && (!limitsAllowed || !REPEAT_PATTERN.test(repeat))) return null;
  if (arms !== undefined && (!limitsAllowed || !isArmList(arms) || repeat !== undefined)) return null;
  if (models !== undefined && (!limitsAllowed || !isModelList(models) || repeat !== undefined)) return null;
  if (shard !== undefined && (!limitsAllowed || !isShard(shard))) return null;
  return {
    command,
    params: {
      runId,
      condition: parsedCondition,
      bucket,
      work,
      seed,
      vmType,
      resumeFrom: resumeFrom ?? null,
      entry: entry ?? BATCH_ENTRY,
      pauseAfterPatches: pauseAfterPatches ?? null,
      batchBudgetUsd: batchBudgetUsd ?? null,
      reviewReserveUsd: reviewReserveUsd ?? null,
      unusableLimit: unusableLimit ?? null,
      patches: patches ?? null,
      repeat: repeat ?? null,
      arms: arms ?? null,
      models: models ?? null,
      shard: shard ?? null,
    },
  };
}

if (import.meta.main) {
  const cli = parseCli(process.argv.slice(2));
  if (!cli) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    const deps: VmDeps = {
      exec: realExec,
      log: (line) => console.error(line),
      now: () => new Date(),
      shmDir: "/dev/shm",
      codeDir: resolve(import.meta.dirname, "..", ".."),
      nodePath: process.execPath,
      scriptPath: import.meta.filename,
    };
    if (cli.command === "run") {
      process.exitCode = runVm(cli.params, deps);
    } else {
      process.exitCode = sync(cli.params, deps).gcsCopyOk ? 0 : 1;
    }
  }
}
