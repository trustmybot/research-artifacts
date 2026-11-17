import {
  armsFlags,
  BATCH_ENTRY,
  batchLimitFlags,
  INFRA_ENV,
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
  REPEAT_PATTERN,
  repeatFlags,
  RUN_ID_PATTERN,
  SEED_PATTERN,
  shardFlags,
  shellQuote,
  UNUSABLE_LIMIT_PATTERN,
  VAULT_REPO,
  VM_WORK_DIR,
  type BatchLimits,
  type Condition,
} from "./common.ts";

export const NODE_VERSION = "v24.22.2";
export const NODE_LINUX_X64_SHA256 = "361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9";
export const STARTUP_LOG = "/var/log/c4-startup.log";

const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface StartupParams extends BatchLimits {
  runId: string;
  condition: Condition;
  seed: string;
  bucket: string;
  machineType: string;
  resumeFrom?: string | null;
  entry?: string;
  patches?: string | null;
  repeat?: string | null;
  arms?: string | null;
  models?: string | null;
  shard?: string | null;
}

function assertSafe(params: StartupParams): void {
  if (!RUN_ID_PATTERN.test(params.runId)) throw new Error(`invalid run id: ${params.runId}`);
  if (parseCondition(params.condition) === null) throw new Error(`invalid condition: ${params.condition}`);
  if (!SEED_PATTERN.test(params.seed)) throw new Error(`invalid seed: ${params.seed}`);
  if (!SAFE_NAME.test(params.bucket)) throw new Error(`invalid bucket: ${params.bucket}`);
  if (!SAFE_NAME.test(params.machineType)) throw new Error(`invalid machine type: ${params.machineType}`);
  if (params.resumeFrom && !RUN_ID_PATTERN.test(params.resumeFrom)) {
    throw new Error(`invalid resume run id: ${params.resumeFrom}`);
  }
  if (params.entry !== undefined && !isAllowedEntry(params.entry)) {
    throw new Error(`invalid entry: ${params.entry}`);
  }
  if (params.pauseAfterPatches && !PAUSE_AFTER_PATCHES_PATTERN.test(params.pauseAfterPatches)) {
    throw new Error(`invalid pause after patches: ${params.pauseAfterPatches}`);
  }
  if (params.batchBudgetUsd && !isPositiveUsd(params.batchBudgetUsd)) {
    throw new Error(`invalid batch budget: ${params.batchBudgetUsd}`);
  }
  if (params.reviewReserveUsd && !isReviewReserveUsd(params.reviewReserveUsd)) {
    throw new Error(`invalid review reserve: ${params.reviewReserveUsd}`);
  }
  if (params.unusableLimit && !UNUSABLE_LIMIT_PATTERN.test(params.unusableLimit)) {
    throw new Error(`invalid unusable limit: ${params.unusableLimit}`);
  }
  if (params.patches && !PATCHES_PATTERN.test(params.patches)) {
    throw new Error(`invalid patches: ${params.patches}`);
  }
  if (params.repeat && !REPEAT_PATTERN.test(params.repeat)) throw new Error(`invalid repeat: ${params.repeat}`);
  if (params.arms && (!isArmList(params.arms) || params.repeat)) throw new Error(`invalid arms: ${params.arms}`);
  if (params.models && (!isModelList(params.models) || params.repeat)) {
    throw new Error(`invalid models: ${params.models}`);
  }
  if (params.shard && !isShard(params.shard)) throw new Error(`invalid shard: ${params.shard}`);
}

export function renderStartupScript(params: StartupParams): string {
  assertSafe(params);
  const { runId, condition, seed, bucket, machineType, resumeFrom, entry = BATCH_ENTRY } = params;
  const resumeFlag = resumeFrom ? ` --resume-from ${resumeFrom}` : "";
  const entryFlag = entry === BATCH_ENTRY ? "" : ` --entry ${entry}`;
  const limitFlags = [
    ...batchLimitFlags(params),
    ...patchesFlags(params.patches),
    ...repeatFlags(params.repeat),
    ...armsFlags(params.arms),
    ...modelsFlags(params.models),
    ...shardFlags(params.shard),
  ]
    .map((arg) => ` ${arg}`)
    .join("");
  const projectFlag = `--project=${PROJECT}`;
  const runPrefix = `gs://${bucket}/runs/${runId}`;
  const marker = `${runPrefix}/STARTED`;
  const nodeDir = `${VM_WORK_DIR}/node`;
  const codeDir = `${VM_WORK_DIR}/code`;
  const nodeTarball = `node-${NODE_VERSION}-linux-x64.tar.gz`;
  const nodePath = `${VM_WORK_DIR}/${nodeTarball}`;
  const codePath = `${VM_WORK_DIR}/code.tar.gz`;
  return [
    "#!/bin/bash",
    `trap 'gcloud storage cp ${STARTUP_LOG} ${runPrefix}/ ${projectFlag} || true; shutdown -h now' EXIT`,
    `exec >>${STARTUP_LOG} 2>&1`,
    "set -euo pipefail",
    "export HOME=/root",
    `export ${INFRA_ENV.project}=${shellQuote(PROJECT)} ${INFRA_ENV.vaultRepo}=${shellQuote(VAULT_REPO)}`,
    `if gcloud storage ls ${marker} ${projectFlag} >/dev/null 2>&1; then`,
    `  echo "STARTED marker exists for ${runId}; stopping without spending"`,
    "  exit 0",
    "fi",
    `date -u +%FT%TZ | gcloud storage cp --if-generation-match=0 - ${marker} ${projectFlag}`,
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update",
    "apt-get install -y docker.io git",
    `mkdir -p ${nodeDir} ${codeDir}`,
    `curl -fsSL -o ${nodePath} https://nodejs.org/dist/${NODE_VERSION}/${nodeTarball}`,
    `echo "${NODE_LINUX_X64_SHA256}  ${nodePath}" | sha256sum -c -`,
    `tar -xzf ${nodePath} -C ${nodeDir} --strip-components=1`,
    `gcloud storage cp gs://${bucket}/code/${runId}.tar.gz ${codePath} ${projectFlag}`,
    `tar -xzf ${codePath} -C ${codeDir}`,
    `cd ${codeDir}`,
    `PATH=${nodeDir}/bin:"$PATH" ${nodeDir}/bin/npm ci --no-audit --no-fund`,
    `${nodeDir}/bin/node harness/gcp/vm-run.ts run --run-id ${runId} --condition ${condition} --seed ${seed} --bucket ${bucket} --vm-type ${machineType} --work ${VM_WORK_DIR}${resumeFlag}${entryFlag}${limitFlags}`,
    "",
  ].join("\n");
}
