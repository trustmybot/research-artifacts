import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test, type TestContext } from "node:test";

import {
  followDockerLogs,
  openClosedNetwork,
  processIsAlive,
  type DockerCli,
  type DockerHost,
} from "../network.ts";
import { resourceNames } from "../gcp/common.ts";
import { dockerDeps, parseCli, reviewInClosedNetwork, UsageError } from "../run-review.ts";
import { API_KEY_ENV, DockerContainer, type ExecResult } from "../runners.ts";
import { PROXY_PORT, PROXY_READY_LINE, startAllowlistProxy } from "../smoke/allowlist-proxy.ts";
import { loadFakeSources, REPO_ROOT } from "../sources.ts";

const NAME = "cr-test-net";
const PROXY = `${NAME}-proxy`;
const PROXY_URL = "http://cr-proxy:3128";
const SECRET = "sk-ant-never-logged";
const LOG_LINE = '{"target":"github.com:443","decision":"refused_not_allowlisted","status":403}\n';
const READY: Partial<ExecResult> = { stdout: LOG_LINE, stderr: `${PROXY_READY_LINE}\n` };
const REMOVE_PROXY = ["rm", "-f", PROXY];
const REMOVE_NETWORK = ["network", "rm", NAME];
const OWNER_LABEL = `cr.owner-pid=${process.pid}`;
const NETWORK_LS = ["network", "ls", "--filter", "label=cr.owner-pid"];
const LEGACY_NETWORK_LS = ["network", "ls", "--filter", "label=c4-c.owner-pid"];
const NAMES = resourceNames("cr-effort-claude-opus-5.5", "test");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cr-network-"));
}

function stubDocker(answer: (args: string[]) => Partial<ExecResult> | undefined = () => undefined) {
  const calls: string[][] = [];
  const docker: DockerCli = async (args) => {
    calls.push(args);
    const fallback = args[0] === "logs" ? READY : {};
    return { code: 0, stdout: "", stderr: "", ...(answer(args) ?? fallback) };
  };
  return { calls, docker };
}

function failing(step: string, stderr = "boom") {
  return (args: string[]): Partial<ExecResult> | undefined =>
    args.join(" ").startsWith(step) ? { code: 1, stderr } : undefined;
}

function stubHost(docker: DockerCli, overrides: Partial<DockerHost> = {}): DockerHost {
  return { docker, followLogs: () => async () => {}, isAlive: () => true, ...overrides };
}

function open(
  docker: DockerCli,
  overrides: { outDir?: string; env?: NodeJS.ProcessEnv; host?: Partial<DockerHost> } = {},
) {
  const { host, ...options } = overrides;
  return openClosedNetwork({ name: NAME, outDir: tempDir(), env: {}, ...options }, stubHost(docker, host));
}

function captureWarnings(t: TestContext): string[] {
  const warnings: string[] = [];
  t.mock.method(console, "error", (message: string) => warnings.push(message));
  return warnings;
}

function recordingFollower() {
  const events: string[] = [];
  const started: Array<[string, string]> = [];
  const followLogs: DockerHost["followLogs"] = (proxy, logPath) => {
    started.push([proxy, logPath]);
    return async () => {
      events.push("follower stopped");
    };
  };
  return { events, started, followLogs };
}

