import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { ARMS } from "../conditions/authornote/arms.ts";
import { BATCH_BUDGET_USD, REVIEW_BUDGET_USD } from "../smoke/run-batch.ts";

import {
  ACCOUNT,
  API_KEY_SECRET,
  armsRunIdSuffix,
  BATCH_ENTRY,
  BUCKET_NAME,
  canonicalArms,
  canonicalModels,
  CHECKS_BOOT_DISK_SIZE,
  CHECKS_ENTRY,
  CONDITION_USAGE,
  DEFAULT_BOOT_DISK_SIZE,
  DEPLOY_KEY_SECRET,
  DNS_LABEL_MAX_LENGTH,
  errorMessage,
  formatCommand,
  formatShard,
  INFRA,
  infraRefusal,
  isAllowedEntry,
  isBootDiskSize,
  isDnsLabel,
  isPositiveUsd,
  isReviewReserveUsd,
  LABEL,
  MACHINE_TYPE,
  MACHINE_TYPE_PATTERN,
  modelsRunIdSuffix,
  parseCondition,
  parseShard,
  PATCHES_PATTERN,
  PAUSE_AFTER_PATCHES_PATTERN,
  PROJECT,
  realExec,
  REGION,
  REPEAT_PATTERN,
  repeatRunIdSuffix,
  resourceNames,
  RUN_ID_PATTERN,
  runIdOfVm,
  SEED_PATTERN,
  SERVICE_ACCOUNT,
  SERVICE_ACCOUNT_ID,
  SHARDED_RUN_ID_PATTERN,
  shardRunIdSuffix,
  UNUSABLE_LIMIT_PATTERN,
  VAULT_REPO,
  ZONE,
  ZONE_PATTERN,
  type Condition,
  type Exec,
  type ExecResult,
  type Infra,
  type ResourceNames,
  type Shard,
} from "./common.ts";
import { renderStartupScript } from "./startup-script.ts";

const BUCKET_URL = `gs://${BUCKET_NAME}`;
const SERVICE_ACCOUNT_MEMBER = `--member=serviceAccount:${SERVICE_ACCOUNT}`;
const APIS = ["compute.googleapis.com", "iam.googleapis.com", "secretmanager.googleapis.com", "storage.googleapis.com"];
const BUCKET_ROLES = ["roles/storage.objectAdmin", "roles/storage.legacyBucketReader"];
const DEFAULT_SEED = "1";
const DELETABLE_STATES = new Set(["TERMINATED", "SUSPENDED"]);
const SHORT_SHA_PLACEHOLDER = "0000000";
const RUN_ID_METADATA_KEY = "run-id";
const USAGE = `usage: node harness/gcp/launch.ts <setup|status|cleanup|start ${CONDITION_USAGE}> [--yes] [--seed <int>] [--run-id <id>] [--resume-from <run_id>] [--entry <harness/smoke/run-batch.ts|harness/checks/run-all.ts>] [--pause-after-patches <n>] [--batch-budget-usd <n>] [--review-reserve-usd <n>] [--unusable-limit <n API or VM failures per cell, per shard>] [--patches <harness/checks/name.json>] [--models <model[:effort],...>] [--arms <${ARMS.join(",")}>] [--repeat <n>] [--shard <k>/<n>] [--zone <zone>] [--machine-type <e2-standard-n>] [--boot-disk-size <nGB>]`;
const PLAN_HEADER = "Plan only, nothing was run. Pass --yes to apply.";

export const API_KEY_COMMAND = `pbpaste | gcloud secrets versions add ${API_KEY_SECRET} --data-file=- --project=${PROJECT} --account=${ACCOUNT}`;

export interface LaunchDeps {
  exec: Exec;
  out(line: string): void;
  err(line: string): void;
  now(): Date;
  repoRoot: string;
  infra: Infra;
}

interface LaunchOptions {
  yes: boolean;
  condition: Condition | null;
  seed: string;
  runId: string | null;
  resumeFrom: string | null;
  entry: string;
  pauseAfterPatches: string | null;
  batchBudgetUsd: string | null;
  reviewReserveUsd: string | null;
  unusableLimit: string | null;
  patches: string | null;
  repeat: string | null;
  arms: string | null;
  models: string | null;
  shard: Shard | null;
  zone: string;
  machineType: string;
  bootDiskSize: string;
}

interface Step {
  run: string[];
  unless?: string[];
  alreadyExistsIsSuccess?: boolean;
}

