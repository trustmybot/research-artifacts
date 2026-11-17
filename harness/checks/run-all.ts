import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { CONDITION_USAGE, conditionFlags, parseCondition, realExec, type Condition, type Exec } from "../gcp/common.ts";
import { scrubber } from "../network.ts";
import { API_KEY_ENV } from "../runners.ts";

export const RUN_ALL_FILE = "run-all.json";
export const PILOT_BUDGET_CEILING_USD = 10;
export const ASSUMED_RECALL_SPEND_USD = 5;
export const PILOT_REVIEW_RESERVE_USD = 1;

const PILOT_PATCHES = "harness/checks/pilot-patches.json";
const RECALL_SUMMARY_FILE = "summary.json";
const RECALL = "recall";
const PILOT = "pilot";
const LABEL_CHECK = "label-check";
const LABEL_CHECK_JOBS = "4";
const CHECKPOINT_TIMEOUT_MS = 10 * 60_000;
const STDERR_TAIL_CHARS = 500;
const USAGE =
  `usage: node harness/checks/run-all.ts --run-id <id> ${CONDITION_USAGE} --seed <int> --vm-type <type> --out <dir> [--checkpoint-cmd <cmd>] [--resume-from <dir>] [--patches <path>]`;

export interface RunAllOptions {
  runId: string;
  condition: Condition;
  seed: string;
  vmType: string;
  outDir: string;
  checkpointCmd: string | null;
  resumeFrom: string | null;
  patches: string | null;
}

export interface RunAllDeps {
  exec: Exec;
  log(line: string): void;
  now(): Date;
  env: NodeJS.ProcessEnv;
  codeDir: string;
  nodePath: string;
}

export interface StepRecord {
  name: string;
  exit_code: number;
  started_at: string;
  finished_at: string;
}

