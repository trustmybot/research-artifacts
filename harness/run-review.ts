import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { buildBrief, fillBriefSlot, type Brief } from "./brief.ts";
import { ARMS, armProfile, authorsNote, CONTROL_ARM, isArm, type Arm } from "./conditions/arms.ts";
import { CONDITION_REFUSAL, CONDITION_USAGE, parseCondition, resourceNames, type ResourceNames } from "./gcp/common.ts";
import { DEFAULT_MODEL, isModel, MODELS, type Model } from "./models.ts";
import { openClosedNetwork, scrubber, type ClosedNetwork, type DockerHost } from "./network.ts";
import {
  applyAndPreflight,
  checkReviewerImports,
  commitDiff,
  environmentFileFor,
  installEnvironment,
  networkPreflight,
  patchPaths,
  setUpstreamBase,
  specWithheldCheck,
  type PreflightCheck,
  type PreflightResult,
} from "./preflight.ts";
import {
  API_KEY_ENV,
  DockerContainer,
  DockerModel,
  ENVIRONMENT_PATH,
  PLATFORM,
  RequestedModelStub,
  StubContainer,
  STUB_HEAD,
  type ContainerRunner,
  type ModelRunner,
} from "./runners.ts";
import {
  loadFakeSources,
  loadMvpSources,
  REPO_ROOT,
  sha256,
  type Instance,
  type Sources,
} from "./sources.ts";
import { summarizeTranscript, type Finding, type SkillFinding, type VerdictValue } from "./transcript.ts";

export const MODEL: Model = DEFAULT_MODEL;
const EFFORTS = ["low", "medium", "high"];
const FAKE_EFFORT = "medium";
const FAKE_BUDGET = "5";
const REDACTED = "[REDACTED]";
const FAKE_TRANSCRIPT_PATH = join(import.meta.dirname, "fixtures", "transcript.jsonl");
const NOTE_KEY = "authors_note";
const USAGE =
  `usage: node harness/run-review.ts ${CONDITION_USAGE} [--fake | --container-only] [--effort low|medium|high] [--budget-usd <n>] [--model ${MODELS.join("|")}] [--arm ${ARMS.join("|")}] [--print-prompt] [--out <dir>]`;

export type Mode = "fake" | "container-only" | "real";

export interface ReviewOptions {
  mode: Mode;
  effort: string | null;
  budgetUsd: string | null;
  outDir: string;
  arm?: Arm;
  model?: Model;
  printPrompt?: boolean;
  context?: RunContext;
}

export interface RunContext {
  label_stratum: string;
  run_order: number;
  repeat_number: number;
  vm_type: string;
  seed: number;
}

export interface ReviewDeps {
  env: NodeJS.ProcessEnv;
  proxyUrl?: string;
  loadSources(): Promise<Sources>;
  createRunners(sources: Sources): { container: ContainerRunner; model: ModelRunner };
}

export interface RunRecord extends Partial<RunContext> {
  mode: Mode;
  instance_id: string | null;
  agent_id: string | null;
  patch_sha256: string | null;
  prompt_sha256: string | null;
  environment_sha256: string | null;
  effort: string | null;
  arm: Arm;
  authors_note: string | null;
  budget_usd: number | null;
  model: string | null;
  model_usage_models: string[] | null;
  cli_version: string | null;
  image_digest: string | null;
  platform: string;
  verdict: VerdictValue | null;
  feedback: string | null;
  findings: Finding[] | null;
  stop_reason: string;
  turns: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  thinking_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  wall_ms: number | null;
  tool_calls: number | null;
  effective_effort: string | null;
  thinking_blocks: number | null;
  thinking_chars: number | null;
  test_files_written: number | null;
  bash_commands: number | null;
  bash_test_runs: number | null;
  bash_inline_code_runs: number | null;
  bash_test_files_written: number | null;
  bash_failures: number | null;
  skill_invocations: number | null;
  skill_args: string | null;
  skill_findings: SkillFinding[] | null;
  skill_verdict: VerdictValue | null;
  skill_failure: string | null;
  transcript_path: string | null;
  command: string[] | null;
  preflight: PreflightResult | null;
}

export interface CliOptions extends ReviewOptions {
  names: ResourceNames;
}

export class UsageError extends Error {}

