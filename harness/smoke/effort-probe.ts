import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";

import { isModel, MODELS, type Model } from "../models.ts";
import { claudeArgv, MODEL } from "../run-review.ts";

const EFFORTS = ["low", "medium", "high"];
const LOOPBACK = "127.0.0.1";
const MESSAGES_PATH_SUFFIX = "/v1/messages";
const DUMMY_API_KEY = "sk-ant-dummy-probe";
const PROBE_BUDGET_USD = "1";
const PROBE_PROMPT = "Reply with the word ok.";
const DEFAULT_TIMEOUT_MS = 60_000;
const PROMPT_CONTENT_KEYS = new Set(["messages", "system"]);
const REFUSAL_BODY = JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: "effort probe refuses every request" },
});
const USAGE =
  `usage: node harness/smoke/effort-probe.ts --run [--model ${MODELS.join("|")}]\n` +
  `Spawns the real claude CLI on the model, ${MODEL} by default, at each effort against a loopback capture server. Nothing runs without --run.`;

export interface EffortField {
  path: string;
  value: unknown;
}

export interface ProbeResult {
  effort: string;
  captured: boolean;
  effort_fields: EffortField[];
  thinking: unknown;
  requested_model: string;
  model: string | null;
}

export interface ProbeChild {
  closed: Promise<void>;
  kill(): void;
}

export type ProbeSpawn = (
  argv: string[],
  options: { env: Record<string, string>; stdin: string },
) => ProbeChild;

export interface ProbeDeps {
  spawn: ProbeSpawn;
  timeoutMs?: number;
}

export interface CliDeps extends ProbeDeps {
  out(line: string): void;
  err(line: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childPath(parent: string, key: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return parent === "" ? key : `${parent}.${key}`;
  return `${parent}[${JSON.stringify(key)}]`;
}

function collectEffortFields(value: unknown, path: string, found: EffortField[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectEffortFields(item, `${path}[${index}]`, found));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (path === "" && PROMPT_CONTENT_KEYS.has(key)) continue;
    const keyPath = childPath(path, key);
    if (key.toLowerCase().includes("effort")) found.push({ path: keyPath, value: child });
    collectEffortFields(child, keyPath, found);
  }
}

function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function summarize(effort: string, requestedModel: string, raw: string): ProbeResult {
  const body = parseBody(raw);
  const effortFields: EffortField[] = [];
  collectEffortFields(body, "", effortFields);
  const fields = isRecord(body) ? body : {};
  return {
    effort,
    captured: true,
    effort_fields: effortFields,
    thinking: fields.thinking ?? null,
    requested_model: requestedModel,
    model: typeof fields.model === "string" ? fields.model : null,
  };
}

function isMessagesPost(request: IncomingMessage): boolean {
  const { pathname } = new URL(request.url ?? "/", `http://${LOOPBACK}`);
  return request.method === "POST" && pathname.endsWith(MESSAGES_PATH_SUFFIX);
}

function refuse(response: ServerResponse, onSent?: () => void): void {
  response.writeHead(400, { "content-type": "application/json", connection: "close" });
  response.end(REFUSAL_BODY, onSent);
}

function listenOnLoopback(server: Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      server.off("error", reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function childEnv(baseUrl: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: DUMMY_API_KEY,
  };
}

export async function probeEffort(effort: string, deps: ProbeDeps, model: Model = MODEL): Promise<ProbeResult> {
  let result: ProbeResult = {
    effort,
    captured: false,
    effort_fields: [],
    thinking: null,
    requested_model: model,
    model: null,
  };
  let claimed = false;
  let onCaptured = (): void => {};
  const capturedSignal = new Promise<void>((resolve) => {
    onCaptured = resolve;
  });

  const server = createServer((request, response) => {
    if (!isMessagesPost(request)) {
      response.writeHead(404, { connection: "close" });
      response.end();
      return;
    }
    if (claimed) {
      refuse(response);
      return;
    }
    claimed = true;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      result = summarize(effort, model, Buffer.concat(chunks).toString("utf8"));
      refuse(response, onCaptured);
    });
  });

  const { port } = await listenOnLoopback(server);
  let timer: NodeJS.Timeout | undefined;
  try {
    const child = deps.spawn(claudeArgv(effort, PROBE_BUDGET_USD, model), {
      env: childEnv(`http://${LOOPBACK}:${port}`),
      stdin: PROBE_PROMPT,
    });
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    });
    try {
      await Promise.race([capturedSignal, child.closed, timedOut]);
    } finally {
      child.kill();
    }
    return result;
  } finally {
    clearTimeout(timer);
    await closeServer(server);
  }
}

const spawnClaude: ProbeSpawn = ([command, ...args], { env, stdin }) => {
  const child = spawn(command as string, args, { env, stdio: ["pipe", "ignore", "inherit"] });
  child.stdin.on("error", () => {});
  child.stdin.end(stdin);
  return {
    closed: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    }),
    kill: () => {
      child.kill("SIGKILL");
    },
  };
};

function parseProbeCli(argv: string[]): Model | null {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { run: { type: "boolean", default: false }, model: { type: "string", default: MODEL } },
    });
    return values.run && isModel(values.model) ? values.model : null;
  } catch {
    return null;
  }
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const model = parseProbeCli(argv);
  if (model === null) {
    deps.err(USAGE);
    return 2;
  }
  const results: ProbeResult[] = [];
  for (const effort of EFFORTS) {
    const result = await probeEffort(effort, deps, model);
    results.push(result);
    deps.out(JSON.stringify(result));
  }
  const missing = results.filter((result) => !result.captured).map((result) => result.effort);
  if (missing.length > 0) {
    deps.err(`no request captured at: ${missing.join(", ")}`);
    return 1;
  }
  const mismatched = results.filter((result) => result.model !== model);
  if (mismatched.length > 0) {
    deps.err(`captured model differs from ${model} at: ${mismatched.map((result) => `${result.effort} (${result.model})`).join(", ")}`);
    return 1;
  }
  const distinct = new Set(results.map((result) => JSON.stringify(result.effort_fields)));
  if (distinct.size !== results.length) {
    deps.err("effort_fields are not distinct across the efforts");
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), {
    spawn: spawnClaude,
    out: console.log,
    err: console.error,
  });
}
