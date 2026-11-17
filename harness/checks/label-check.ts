import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { withFinalNewline } from "../preflight.ts";
import { dockerRunArgs, REVIEWER_ENV, spawnCollect, type ExecResult } from "../runners.ts";
import { fetchText, requireHash, sha256, type Downloader } from "../sources.ts";

export const DEFAULT_REPEATS = 3;
export const RUN_TIMEOUT_MS = 60 * 60_000;
export const REPORT_FILE = "label-check.json";
export const EXCLUSIONS_FILE = "exclusions.json";
export const RUNNER_NOTE =
  "These results come from this harness, not the official SWE-ABS runner.";

const SMOKE_PATCHES_PATH = join(import.meta.dirname, "..", "smoke", "smoke-patches.json");
const INPUTS_PATH = join(import.meta.dirname, "label-check-inputs.json");
const DATASET_SERVER = "https://datasets-server.huggingface.co";
const ROWS_PAGE_LENGTH = 100;
const TESTBED = "/testbed";
const RUNTESTS = "./tests/runtests.py";
const NON_TEST_SUFFIXES = [
  ".json",
  ".png",
  "csv",
  ".txt",
  ".md",
  ".jpg",
  ".jpeg",
  ".pkl",
  ".yml",
  ".yaml",
  ".toml",
];
const USAGE = [
  "usage: node harness/checks/label-check.ts --out <dir> [--repeats 3] [--patches <path>] [--inputs <path>] [--jobs <n>]",
  "       node harness/checks/label-check.ts pin --patches <path> --out <inputs.json> [--from <inputs.json>]",
  "       node harness/checks/label-check.ts reverdict --report <label-check.json> --logs <dir> --out <dir> [--repeats 3] [--inputs <path>]",
].join("\n");
const OFFICIAL_REPEATS = 1;

const CORRECT_STRATUM = "swe_abs_correct";
const PATCH_KINDS = ["candidate", "official"] as const;
const TEST_SETS = ["verified", "abs"] as const;

export type PatchKind = (typeof PATCH_KINDS)[number];
export type TestSet = (typeof TEST_SETS)[number];

export interface SmokePatch {
  instance_id: string;
  agent_id?: string;
  label_stratum: string;
  patch_url: string;
  patch_sha256: string;
  gold_patch_sha256: string;
  image: string;
  image_digest: string;
  base_commit: string;
}

export interface Inputs {
  source: { dataset: string; revision: string };
  instances: Record<
    string,
    {
      abs_test_patch_sha256: string;
      verified_test_patch_sha256: string;
      fail_to_pass_sha256: string;
      pass_to_pass_sha256: string;
    }
  >;
}

interface DatasetRow {
  instance_id: string;
  patch: string;
  test_patch: string;
  original_test_patch: string;
  FAIL_TO_PASS: string;
  PASS_TO_PASS: string;
}

export interface RunInput {
  patch: SmokePatch;
  candidatePatch: string;
  officialPatch: string;
  testPatches: Record<TestSet, string>;
  expectedTests: string[];
}

export interface RunRecord {
  instance_id: string;
  agent_id: string | null;
  patch_kind: PatchKind;
  test_set: TestSet;
  repeat: number;
  exit_code: number;
  timed_out: boolean;
  directives: string[];
  directives_empty: boolean;
  tests_seen: string[];
  failed_tests: string[];
  expected_missing: string[];
  expected_failed: string[];
}

export interface Verdict {
  instance_id: string;
  agent_id: string;
  label_stratum: string;
  verified_pass: boolean;
  abs_pass: boolean;
  repeats_agree: boolean;
  control_ok: boolean;
  matches_label: boolean;
  abs_failing_tests: string[][];
  official_abs_failing_tests: string[];
}

export interface Exclusion {
  instance_id: string;
  agent_id: string;
  reason: string;
}

export function agentKey(patch: SmokePatch): string {
  return patch.agent_id ?? "";
}