export function parseCli(args: string[], env: NodeJS.ProcessEnv): CliOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        condition: { type: "string" },
        fake: { type: "boolean", default: false },
        "container-only": { type: "boolean", default: false },
        effort: { type: "string" },
        "budget-usd": { type: "string" },
        arm: { type: "string", default: CONTROL_ARM },
        model: { type: "string", default: MODEL },
        "print-prompt": { type: "boolean", default: false },
        out: { type: "string" },
      },
    }));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (values.fake && values["container-only"]) {
    throw new UsageError("--fake and --container-only are mutually exclusive");
  }
  const condition = parseCondition(values.condition);
  if (condition === null) {
    throw new UsageError(CONDITION_REFUSAL);
  }
  const mode: Mode = values.fake ? "fake" : values["container-only"] ? "container-only" : "real";
  const effort = values.effort ?? null;
  const budgetUsd = values["budget-usd"] ?? null;

  if (effort !== null && !EFFORTS.includes(effort)) {
    throw new UsageError(`--effort must be one of ${EFFORTS.join(", ")}`);
  }
  if (budgetUsd !== null && !/^\d+(\.\d+)?$/.test(budgetUsd)) {
    throw new UsageError("--budget-usd must be a positive number");
  }
  if (budgetUsd !== null && Number(budgetUsd) <= 0) {
    throw new UsageError("--budget-usd must be a positive number");
  }
  if (values.out === "") {
    throw new UsageError("--out must not be empty");
  }
  const arm = values.arm;
  if (!isArm(arm)) {
    throw new UsageError(`--arm must be one of ${ARMS.join(", ")}`);
  }
  const model = values.model;
  if (!isModel(model)) {
    throw new UsageError(`--model must be one of ${MODELS.join(", ")}`);
  }
  if (values["print-prompt"] && mode !== "fake") {
    throw new UsageError("--print-prompt needs --fake");
  }
  if (mode === "real") {
    const missing = [
      ...(env[API_KEY_ENV] ? [] : [API_KEY_ENV]),
      ...(effort === null ? ["--effort"] : []),
      ...(budgetUsd === null ? ["--budget-usd"] : []),
    ];
    if (missing.length > 0) {
      throw new UsageError(`a real run requires ${missing.join(", ")}`);
    }
  }
  const names = resourceNames(condition, new Date().toISOString().replace(/[:.]/g, "-"));
  return {
    mode,
    effort,
    budgetUsd,
    outDir: resolve(values.out ?? join(REPO_ROOT, names.reviewOutDir(mode))),
    arm,
    model,
    printPrompt: values["print-prompt"],
    names,
  };
}

export function claudeArgv(effort: string, budgetUsd: string, model: Model = MODEL, arm: Arm = CONTROL_ARM): string[] {
  const { tools } = armProfile(arm);
  return [
    "claude",
    "-p",
    "--model",
    model,
    "--effort",
    effort,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--output-format",
    "stream-json",
    "--verbose",
    "--thinking-display",
    "summarized",
    "--no-session-persistence",
    "--max-budget-usd",
    budgetUsd,
    "--tools",
    tools,
    "--allowedTools",
    tools,
  ];
}

export function renderPrompt(brief: Brief, arm: Arm = CONTROL_ARM): string {
  return fillBriefSlot(readFileSync(armProfile(arm).promptPath, "utf8"), brief);
}

export function armPrompt(commitSha: string, problemStatement: string, arm: Arm, diff = ""): string {
  const profile = armProfile(arm);
  const brief = buildBrief({
    commitSha,
    environmentPath: profile.includeEnvironment ? ENVIRONMENT_PATH : undefined,
    problemStatement: profile.includeSpec ? problemStatement : undefined,
    diff: profile.includeDiff ? diff : undefined,
    authorsNote: profile.authorsNote,
  });
  return renderPrompt(brief, arm);
}

export function promptChecks(prompt: string, problemStatement: string, arm: Arm): PreflightCheck[] {
  const checks = [authorsNoteCheck(prompt, arm)];
  if (!armProfile(arm).includeSpec) checks.push(specWithheldCheck(prompt, problemStatement));
  return checks;
}

export function authorsNoteCheck(prompt: string, arm: Arm): PreflightCheck {
  const note = authorsNote(arm);
  if (note === null) {
    const passed = !prompt.includes(NOTE_KEY);
    return { id: NOTE_KEY, passed, detail: `arm ${arm}: prompt ${passed ? "has no" : "holds"} ${NOTE_KEY}` };
  }
  const count = prompt.split(note).length - 1;
  return { id: NOTE_KEY, passed: count === 1, detail: `arm ${arm}: the note appears ${count} time(s)` };
}

export function foreignModels(requested: string, initModel: string | null, usageModels: string[] | null): string[] {
  const observed = new Set([...(initModel === null ? [] : [initModel]), ...(usageModels ?? [])]);
  return [...observed].filter((model) => model !== requested).sort();
}