function fakeDockerBinary(script: string): string {
  const path = join(tempDir(), "docker");
  writeFileSync(path, `#!${process.execPath}\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

const TICKING_DOCKER = `
console.log("pid", process.pid, process.argv.slice(2).join(" "));
console.error("from stderr");
setInterval(() => console.log("tick"), 20);
`;

function runInOwnGroup(script: string) {
  const entry = `import { followDockerLogs } from ${JSON.stringify(join(REPO_ROOT, "harness", "network.ts"))};\n${script}`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", entry], {
    encoding: "utf8",
    timeout: 30_000,
    detached: true,
  });
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(20);
  }
}

function connectThroughEntry(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(PROXY_PORT, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.once("data", (chunk) => {
      socket.destroy();
      resolve(chunk.toString("utf8"));
    });
    socket.once("error", reject);
  });
}

describe("openClosedNetwork", () => {
  test("starts the proxy on bridge, then joins it to the internal network, then waits for it", async () => {
    const { calls, docker } = stubDocker();
    const network = await open(docker);
    const [list, legacyList, build, create, run, attach, logs] = calls;
    assert.equal(calls.length, 7);
    assert.deepEqual(list.slice(0, 4), NETWORK_LS);
    assert.deepEqual(legacyList.slice(0, 4), LEGACY_NETWORK_LS);
    assert.equal(build[0], "build");
    assert.equal(build[build.indexOf("-f") + 1], join(REPO_ROOT, "harness", "docker", "proxy.Dockerfile"));
    assert.equal(build.at(-1), join(REPO_ROOT, "harness", "smoke"));
    const image = build[build.indexOf("-t") + 1];
    assert.equal(image, "cr-allowlist-proxy:local");
    assert.deepEqual(create, ["network", "create", "--internal", "--label", OWNER_LABEL, NAME]);
    assert.deepEqual(run, ["run", "-d", "--name", PROXY, "--network", "bridge", image]);
    assert.deepEqual(attach, ["network", "connect", "--alias", "cr-proxy", NAME, PROXY]);
    assert.deepEqual(logs, ["logs", PROXY]);
    await network.close();
  });

  test("returns the proxy's network alias and the model environment", async () => {
    const network = await open(stubDocker().docker);
    assert.equal(network.proxyUrl, PROXY_URL);
    assert.deepEqual(network.modelEnv, {
      HTTPS_PROXY: PROXY_URL,
      DISABLE_TELEMETRY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    await network.close();
  });

  test("a network name past the DNS label limit still yields a resolvable proxy host", async () => {
    const name = "c4-c-smoke-20261105t173811z-857bff4-models-sonnet-haiku-s0of5-extra-long";
    assert.ok(name.length >= 70);
    const network = await openClosedNetwork({ name, outDir: tempDir(), env: {} }, stubHost(stubDocker().docker));
    assert.ok(new URL(network.proxyUrl).hostname.length <= 63);
    assert.equal(network.proxyUrl, PROXY_URL);
    await network.close();
  });

  test("the harness README gives the proxy address the network returns", () => {
    const readme = readFileSync(join(REPO_ROOT, "harness", "README.md"), "utf8");
    assert.ok(readme.includes(`\`${PROXY_URL}\``));
    assert.ok(!readme.includes("<network>-proxy:3128"));
  });

  const cleanups: Array<[string, string[][]]> = [
    ["build", []],
    ["network create", []],
    ["run", [REMOVE_PROXY, REMOVE_NETWORK]],
    ["network connect", [REMOVE_PROXY, REMOVE_NETWORK]],
    ["logs", [REMOVE_PROXY, REMOVE_NETWORK]],
  ];
  for (const [step, removed] of cleanups) {
    test(`a failed ${step} fails with its cause and removes only what it created`, async () => {
      const { calls, docker } = stubDocker(failing(step));
      await assert.rejects(open(docker), new RegExp(`docker ${step}.*exited 1: boom`));
      const stepIndex = calls.findIndex((args) => args.join(" ").startsWith(step));
      assert.deepEqual(calls.slice(stepIndex + 1), removed);
    });
  }

  test("a failed cleanup does not hide the cause and does not stop the next removal", async () => {
    const { calls, docker } = stubDocker((args) =>
      args[0] === "run" || args[0] === "rm" ? { code: 1, stderr: args[0] } : undefined,
    );
    await assert.rejects(open(docker), /docker run.*exited 1: run; cleanup also failed: docker rm.*exited 1: rm/);
    assert.deepEqual(calls.at(-1), REMOVE_NETWORK);
  });

  test("a docker binary that cannot start still removes what exists", async () => {
    const calls: string[][] = [];
    const docker: DockerCli = async (args) => {
      calls.push(args);
      if (args[0] === "run") throw new Error("spawn docker ENOENT");
      return { code: 0, stdout: "", stderr: "" };
    };
    await assert.rejects(open(docker), /spawn docker ENOENT/);
    assert.deepEqual(calls.slice(-2), [REMOVE_PROXY, REMOVE_NETWORK]);
  });

  test("polls until the readiness line appears", async () => {
    let polls = 0;
    const { calls, docker } = stubDocker((args) => {
      if (args[0] !== "logs") return undefined;
      polls += 1;
      return polls < 3 ? { stderr: "" } : READY;
    });
    const network = await open(docker);
    assert.equal(calls.filter(([command]) => command === "logs").length, 3);
    await network.close();
  });

  test("a proxy that never gets ready times out with the cause and cleans up", async () => {
    const { calls, docker } = stubDocker((args) =>
      args[0] === "logs" ? { stderr: "EADDRINUSE 0.0.0.0:3128\n" } : undefined,
    );
    await assert.rejects(
      openClosedNetwork({ name: NAME, outDir: tempDir(), env: {}, readyTimeoutMs: 300 }, stubHost(docker)),
      new RegExp(`proxy ${PROXY} was not ready after 300 ms; its stderr: EADDRINUSE`),
    );
    assert.deepEqual(calls.slice(-2), [REMOVE_PROXY, REMOVE_NETWORK]);
  });

  test("close writes the scrubbed proxy log, then removes the proxy and the network", async () => {
    const outDir = join(tempDir(), "not-created-yet");
    const { calls, docker } = stubDocker((args) =>
      args[0] === "logs"
        ? { stdout: `${LOG_LINE}{"target":"${SECRET}.example:443"}\n`, stderr: READY.stderr }
        : undefined,
    );
    const network = await open(docker, { outDir, env: { ANTHROPIC_API_KEY: SECRET } });
    await network.close();
    assert.equal(
      readFileSync(join(outDir, "proxy.log"), "utf8"),
      `${LOG_LINE}{"target":"[REDACTED].example:443"}\n`,
    );
    assert.deepEqual(calls.slice(-2), [REMOVE_PROXY, REMOVE_NETWORK]);
  });

  test("close keeps a proxy crash from stderr in the log", async () => {
    const outDir = tempDir();
    const { docker } = stubDocker((args) =>
      args[0] === "logs" ? { stdout: LOG_LINE, stderr: `${READY.stderr}crash\n` } : undefined,
    );
    await (await open(docker, { outDir })).close();
    assert.equal(readFileSync(join(outDir, "proxy.log"), "utf8"), `${LOG_LINE}crash\n`);
  });

  test("close still removes everything when the log capture fails, then reports it", async () => {
    let polls = 0;
    const outDir = tempDir();
    const { calls, docker } = stubDocker((args) => {
      if (args[0] !== "logs") return undefined;
      polls += 1;
      return polls === 1 ? READY : { code: 1, stderr: "daemon gone" };
    });
    const network = await open(docker, { outDir });
    await assert.rejects(network.close(), /proxy log capture failed: .*daemon gone/);
    assert.deepEqual(calls.slice(-2), [REMOVE_PROXY, REMOVE_NETWORK]);
    assert.ok(!existsSync(join(outDir, "proxy.log")));
  });

  test("close removes the network when removing the proxy fails, then reports it", async () => {
    const { calls, docker } = stubDocker(failing("rm -f", "stuck"));
    const network = await open(docker);
    await assert.rejects(network.close(), /docker rm -f .*stuck/);
    assert.deepEqual(calls.at(-1), REMOVE_NETWORK);
  });

  test("starts the follower once the proxy runs, with the proxy name and the proxy.log path", async () => {
    const outDir = tempDir();
    const { calls, docker } = stubDocker();
    let callsAtStart: string[][] = [];
    const started: Array<[string, string]> = [];
    const network = await open(docker, {
      outDir,
      host: {
        followLogs: (proxy, logPath) => {
          started.push([proxy, logPath]);
          callsAtStart = [...calls];
          return async () => {};
        },
      },
    });
    assert.deepEqual(started, [[PROXY, join(outDir, "proxy.log")]]);
    assert.equal(callsAtStart.at(-1)?.[0], "run");
    await network.close();
  });

  test("close stops the follower before its capture and overwrites the live file", async () => {
    const outDir = tempDir();
    const events: string[] = [];
    const { docker } = stubDocker((args) => {
      if (args[0] === "logs") events.push("captured");
      return undefined;
    });
    const network = await open(docker, {
      outDir,
      host: {
        followLogs: (_proxy, logPath) => {
          writeFileSync(logPath, `${PROXY_READY_LINE}\nraw\n`);
          return async () => {
            events.push("follower stopped");
          };
        },
      },
    });
    events.length = 0;
    await network.close();
    assert.deepEqual(events, ["follower stopped", "captured"]);
    assert.equal(readFileSync(join(outDir, "proxy.log"), "utf8"), LOG_LINE);
  });

  for (const step of ["network connect", "logs"]) {
    test(`a failed ${step} stops the follower before removing anything`, async () => {
      const { events, followLogs } = recordingFollower();
      const { calls, docker } = stubDocker((args) => {
        if (args[0] === "rm") events.push("removed");
        return failing(step)(args);
      });
      await assert.rejects(open(docker, { host: { followLogs } }), /boom/);
      assert.deepEqual(events.slice(0, 2), ["follower stopped", "removed"]);
      assert.deepEqual(calls.slice(-2), [REMOVE_PROXY, REMOVE_NETWORK]);
    });
  }

  test("a failure before the proxy runs starts no follower", async () => {
    const { events, started, followLogs } = recordingFollower();
    await assert.rejects(open(stubDocker(failing("run")).docker, { host: { followLogs } }), /boom/);
    assert.deepEqual(started, []);
    assert.deepEqual(events, []);
  });

  const writesRawLog = (_proxy: string, logPath: string) => {
    writeFileSync(logPath, `${PROXY_READY_LINE}\nattempt ${SECRET}\n`);
    return async () => {};
  };

  test("a failed capture at close scrubs the live proxy.log in place", async () => {
    const outDir = tempDir();
    let closing = false;
    const { calls, docker } = stubDocker((args) =>
      closing && args[0] === "logs" ? { code: 1, stderr: "daemon gone" } : undefined,
    );
    const network = await open(docker, {
      outDir,
      env: { [API_KEY_ENV]: SECRET },
      host: { followLogs: writesRawLog },
    });
    closing = true;
    await assert.rejects(network.close(), /proxy log capture failed: .*daemon gone/);
    assert.equal(readFileSync(join(outDir, "proxy.log"), "utf8"), "attempt [REDACTED]\n");
    assert.deepEqual(calls.slice(-2), [REMOVE_PROXY, REMOVE_NETWORK]);
  });

  test("a failed open after docker run scrubs the live proxy.log in place", async () => {
    const outDir = tempDir();
    const { calls, docker } = stubDocker(failing("network connect"));
    await assert.rejects(
      open(docker, { outDir, env: { [API_KEY_ENV]: SECRET }, host: { followLogs: writesRawLog } }),
      /boom/,
    );
    assert.equal(readFileSync(join(outDir, "proxy.log"), "utf8"), "attempt [REDACTED]\n");
    assert.deepEqual(calls.slice(-2), [REMOVE_PROXY, REMOVE_NETWORK]);
  });

  test("a live log that cannot be scrubbed warns and keeps the original failure and the cleanup", async (t) => {
    const warnings = captureWarnings(t);
    const outDir = tempDir();
    mkdirSync(join(outDir, "proxy.log"));
    const { calls, docker } = stubDocker(failing("network connect"));
    await assert.rejects(open(docker, { outDir }), /docker network connect .*boom/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /proxy log scrub failed: /);
    assert.deepEqual(calls.slice(-2), [REMOVE_PROXY, REMOVE_NETWORK]);
  });
});

