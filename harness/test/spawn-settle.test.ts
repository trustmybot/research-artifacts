import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, mock, test } from "node:test";

import { spawnCollect, STDIO_GRACE_MS } from "../runners.ts";
import { runCheckpoint } from "../smoke/run-batch.ts";

const SETTLE_LIMIT_MS = STDIO_GRACE_MS + 3_000;
const LONG_TIMEOUT_MS = 60_000;
const SHORT_TIMEOUT_MS = 300;

const grandchildren: number[] = [];
const tempDirs: string[] = [];

function trackGrandchild(pidText: string): void {
  const pid = Number.parseInt(pidText.trim(), 10);
  assert.ok(Number.isInteger(pid) && pid > 0, `grandchild pid: ${JSON.stringify(pidText)}`);
  grandchildren.push(pid);
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-settle-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const pid of grandchildren.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  mock.restoreAll();
});

describe("spawnCollect", () => {
  test("SC1: settles on exit while a grandchild holds stdout and stderr", async () => {
    const started = Date.now();
    const result = await spawnCollect("sh", ["-c", "sleep 30 & echo $!; echo out; exit 3"], {
      timeoutMs: LONG_TIMEOUT_MS,
    });
    const elapsed = Date.now() - started;
    const [pidLine, ...rest] = result.stdout.split("\n");
    trackGrandchild(pidLine);
    assert.ok(elapsed < SETTLE_LIMIT_MS, `settled after ${elapsed} ms`);
    assert.equal(result.code, 3);
    assert.equal(result.timedOut, false);
    assert.equal(rest.join("\n"), "out\n");
  });

  test("SC2: settles after its timeout kills a child whose grandchild holds the pipes", async () => {
    const started = Date.now();
    const result = await spawnCollect("sh", ["-c", "sleep 30 & echo $!; wait"], {
      timeoutMs: SHORT_TIMEOUT_MS,
    });
    const elapsed = Date.now() - started;
    trackGrandchild(result.stdout);
    assert.ok(elapsed < SHORT_TIMEOUT_MS + SETTLE_LIMIT_MS, `settled after ${elapsed} ms`);
    assert.equal(result.timedOut, true);
    assert.notEqual(result.code, 0);
  });

  test("SC4: a normal command returns its full stdout, stderr and exit code", async () => {
    const size = 1_000_000;
    const result = await spawnCollect(
      "sh",
      ["-c", `head -c ${size} /dev/zero | tr '\\0' a; printf err >&2; exit 2`],
      { timeoutMs: LONG_TIMEOUT_MS },
    );
    assert.equal(result.code, 2);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout, "a".repeat(size));
    assert.equal(result.stderr, "err");
  });

  test("SC4: stdin still reaches the child", async () => {
    const result = await spawnCollect("cat", [], { stdin: "piped", timeoutMs: LONG_TIMEOUT_MS });
    assert.deepEqual(result, { code: 0, stdout: "piped", stderr: "", timedOut: false });
  });
});

describe("runCheckpoint", () => {
  test("SC3: settles when the command backgrounds a process that keeps stderr open", async () => {
    const pidFile = join(tempDir(), "pid");
    const logged = mock.method(console, "error", () => {});
    const started = Date.now();
    await runCheckpoint(`sleep 30 & echo $! > '${pidFile}'; echo boom >&2; exit 4`, (text) => text);
    const elapsed = Date.now() - started;
    trackGrandchild(readFileSync(pidFile, "utf8"));
    assert.ok(elapsed < SETTLE_LIMIT_MS, `settled after ${elapsed} ms`);
    assert.deepEqual(
      logged.mock.calls.map((call) => call.arguments[0]),
      ["checkpoint exited 4: boom\n"],
    );
  });

  test("SC4: a clean checkpoint logs nothing", async () => {
    const logged = mock.method(console, "error", () => {});
    await runCheckpoint("true", (text) => text);
    assert.equal(logged.mock.callCount(), 0);
  });
});