function blankRecord(options: ReviewOptions): RunRecord {
  return {
    mode: options.mode,
    instance_id: null,
    agent_id: null,
    patch_sha256: null,
    prompt_sha256: null,
    environment_sha256: null,
    effort: options.effort,
    arm: options.arm ?? CONTROL_ARM,
    authors_note: authorsNote(options.arm ?? CONTROL_ARM),
    budget_usd: options.budgetUsd === null ? null : Number(options.budgetUsd),
    model: options.model ?? MODEL,
    model_usage_models: null,
    cli_version: null,
    image_digest: null,
    platform: PLATFORM,
    verdict: null,
    feedback: null,
    findings: null,
    stop_reason: "not_started",
    turns: null,
    input_tokens: null,
    output_tokens: null,
    thinking_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_usd: null,
    wall_ms: null,
    tool_calls: null,
    effective_effort: null,
    thinking_blocks: null,
    thinking_chars: null,
    test_files_written: null,
    bash_commands: null,
    bash_test_runs: null,
    bash_inline_code_runs: null,
    bash_test_files_written: null,
    bash_failures: null,
    skill_invocations: null,
    skill_args: null,
    skill_findings: null,
    skill_verdict: null,
    skill_failure: null,
    transcript_path: null,
    command: null,
    preflight: null,
    ...options.context,
  };
}

export async function runReview(
  options: ReviewOptions,
  deps: ReviewDeps,
): Promise<{ record: RunRecord; exitCode: number }> {
  const secret = deps.env[API_KEY_ENV];
  const scrub = (text: string): string => (secret ? text.split(secret).join(REDACTED) : text);
  mkdirSync(options.outDir, { recursive: true });

  const record = blankRecord(options);
  let exitCode = 1;
  let container: ContainerRunner | null = null;
  try {
    const sources = await deps.loadSources();
    record.instance_id = sources.instance.instance_id;
    record.agent_id = sources.instance.agent_id;
    record.patch_sha256 = sha256(sources.patch);
    record.image_digest = sources.instance.image_digest;
    const environment = environmentFileFor(sources.instance.instance_id);

    const runners = deps.createRunners(sources);
    container = runners.container;
    await container.start();
    record.preflight = await applyAndPreflight(container, {
      baseCommit: sources.instance.base_commit,
      patch: sources.patch,
      testPatch: sources.testPatch,
      goldPatch: sources.goldPatch,
      hostEnv: deps.env,
    });
    if (deps.proxyUrl && record.preflight.passed) {
      const network = await networkPreflight(container, deps.proxyUrl);
      record.preflight = {
        passed: network.every((check) => check.passed),
        checks: [...record.preflight.checks, ...network],
      };
    }

    if (record.preflight.passed) {
      const imports = await checkReviewerImports(container);
      record.preflight.checks.push(imports);
      record.preflight.passed = imports.passed;
    }
    let commitSha = "";
    if (record.preflight.passed) {
      const installed = await installEnvironment(container, environment);
      record.preflight.checks.push(...installed.checks);
      record.preflight.passed = installed.checks.every((check) => check.passed);
      record.environment_sha256 = installed.written ? sha256(environment) : null;
      commitSha = installed.commitSha ?? "";
    }
    if (record.preflight.passed && armProfile(record.arm).upstreamBase) {
      const upstream = await setUpstreamBase(container, sources.patch);
      record.preflight.checks.push(upstream);
      record.preflight.passed = upstream.passed;
    }
    let diff = "";
    if (record.preflight.passed && armProfile(record.arm).includeDiff) {
      const fetched = await commitDiff(container, sources.patch);
      record.preflight.checks.push(fetched.check);
      record.preflight.passed = fetched.check.passed;
      diff = fetched.diff;
    }
    const version = record.preflight.checks.find((check) => check.id === "cli_version");
    record.cli_version = version?.detail.split(" ")[0] || null;

    let prompt = "";
    if (record.preflight.passed && options.mode !== "container-only") {
      prompt = armPrompt(commitSha, sources.problemStatement, record.arm, diff);
      const checks = promptChecks(prompt, sources.problemStatement, record.arm);
      record.preflight.checks.push(...checks);
      record.preflight.passed = checks.every((check) => check.passed);
    }

    const failed = record.preflight.checks.find((check) => !check.passed);
    if (failed) {
      record.stop_reason = `preflight_failed:${failed.id}`;
    } else if (options.mode === "container-only") {
      record.stop_reason = "container_only_stopped_before_model";
      exitCode = 0;
    } else {
      const requested = options.model ?? MODEL;
      const argv = claudeArgv(options.effort ?? "", options.budgetUsd ?? "", requested, record.arm);
      record.command = runners.model.command(argv);
      record.prompt_sha256 = sha256(prompt);
      const result = await runners.model.run(argv, prompt);
      const transcriptPath = join(options.outDir, "transcript.jsonl");
      const transcript = scrub(result.stdout);
      writeFileSync(transcriptPath, transcript);
      writeFileSync(join(options.outDir, "stderr.log"), scrub(result.stderr));
      const { duration_ms, ...summary } = summarizeTranscript(
        transcript,
        result.exitCode,
        result.timedOut,
      );
      Object.assign(record, summary, {
        model: summary.model ?? record.model,
        cli_version: summary.cli_version ?? record.cli_version,
        wall_ms: duration_ms ?? result.wallMs,
        transcript_path: transcriptPath,
      });
      const foreign = foreignModels(requested, summary.model, summary.model_usage_models);
      if (foreign.length > 0) {
        Object.assign(record, {
          verdict: null,
          feedback: null,
          findings: null,
          stop_reason: `model_mismatch:${foreign.join(",")}`,
        });
      }
      exitCode = record.verdict === null ? 1 : 0;
    }
  } catch (error) {
    record.stop_reason = `setup_failed:${(error as Error).message}`;
    exitCode = 1;
  } finally {
    try {
      await container?.stop();
    } catch (error) {
      console.error(scrub(`container cleanup failed: ${(error as Error).message}`));
    }
  }

  writeFileSync(join(options.outDir, "run.json"), scrub(`${JSON.stringify(record, null, 2)}\n`));
  return { record: JSON.parse(scrub(JSON.stringify(record))) as RunRecord, exitCode };
}