describe("the proxy log follower", () => {
  test("streams stdout and stderr of docker logs -f into the file, and stop waits for its exit", async () => {
    const logPath = join(tempDir(), "not-created-yet", "proxy.log");
    const stop = followDockerLogs(PROXY, logPath, assert.fail, fakeDockerBinary(TICKING_DOCKER));
    const read = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
    await waitFor(() => read().includes("tick") && read().includes("from stderr"), "the follower's output");
    assert.ok(read().includes(`logs -f ${PROXY}`));
    await stop();
    const final = read();
    await delay(100);
    assert.equal(read(), final);
    await stop();
  });

  test("stop finishes in a process with nothing else keeping it alive", () => {
    const logPath = join(tempDir(), "proxy.log");
    const child = runInOwnGroup(`
      const stop = followDockerLogs("p", ${JSON.stringify(logPath)}, console.error, ${JSON.stringify(fakeDockerBinary(TICKING_DOCKER))});
      await new Promise((resolve) => setTimeout(resolve, 200));
      await stop();
      console.log("stopped");`);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /stopped/);
  });

  for (const ending of ['process.kill(process.pid, "SIGKILL");', "process.exitCode = 0;"]) {
    test(`keeps writing after a harness that ends with ${ending}`, async () => {
      const logPath = join(tempDir(), "proxy.log");
      const child = runInOwnGroup(`
        followDockerLogs("p", ${JSON.stringify(logPath)}, console.error, ${JSON.stringify(fakeDockerBinary(TICKING_DOCKER))});
        ${ending}`);
      assert.equal(child.error, undefined);
      await waitFor(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes("tick"), "a first tick");
      const pid = Number(/^pid (\d+)/m.exec(readFileSync(logPath, "utf8"))?.[1]);
      try {
        const before = readFileSync(logPath, "utf8").length;
        await waitFor(() => readFileSync(logPath, "utf8").length > before, "more ticks after the harness ended");
      } finally {
        process.kill(pid, "SIGKILL");
      }
    });
  }

  test("a docker binary that cannot start warns, and stop signals no process group", () => {
    const child = runInOwnGroup(`
      const stop = followDockerLogs("p", ${JSON.stringify(join(tempDir(), "proxy.log"))}, console.error, "/nonexistent/docker");
      await stop();
      console.log("stopped");`);
    assert.equal(child.signal, null);
    assert.match(child.stdout, /stopped/);
    assert.match(child.stderr, /proxy log follower failed: .*ENOENT/);
  });

  test("a log file that cannot open warns, and stop still returns", async () => {
    const blocker = join(tempDir(), "a-file");
    writeFileSync(blocker, "");
    const warnings: string[] = [];
    const stop = followDockerLogs(PROXY, join(blocker, "proxy.log"), (m) => warnings.push(m));
    await stop();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /proxy log follower failed/);
  });
});

