import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { fillBriefSlot, type Brief } from "../brief.ts";
import { applyAndPreflight, checkReviewerImports, type PreflightCheck } from "../preflight.ts";
import { PLATFORM, REVIEWER_ENV, spawnCollect, type ContainerRunner, type ExecResult } from "../runners.ts";
import { loadSources, sha256, type Instance } from "../sources.ts";

const USAGE = "usage: node harness/subagent/prepare.ts --patches <json> --models <a,b,...> --root <dir> --out <plan.json>";
const DOCKER_TIMEOUT_MS = 30 * 60_000;
const PROMPT_TEMPLATE = join(import.meta.dirname, "..", "review-prompt.md");
// The reviewer container holds no Claude Code CLI, so the CLI version check does not apply.
const NOT_APPLICABLE = new Set(["cli_version"]);
// Owner may traverse but not list, so a reviewer cannot find its siblings' workspaces.
const ROOT_MODE = 0o311;

type PatchEntry = Instance & { label_stratum: string };

export interface PlanEntry {
  id: string;
  model: string;
  instance_id: string;
  agent_id: string;
  label_stratum: string;
  workspace: string;
  container: string;
  image: string;
  commit_sha: string;
  prompt_sha256: string;
  environment_sha256: string;
  log: string;
  task_prompt: string;
  prepared_at: string;
}