interface Vm {
  name: string;
  status: string;
  zone: string;
  labels?: Record<string, string>;
  metadata?: { items?: Array<{ key: string; value?: string }> };
}

class StepError extends Error {}

function gcloud(...args: string[]): string[] {
  return ["gcloud", ...args, `--project=${PROJECT}`, `--account=${ACCOUNT}`];
}

function isPlanningGit(argv: string[]): boolean {
  return argv[0] === "git" && argv[1] === "-C" && argv[3] === "rev-parse";
}

function isGcloudRead(argv: string[]): boolean {
  if (argv[0] !== "gcloud") return false;
  return argv.slice(1, 4).join(" ") === "compute instances list" || argv.slice(1, 3).join(" ") === "storage ls";
}

function allowlistedExec(exec: Exec, allowed: (argv: string[]) => boolean): Exec {
  return (argv, options) => {
    if (!allowed(argv)) throw new StepError(`blocked by the mutation guard: ${formatCommand(argv)}`);
    return exec(argv, options);
  };
}

function setupSteps(): Step[] {
  const secretSteps = [API_KEY_SECRET, DEPLOY_KEY_SECRET].flatMap((secret): Step[] => [
    {
      unless: gcloud("secrets", "describe", secret),
      run: gcloud("secrets", "create", secret, "--replication-policy=automatic", `--labels=${LABEL}`),
      alreadyExistsIsSuccess: true,
    },
    {
      run: gcloud(
        "secrets",
        "add-iam-policy-binding",
        secret,
        SERVICE_ACCOUNT_MEMBER,
        "--role=roles/secretmanager.secretAccessor",
      ),
    },
  ]);
  return [
    { run: gcloud("services", "enable", ...APIS) },
    {
      unless: gcloud("storage", "buckets", "describe", BUCKET_URL),
      run: gcloud(
        "storage",
        "buckets",
        "create",
        BUCKET_URL,
        `--location=${REGION}`,
        "--uniform-bucket-level-access",
        `--labels=${LABEL}`,
      ),
    },
    {
      run: gcloud(
        "storage",
        "buckets",
        "update",
        BUCKET_URL,
        "--uniform-bucket-level-access",
        `--update-labels=${LABEL}`,
      ),
    },
    {
      unless: gcloud("iam", "service-accounts", "describe", SERVICE_ACCOUNT),
      run: gcloud("iam", "service-accounts", "create", SERVICE_ACCOUNT_ID, "--display-name=C4 smoke test runner"),
    },
    ...secretSteps,
    ...BUCKET_ROLES.map((role): Step => ({
      run: gcloud("storage", "buckets", "add-iam-policy-binding", BUCKET_URL, SERVICE_ACCOUNT_MEMBER, `--role=${role}`),
    })),
  ];
}

function deployKeySteps(tempDir: string): Step[] {
  const keyPath = join(tempDir, "key");
  return [
    { run: ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "c4-smoke", "-f", keyPath] },
    {
      run: [
        "gh",
        "repo",
        "deploy-key",
        "add",
        `${keyPath}.pub`,
        "--allow-write",
        "--title",
        "c4-smoke",
        "--repo",
        VAULT_REPO,
      ],
    },
    { run: gcloud("secrets", "versions", "add", DEPLOY_KEY_SECRET, `--data-file=${keyPath}`) },
  ];
}

function enabledVersionsCommand(secret: string): string[] {
  return gcloud("secrets", "versions", "list", secret, "--filter=state:ENABLED", "--format=value(name)", "--limit=1");
}

function listVmsCommand(): string[] {
  return gcloud("compute", "instances", "list", `--filter=labels.${LABEL}`, "--format=json");
}

function deleteVmCommand(name: string, zone: string): string[] {
  return gcloud("compute", "instances", "delete", name, `--zone=${zone}`, "--quiet");
}

