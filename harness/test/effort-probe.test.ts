import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, mock, test } from "node:test";

import { claudeArgv } from "../run-review.ts";
import {
  probeEffort,
  runCli,
  type CliDeps,
  type ProbeChild,
  type ProbeSpawn,
} from "../smoke/effort-probe.ts";

const SHORT_TIMEOUT_MS = 50;
const NEVER = new Promise<void>(() => {});
const PROBE_SCRIPT = join(import.meta.dirname, "..", "smoke", "effort-probe.ts");

type Send = (baseUrl: string, effort: string, model: string) => Promise<void>;

interface SpawnCall {
  argv: string[];
  env: Record<string, string>;
  stdin: string;
}

function effortOf(argv: string[]): string {
  return argv[argv.indexOf("--effort") + 1] ?? "";
}

function modelOf(argv: string[]): string {
  return argv[argv.indexOf("--model") + 1] ?? "";
}

function fakeSpawn(send: Send): { spawn: ProbeSpawn; calls: SpawnCall[]; kills: () => number } {
  const calls: SpawnCall[] = [];
  let kills = 0;
  const spawn: ProbeSpawn = (argv, { env, stdin }): ProbeChild => {
    calls.push({ argv, env, stdin });
    return {
      closed: send(env.ANTHROPIC_BASE_URL ?? "", effortOf(argv), modelOf(argv)),
      kill: () => {
        kills += 1;
      },
    };
  };
  return { spawn, calls, kills: () => kills };
}

function post(baseUrl: string, path: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "POST", body });
}

async function postJson(baseUrl: string, value: unknown): Promise<void> {
  await post(baseUrl, "/v1/messages?beta=true", JSON.stringify(value));
}

function cliHarness(spawn: ProbeSpawn): { deps: CliDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    deps: {
      spawn,
      timeoutMs: SHORT_TIMEOUT_MS,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
    out,
    err,
  };
}

afterEach(() => {
  mock.restoreAll();
});