async function docker(args: string[]): Promise<string> {
  const result = await spawnCollect("docker", args, { timeoutMs: DOCKER_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(`docker ${args.slice(0, 2).join(" ")} exited ${result.code}: ${result.stderr.slice(-400)}`);
  return result.stdout;
}

class Container implements ContainerRunner {
  readonly name: string;
  private readonly runArgs: string[];

  constructor(name: string, runArgs: string[]) {
    this.name = name;
    this.runArgs = runArgs;
  }

  async start(): Promise<void> {
    await docker(["run", "-d", "--name", this.name, ...this.runArgs]);
  }

  exec(argv: string[], options: { stdin?: string } = {}): Promise<ExecResult> {
    return spawnCollect("docker", ["exec", "-i", this.name, ...argv], { stdin: options.stdin, timeoutMs: DOCKER_TIMEOUT_MS });
  }

  async stop(): Promise<void> {
    await docker(["rm", "-f", this.name]);
  }
}

const hex = (): string => randomBytes(4).toString("hex");

function requireChecks(stage: string, checks: PreflightCheck[]): void {
  const failed = checks.filter((check) => !check.passed && !NOT_APPLICABLE.has(check.id));
  if (failed.length > 0) throw new Error(`${stage}: ${failed.map((c) => `${c.id} (${c.detail})`).join("; ")}`);
}

// macOS clones with APFS clonefile; elsewhere cp reflinks where the filesystem allows it.
export function cloneArgs(platform: NodeJS.Platform, from: string, to: string): string[] {
  return platform === "darwin" ? ["-c", "-pR", from, to] : ["-a", "--reflink=auto", from, to];
}

export function taskBrief(commitSha: string, workspace: string, problemStatement: string): Brief {
  return {
    commit_sha: commitSha,
    repo_path: join(workspace, "testbed"),
    environment_path: join(workspace, "review", "environment.txt"),
    spec: problemStatement,
  };
}

export function environmentFile(workspace: string): string {
  const tb = join(workspace, "bin", "tb");
  return [
    "language: Python",
    `container: the project's Python environment runs in a Docker container with no network; ${tb} '<command>' runs a shell command in /testbed inside it`,
    `files: repo_path on this machine is /testbed in the container, and ${join(workspace, "tmp")} on this machine is /tmp in the container; a change on either side shows on both`,
    "interpreter: python, first on PATH in the container",
    "import_path: PYTHONPATH=/testbed in the container",
    `run_tests: ${tb} 'python tests/runtests.py <test_label>'`,
    "network: none, apart from the model API",
    "",
  ].join("\n");
}

export function tbScript(container: string, log: string): string {
  return [
    "#!/bin/sh",
    `printf '%s\\t%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(printf '%s' "$*" | tr '\\n\\t' '  ')" >> '${log}'`,
    `exec docker exec -i -w /testbed ${container} bash -c "$*"`,
    "",
  ].join("\n");
}

export function wrapperPrompt(workspace: string): string {
  const review = join(workspace, "review");
  return [
    `Your task is in ${join(review, "task.md")}. Read that file first and follow it exactly: it is a code review, and it sets the verdict rules and the output format.`,
    "",
    "Rules:",
    `- Work only inside ${workspace}. Do not list, read or search any path outside it.`,
    "- Do not use web search, web fetch, a browser, MCP tools or subagents. Use only what the task, the repository and its environment give you.",
    `- Run Python and tests only through ${join(workspace, "bin", "tb")}, as ${join(review, "environment.txt")} explains.`,
    "",
    `When you finish, write your final response, the complete text the task asks for ending with its fenced toon block, to ${join(review, "final.md")}. Then reply with one line: the verdict, pass or fail.`,
  ].join("\n");
}

async function reviewChecks(container: Container, commitSha: string): Promise<PreflightCheck[]> {
  const git = (...args: string[]) => container.exec(["git", "-C", "/testbed", ...args]);
  const imports = await checkReviewerImports(container);
  const status = await git("status", "--porcelain");
  const head = await git("rev-parse", "HEAD");
  const beyond = await git("rev-list", "--all", "--reflog", "^HEAD");
  const online = await container.exec(["python", "-c", "import socket; socket.create_connection(('1.1.1.1', 53), 3)"]);
  return [
    imports,
    { id: "tree_clean", passed: status.code === 0 && status.stdout.trim() === "", detail: `${status.stdout}${status.stderr}`.slice(0, 300) },
    { id: "head_is_candidate_commit", passed: head.stdout.trim() === commitSha, detail: `${head.stdout}${head.stderr}`.slice(0, 300) },
    { id: "no_commits_beyond_head", passed: beyond.code === 0 && beyond.stdout.trim() === "", detail: beyond.stdout.slice(0, 300) },
    { id: "container_offline", passed: online.code !== 0, detail: online.stderr.trim().split("\n").at(-1) ?? "" },
  ];
}

async function stageTestbed(entry: PatchEntry, image: string, target: string): Promise<{ commitSha: string; problemStatement: string }> {
  const sources = await loadSources(entry);
  const stage = new Container(`crx-stage-${hex()}`, ["--platform", PLATFORM, "--network", "none", image, "sleep", "infinity"]);
  await stage.start();
  try {
    const preflight = await applyAndPreflight(stage, {
      baseCommit: entry.base_commit,
      patch: sources.patch,
      testPatch: sources.testPatch,
      goldPatch: sources.goldPatch,
      hostEnv: process.env,
    });
    requireChecks(`${entry.instance_id} preflight`, preflight.checks);
    requireChecks(`${entry.instance_id} imports`, [await checkReviewerImports(stage)]);
    const commitSha = (await stage.exec(["git", "-C", "/testbed", "rev-parse", "HEAD"])).stdout.trim();
    mkdirSync(dirname(target), { recursive: true });
    await docker(["cp", `${stage.name}:/testbed`, target]);
    return { commitSha, problemStatement: sources.problemStatement };
  } finally {
    await stage.stop();
  }
}

async function prepareAll(entries: PatchEntry[], models: string[], root: string, plan: PlanEntry[]): Promise<void> {
  const template = readFileSync(PROMPT_TEMPLATE, "utf8");
  for (const entry of entries) {
    const image = `${entry.image}@${entry.image_digest}`;
    console.error(`${entry.instance_id}: pulling and staging`);
    await docker(["pull", "--quiet", "--platform", PLATFORM, image]);
    const staged = join(root, "stage", hex(), "testbed");
    const { commitSha, problemStatement } = await stageTestbed(entry, image, staged);

    for (const model of models) {
      const id = hex();
      const workspace = join(root, id);
      for (const dir of ["review", "bin", "tmp"]) mkdirSync(join(workspace, dir), { recursive: true });
      execFileSync("cp", cloneArgs(process.platform, staged, join(workspace, "testbed")));
      const container = `crx-${id}`;
      const log = join(root, "logs", `${id}.tsv`);
      const environment = environmentFile(workspace);
      writeFileSync(join(workspace, "review", "environment.txt"), environment);
      const prompt = fillBriefSlot(template, taskBrief(commitSha, workspace, problemStatement));
      writeFileSync(join(workspace, "review", "task.md"), prompt);
      writeFileSync(join(workspace, "bin", "tb"), tbScript(container, log), { mode: 0o755 });
      const review = new Container(container, [
        "--platform", PLATFORM, "--network", "none",
        ...REVIEWER_ENV.flatMap((assignment) => ["-e", assignment]),
        "-v", `${join(workspace, "testbed")}:/testbed`,
        "-v", `${join(workspace, "tmp")}:/tmp`,
        "-w", "/testbed",
        image, "sleep", "infinity",
      ]);
      await review.start();
      plan.push({
        id,
        model,
        instance_id: entry.instance_id,
        agent_id: entry.agent_id,
        label_stratum: entry.label_stratum,
        workspace,
        container,
        image,
        commit_sha: commitSha,
        prompt_sha256: sha256(prompt),
        environment_sha256: sha256(environment),
        log,
        task_prompt: wrapperPrompt(workspace),
        prepared_at: new Date().toISOString(),
      });
      requireChecks(`${entry.instance_id} ${model} review container`, await reviewChecks(review, commitSha));
      console.error(`  ${model}: ${id} ready`);
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { patches: { type: "string" }, models: { type: "string" }, root: { type: "string" }, out: { type: "string" } },
  });
  if (!values.patches || !values.models || !values.root || !values.out) {
    console.error(USAGE);
    process.exit(2);
  }
  const entries = JSON.parse(readFileSync(values.patches, "utf8")) as PatchEntry[];
  const models = values.models.split(",").map((m) => m.trim()).filter(Boolean);
  const root = resolve(values.root);
  mkdirSync(join(root, "logs"), { recursive: true });
  chmodSync(root, 0o755);
  const plan: PlanEntry[] = [];
  let failure: Error | null = null;
  try {
    await prepareAll(entries, models, root, plan);
  } catch (error) {
    failure = error as Error;
  }
  chmodSync(root, ROOT_MODE);
  mkdirSync(dirname(resolve(values.out)), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify(plan, null, 2)}\n`);
  if (failure !== null) {
    console.error(`stopped after ${plan.length} containers; ${values.out} lists them for teardown.ts`);
    throw failure;
  }
  console.error(`${plan.length} reviews prepared; plan in ${values.out}`);
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