export type Exec = (
  command: string,
  args: string[],
  options: { stdin?: string; timeoutMs: number },
) => Promise<ExecResult & { timedOut: boolean }>;

export interface LabelCheckDeps {
  exec: Exec;
  fetch: (url: string) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  warn: (message: string) => void;
}

export function testDirectives(testPatch: string): string[] {
  return [...testPatch.matchAll(/^diff --git a\/.* b\/(.*)$/gm)]
    .map((match) => match[1])
    .filter((path) => !NON_TEST_SUFFIXES.some((suffix) => path.endsWith(suffix)))
    .map((path) => path.replace(/\.py$/, "").replace(/^tests\//, "").replaceAll("/", "."));
}

function existingTestFiles(testPatch: string): string[] {
  return [...testPatch.matchAll(/^--- a\/(.*)$/gm)].map((match) => match[1]);
}

export function parseDjangoLog(log: string): Map<string, "passed" | "failed" | "skipped"> {
  const statuses = new Map<string, "passed" | "failed" | "skipped">();
  let previousLine = "";
  let unfinishedTest: string | null = null;
  for (const rawLine of log.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const skipped = line.match(/^(.*?) \.\.\. skipped\b/);
    const finished = line.match(/^(.*) \.\.\. {1,2}(ok|OK|FAIL|ERROR)$/);
    const onlyStatus = line.match(/^\.\.\. (ok|OK|FAIL|ERROR)$/);
    if (skipped) {
      statuses.set(skipped[1], "skipped");
      unfinishedTest = null;
    } else if (finished) {
      statuses.set(finished[1], statusOf(finished[2]));
      unfinishedTest = null;
    } else if (onlyStatus && previousLine) {
      statuses.set(previousLine, statusOf(onlyStatus[1]));
      unfinishedTest = null;
    } else if (line === "ok" && unfinishedTest) {
      statuses.set(unfinishedTest, "passed");
      unfinishedTest = null;
    } else if (line.includes(" ... ")) {
      unfinishedTest = line.slice(0, line.indexOf(" ... "));
    }
    previousLine = line;
  }
  return statuses;
}

function statusOf(word: string): "passed" | "failed" {
  return word.toLowerCase() === "ok" ? "passed" : "failed";
}

export function failureHeaders(log: string): string[] {
  const names = [...log.matchAll(/^(?:FAIL|ERROR): (\S+) \(([^()\s]+)\)/gm)].map((match) => `${match[1]} (${match[2]})`);
  return [...new Set(names)];
}

export function testResults(log: string, expectedTests: string[]) {
  const statuses = parseDjangoLog(log);
  const failures = new Set(failureHeaders(log));
  const seen = new Set([...statuses.keys(), ...failures]);
  const failed = (name: string) => failures.has(name) || statuses.get(name) === "failed";
  return {
    tests_seen: [...seen],
    failed_tests: [...seen].filter(failed),
    expected_missing: expectedTests.filter((name) => !seen.has(name)),
    expected_failed: expectedTests.filter(failed),
  };
}

function isRuntestsStepLine(line: string): boolean {
  return line.startsWith("$ docker exec ") && line.split(" ").includes(RUNTESTS);
}

export function testOutputOf(runLog: string): string {
  const lines = runLog.split("\n");
  const stepLine = lines.findIndex(isRuntestsStepLine);
  if (stepLine < 0 || stepLine === lines.length - 1) return "";
  return lines.slice(stepLine + 1).join("\n");
}

function dockerExecArgs(container: string, argv: string[], env: string[] = []): string[] {
  const envArgs = env.flatMap((assignment) => ["--env", assignment]);
  return ["exec", "-i", ...envArgs, "-w", TESTBED, container, ...argv];
}

function runtestsArgv(directives: string[]): string[] {
  return [
    RUNTESTS,
    "--verbosity",
    "2",
    "--settings=test_sqlite",
    "--parallel",
    "1",
    ...directives,
  ];
}

interface RunSpec {
  input: RunInput;
  patchKind: PatchKind;
  testSet: TestSet;
  repeat: number;
  logsDir: string;
}

export async function executeRun(spec: RunSpec, deps: LabelCheckDeps): Promise<RunRecord> {
  const { input, patchKind, testSet, repeat } = spec;
  const { patch } = input;
  const testPatch = input.testPatches[testSet];
  const directives = testDirectives(testPatch);
  const container = `cr-label-check-${randomBytes(4).toString("hex")}`;
  const logParts: string[] = [];
  const step = async (args: string[], stdin?: string) => {
    const result = await deps.exec("docker", args, { stdin, timeoutMs: RUN_TIMEOUT_MS });
    logParts.push(`$ docker ${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result;
  };
  const setup: Array<{ args: string[]; stdin?: string }> = [
    { args: dockerRunArgs(container, `${patch.image}@${patch.image_digest}`, "none") },
    {
      args: dockerExecArgs(container, ["git", "apply", "-"]),
      stdin: withFinalNewline(patchKind === "candidate" ? input.candidatePatch : input.officialPatch),
    },
  ];
  // SWE-bench restores the test files first, so a patch that edits them cannot block the test patch.
  const testFiles = existingTestFiles(testPatch);
  if (testFiles.length > 0) {
    setup.push({
      args: dockerExecArgs(container, ["git", "checkout", patch.base_commit, "--", ...testFiles]),
    });
  }
  setup.push({
    args: dockerExecArgs(container, ["git", "apply", "-"]),
    stdin: withFinalNewline(testPatch),
  });

  let outcome = { code: 0, timedOut: false };
  let testLog = "";
  try {
    for (const { args, stdin } of setup) {
      outcome = await step(args, stdin);
      if (outcome.code !== 0 || outcome.timedOut) break;
    }
    if (outcome.code === 0 && !outcome.timedOut) {
      const run = await step(dockerExecArgs(container, runtestsArgv(directives), REVIEWER_ENV));
      outcome = run;
      testLog = `${run.stdout}${run.stderr}`;
    }
  } finally {
    await removeContainer(container, deps);
  }

  const agentId = patchKind === "candidate" ? agentKey(patch) : null;
  writeFileSync(join(spec.logsDir, logName(patch.instance_id, agentId, patchKind, testSet, repeat)), logParts.join("\n"));
  return {
    instance_id: patch.instance_id,
    agent_id: agentId,
    patch_kind: patchKind,
    test_set: testSet,
    repeat,
    exit_code: outcome.code,
    timed_out: outcome.timedOut,
    directives,
    directives_empty: directives.length === 0,
    ...testResults(testLog, input.expectedTests),
  };
}

export function logName(
  instanceId: string,
  agentId: string | null,
  patchKind: PatchKind,
  testSet: TestSet,
  repeat: number,
): string {
  const agentPart = agentId ? `${agentId.replace(/[^\w.-]/g, "_")}.` : "";
  return `${instanceId}.${agentPart}${patchKind}.${testSet}.${repeat}.log`;
}

async function removeContainer(container: string, deps: LabelCheckDeps): Promise<void> {
  try {
    const removal = await deps.exec("docker", ["rm", "-f", container], {
      timeoutMs: RUN_TIMEOUT_MS,
    });
    if (removal.code !== 0) deps.warn(`docker rm ${container} exited ${removal.code}`);
  } catch (error) {
    deps.warn(`docker rm ${container} failed: ${(error as Error).message}`);
  }
}

function passesVerified(run: RunRecord): boolean {
  return (
    run.tests_seen.length > 0 &&
    run.expected_failed.length === 0 &&
    run.expected_missing.length === 0 &&
    !run.timed_out
  );
}

function passesAbs(run: RunRecord): boolean {
  return (
    run.tests_seen.length > 0 &&
    run.failed_tests.length === 0 &&
    !run.timed_out &&
    run.exit_code === 0
  );
}

function completed(run: RunRecord): boolean {
  return run.tests_seen.length > 0 && !run.timed_out && (run.exit_code === 0 || run.failed_tests.length > 0);
}

function outcomeKey(run: RunRecord): string {
  const { exit_code, timed_out, tests_seen, failed_tests, expected_missing, expected_failed } = run;
  return JSON.stringify([
    exit_code,
    timed_out,
    [...tests_seen].sort(),
    [...failed_tests].sort(),
    expected_missing,
    expected_failed,
  ]);
}

export function computeVerdicts(
  runs: RunRecord[],
  patches: SmokePatch[],
  repeats: number,
): Verdict[] {
  return patches.map((patch) => {
    const agentId = agentKey(patch);
    const select = (patchKind: PatchKind, testSet: TestSet) =>
      runs
        .filter(
          (run) =>
            run.instance_id === patch.instance_id &&
            run.patch_kind === patchKind &&
            run.test_set === testSet &&
            (patchKind === "official" || run.agent_id === agentId),
        )
        .sort((a, b) => a.repeat - b.repeat);
    const allPass = (
      patchKind: PatchKind,
      testSet: TestSet,
      required: number,
      passes: (run: RunRecord) => boolean,
    ) => {
      const selected = select(patchKind, testSet);
      return selected.length === required && selected.every(passes);
    };
    const officialAbsFailures = new Set(select("official", "abs").flatMap((run) => run.failed_tests));
    const officialFails = (name: string) => officialAbsFailures.has(name);
    const verifiedPass = allPass("candidate", "verified", repeats, passesVerified);
    const labelHolds =
      patch.label_stratum === CORRECT_STRATUM
        ? allPass("candidate", "abs", repeats, (run) => completed(run) && run.failed_tests.every(officialFails))
        : allPass("candidate", "abs", repeats, (run) => completed(run) && !run.failed_tests.every(officialFails));
    return {
      instance_id: patch.instance_id,
      agent_id: agentId,
      label_stratum: patch.label_stratum,
      verified_pass: verifiedPass,
      abs_pass: allPass("candidate", "abs", repeats, passesAbs),
      repeats_agree: TEST_SETS.every((testSet) => {
        const selected = select("candidate", testSet);
        return selected.length === repeats && new Set(selected.map(outcomeKey)).size === 1;
      }),
      control_ok:
        allPass("official", "verified", OFFICIAL_REPEATS, passesVerified) &&
        allPass("official", "abs", OFFICIAL_REPEATS, completed),
      matches_label: verifiedPass && labelHolds,
      abs_failing_tests: select("candidate", "abs").map((run) => [...run.failed_tests].sort()),
      official_abs_failing_tests: [...officialAbsFailures].sort(),
    };
  });
}

export function exclusionsOf(verdicts: Verdict[]): Exclusion[] {
  return verdicts.flatMap((verdict) => {
    const reasons = [
      ...(verdict.matches_label ? [] : ["label_mismatch"]),
      ...(verdict.repeats_agree ? [] : ["repeats_disagree"]),
      ...(verdict.control_ok ? [] : ["control_failed"]),
    ];
    if (reasons.length === 0) return [];
    return [{ instance_id: verdict.instance_id, agent_id: verdict.agent_id, reason: reasons.join(",") }];
  });
}

async function fetchRows(
  inputs: Inputs,
  requested: string[],
  downloader: Downloader,
): Promise<Map<string, DatasetRow>> {
  const wanted = [...new Set(requested)];
  const found = new Map<string, DatasetRow>();
  for (let offset = 0; found.size < wanted.length; ) {
    const query = new URLSearchParams({
      dataset: inputs.source.dataset,
      config: "default",
      split: "test",
      offset: String(offset),
      length: String(ROWS_PAGE_LENGTH),
    });
    const page = JSON.parse(await fetchText(`${DATASET_SERVER}/rows?${query}`, downloader)) as {
      rows?: Array<{ row: DatasetRow; truncated_cells?: string[] }>;
    };
    if (!page.rows?.length) {
      const missing = wanted.filter((id) => !found.has(id));
      throw new Error(`rows at offset ${offset} are empty, still missing ${missing.join(", ")}`);
    }
    for (const { row, truncated_cells: truncated } of page.rows) {
      if (!wanted.includes(row.instance_id)) continue;
      if (truncated?.length !== 0) {
        throw new Error(`dataset row for ${row.instance_id} is truncated`);
      }
      found.set(row.instance_id, row);
    }
    offset += page.rows.length;
  }
  return found;
}

function requirePins(id: string, row: DatasetRow, pins: Inputs["instances"][string]): void {
  requireHash(`${id} abs test patch`, row.test_patch, pins.abs_test_patch_sha256);
  requireHash(`${id} verified test patch`, row.original_test_patch, pins.verified_test_patch_sha256);
  requireHash(`${id} FAIL_TO_PASS`, row.FAIL_TO_PASS, pins.fail_to_pass_sha256);
  requireHash(`${id} PASS_TO_PASS`, row.PASS_TO_PASS, pins.pass_to_pass_sha256);
}

export async function pinInputs(
  patches: SmokePatch[],
  existing: Inputs,
  downloader: Downloader,
): Promise<Inputs> {
  const rows = await fetchRows(
    existing,
    patches.map((patch) => patch.instance_id),
    downloader,
  );
  const instances = { ...existing.instances };
  for (const patch of patches) {
    const id = patch.instance_id;
    const row = rows.get(id) as DatasetRow;
    requireHash(`${id} official fix`, row.patch, patch.gold_patch_sha256);
    const pinned = existing.instances[id];
    if (pinned) {
      requirePins(id, row, pinned);
      continue;
    }
    instances[id] = {
      abs_test_patch_sha256: sha256(row.test_patch),
      verified_test_patch_sha256: sha256(row.original_test_patch),
      fail_to_pass_sha256: sha256(row.FAIL_TO_PASS),
      pass_to_pass_sha256: sha256(row.PASS_TO_PASS),
    };
  }
  return { source: existing.source, instances };
}

export async function loadRunInputs(
  patches: SmokePatch[],
  inputs: Inputs,
  downloader: Downloader,
): Promise<RunInput[]> {
  const rows = await fetchRows(
    inputs,
    patches.map((patch) => patch.instance_id),
    downloader,
  );
  const loaded: RunInput[] = [];
  for (const patch of patches) {
    const id = patch.instance_id;
    const row = rows.get(id) as DatasetRow;
    const pins = inputs.instances[id];
    if (!pins) throw new Error(`no pinned hashes for ${id}`);
    requirePins(id, row, pins);
    requireHash(`${id} official fix`, row.patch, patch.gold_patch_sha256);
    const candidatePatch = await fetchText(patch.patch_url, downloader);
    requireHash(`${id} candidate patch`, candidatePatch, patch.patch_sha256);
    loaded.push({
      patch,
      candidatePatch,
      officialPatch: row.patch,
      testPatches: { verified: row.original_test_patch, abs: row.test_patch },
      expectedTests: [
        ...(JSON.parse(row.FAIL_TO_PASS) as string[]),
        ...(JSON.parse(row.PASS_TO_PASS) as string[]),
      ],
    });
  }
  return loaded;
}

function refuseDuplicates(patches: SmokePatch[]): void {
  const seen = new Set<string>();
  for (const patch of patches) {
    const key = `${patch.instance_id} ${agentKey(patch)}`;
    if (seen.has(key)) throw new Error(`patch list repeats ${key}`);
    seen.add(key);
  }
}

async function runPool(tasks: Array<() => Promise<void>>, jobs: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next];
      next += 1;
      await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
}

function plannedRuns(runInputs: RunInput[], repeats: number, logsDir: string): RunSpec[] {
  const byInstance = Map.groupBy(runInputs, (input) => input.patch.instance_id);
  return [...byInstance.values()].flatMap((inputs) => {
    const plan = (input: RunInput, patchKind: PatchKind, count: number) =>
      TEST_SETS.flatMap((testSet) =>
        Array.from({ length: count }, (_, index) => ({ input, patchKind, testSet, repeat: index + 1, logsDir })),
      );
    return [
      ...inputs.flatMap((input) => plan(input, "candidate", repeats)),
      ...plan(inputs[0], "official", OFFICIAL_REPEATS),
    ];
  });
}

export async function runLabelCheck(
  options: { outDir: string; repeats: number; patches: SmokePatch[]; inputs: Inputs; jobs?: number },
  deps: LabelCheckDeps,
): Promise<number> {
  const { outDir, repeats, patches, inputs, jobs = 1 } = options;
  refuseDuplicates(patches);
  const runInputs = await loadRunInputs(patches, inputs, {
    fetch: deps.fetch,
    sleep: deps.sleep,
    cacheRoot: "",
  });
  const logsDir = join(outDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const specs = plannedRuns(runInputs, repeats, logsDir);
  const results: Array<RunRecord | undefined> = Array.from({ length: specs.length });
  const writeReport = () => {
    const runs = results.filter((run) => run !== undefined);
    const verdicts = computeVerdicts(runs, patches, repeats);
    const report = { runner_note: RUNNER_NOTE, runs, verdicts };
    writeFileSync(join(outDir, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);
    return verdicts;
  };
  let unrecorded = 0;
  await runPool(
    specs.map((spec, index) => async () => {
      try {
        results[index] = await executeRun(spec, deps);
      } catch (error) {
        unrecorded += 1;
        const agent = spec.patchKind === "candidate" ? ` ${agentKey(spec.input.patch)}` : "";
        const label = `${spec.input.patch.instance_id}${agent} ${spec.patchKind} ${spec.testSet} ${spec.repeat}`;
        deps.warn(`run ${label} could not be recorded: ${(error as Error).message}`);
      }
      writeReport();
    }),
    jobs,
  );
  const exclusions = exclusionsOf(writeReport());
  writeFileSync(join(outDir, EXCLUSIONS_FILE), `${JSON.stringify(exclusions, null, 2)}\n`);
  return unrecorded === 0 ? 0 : 1;
}

export async function runPin(
  options: { patchesPath: string; outPath: string; fromPath: string },
  downloader: Pick<LabelCheckDeps, "fetch" | "sleep">,
): Promise<void> {
  const pinned = await pinInputs(
    JSON.parse(readFileSync(options.patchesPath, "utf8")) as SmokePatch[],
    JSON.parse(readFileSync(options.fromPath, "utf8")) as Inputs,
    { ...downloader, cacheRoot: "" },
  );
  writeFileSync(options.outPath, `${JSON.stringify(pinned, null, 2)}\n`);
}

export async function runReverdict(
  options: { reportPath: string; logsDir: string; outDir: string; repeats: number; inputs: Inputs },
  downloader: Pick<LabelCheckDeps, "fetch" | "sleep">,
): Promise<Verdict[]> {
  const filed = JSON.parse(readFileSync(options.reportPath, "utf8")) as { runs: RunRecord[]; verdicts: Verdict[] };
  const rows = await fetchRows(
    options.inputs,
    filed.runs.map((run) => run.instance_id),
    { ...downloader, cacheRoot: "" },
  );
  const expectedTests = (id: string) => {
    const row = rows.get(id) as DatasetRow;
    const pins = options.inputs.instances[id];
    if (!pins) throw new Error(`no pinned hashes for ${id}`);
    requirePins(id, row, pins);
    return [...(JSON.parse(row.FAIL_TO_PASS) as string[]), ...(JSON.parse(row.PASS_TO_PASS) as string[])];
  };
  const runs = filed.runs.map((run) => {
    const log = readFileSync(
      join(options.logsDir, logName(run.instance_id, run.agent_id, run.patch_kind, run.test_set, run.repeat)),
      "utf8",
    );
    return { ...run, ...testResults(testOutputOf(log), expectedTests(run.instance_id)) };
  });
  const patches = filed.verdicts.map((verdict) => ({
    instance_id: verdict.instance_id,
    agent_id: verdict.agent_id,
    label_stratum: verdict.label_stratum,
  })) as SmokePatch[];
  const verdicts = computeVerdicts(runs, patches, options.repeats);
  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(
    join(options.outDir, REPORT_FILE),
    `${JSON.stringify({ runner_note: RUNNER_NOTE, runs, verdicts }, null, 2)}\n`,
  );
  writeFileSync(join(options.outDir, EXCLUSIONS_FILE), `${JSON.stringify(exclusionsOf(verdicts), null, 2)}\n`);
  return verdicts;
}

export type Cli =
  | { command: "run"; outDir: string; repeats: number; patchesPath: string; inputsPath: string; jobs: number }
  | { command: "pin"; patchesPath: string; outPath: string; fromPath: string }
  | { command: "reverdict"; reportPath: string; logsDir: string; outDir: string; repeats: number; inputsPath: string };

function positiveInteger(text: string | undefined): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) throw new TypeError(USAGE);
  return value;
}

export function parseCli(argv: string[]): Cli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      repeats: { type: "string", default: String(DEFAULT_REPEATS) },
      patches: { type: "string" },
      inputs: { type: "string", default: INPUTS_PATH },
      jobs: { type: "string", default: "1" },
      from: { type: "string", default: INPUTS_PATH },
      logs: { type: "string" },
      report: { type: "string" },
    },
  });
  if (!values.out) throw new TypeError(USAGE);
  if (positionals.length === 1 && positionals[0] === "pin") {
    if (!values.patches) throw new TypeError(USAGE);
    return { command: "pin", patchesPath: values.patches, outPath: values.out, fromPath: values.from };
  }
  if (positionals.length === 1 && positionals[0] === "reverdict") {
    if (!values.logs || !values.report) throw new TypeError(USAGE);
    return {
      command: "reverdict",
      reportPath: values.report,
      logsDir: values.logs,
      outDir: values.out,
      repeats: positiveInteger(values.repeats),
      inputsPath: values.inputs,
    };
  }
  if (positionals.length > 0) throw new TypeError(USAGE);
  return {
    command: "run",
    outDir: values.out,
    repeats: positiveInteger(values.repeats),
    patchesPath: values.patches ?? SMOKE_PATCHES_PATH,
    inputsPath: values.inputs,
    jobs: positiveInteger(values.jobs),
  };
}

async function main(): Promise<number> {
  let cli: Cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  const deps: LabelCheckDeps = {
    exec: spawnCollect,
    fetch: (url) => fetch(url),
    sleep: async (ms) => {
      await delay(ms);
    },
    warn: (message) => console.error(message),
  };
  try {
    if (cli.command === "pin") {
      await runPin(cli, deps);
      return 0;
    }
    if (cli.command === "reverdict") {
      await runReverdict(
        { ...cli, inputs: JSON.parse(readFileSync(cli.inputsPath, "utf8")) as Inputs },
        deps,
      );
      return 0;
    }
    return await runLabelCheck(
      {
        outDir: cli.outDir,
        repeats: cli.repeats,
        jobs: cli.jobs,
        patches: JSON.parse(readFileSync(cli.patchesPath, "utf8")) as SmokePatch[],
        inputs: JSON.parse(readFileSync(cli.inputsPath, "utf8")) as Inputs,
      },
      deps,
    );
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
