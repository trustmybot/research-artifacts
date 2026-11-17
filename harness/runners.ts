import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export const PLATFORM = "linux/amd64";
export const API_KEY_ENV = "ANTHROPIC_API_KEY";
export const FIXED_AUTHOR_NAME = "Candidate Author";
export const FIXED_AUTHOR_EMAIL = "candidate@example.invalid";
export const FIXED_EPOCH_SECONDS = 946684800;
export const FIXED_MESSAGE = "Apply candidate patch";
export const FIELD_SEPARATOR = "\x1f";
export const ENVIRONMENT_DIR = "/review";
export const ENVIRONMENT_PATH = `${ENVIRONMENT_DIR}/environment.txt`;
export const TESTBED_BIN = "/opt/miniconda3/envs/testbed/bin";
export const REVIEWER_PYTHON = `${TESTBED_BIN}/python`;
const IMAGE_PATH = "/opt/miniconda3/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const REVIEWER_ENV = [
  "PYTHONPATH=/testbed",
  `PATH=${TESTBED_BIN}:${IMAGE_PATH}`,
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
];

const EXEC_TIMEOUT_MS = 30 * 60_000;
const MODEL_TIMEOUT_MS = 60 * 60_000;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ContainerRunner {
  start(): Promise<void>;
  exec(argv: string[], options?: { stdin?: string }): Promise<ExecResult>;
  stop(): Promise<void>;
}

export interface ModelResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  wallMs: number;
  timedOut?: boolean;
}

export interface ModelRunner {
  command(claudeArgv: string[]): string[];
  run(claudeArgv: string[], prompt: string): Promise<ModelResult>;
}

export const STDIO_GRACE_MS = 2_000;

// A grandchild that inherited stdout or stderr keeps the pipes open after the
// child exits, so `close` alone may never fire.
export function onSettled(
  child: ChildProcess,
  settle: (code: number | null, signal: NodeJS.Signals | null) => void,
  graceMs: number = STDIO_GRACE_MS,
): void {
  let settled = false;
  let grace: NodeJS.Timeout | undefined;
  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(grace);
    settle(code, signal);
  };
  child.once("close", finish);
  child.once("exit", (code, signal) => {
    grace = setTimeout(() => {
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      finish(code, signal);
    }, graceMs);
  });
}

