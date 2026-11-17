import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { proxyName } from "./gcp/common.ts";
import { API_KEY_ENV, spawnCollect, type ExecResult } from "./runners.ts";
import { PROXY_PORT, PROXY_READY_LINE } from "./smoke/allowlist-proxy.ts";

const DOCKER_TIMEOUT_MS = 5 * 60_000;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
const PROXY_IMAGE = "cr-allowlist-proxy:local";
const PROXY_DOCKERFILE = join(import.meta.dirname, "docker", "proxy.Dockerfile");
const PROXY_CONTEXT = join(import.meta.dirname, "smoke");
const OWNER_LABEL = "cr.owner-pid";
const LEGACY_OWNER_LABEL = "c4-c.owner-pid";
const PROXY_ALIAS = "cr-proxy";

export type DockerCli = (args: string[]) => Promise<ExecResult>;
export type StopFollower = () => Promise<void>;
export type LogFollower = (proxy: string, logPath: string, warn: (message: string) => void) => StopFollower;

export interface DockerHost {
  docker: DockerCli;
  followLogs: LogFollower;
  isAlive: (pid: number) => boolean;
}

export interface ClosedNetworkOptions {
  name: string;
  outDir: string;
  env: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
}

export interface ClosedNetwork {
  proxyUrl: string;
  modelEnv: Record<string, string>;
  close(): Promise<void>;
}

const dockerCli: DockerCli = (args) =>
  spawnCollect("docker", args, { timeoutMs: DOCKER_TIMEOUT_MS });

export function scrubber(env: NodeJS.ProcessEnv): (text: string) => string {
  const secret = env[API_KEY_ENV];
  return (text) => (secret ? text.split(secret).join("[REDACTED]") : text);
}

export function followDockerLogs(
  proxy: string,
  logPath: string,
  warn: (message: string) => void,
  command = "docker",
): StopFollower {
  let logFd: number | undefined;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    logFd = openSync(logPath, "w");
    const child = spawn(command, ["logs", "-f", proxy], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    const stopped = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.on("error", (error) => {
        warn(`proxy log follower failed: ${error.message}`);
        resolve();
      });
    });
    child.unref();
    return async () => {
      if (child.pid) {
        child.ref();
        child.kill("SIGKILL");
      }
      await stopped;
    };
  } catch (error) {
    warn(`proxy log follower failed: ${(error as Error).message}`);
    return async () => {};
  } finally {
    if (logFd !== undefined) closeSync(logFd);
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const dockerHost: DockerHost = { docker: dockerCli, followLogs: followDockerLogs, isAlive: processIsAlive };

async function sweepDeadOwners(
  must: (args: string[]) => Promise<ExecResult>,
  isAlive: (pid: number) => boolean,
  warn: (message: string) => void,
): Promise<void> {
  const attempt = async (args: string[]): Promise<ExecResult | null> => {
    try {
      return await must(args);
    } catch (error) {
      warn(`closed network sweep failed: ${(error as Error).message}`);
      return null;
    }
  };

  const lines: string[] = [];
  for (const label of [OWNER_LABEL, LEGACY_OWNER_LABEL]) {
    const listed = await attempt(["network", "ls", "--filter", `label=${label}`, "--format", `{{.Name}} {{.Label "${label}"}}`]);
    lines.push(...(listed?.stdout.split("\n") ?? []));
  }
  for (const line of lines) {
    const owned = /^(\S+) ([1-9]\d*)$/.exec(line.trim());
    if (owned === null || isAlive(Number(owned[2]))) continue;
    const network = owned[1];
    const attached = await attempt(["ps", "-aq", "--filter", `network=${network}`]);
    if (attached === null) continue;
    const containers = attached.stdout.split(/\s+/).filter(Boolean);
    if (containers.length > 0 && (await attempt(["rm", "-f", ...containers])) === null) continue;
    await attempt(["rm", "-f", proxyName(network)]);
    await attempt(["network", "rm", network]);
  }
}

export async function openClosedNetwork(
  options: ClosedNetworkOptions,
  { docker, followLogs, isAlive }: DockerHost = dockerHost,
): Promise<ClosedNetwork> {
  const { name, outDir, env, readyTimeoutMs = READY_TIMEOUT_MS } = options;
  const proxy = proxyName(name);
  const logsArgs = ["logs", proxy];
  const logPath = join(outDir, "proxy.log");
  const warn = (message: string): void => console.error(scrubber(env)(message));

  const must = async (args: string[]): Promise<ExecResult> => {
    const result = await docker(args);
    if (result.code !== 0) {
      throw new Error(`docker ${args.join(" ")} exited ${result.code}: ${result.stderr.slice(-300)}`);
    }
    return result;
  };

  const withoutReadyLine = (text: string): string => text.replace(`${PROXY_READY_LINE}\n`, "");

  const scrubLiveLog = (): void => {
    try {
      if (!existsSync(logPath)) return;
      writeFileSync(logPath, scrubber(env)(withoutReadyLine(readFileSync(logPath, "utf8"))));
    } catch (error) {
      warn(`proxy log scrub failed: ${(error as Error).message}`);
    }
  };

  const removals: string[][] = [];
  const removeCreated = async (): Promise<string[]> => {
    const failures: string[] = [];
    for (const args of removals) {
      try {
        await must(args);
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    return failures;
  };

  const waitForReady = async (): Promise<void> => {
    const deadline = Date.now() + readyTimeoutMs;
    let { stderr } = await must(logsArgs);
    while (!stderr.includes(PROXY_READY_LINE)) {
      if (Date.now() >= deadline) {
        throw new Error(
          `proxy ${proxy} was not ready after ${readyTimeoutMs} ms; its stderr: ${stderr.slice(-300) || "(empty)"}`,
        );
      }
      await delay(READY_POLL_MS);
      ({ stderr } = await must(logsArgs));
    }
  };

  await sweepDeadOwners(must, isAlive, warn);

  let stopFollower: StopFollower = async () => {};
  try {
    await must(["build", "-t", PROXY_IMAGE, "-f", PROXY_DOCKERFILE, PROXY_CONTEXT]);
    await must(["network", "create", "--internal", "--label", `${OWNER_LABEL}=${process.pid}`, name]);
    removals.unshift(["network", "rm", name]);
    removals.unshift(["rm", "-f", proxy]);
    await must(["run", "-d", "--name", proxy, "--network", "bridge", PROXY_IMAGE]);
    stopFollower = followLogs(proxy, logPath, warn);
    await must(["network", "connect", "--alias", PROXY_ALIAS, name, proxy]);
    await waitForReady();
  } catch (error) {
    await stopFollower();
    scrubLiveLog();
    const failures = await removeCreated();
    if (failures.length === 0) throw error;
    throw new Error(`${(error as Error).message}; cleanup also failed: ${failures.join("; ")}`);
  }

  const proxyUrl = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
  return {
    proxyUrl,
    modelEnv: {
      HTTPS_PROXY: proxyUrl,
      DISABLE_TELEMETRY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    close: async () => {
      const failures: string[] = [];
      await stopFollower();
      try {
        const { stdout, stderr } = await must(logsArgs);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(logPath, scrubber(env)(`${stdout}${withoutReadyLine(stderr)}`));
      } catch (error) {
        failures.push(`proxy log capture failed: ${(error as Error).message}`);
        scrubLiveLog();
      }
      failures.push(...(await removeCreated()));
      if (failures.length > 0) throw new Error(failures.join("; "));
    },
  };
}
