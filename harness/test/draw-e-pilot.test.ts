import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { E_PILOT_STRATA, runEPilotDraw } from "../draw-e-pilot.ts";
import { RepeatDrawRefusal, selectStrata } from "../draw-repeats.ts";

const SCRIPT = join(import.meta.dirname, "..", "draw-e-pilot.ts");
const PILOT_PATCHES = join(import.meta.dirname, "..", "checks", "pilot-patches.json");
const MAIN_PATCHES = join(import.meta.dirname, "..", "checks", "main-patches.json");
const COMMITTED = join(import.meta.dirname, "..", "checks", "e-pilot-patches.json");
const SEED = "20261102";

type Entry = Record<string, unknown> & { instance_id: string; agent_id: string; label_stratum: string };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cr-draw-e-pilot-"));
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

function drawTo(seed: string): string {
  const out = join(tempDir(), "e-pilot.json");
  runEPilotDraw({ patchesPath: PILOT_PATCHES, seed, outPath: out });
  return out;
}

describe("draw-e-pilot.ts", () => {
  const pilot = readEntries(PILOT_PATCHES);

  test("the CLI with its default patches file reproduces the committed e-pilot-patches.json byte for byte", () => {
    const out = join(tempDir(), "e-pilot.json");
    const child = draw(["--seed", SEED, "--out", out]);
    assert.equal(child.status, 0, child.stderr);
    assert.ok(readFileSync(out).equals(readFileSync(COMMITTED)));
  });

  test("the same seed gives the same file", () => {
    assert.ok(readFileSync(drawTo(SEED)).equals(readFileSync(drawTo(SEED))));
  });

  test("it holds 7 wrong then 3 correct entries, all distinct", () => {
    const selected = readEntries(COMMITTED);
    assert.equal(selected.length, 10);
    assert.ok(selected.slice(0, 7).every((entry) => entry.label_stratum === "swe_abs_wrong"));
    assert.ok(selected.slice(7).every((entry) => entry.label_stratum === "swe_abs_correct"));
    assert.equal(new Set(selected.map(key)).size, 10);
  });

  test("every entry is present unchanged in pilot-patches.json", () => {
    const byKey = new Map(pilot.map((entry) => [key(entry), entry]));
    for (const entry of readEntries(COMMITTED)) {
      assert.deepEqual(entry, byKey.get(key(entry)));
      assert.deepEqual(Object.keys(entry), Object.keys(byKey.get(key(entry)) as Entry));
    }
  });

  test("no entry is in main-patches.json", () => {
    const main = new Set(readEntries(MAIN_PATCHES).map(key));
    for (const entry of readEntries(COMMITTED)) {
      assert.ok(!main.has(key(entry)), key(entry));
    }
  });

  test("a different seed gives a different selection", () => {
    const other = selectStrata(pilot, "20261103", E_PILOT_STRATA).map(key);
    assert.notDeepEqual(other, readEntries(COMMITTED).map(key));
    assert.equal(other.length, 10);
  });

  test("the selection does not depend on the order of the patches file", () => {
    const reversed = selectStrata([...pilot].reverse(), SEED, E_PILOT_STRATA).map(key);
    assert.deepEqual(reversed, readEntries(COMMITTED).map(key));
  });

  const refusals: Array<[string, string[], RegExp]> = [
    ["a missing seed", [], /--seed is required/],
    ["a seed that is not digits", ["--seed", "abc"], /--seed must be digits/],
  ];
  for (const [name, args, message] of refusals) {
    test(`refuses ${name} with exit 2 and the usage line`, () => {
      const out = join(tempDir(), "e-pilot.json");
      const child = draw([...args, "--out", out]);
      assert.equal(child.status, 2);
      assert.match(child.stderr, message);
      assert.match(child.stderr, /usage: node harness\/draw-e-pilot.ts/);
      assert.ok(!existsSync(out));
    });
  }

  test("refuses a patches file whose strata counts differ from the pilot's", () => {
    const dir = tempDir();
    const patches = join(dir, "patches.json");
    const index = pilot.findIndex((entry) => entry.label_stratum === "swe_abs_wrong");
    writeFileSync(patches, JSON.stringify(pilot.filter((_, i) => i !== index)));
    assert.throws(
      () => runEPilotDraw({ patchesPath: patches, seed: SEED, outPath: join(dir, "out.json") }),
      RepeatDrawRefusal,
    );
    const child = draw(["--patches", patches, "--seed", SEED, "--out", join(dir, "out.json")]);
    assert.equal(child.status, 2);
    assert.match(child.stderr, /stratum counts differ/);
    assert.ok(!existsSync(join(dir, "out.json")));
  });
});