export interface RunAllReport {
  steps: StepRecord[];
  recall_spent_usd: number | null;
  pilot_budget_usd: number | null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readPriorReport(dir: string | null): Partial<RunAllReport> {
  if (dir === null) return {};
  const report = readJson(join(dir, RUN_ALL_FILE));
  return typeof report === "object" && report !== null ? report : {};
}

function readRecallSpend(outDir: string): number | null {
  const summary = readJson(join(outDir, RECALL, RECALL_SUMMARY_FILE)) as { spent_usd?: unknown } | null | undefined;
  const spent = summary?.spent_usd;
  return typeof spent === "number" && Number.isFinite(spent) && spent >= 0 ? spent : null;
}

function checkpoint(options: RunAllOptions, deps: RunAllDeps): void {
  if (options.checkpointCmd === null) return;
  const { [API_KEY_ENV]: _key, ...env } = deps.env;
  const result = deps.exec(["sh", "-c", options.checkpointCmd], { env, timeoutMs: CHECKPOINT_TIMEOUT_MS });
  if (result.code !== 0) {
    deps.log(scrubber(deps.env)(`checkpoint exited ${result.code}: ${result.stderr.slice(-STDERR_TAIL_CHARS)}`));
  }
}

export function runAll(options: RunAllOptions, deps: RunAllDeps): number {
  const { outDir, resumeFrom } = options;
  mkdirSync(outDir, { recursive: true });
  const prior = readPriorReport(resumeFrom);
  const priorSteps = Array.isArray(prior.steps) ? prior.steps : [];
  const passedBefore = (name: string): StepRecord | undefined =>
    priorSteps.find((step) => step?.name === name && step.exit_code === 0);
  const report: RunAllReport = { steps: [], recall_spent_usd: null, pilot_budget_usd: null };

  const copyPassedStep = (name: string): StepRecord | null => {
    const record = passedBefore(name);
    if (resumeFrom === null || record === undefined) return null;
    try {
      cpSync(join(resumeFrom, name), join(outDir, name), { recursive: true, verbatimSymlinks: true });
      deps.log(`${name}: passed in ${resumeFrom}, copied and skipped`);
      return record;
    } catch (error) {
      rmSync(join(outDir, name), { recursive: true, force: true });
      deps.log(`${name}: could not copy the prior result, running it again: ${(error as Error).message}`);
      return null;
    }
  };

  const executeStep = (name: string, args: string[]): StepRecord => {
    const startedAt = deps.now().toISOString();
    const { code } = deps.exec([deps.nodePath, ...args], { cwd: deps.codeDir, env: deps.env, inheritStdio: true });
    deps.log(`${name} exited with ${code}`);
    return { name, exit_code: code, started_at: startedAt, finished_at: deps.now().toISOString() };
  };

  const step = (name: string, args: () => string[], settle: () => void = () => {}): void => {
    report.steps.push(copyPassedStep(name) ?? executeStep(name, args()));
    settle();
    writeFileSync(join(outDir, RUN_ALL_FILE), `${JSON.stringify(report, null, 2)}\n`);
    checkpoint(options, deps);
  };

  const { patches } = options;

  step(
    RECALL,
    () => ["harness/checks/recall.ts", "--out", join(outDir, RECALL), "--patches", patches ?? PILOT_PATCHES],
    () => {
      const spent = readRecallSpend(outDir);
      if (patches !== null) {
        report.recall_spent_usd = spent;
        return;
      }
      if (spent === null) deps.log(`no readable recall spent_usd; assuming $${ASSUMED_RECALL_SPEND_USD}`);
      report.recall_spent_usd = spent ?? ASSUMED_RECALL_SPEND_USD;
      const priorBudget = passedBefore(PILOT) && prior.pilot_budget_usd;
      report.pilot_budget_usd =
        typeof priorBudget === "number" ? priorBudget : PILOT_BUDGET_CEILING_USD - report.recall_spent_usd;
    },
  );

  if (patches === null) {
    step(PILOT, () => {
      const priorPilot = resumeFrom === null ? null : join(resumeFrom, PILOT);
      return [
        "harness/smoke/run-batch.ts",
        "--patches",
        PILOT_PATCHES,
        "--batch-budget-usd",
        String(report.pilot_budget_usd),
        "--review-reserve-usd",
        String(PILOT_REVIEW_RESERVE_USD),
        "--out",
        join(outDir, PILOT),
        "--run-id",
        options.runId,
        ...conditionFlags(options.condition),
        "--seed",
        options.seed,
        "--vm-type",
        options.vmType,
        ...(options.checkpointCmd === null ? [] : ["--checkpoint-cmd", options.checkpointCmd]),
        ...(priorPilot !== null && existsSync(priorPilot) ? ["--resume-from", priorPilot] : []),
      ];
    });
  }

  step(LABEL_CHECK, () => [
    "harness/checks/label-check.ts",
    "--out",
    join(outDir, LABEL_CHECK),
    ...(patches === null ? [] : ["--patches", patches, "--jobs", LABEL_CHECK_JOBS]),
  ]);

  return report.steps.every((record) => record.exit_code === 0) ? 0 : 1;
}

function parseCli(argv: string[]): RunAllOptions | null {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "run-id": { type: "string" },
        condition: { type: "string" },
        seed: { type: "string" },
        "vm-type": { type: "string" },
        out: { type: "string" },
        "checkpoint-cmd": { type: "string" },
        "resume-from": { type: "string" },
        patches: { type: "string" },
      },
    }));
  } catch {
    return null;
  }
  const { "run-id": runId, seed, "vm-type": vmType, out, "checkpoint-cmd": checkpointCmd, "resume-from": resumeFrom, patches } = values;
  const condition = parseCondition(values.condition);
  if (!runId || condition === null || !seed || !vmType || !out || patches === "") return null;
  return {
    runId,
    condition,
    seed,
    vmType,
    outDir: resolve(out),
    checkpointCmd: checkpointCmd ?? null,
    resumeFrom: resumeFrom === undefined ? null : resolve(resumeFrom),
    patches: patches ?? null,
  };
}

if (import.meta.main) {
  const options = parseCli(process.argv.slice(2));
  if (options === null) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    process.exitCode = runAll(options, {
      exec: realExec,
      log: (line) => console.error(line),
      now: () => new Date(),
      env: process.env,
      codeDir: resolve(import.meta.dirname, "..", ".."),
      nodePath: process.execPath,
    });
  }
}