export function spawnCollect(
  command: string,
  args: string[],
  options: { stdin?: string; timeoutMs: number },
): Promise<ExecResult & { timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: options.timeoutMs,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", () => {});
    child.on("error", reject);
    onSettled(child, (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut: child.killed,
      });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

export function dockerBuildArgs(baseImage: string, tag: string, contextDir: string): string[] {
  return [
    "build",
    "--platform",
    PLATFORM,
    "--build-arg",
    `BASE_IMAGE=${baseImage}`,
    "-t",
    tag,
    contextDir,
  ];
}

export function dockerImageRemoveArgs(tag: string, baseImage: string): string[] {
  return ["image", "rm", tag, baseImage];
}

export function dockerRunArgs(name: string, tag: string, network?: string): string[] {
  const networkArgs = network ? ["--network", network] : [];
  return ["run", "-d", "--platform", PLATFORM, ...networkArgs, "--name", name, tag, "sleep", "infinity"];
}

export function dockerModelExecArgs(
  name: string,
  claudeArgv: string[],
  extraEnv: Record<string, string> = {},
): string[] {
  const assignments = [...REVIEWER_ENV, ...Object.entries(extraEnv).map(([key, value]) => `${key}=${value}`)];
  const envArgs = assignments.flatMap((assignment) => ["--env", assignment]);
  return ["exec", "-i", "--env", API_KEY_ENV, ...envArgs, "-w", "/testbed", name, ...claudeArgv];
}

export class DockerContainer implements ContainerRunner {
  readonly name: string;
  private readonly baseImage: string;
  private readonly tag: string;
  private readonly network?: string;

  constructor(name: string, baseImage: string, tag: string, network?: string) {
    this.name = name;
    this.baseImage = baseImage;
    this.tag = tag;
    this.network = network;
  }

  runArgs(): string[] {
    return dockerRunArgs(this.name, this.tag, this.network);
  }

  private async docker(args: string[]): Promise<void> {
    const result = await spawnCollect("docker", args, { timeoutMs: EXEC_TIMEOUT_MS });
    if (result.code !== 0) {
      throw new Error(`docker ${args[0]} exited ${result.code}: ${result.stderr.slice(-500)}`);
    }
  }

  async start(): Promise<void> {
    const contextDir = join(import.meta.dirname, "docker");
    await this.docker(dockerBuildArgs(this.baseImage, this.tag, contextDir));
    await this.docker(this.runArgs());
  }

  exec(argv: string[], options: { stdin?: string } = {}): Promise<ExecResult> {
    return spawnCollect("docker", ["exec", "-i", this.name, ...argv], {
      stdin: options.stdin,
      timeoutMs: EXEC_TIMEOUT_MS,
    });
  }

  async stop(): Promise<void> {
    await this.docker(["rm", "-f", this.name]);
  }
}

export class DockerModel implements ModelRunner {
  private readonly containerName: string;
  private readonly extraEnv: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(
    containerName: string,
    extraEnv: Record<string, string> = {},
    timeoutMs = MODEL_TIMEOUT_MS,
  ) {
    this.containerName = containerName;
    this.extraEnv = extraEnv;
    this.timeoutMs = timeoutMs;
  }

  command(claudeArgv: string[]): string[] {
    return ["docker", ...dockerModelExecArgs(this.containerName, claudeArgv, this.extraEnv)];
  }

  async run(claudeArgv: string[], prompt: string): Promise<ModelResult> {
    const started = Date.now();
    const args = dockerModelExecArgs(this.containerName, claudeArgv, this.extraEnv);
    const result = await spawnCollect("docker", args, {
      stdin: prompt,
      timeoutMs: this.timeoutMs,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
      wallMs: Date.now() - started,
      timedOut: result.timedOut,
    };
  }
}

export class StubModel implements ModelRunner {
  calls = 0;
  private readonly stdout: string;
  private readonly exitCode: number;

  constructor(stdout: string, exitCode = 0) {
    this.stdout = stdout;
    this.exitCode = exitCode;
  }

  command(claudeArgv: string[]): string[] {
    return ["stub-model", ...claudeArgv];
  }

  async run(): Promise<ModelResult> {
    this.calls += 1;
    return { stdout: this.stdout, stderr: "", exitCode: this.exitCode, wallMs: 1 };
  }
}

export function withInitModel(transcript: string, model: string): string {
  return transcript
    .split("\n")
    .map((line) => {
      if (!line.includes('"subtype":"init"')) return line;
      const event = JSON.parse(line) as Record<string, unknown>;
      return event.model === model ? line : JSON.stringify({ ...event, model });
    })
    .join("\n");
}

export class RequestedModelStub extends StubModel {
  async run(claudeArgv: string[] = []): Promise<ModelResult> {
    const result = await super.run();
    const flag = claudeArgv.indexOf("--model");
    const model = flag === -1 ? undefined : claudeArgv[flag + 1];
    return model === undefined ? result : { ...result, stdout: withInitModel(result.stdout, model) };
  }
}

export type StubOverride = [
  commandSubstring: string,
  result: Partial<ExecResult>,
  stdinSubstring?: string,
];

export const STUB_HEAD = "f".repeat(40);
export const STUB_BRANCH = "main";

export class StubContainer implements ContainerRunner {
  readonly calls: string[] = [];
  readonly stdinByCommand: Array<string | undefined> = [];
  started = false;
  stopped = false;
  private readonly baseCommit: string;
  private readonly patchPaths: string[];
  private readonly overrides: StubOverride[];
  private readonly patch: string;
  private committed = false;
  private environmentFile = "";

  constructor(baseCommit: string, patchPaths: string[], overrides: StubOverride[] = [], patch = "") {
    this.baseCommit = baseCommit;
    this.patchPaths = patchPaths;
    this.overrides = overrides;
    this.patch = patch;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  private cleanCurl(command: string): Partial<ExecResult> {
    if (command.includes("--noproxy")) return { code: 7 };
    return command.includes("api.anthropic.com") ? { stdout: "200" } : { code: 56, stdout: "403" };
  }

  private cleanRun(command: string): Partial<ExecResult> {
    if (command.startsWith("curl ")) return this.cleanCurl(command);
    if (command === `cat ${ENVIRONMENT_PATH}`) return { stdout: this.environmentFile };
    const fixed = [FIXED_AUTHOR_NAME, FIXED_AUTHOR_EMAIL, FIXED_EPOCH_SECONDS, FIXED_EPOCH_SECONDS];
    if (command.includes("printenv")) return { code: 1 };
    if (command.includes("claude --version")) return { stdout: "2.1.311 (Claude Code)\n" };
    if (command.includes("import django")) {
      return { stdout: `${REVIEWER_PYTHON} /testbed/django/__init__.py\n` };
    }
    if (command.includes("apply --check -R")) return { code: 1 };
    if (command.includes("symbolic-ref --short -q HEAD")) return { stdout: `${STUB_BRANCH}\n` };
    if (command.includes("rev-parse HEAD")) return { stdout: `${this.committed ? STUB_HEAD : this.baseCommit}\n` };
    if (command.includes("diff --name-only")) return { stdout: `${this.patchPaths.join("\n")}\n` };
    if (command.includes("diff --no-color")) return { stdout: this.patch };
    if (command.includes(" log ")) {
      const head = [STUB_HEAD, this.baseCommit, ...fixed, FIXED_MESSAGE];
      const base = [this.baseCommit, "e".repeat(40), "Upstream", "u@example.invalid", 1, 1, "Base"];
      return { stdout: `${head.join(FIELD_SEPARATOR)}\n${base.join(FIELD_SEPARATOR)}\n` };
    }
    return {};
  }

  async exec(argv: string[], options: { stdin?: string } = {}): Promise<ExecResult> {
    const command = argv.join(" ");
    this.calls.push(command);
    this.stdinByCommand.push(options.stdin);
    const override = this.overrides.find(
      ([substring, , stdinSubstring]) =>
        command.includes(substring) &&
        (stdinSubstring === undefined || options.stdin?.includes(stdinSubstring)),
    );
    if (command.includes(" commit --no-verify")) this.committed = true;
    if (!override && command.includes(`cat > ${ENVIRONMENT_PATH}`)) this.environmentFile = options.stdin ?? "";
    const result = override ? override[1] : this.cleanRun(command);
    return { code: 0, stdout: "", stderr: "", ...result };
  }
}