describe("the sweep of killed runs", () => {
  const DEAD = 111;
  const LIVE = 222;
  const isAlive = (pid: number) => pid === LIVE;

  function hostWithNetworks(
    listing: string,
    answer: (args: string[]) => Partial<ExecResult> | undefined = () => undefined,
    legacyListing = "",
  ) {
    return stubDocker((args) => {
      if (args.slice(0, 2).join(" ") !== "network ls") return answer(args);
      return { stdout: args.includes("label=c4-c.owner-pid") ? legacyListing : listing };
    });
  }

  const swept = (calls: string[][]) => calls.slice(0, calls.findIndex(([command]) => command === "build"));

  test("a dead owner's containers, proxy and network go, in that order, before anything is created", async () => {
    const { calls, docker } = hostWithNetworks(`old ${DEAD}\n`, (args) =>
      args[0] === "ps" ? { stdout: "aaa\nbbb\n" } : undefined,
    );
    await (await open(docker, { host: { isAlive } })).close();
    assert.deepEqual(swept(calls).slice(2), [
      ["ps", "-aq", "--filter", "network=old"],
      ["rm", "-f", "aaa", "bbb"],
      ["rm", "-f", "old-proxy"],
      ["network", "rm", "old"],
    ]);
  });

  test("a dead owner's network with no container still loses its proxy and the network", async () => {
    const { calls, docker } = hostWithNetworks(`old ${DEAD}`);
    await (await open(docker, { host: { isAlive } })).close();
    assert.deepEqual(swept(calls).slice(2), [
      ["ps", "-aq", "--filter", "network=old"],
      ["rm", "-f", "old-proxy"],
      ["network", "rm", "old"],
    ]);
  });

  test("a live owner's network is untouched", async () => {
    const { calls, docker } = hostWithNetworks(`theirs ${LIVE}\n`);
    await (await open(docker, { host: { isAlive } })).close();
    assert.deepEqual(swept(calls).map(([command]) => command), ["network", "network"]);
    assert.ok(!calls.flat().some((arg) => arg.includes("theirs")));
  });

  test("a network without the label is never touched", async () => {
    const { calls, docker } = hostWithNetworks("unlabelled \n", undefined, "unlabelled \n");
    await (await open(docker, { host: { isAlive: () => false } })).close();
    assert.ok(!calls.flat().some((arg) => arg.includes("unlabelled")));
  });

  test("a dead owner under the legacy c4-c.owner-pid label is swept too", async () => {
    const { calls, docker } = hostWithNetworks("", undefined, `old ${DEAD}\n`);
    await (await open(docker, { host: { isAlive } })).close();
    assert.deepEqual(swept(calls).slice(0, 2), [
      [...NETWORK_LS, "--format", '{{.Name}} {{.Label "cr.owner-pid"}}'],
      [...LEGACY_NETWORK_LS, "--format", '{{.Name}} {{.Label "c4-c.owner-pid"}}'],
    ]);
    assert.deepEqual(swept(calls).slice(2), [
      ["ps", "-aq", "--filter", "network=old"],
      ["rm", "-f", "old-proxy"],
      ["network", "rm", "old"],
    ]);
  });

  test("a live owner under the legacy label is untouched", async () => {
    const { calls, docker } = hostWithNetworks("", undefined, `theirs ${LIVE}\n`);
    await (await open(docker, { host: { isAlive } })).close();
    assert.deepEqual(swept(calls).map(([command]) => command), ["network", "network"]);
    assert.ok(!calls.flat().some((arg) => arg.includes("theirs")));
  });

  test("dead owners under both labels are each swept once, the current label first", async () => {
    const { calls, docker } = hostWithNetworks(`new ${DEAD}\nmine ${LIVE}\n`, undefined, `old ${DEAD}\n`);
    await (await open(docker, { host: { isAlive } })).close();
    assert.deepEqual(swept(calls).slice(2), [
      ["ps", "-aq", "--filter", "network=new"],
      ["rm", "-f", "new-proxy"],
      ["network", "rm", "new"],
      ["ps", "-aq", "--filter", "network=old"],
      ["rm", "-f", "old-proxy"],
      ["network", "rm", "old"],
    ]);
    assert.ok(!calls.flat().some((arg) => arg.includes("mine")));
  });

  for (const [why, line] of [
    ["empty", "odd"],
    ["not a pid", "odd abc"],
    ["zero", "odd 0"],
    ["negative", "odd -1"],
    ["more than one word", `odd ${DEAD} 7`],
  ]) {
    test(`a label value that is ${why} proves nothing and leaves the network`, async () => {
      const { calls, docker } = hostWithNetworks(`${line}\n`);
      await (await open(docker, { host: { isAlive: () => false } })).close();
      assert.ok(!calls.flat().some((arg) => arg.includes("odd")));
    });
  }

  test("a failed listing warns through the scrubber and the open continues", async (t) => {
    const warnings = captureWarnings(t);
    const { calls, docker } = stubDocker(failing("network ls", `denied ${SECRET}`));
    await (await open(docker, { env: { ANTHROPIC_API_KEY: SECRET } })).close();
    assert.equal(warnings.length, 2);
    for (const warning of warnings) assert.match(warning, /closed network sweep failed: .*denied \[REDACTED\]/);
    assert.ok(calls.some(([command]) => command === "build"));
  });

  test("a docker binary that cannot start warns during the sweep and the open continues", async (t) => {
    const warnings = captureWarnings(t);
    const docker: DockerCli = async (args) => {
      if (args[0] === "network" && args[1] === "ls") throw new Error("spawn docker ENOENT");
      return { code: 0, stdout: "", stderr: args[0] === "logs" ? READY.stderr ?? "" : "" };
    };
    await (await open(docker)).close();
    assert.match(warnings[0], /spawn docker ENOENT/);
  });

  test("a network whose containers cannot be listed stays, and the next one is still swept", async (t) => {
    const warnings = captureWarnings(t);
    const { calls, docker } = hostWithNetworks(`bad ${DEAD}\nnext ${DEAD}\n`, failing("ps -aq --filter network=bad"));
    await (await open(docker, { host: { isAlive } })).close();
    assert.equal(warnings.length, 1);
    assert.deepEqual(swept(calls).slice(2), [
      ["ps", "-aq", "--filter", "network=bad"],
      ["ps", "-aq", "--filter", "network=next"],
      ["rm", "-f", "next-proxy"],
      ["network", "rm", "next"],
    ]);
  });

  test("a container that cannot be removed keeps its network", async (t) => {
    const warnings = captureWarnings(t);
    const { calls, docker } = hostWithNetworks(`old ${DEAD}\n`, (args) => {
      if (args[0] === "ps") return { stdout: "aaa\n" };
      return failing("rm -f aaa")(args);
    });
    await (await open(docker, { host: { isAlive } })).close();
    assert.equal(warnings.length, 1);
    assert.deepEqual(swept(calls).slice(2), [
      ["ps", "-aq", "--filter", "network=old"],
      ["rm", "-f", "aaa"],
    ]);
  });

  test("a failed proxy removal warns and still tries the network", async (t) => {
    const warnings = captureWarnings(t);
    const { calls, docker } = hostWithNetworks(`old ${DEAD}\n`, failing("rm -f old-proxy"));
    await (await open(docker, { host: { isAlive } })).close();
    assert.equal(warnings.length, 1);
    assert.deepEqual(swept(calls).at(-1), ["network", "rm", "old"]);
  });

  test("processIsAlive: this process lives, an unreadable one counts as alive, an exited one is dead", () => {
    assert.equal(processIsAlive(process.pid), true);
    assert.equal(processIsAlive(1), true);
    const exited = spawnSync(process.execPath, ["-e", ""]);
    assert.equal(processIsAlive(exited.pid), false);
  });
});

