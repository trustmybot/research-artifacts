import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { RepeatDrawRefusal, runRepeatDraw, selectRepeats } from "../draw-repeats.ts";

const SCRIPT = join(import.meta.dirname, "..", "draw-repeats.ts");
const MAIN_PATCHES = join(import.meta.dirname, "..", "checks", "main-patches.json");
const COMMITTED = join(import.meta.dirname, "..", "checks", "repeat-patches.json");
const SEED = "20261102";

type Entry = Record<string, unknown> & { instance_id: string; agent_id: string; label_stratum: string };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cr-draw-repeats-"));
}

function readEntries(path: string): Entry[] {
  return JSON.parse(readFileSync(path, "utf8")) as Entry[];
}

function key(entry: Entry): string {
  return `${entry.instance_id}|${entry.agent_id}`;
}

function draw(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function drawTo(seed: string, patches = MAIN_PATCHES): string {
  const out = join(tempDir(), "repeat.json");
  runRepeatDraw({ patchesPath: patches, seed, outPath: out });
  return out;
}

describe("draw-repeats.ts", () => {
  const main = readEntries(MAIN_PATCHES);

  test("the CLI reproduces the committed repeat-patches.json byte for byte", () => {
    const out = join(tempDir(), "repeat.json");
    const child = draw(["--patches", MAIN_PATCHES, "--seed", SEED, "--out", out]);
    assert.equal(child.status, 0, child.stderr);
    assert.ok(readFileSync(out).equals(readFileSync(COMMITTED)));
  });

  test("the same seed gives the same file", () => {
    assert.ok(readFileSync(drawTo(SEED)).equals(readFileSync(drawTo(SEED))));
  });

  test("it holds 14 wrong then 6 correct entries, all distinct", () => {
    const selected = readEntries(COMMITTED);
    assert.equal(selected.length, 20);
    assert.ok(selected.slice(0, 14).every((entry) => entry.label_stratum === "swe_abs_wrong"));
    assert.ok(selected.slice(14).every((entry) => entry.label_stratum === "swe_abs_correct"));
    assert.equal(new Set(selected.map(key)).size, 20);
  });

  test("every entry is present unchanged in main-patches.json", () => {
    const byKey = new Map(main.map((entry) => [key(entry), entry]));
    for (const entry of readEntries(COMMITTED)) {
      assert.deepEqual(entry, byKey.get(key(entry)));
      assert.deepEqual(Object.keys(entry), Object.keys(byKey.get(key(entry)) as Entry));
    }
  });

  test("a different seed gives a different selection", () => {
    const other = selectRepeats(main, "20261103").map(key);
    assert.notDeepEqual(other, readEntries(COMMITTED).map(key));
    assert.equal(other.length, 20);
  });

  test("the selection does not depend on the order of the patches file", () => {
    const reversed = selectRepeats([...main].reverse(), SEED).map(key);
    assert.deepEqual(reversed, readEntries(COMMITTED).map(key));
  });

  const refusals: Array<[string, string[], RegExp]> = [
    ["a missing seed", [], /--seed is required/],
    ["a seed that is not digits", ["--seed", "abc"], /--seed must be digits/],
  ];
  for (const [name, args, message] of refusals) {
    test(`refuses ${name} with exit 2 and the usage line`, () => {
      const out = join(tempDir(), "repeat.json");
      const child = draw(["--patches", MAIN_PATCHES, ...args, "--out", out]);
      assert.equal(child.status, 2);
      assert.match(child.stderr, message);
      assert.match(child.stderr, /usage: node harness\/draw-repeats.ts/);
      assert.ok(!existsSync(out));
    });
  }

  test("refuses a missing --out with exit 2", () => {
    const child = draw(["--seed", SEED]);
    assert.equal(child.status, 2);
    assert.match(child.stderr, /--out is required/);
  });

  const miscounted: Array<[string, (entries: Entry[]) => Entry[]]> = [
    ["one wrong entry short", (entries) => {
      const index = entries.findIndex((entry) => entry.label_stratum === "swe_abs_wrong");
      return entries.filter((_, i) => i !== index);
    }],
    ["one correct entry short", (entries) => {
      const index = entries.findIndex((entry) => entry.label_stratum === "swe_abs_correct");
      return entries.filter((_, i) => i !== index);
    }],
    ["an extra correct entry", (entries) => [
      ...entries,
      { ...(entries.find((entry) => entry.label_stratum === "swe_abs_correct") as Entry), agent_id: "extra" },
    ]],
  ];
  for (const [name, edit] of miscounted) {
    test(`refuses a patches file with ${name}`, () => {
      const dir = tempDir();
      const patches = join(dir, "patches.json");
      writeFileSync(patches, JSON.stringify(edit(main)));
      assert.throws(() => runRepeatDraw({ patchesPath: patches, seed: SEED, outPath: join(dir, "out.json") }), RepeatDrawRefusal);
      const child = draw(["--patches", patches, "--seed", SEED, "--out", join(dir, "out.json")]);
      assert.equal(child.status, 2);
      assert.match(child.stderr, /stratum counts differ/);
      assert.ok(!existsSync(join(dir, "out.json")));
    });
  }
});