function createVmCommand(runId: string, condition: Condition, scriptPath: string, options: LaunchOptions): string[] {
  const { seed, resumeFrom, entry, pauseAfterPatches, batchBudgetUsd, reviewReserveUsd, unusableLimit, patches, repeat, arms, models, shard, machineType } =
    options;
  const metadata = [
    `${RUN_ID_METADATA_KEY}=${runId}`,
    `condition=${condition}`,
    `seed=${seed}`,
    `bucket=${BUCKET_NAME}`,
    `machine-type=${machineType}`,
    ...(resumeFrom === null ? [] : [`resume-from=${resumeFrom}`]),
    ...(entry === BATCH_ENTRY ? [] : [`entry=${entry}`]),
    ...(pauseAfterPatches ? [`pause-after-patches=${pauseAfterPatches}`] : []),
    ...(batchBudgetUsd ? [`batch-budget-usd=${batchBudgetUsd}`] : []),
    ...(reviewReserveUsd ? [`review-reserve-usd=${reviewReserveUsd}`] : []),
    ...(unusableLimit ? [`unusable-limit=${unusableLimit}`] : []),
    ...(patches ? [`patches=${patches}`] : []),
    ...(repeat ? [`repeat=${repeat}`] : []),
    ...(arms ? [`arms=${arms}`] : []),
    ...(models ? [`models=${models}`] : []),
    ...(shard ? [`shard=${formatShard(shard)}`] : []),
  ];
  // gcloud's `^;^` prefix switches the list delimiter so a value can hold commas (see `gcloud topic escaping`).
  const metadataFlag = metadata.some((item) => item.includes(","))
    ? `--metadata=^;^${metadata.join(";")}`
    : `--metadata=${metadata.join(",")}`;
  const names = resourceNames(condition, runId);
  return gcloud(
    "compute",
    "instances",
    "create",
    names.vm,
    `--zone=${options.zone}`,
    `--machine-type=${machineType}`,
    "--provisioning-model=STANDARD",
    "--max-run-duration=10h",
    "--instance-termination-action=DELETE",
    "--no-restart-on-failure",
    `--service-account=${SERVICE_ACCOUNT}`,
    "--scopes=cloud-platform",
    "--image-family=debian-12",
    "--image-project=debian-cloud",
    `--boot-disk-size=${options.bootDiskSize}`,
    "--boot-disk-type=pd-balanced",
    `--labels=${LABEL},${names.studyLabel}`,
    `--metadata-from-file=startup-script=${scriptPath}`,
    metadataFlag,
  );
}

function git(deps: LaunchDeps, ...args: string[]): ExecResult {
  return deps.exec(["git", "-C", deps.repoRoot, ...args]);
}

function failure(argv: string[], result: ExecResult): StepError {
  return new StepError(`command failed (exit ${result.code}): ${formatCommand(argv)}\n${result.stderr.trim()}`);
}

function must(deps: LaunchDeps, argv: string[]): ExecResult {
  const result = deps.exec(argv);
  if (result.code !== 0) throw failure(argv, result);
  return result;
}

function runSteps(deps: LaunchDeps, steps: Step[]): void {
  for (const step of steps) {
    if (step.unless && deps.exec(step.unless).code === 0) {
      deps.out(`exists, skipping: ${formatCommand(step.run)}`);
      continue;
    }
    deps.out(formatCommand(step.run));
    const result = deps.exec(step.run);
    const accepted = step.alreadyExistsIsSuccess && /already exists/i.test(result.stderr);
    if (result.code !== 0 && !accepted) throw failure(step.run, result);
  }
}

function planSteps(deps: LaunchDeps, steps: Step[]): void {
  for (const step of steps) {
    if (step.unless) deps.out(`# skipped when this succeeds: ${formatCommand(step.unless)}`);
    deps.out(formatCommand(step.run));
  }
}

function hasEnabledVersion(deps: LaunchDeps, secret: string): boolean {
  return must(deps, enabledVersionsCommand(secret)).stdout.trim() !== "";
}

function listVms(deps: LaunchDeps): Vm[] {
  const vms: Vm[] = JSON.parse(must(deps, listVmsCommand()).stdout || "[]");
  return vms.map((vm) => ({ ...vm, zone: vm.zone.split("/").at(-1) ?? vm.zone }));
}

function printApiKeyHandoff(deps: LaunchDeps): void {
  deps.out(`The API key is yours to add. Copy it, then run:\n${API_KEY_COMMAND}`);
}