describe("probeEffort", () => {
  test("reports every effort path recursively and stores no prompt content", async () => {
    const { spawn, kills } = fakeSpawn((baseUrl) =>
      postJson(baseUrl, {
        model: "claude-test",
        thinking: { type: "adaptive" },
        output_config: { effort: "high", nested: [{ reasoningEffort: { level: 3 } }] },
        "odd.key": { EFFORT_HINT: 1 },
        messages: [{ role: "user", content: "SECRET-MESSAGE", effort: "SECRET-MESSAGE-EFFORT" }],
        system: [{ text: "SECRET-SYSTEM", effort: "SECRET-SYSTEM-EFFORT" }],
      }),
    );

    const result = await probeEffort("high", { spawn });

    assert.deepEqual(result, {
      effort: "high",
      captured: true,
      effort_fields: [
        { path: "output_config.effort", value: "high" },
        { path: "output_config.nested[0].reasoningEffort", value: { level: 3 } },
        { path: '["odd.key"].EFFORT_HINT', value: 1 },
      ],
      thinking: { type: "adaptive" },
      requested_model: "claude-opus-5-5",
      model: "claude-test",
    });
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    assert.equal(kills(), 1);
  });

  test("answers 400 to a messages POST under a path prefix", async () => {
    let answer: Promise<Response> | undefined;
    const { spawn } = fakeSpawn(async (baseUrl) => {
      answer = post(baseUrl, "/proxy/v1/messages", JSON.stringify({ model: "first" }));
      await answer;
    });

    const result = await probeEffort("low", { spawn });

    assert.equal((await answer)?.status, 400);
    assert.equal(result.model, "first");
  });

  test("ignores a later messages POST", async () => {
    const statuses: number[] = [];
    let release = (): void => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawn: ProbeSpawn = (_argv, { env }) => {
      const baseUrl = env.ANTHROPIC_BASE_URL ?? "";
      const firstBody = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ model: "first" })));
          await released;
          controller.close();
        },
      });
      const first = fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        body: firstBody,
        duplex: "half",
      } as RequestInit);
      const second = setTimeout(async () => {
        const response = await post(baseUrl, "/v1/messages", JSON.stringify({ model: "second" }));
        statuses.push(response.status);
        release();
      }, 10);
      return {
        closed: first.then(() => undefined),
        kill: () => clearTimeout(second),
      };
    };

    const result = await probeEffort("low", { spawn });

    assert.equal(result.model, "first");
    assert.deepEqual(statuses, [400]);
  });

  test("does not capture other paths or methods", async () => {
    const statuses: number[] = [];
    const { spawn } = fakeSpawn(async (baseUrl) => {
      for (const response of [
        await post(baseUrl, "/v1/messages/count_tokens", "{}"),
        await post(baseUrl, "/v1/other", "{}"),
        await fetch(`${baseUrl}/v1/messages`),
      ]) {
        statuses.push(response.status);
      }
    });

    const result = await probeEffort("low", { spawn });

    assert.deepEqual(statuses, [404, 404, 404]);
    assert.equal(result.captured, false);
  });

  test("records a captured body that is not JSON with no fields", async () => {
    const { spawn } = fakeSpawn(async (baseUrl) => {
      await post(baseUrl, "/v1/messages", "not json");
    });

    assert.deepEqual(await probeEffort("low", { spawn }), {
      effort: "low",
      captured: true,
      effort_fields: [],
      thinking: null,
      requested_model: "claude-opus-5-5",
      model: null,
    });
  });

  test("builds the child env from the listed keys only", async () => {
    const realLooking = "sk-ant-real-looking-value";
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = realLooking;
    process.env.CLAUDE_CODE_EFFORT_LEVEL = "high";
    try {
      const { spawn, calls } = fakeSpawn((baseUrl) => postJson(baseUrl, {}));

      await probeEffort("medium", { spawn });

      const [call] = calls;
      assert.ok(call);
      assert.deepEqual(Object.keys(call.env).sort(), [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "HOME",
        "PATH",
      ]);
      assert.equal(call.env.PATH, process.env.PATH);
      assert.equal(call.env.HOME, process.env.HOME);
      assert.match(call.env.ANTHROPIC_BASE_URL ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(call.env.ANTHROPIC_API_KEY ?? "", /dummy/);
      assert.notEqual(call.env.ANTHROPIC_API_KEY, realLooking);
      assert.deepEqual(call.argv, claudeArgv("medium", "1"));
      assert.ok(call.stdin.length > 0);
    } finally {
      delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  test("times out and kills a child that never sends or exits", async () => {
    const { spawn, kills } = fakeSpawn(() => NEVER);

    const result = await probeEffort("low", { spawn, timeoutMs: SHORT_TIMEOUT_MS });

    assert.equal(result.captured, false);
    assert.equal(kills(), 1);
  });

  test("returns uncaptured when the child exits without sending", async () => {
    const { spawn, kills } = fakeSpawn(async () => {});

    assert.equal((await probeEffort("low", { spawn })).captured, false);
    assert.equal(kills(), 1);
  });

  test("rejects when the child fails to start and still kills it", async () => {
    const { spawn, kills } = fakeSpawn(() => Promise.reject(new Error("spawn claude ENOENT")));

    await assert.rejects(probeEffort("low", { spawn }), /ENOENT/);
    assert.equal(kills(), 1);
  });

  test("rejects on a listen error without spawning", async () => {
    mock.method(Server.prototype, "listen", function (this: Server) {
      process.nextTick(() => this.emit("error", new Error("listen EPERM")));
      return this;
    });
    const { spawn, calls } = fakeSpawn(async () => {});

    await assert.rejects(probeEffort("low", { spawn }), /EPERM/);
    assert.equal(calls.length, 0);
  });
});

describe("runCli", () => {
  for (const argv of [[], ["--dry"], ["--run", "--extra"], ["--model", "claude-haiku-5-5"], ["--run", "--model", "claude-sonnet-4-5"], ["--run", "--model"], ["--run", "x"]]) {
    test(`refuses ${JSON.stringify(argv)} without spawning`, async () => {
      const { spawn, calls } = fakeSpawn(async () => {});
      const { deps, out, err } = cliHarness(spawn);

      assert.equal(await runCli(argv, deps), 2);
      assert.equal(calls.length, 0);
      assert.equal(out.length, 0);
      assert.match(err.join("\n"), /usage:.*--run/);
    });
  }

  test("the script itself prints usage and exits non-zero with no arguments", () => {
    const run = spawnSync(process.execPath, [PROBE_SCRIPT], { encoding: "utf8", env: {} });

    assert.equal(run.status, 2);
    assert.match(run.stderr, /usage:.*--run/);
    assert.equal(run.stdout, "");
  });

  test("prints one JSON line per effort and exits 0 when the fields are distinct", async () => {
    const { spawn } = fakeSpawn((baseUrl, effort, model) => postJson(baseUrl, { model, effort }));
    const { deps, out } = cliHarness(spawn);

    assert.equal(await runCli(["--run"], deps), 0);
    assert.deepEqual(
      out.map((line) => JSON.parse(line).effort_fields),
      ["low", "medium", "high"].map((value) => [{ path: "effort", value }]),
    );
  });

  test("exits non-zero when two efforts send the same fields", async () => {
    const { spawn } = fakeSpawn((baseUrl, effort, model) =>
      postJson(baseUrl, { model, effort: effort === "low" ? "low" : "high" }),
    );
    const { deps, out, err } = cliHarness(spawn);

    assert.equal(await runCli(["--run"], deps), 1);
    assert.equal(out.length, 3);
    assert.match(err.join("\n"), /not distinct/);
  });

  test("reports captured false and exits non-zero when no capture arrives", async () => {
    const { spawn, calls } = fakeSpawn(() => NEVER);
    const { deps, out } = cliHarness(spawn);

    assert.equal(await runCli(["--run"], deps), 1);
    assert.equal(calls.length, 3);
    assert.deepEqual(
      out.map((line) => JSON.parse(line).captured),
      [false, false, false],
    );
  });

  test("exits non-zero when one effort is uncaptured though the fields differ", async () => {
    const { spawn } = fakeSpawn(async (baseUrl, effort, model) => {
      if (effort !== "low") await postJson(baseUrl, { model, effort });
    });
    const { deps, err } = cliHarness(spawn);

    assert.equal(await runCli(["--run"], deps), 1);
    assert.match(err.join("\n"), /no request captured at: low/);
  });

  test("--model probes that model at each effort and prints the requested and captured model", async () => {
    const { spawn, calls } = fakeSpawn((baseUrl, effort, model) => postJson(baseUrl, { model, effort }));
    const { deps, out, err } = cliHarness(spawn);

    assert.equal(await runCli(["--run", "--model", "claude-haiku-5-5"], deps), 0, err.join("\n"));
    assert.deepEqual(calls.map((call) => call.argv), ["low", "medium", "high"].map((effort) => claudeArgv(effort, "1", "claude-haiku-5-5")));
    assert.deepEqual(
      out.map((line) => [JSON.parse(line).requested_model, JSON.parse(line).model]),
      Array.from({ length: 3 }, () => ["claude-haiku-5-5", "claude-haiku-5-5"]),
    );
  });

  test("without --model the probe requests the default model", async () => {
    const { spawn, calls } = fakeSpawn((baseUrl, effort, model) => postJson(baseUrl, { model, effort }));
    const { deps, out } = cliHarness(spawn);

    assert.equal(await runCli(["--run"], deps), 0);
    assert.deepEqual(calls.map((call) => call.argv), ["low", "medium", "high"].map((effort) => claudeArgv(effort, "1")));
    assert.ok(out.every((line) => JSON.parse(line).requested_model === "claude-opus-5-5"));
  });

  test("exits 1 when a captured model differs from the requested one", async () => {
    const { spawn } = fakeSpawn((baseUrl, effort) =>
      postJson(baseUrl, { model: effort === "medium" ? "claude-opus-5-5" : "claude-sonnet-5-5", effort }),
    );
    const { deps, out, err } = cliHarness(spawn);

    assert.equal(await runCli(["--run", "--model", "claude-sonnet-5-5"], deps), 1);
    assert.equal(out.length, 3);
    assert.match(err.join("\n"), /captured model differs from claude-sonnet-5-5 at: medium \(claude-opus-5-5\)/);
  });

  test("exits 1 when a captured request carries no model", async () => {
    const { spawn } = fakeSpawn((baseUrl, effort) => postJson(baseUrl, { effort }));
    const { deps, err } = cliHarness(spawn);

    assert.equal(await runCli(["--run"], deps), 1);
    assert.match(err.join("\n"), /captured model differs from claude-opus-5-5 at: low \(null\), medium \(null\), high \(null\)/);
  });
});