describe("run-review always uses the closed network", () => {
  const closedOptions = (outDir: string) => ({
    mode: "container-only" as const,
    effort: null,
    budgetUsd: null,
    outDir,
  });

  test("the real wiring passes proxyUrl, the network and the model environment", async () => {
    const network = await open(stubDocker().docker);
    const deps = dockerDeps({}, NAMES, NAME, network);
    assert.equal(deps.proxyUrl, PROXY_URL);
    const { container, model } = deps.createRunners(loadFakeSources());
    const runArgs = (container as DockerContainer).runArgs();
    assert.match((container as DockerContainer).name, /^cr-mvp-[0-9a-f]{8}$/);
    assert.ok(runArgs.includes((container as DockerContainer).name));
    assert.equal(runArgs.filter((arg) => arg === "--network").length, 1);
    assert.equal(runArgs[runArgs.indexOf("--network") + 1], NAME);
    assert.ok(model.command(["claude"]).includes(`HTTPS_PROXY=${PROXY_URL}`));
    await network.close();
  });

  test("a review that stops early still closes the network and captures the log", async () => {
    const outDir = tempDir();
    const { calls, docker } = stubDocker();
    const { record, exitCode } = await reviewInClosedNetwork(closedOptions(outDir), NAMES, {}, {
      host: stubHost(docker),
      loadSources: () => Promise.reject(new Error("offline")),
    });
    assert.equal(record.stop_reason, "setup_failed:offline");
    assert.equal(exitCode, 1);
    const networkName = calls[3].at(-1) as string;
    assert.match(networkName, /^cr-mvp-net-[0-9a-f]{8}$/);
    assert.deepEqual(calls.at(-2), ["rm", "-f", `${networkName}-proxy`]);
    assert.deepEqual(calls.at(-1), ["network", "rm", networkName]);
    assert.equal(readFileSync(join(outDir, "proxy.log"), "utf8"), LOG_LINE);
  });

  test("a network that cannot open records setup_failed and loads no sources", async () => {
    const outDir = tempDir();
    let loaded = false;
    const { record, exitCode } = await reviewInClosedNetwork(
      closedOptions(outDir),
      NAMES,
      { ANTHROPIC_API_KEY: SECRET },
      {
        host: stubHost(stubDocker(failing("build", `pull failed ${SECRET}`)).docker),
        loadSources: async () => {
          loaded = true;
          return loadFakeSources();
        },
      },
    );
    assert.match(record.stop_reason, /^setup_failed:docker build.*pull failed \[REDACTED\]/);
    assert.equal(exitCode, 1);
    assert.equal(loaded, false);
    assert.ok(!readFileSync(join(outDir, "run.json"), "utf8").includes(SECRET));
  });

  test("no flag opens the network", () => {
    for (const flag of ["--no-network", "--open-network", "--network"]) {
      assert.throws(() => parseCli(["--condition", "cr-effort-claude-opus-5.5", "--container-only", flag], {}), UsageError);
    }
  });

  test("--fake starts no network and needs no Docker", () => {
    const out = tempDir();
    const child = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "harness", "run-review.ts"), "--condition", "cr-effort-claude-opus-5.5", "--fake", "--out", out],
      { encoding: "utf8", env: { PATH: "" } },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.ok(!existsSync(join(out, "proxy.log")));
  });
});