function setup(options: LaunchOptions, deps: LaunchDeps): number {
  if (!options.yes) {
    deps.out(PLAN_HEADER);
    planSteps(deps, setupSteps());
    deps.out(
      `# skipped when ${DEPLOY_KEY_SECRET} has an enabled version: ${formatCommand(enabledVersionsCommand(DEPLOY_KEY_SECRET))}`,
    );
    planSteps(deps, deployKeySteps("<temp-dir>"));
    printApiKeyHandoff(deps);
    return 0;
  }
  runSteps(deps, setupSteps());
  if (hasEnabledVersion(deps, DEPLOY_KEY_SECRET)) {
    deps.out(`${DEPLOY_KEY_SECRET} already has an enabled version, keeping it`);
  } else {
    const tempDir = mkdtempSync(join(tmpdir(), "cr-deploy-key-"));
    try {
      runSteps(deps, deployKeySteps(tempDir));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
  printApiKeyHandoff(deps);
  return 0;
}

function utcStamp(now: Date): string {
  return now.toISOString().replace(/[-:]|\.\d+/g, "").toLowerCase();
}

function runIdFor(options: LaunchOptions, deps: LaunchDeps): string {
  const sha = git(deps, "rev-parse", "--short=7", "HEAD");
  const shortSha = sha.code === 0 ? sha.stdout.trim() : SHORT_SHA_PLACEHOLDER;
  const repeatSuffix = options.repeat === null ? "" : repeatRunIdSuffix(options.repeat);
  const armsSuffix = options.arms === null ? "" : armsRunIdSuffix(options.arms);
  const modelsSuffix = options.models === null ? "" : modelsRunIdSuffix(options.models);
  const shardSuffix = options.shard === null ? "" : shardRunIdSuffix(options.shard);
  return `${utcStamp(deps.now())}-${shortSha}${repeatSuffix}${armsSuffix}${modelsSuffix}${shardSuffix}`;
}

function priorRunMarkerUrl(resumeFrom: string, entry: string): string {
  const marker = entry === CHECKS_ENTRY ? "run-all.json" : "preflight-report.json";
  return `${BUCKET_URL}/runs/${resumeFrom}/${marker}`;
}

function runIdOf(vm: Vm): string {
  return vm.metadata?.items?.find((item) => item.key === RUN_ID_METADATA_KEY)?.value ?? runIdOfVm(vm.name);
}

function blockingVms(vms: Vm[], vmName: string, sharded: boolean): Vm[] {
  if (!sharded) return vms;
  return vms.filter((vm) => vm.name === vmName || !SHARDED_RUN_ID_PATTERN.test(runIdOf(vm)));
}

function dnsNameRefusals(names: ResourceNames): string[] {
  const dnsBound: Array<[string, string]> = [
    ["VM name", names.vm],
    ["batch network name", names.batchNetwork],
    ["proxy name", names.batchProxy],
  ];
  return dnsBound
    .filter(([, name]) => !isDnsLabel(name))
    .map(([kind, name]) => `${kind} ${name} is not a DNS label of at most ${DNS_LABEL_MAX_LENGTH} characters`);
}

function startRefusals(runId: string, condition: Condition, options: LaunchOptions, deps: LaunchDeps): string[] {
  const names = resourceNames(condition, runId);
  const vmName = names.vm;
  const refusals = dnsNameRefusals(names);
  const status = git(deps, "status", "--porcelain");
  if (status.code !== 0 || status.stdout.trim() !== "") refusals.push("the working tree is not clean");
  const refs = git(deps, "for-each-ref", "--contains", "HEAD", "--format=%(refname)", "refs/remotes/origin/");
  if (refs.code !== 0 || refs.stdout.trim() === "") refusals.push("HEAD is not contained in an origin/* ref");
  if (git(deps, "cat-file", "-e", `HEAD:${options.entry}`).code !== 0) {
    refusals.push(`${options.entry} does not exist at HEAD`);
  }
  if (options.patches !== null && git(deps, "cat-file", "-e", `HEAD:${options.patches}`).code !== 0) {
    refusals.push(`${options.patches} does not exist at HEAD`);
  }
  for (const secret of [API_KEY_SECRET, DEPLOY_KEY_SECRET]) {
    if (!hasEnabledVersion(deps, secret)) refusals.push(`secret ${secret} has no enabled version`);
  }
  const vms = blockingVms(listVms(deps), vmName, options.shard !== null);
  if (vms.length > 0) {
    const kind = options.shard === null ? LABEL : `same-name or unsharded ${LABEL}`;
    refusals.push(`a ${kind} VM already exists: ${vms.map((vm) => `${vm.name} (${vm.status})`).join(", ")}`);
  }
  if (options.resumeFrom !== null) {
    const url = priorRunMarkerUrl(options.resumeFrom, options.entry);
    if (deps.exec(gcloud("storage", "ls", url)).code !== 0) refusals.push(`${url} does not exist`);
  }
  return refusals;
}

function printRunDetails(deps: LaunchDeps, runId: string, condition: Condition, options: LaunchOptions): void {
  const names = resourceNames(condition, runId);
  deps.out(`VM: ${names.vm}`);
  deps.out(`Run ID: ${runId}`);
  deps.out(`Condition: ${condition}`);
  deps.out(`Machine type: ${options.machineType}`);
  deps.out(`Zone: ${options.zone}`);
  deps.out(`Boot disk: ${options.bootDiskSize}`);
  deps.out(`Entry: ${options.entry}`);
  if (options.repeat !== null) deps.out(`Repeat: ${options.repeat}`);
  if (options.arms !== null) deps.out(`Arms: ${options.arms}`);
  if (options.models !== null) deps.out(`Models: ${options.models}`);
  if (options.shard !== null) deps.out(`Shard: ${formatShard(options.shard)}`);
  if (options.patches !== null) deps.out(`Patches: ${options.patches}`);
  if (options.resumeFrom !== null) deps.out(`Resumes from: ${options.resumeFrom}`);
  deps.out(`Results in GCS: ${BUCKET_URL}/runs/${runId}/`);
  deps.out(`Results on GitHub: ${VAULT_REPO}, branch ${names.vaultBranch}, under ${names.vaultPath}/`);
  deps.out(`Status: node harness/gcp/launch.ts status --run-id ${runId}`);
  deps.out("Cleanup: node harness/gcp/launch.ts cleanup --yes");
}

function archiveCommand(deps: LaunchDeps, path: string): string[] {
  return ["git", "-C", deps.repoRoot, "archive", "--format=tar.gz", "-o", path, "HEAD"];
}

function uploadCommand(path: string, runId: string): string[] {
  return gcloud("storage", "cp", path, `${BUCKET_URL}/code/${runId}.tar.gz`);
}

function reserveAboveBudgetRefusal(options: LaunchOptions): string | null {
  if (options.entry !== BATCH_ENTRY) return null;
  const budget = options.batchBudgetUsd === null ? BATCH_BUDGET_USD : Number(options.batchBudgetUsd);
  const reserve = options.reviewReserveUsd === null ? REVIEW_BUDGET_USD : Number(options.reviewReserveUsd);
  if (reserve <= budget) return null;
  const reserveSource = options.reviewReserveUsd === null ? " (the default)" : "";
  const budgetSource = options.batchBudgetUsd === null ? " (the default)" : "";
  return (
    `--review-reserve-usd ${reserve}${reserveSource} is above --batch-budget-usd ${budget}${budgetSource}, ` +
    `so the meter would dispatch no review; pass --review-reserve-usd at most ${budget}`
  );
}

function start(options: LaunchOptions, deps: LaunchDeps): number {
  const { condition } = options;
  if (condition === null) throw new StepError(`start requires ${CONDITION_USAGE}`);
  const reserveRefusal = reserveAboveBudgetRefusal(options);
  if (reserveRefusal !== null) {
    deps.err(`refused: ${reserveRefusal}`);
    return 2;
  }
  const runId = runIdFor(options, deps);
  if (!options.yes) {
    deps.out(PLAN_HEADER);
    deps.out(`# refuses unless the tree is clean, HEAD is on origin, ${options.entry} exists at HEAD,`);
    if (options.shard === null) {
      deps.out(`# both secrets have an enabled version and no ${LABEL} VM exists`);
    } else {
      deps.out(`# both secrets have an enabled version, no VM named ${resourceNames(condition, runId).vm} exists`);
      deps.out(`# and every existing ${LABEL} VM belongs to a sharded run`);
    }
    if (options.resumeFrom !== null) {
      deps.out(`# --resume-from ${options.resumeFrom} also refuses unless ${priorRunMarkerUrl(options.resumeFrom, options.entry)} exists`);
    }
    if (options.patches !== null) deps.out(`# --patches ${options.patches} also refuses unless it exists at HEAD`);
    deps.out(formatCommand(archiveCommand(deps, "<temp-dir>/code.tar.gz")));
    deps.out(formatCommand(uploadCommand("<temp-dir>/code.tar.gz", runId)));
    deps.out(formatCommand(createVmCommand(runId, condition, "<temp-dir>/startup.sh", options)));
    printRunDetails(deps, runId, condition, options);
    return 0;
  }
  const refusals = startRefusals(runId, condition, options, deps);
  if (refusals.length > 0) {
    for (const refusal of refusals) deps.err(`refused: ${refusal}`);
    return 1;
  }
  const tempDir = mkdtempSync(join(tmpdir(), "cr-start-"));
  try {
    const archivePath = join(tempDir, "code.tar.gz");
    const scriptPath = join(tempDir, "startup.sh");
    writeFileSync(
      scriptPath,
      renderStartupScript({
        runId,
        condition,
        seed: options.seed,
        bucket: BUCKET_NAME,
        machineType: options.machineType,
        resumeFrom: options.resumeFrom,
        entry: options.entry,
        pauseAfterPatches: options.pauseAfterPatches,
        batchBudgetUsd: options.batchBudgetUsd,
        reviewReserveUsd: options.reviewReserveUsd,
        unusableLimit: options.unusableLimit,
        patches: options.patches,
        repeat: options.repeat,
        arms: options.arms,
        models: options.models,
        shard: options.shard === null ? null : formatShard(options.shard),
      }),
    );
    must(deps, archiveCommand(deps, archivePath));
    must(deps, uploadCommand(archivePath, runId));
    must(deps, createVmCommand(runId, condition, scriptPath, options));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  printRunDetails(deps, runId, condition, options);
  return 0;
}

function status(options: LaunchOptions, deps: LaunchDeps): number {
  const vms = listVms(deps);
  if (vms.length === 0) deps.out(`No ${LABEL} VM exists`);
  for (const vm of vms) deps.out(`${vm.name} ${vm.status} ${vm.zone}`);
  const runId = options.runId ?? (vms.length === 1 ? runIdOf(vms[0]) : null);
  const prefix = runId ? `${BUCKET_URL}/runs/${runId}/` : `${BUCKET_URL}/runs/`;
  const objects = deps.exec(gcloud("storage", "ls", ...(runId ? ["--recursive"] : []), prefix));
  deps.out(objects.code === 0 ? objects.stdout.trimEnd() : `No objects under ${prefix}`);
  return 0;
}

function cleanup(options: LaunchOptions, deps: LaunchDeps): number {
  if (!options.yes) {
    deps.out(PLAN_HEADER);
    deps.out(formatCommand(listVmsCommand()));
    deps.out(`# for each listed ${LABEL} VM that is stopped; a RUNNING VM is refused`);
    deps.out(formatCommand(deleteVmCommand("<vm-name>", "<zone>")));
    return 0;
  }
  const [labelKey, labelValue] = LABEL.split("=");
  let code = 0;
  for (const vm of listVms(deps)) {
    if (vm.labels?.[labelKey] !== labelValue) {
      deps.err(`refused: ${vm.name} is not labelled ${LABEL}`);
      code = 1;
    } else if (!DELETABLE_STATES.has(vm.status)) {
      deps.err(`refused: ${vm.name} is ${vm.status}`);
      code = 1;
    } else {
      must(deps, deleteVmCommand(vm.name, vm.zone));
      deps.out(`deleted ${vm.name}`);
    }
  }
  return code;
}

const COMMANDS: Record<string, (options: LaunchOptions, deps: LaunchDeps) => number> = {
  setup,
  start,
  status,
  cleanup,
};

function parseCli(argv: string[]): { command: string; options: LaunchOptions } | null {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        yes: { type: "boolean", default: false },
        condition: { type: "string" },
        seed: { type: "string", default: DEFAULT_SEED },
        "run-id": { type: "string" },
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
        zone: { type: "string" },
        "machine-type": { type: "string" },
        "boot-disk-size": { type: "string" },
      },
    });
  } catch {
    return null;
  }
  const [command, ...rest] = parsed.positionals;
  const { yes, condition, seed, "run-id": runId, "resume-from": resumeFrom, entry } = parsed.values;
  const { "pause-after-patches": pauseAfterPatches, "batch-budget-usd": batchBudgetUsd, patches } = parsed.values;
  const { "review-reserve-usd": reviewReserveUsd, "unusable-limit": unusableLimit, models } = parsed.values;
  const { repeat, arms, shard, zone, "machine-type": machineType, "boot-disk-size": bootDiskSize } = parsed.values;
  const known = command !== undefined && Object.hasOwn(COMMANDS, command);
  if (!known || rest.length > 0 || !SEED_PATTERN.test(seed)) return null;
  const parsedCondition = condition === undefined ? null : parseCondition(condition);
  if (command === "start" ? parsedCondition === null : condition !== undefined) return null;
  if (runId !== undefined && !RUN_ID_PATTERN.test(runId)) return null;
  if (resumeFrom !== undefined && (command !== "start" || !RUN_ID_PATTERN.test(resumeFrom))) return null;
  if (entry !== undefined && (command !== "start" || !isAllowedEntry(entry))) return null;
  const limitsAllowed = command === "start" && (entry ?? BATCH_ENTRY) === BATCH_ENTRY;
  if (pauseAfterPatches !== undefined && (!limitsAllowed || !PAUSE_AFTER_PATCHES_PATTERN.test(pauseAfterPatches))) return null;
  if (batchBudgetUsd !== undefined && (!limitsAllowed || !isPositiveUsd(batchBudgetUsd))) return null;
  if (reviewReserveUsd !== undefined && (!limitsAllowed || !isReviewReserveUsd(reviewReserveUsd))) return null;
  if (unusableLimit !== undefined && (!limitsAllowed || !UNUSABLE_LIMIT_PATTERN.test(unusableLimit))) return null;
  if (patches !== undefined && (command !== "start" || !PATCHES_PATTERN.test(patches))) return null;
  if (repeat !== undefined && (!limitsAllowed || !REPEAT_PATTERN.test(repeat))) return null;
  const parsedArms = arms === undefined ? null : canonicalArms(arms);
  if (arms !== undefined && (!limitsAllowed || parsedArms === null || repeat !== undefined)) return null;
  const parsedModels = models === undefined ? null : canonicalModels(models);
  if (models !== undefined && (!limitsAllowed || parsedModels === null || repeat !== undefined)) return null;
  const parsedShard = shard === undefined ? null : parseShard(shard);
  if (shard !== undefined && (!limitsAllowed || parsedShard === null)) return null;
  if (zone !== undefined && (command !== "start" || !ZONE_PATTERN.test(zone))) return null;
  if (machineType !== undefined && (command !== "start" || !MACHINE_TYPE_PATTERN.test(machineType))) return null;
  if (bootDiskSize !== undefined && (command !== "start" || !isBootDiskSize(bootDiskSize))) return null;
  const resolvedEntry = entry ?? BATCH_ENTRY;
  return {
    command,
    options: {
      yes,
      condition: parsedCondition,
      seed,
      runId: runId ?? null,
      resumeFrom: resumeFrom ?? null,
      entry: resolvedEntry,
      pauseAfterPatches: pauseAfterPatches ?? null,
      batchBudgetUsd: batchBudgetUsd ?? null,
      reviewReserveUsd: reviewReserveUsd ?? null,
      unusableLimit: unusableLimit ?? null,
      patches: patches ?? null,
      repeat: repeat ?? null,
      arms: parsedArms,
      models: parsedModels,
      shard: parsedShard,
      zone: zone ?? ZONE,
      machineType: machineType ?? MACHINE_TYPE,
      bootDiskSize: bootDiskSize ?? (resolvedEntry === CHECKS_ENTRY ? CHECKS_BOOT_DISK_SIZE : DEFAULT_BOOT_DISK_SIZE),
    },
  };
}

function guardFor(command: string, yes: boolean): (argv: string[]) => boolean {
  if (command === "status") return isGcloudRead;
  return yes ? () => true : isPlanningGit;
}

function callsExternalTools(command: string, yes: boolean): boolean {
  return yes || command === "status";
}

export function runLauncher(argv: string[], deps: LaunchDeps): number {
  const cli = parseCli(argv);
  if (!cli) {
    deps.err(USAGE);
    return 2;
  }
  const placeholderRefusal = infraRefusal(deps.infra);
  if (placeholderRefusal !== null && callsExternalTools(cli.command, cli.options.yes)) {
    deps.err(`refused: ${placeholderRefusal}`);
    return 2;
  }
  const guarded = { ...deps, exec: allowlistedExec(deps.exec, guardFor(cli.command, cli.options.yes)) };
  try {
    return COMMANDS[cli.command](cli.options, guarded);
  } catch (error) {
    deps.err(errorMessage(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = runLauncher(process.argv.slice(2), {
    exec: realExec,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    now: () => new Date(),
    repoRoot: resolve(import.meta.dirname, "..", ".."),
    infra: INFRA,
  });
}