function fakeDeps(): ReviewDeps {
  return {
    env: {},
    loadSources: async () => loadFakeSources(),
    createRunners: (sources) => ({
      container: new StubContainer(sources.instance.base_commit, patchPaths(sources.patch), [], sources.patch),
      model: new RequestedModelStub(readFileSync(FAKE_TRANSCRIPT_PATH, "utf8")),
    }),
  };
}

export function reviewImageRefs(names: ResourceNames, instance: Instance): { tag: string; baseImage: string } {
  const digest = instance.image_digest.replace("sha256:", "").slice(0, 12);
  return {
    tag: names.reviewImage(instance.instance_id, digest),
    baseImage: `${instance.image}@${instance.image_digest}`,
  };
}

export function dockerRunners(
  names: ResourceNames,
  instance: Instance,
  network?: string,
  modelEnv: Record<string, string> = {},
): { container: DockerContainer; model: DockerModel } {
  const { tag, baseImage } = reviewImageRefs(names, instance);
  const name = names.reviewContainer(randomBytes(4).toString("hex"));
  const container = new DockerContainer(name, baseImage, tag, network);
  return { container, model: new DockerModel(container.name, modelEnv) };
}

export function dockerDeps(
  env: NodeJS.ProcessEnv,
  names: ResourceNames,
  networkName: string,
  { proxyUrl, modelEnv }: Pick<ClosedNetwork, "proxyUrl" | "modelEnv">,
  loadSources: () => Promise<Sources> = () => loadMvpSources(),
): ReviewDeps {
  return {
    env,
    proxyUrl,
    loadSources,
    createRunners: ({ instance }) => dockerRunners(names, instance, networkName, modelEnv),
  };
}

export async function reviewInClosedNetwork(
  options: ReviewOptions,
  names: ResourceNames,
  env: NodeJS.ProcessEnv,
  { host, loadSources }: { host?: DockerHost; loadSources?: () => Promise<Sources> } = {},
): Promise<{ record: RunRecord; exitCode: number }> {
  const name = names.reviewNetwork(randomBytes(4).toString("hex"));
  let network: ClosedNetwork;
  try {
    network = await openClosedNetwork({ name, outDir: options.outDir, env }, host);
  } catch (error) {
    return runReview(options, {
      env,
      loadSources: () => Promise.reject(error),
      createRunners: () => {
        throw error;
      },
    });
  }
  try {
    return await runReview(options, dockerDeps(env, names, name, network, loadSources));
  } finally {
    try {
      await network.close();
    } catch (error) {
      console.error(scrubber(env)(`network cleanup failed: ${(error as Error).message}`));
    }
  }
}

function printFakePrompt(arm: Arm): number {
  const { problemStatement, patch } = loadFakeSources();
  const prompt = armPrompt(STUB_HEAD, problemStatement, arm, patch);
  const failed = promptChecks(prompt, problemStatement, arm).find((check) => !check.passed);
  if (failed) {
    console.error(`refused: ${failed.detail}`);
    return 1;
  }
  process.stdout.write(prompt);
  return 0;
}

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCli(process.argv.slice(2), process.env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (options.printPrompt) return printFakePrompt(options.arm ?? CONTROL_ARM);
  if (options.mode === "fake") {
    options = {
      ...options,
      effort: options.effort ?? FAKE_EFFORT,
      budgetUsd: options.budgetUsd ?? FAKE_BUDGET,
    };
  }
  const { record, exitCode } =
    options.mode === "fake"
      ? await runReview(options, fakeDeps())
      : await reviewInClosedNetwork(options, options.names, process.env);
  console.log(
    `${join(options.outDir, "run.json")} verdict=${record.verdict} stop_reason=${record.stop_reason}`,
  );
  return exitCode;
}

if (import.meta.main) {
  process.exitCode = await main();
}