describe("proxy image", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, "harness", "docker", "proxy.Dockerfile"), "utf8");

  test("pins its base by digest, copies the proxy files and runs the entry as node", () => {
    assert.match(
      dockerfile,
      /^FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85$/m,
    );
    assert.match(dockerfile, /^COPY allowlist-proxy\.ts proxy-entry\.ts /m);
    assert.match(dockerfile, /^USER node$/m);
    assert.match(dockerfile, /^ENTRYPOINT \["node", "\/app\/proxy-entry\.ts"\]$/m);
  });

  test("the proxy binds a given port and still picks a free one by default", async () => {
    const logPath = join(tempDir(), "proxy.log");
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise((resolve) => probe.close(resolve));

    const fixed = await startAllowlistProxy({ host: "127.0.0.1", port, logPath });
    const free = await startAllowlistProxy({ host: "127.0.0.1", logPath });
    assert.equal(fixed.url, `http://127.0.0.1:${port}`);
    assert.notEqual(free.url, fixed.url);
    await fixed.close();
    await free.close();
  });

  test("the entry binds 0.0.0.0:3128, reports ready on stderr and logs to stdout", async (t) => {
    const logPath = join(tempDir(), "stdout.log");
    const stdout = openSync(logPath, "a");
    const child = spawn(process.execPath, [join(REPO_ROOT, "harness", "smoke", "proxy-entry.ts")], {
      stdio: ["ignore", stdout, "pipe"],
    });
    closeSync(stdout);
    let stderr = "";
    const exited = new Promise((resolve) => child.once("close", resolve));
    const ready = new Promise<void>((resolve) => {
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.includes(PROXY_READY_LINE)) resolve();
      });
    });
    try {
      await Promise.race([exited, ready]);
      if (/EADDRINUSE|EPERM/.test(stderr)) {
        t.skip(`port ${PROXY_PORT} is not available here`);
        return;
      }
      assert.ok(stderr.includes(PROXY_READY_LINE), stderr);
      assert.match(await connectThroughEntry("github.com:443"), /^HTTP\/1\.1 403/);
      const logged = JSON.parse(readFileSync(logPath, "utf8").trim());
      assert.equal(logged.target, "github.com:443");
      assert.equal(logged.decision, "refused_not_allowlisted");
    } finally {
      child.kill();
      await exited;
    }
  });
});
