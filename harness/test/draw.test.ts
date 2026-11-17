import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  correctFrame,
  CORRECT_STRATUM,
  CORRECT_TIERS,
  DrawRefusal,
  drawStratum,
  EXCLUDED_AGENTS,
  mainFrames,
  PILOT_CORRECT_INSTANCES,
  PILOT_WRONG_INSTANCES,
  PINNED_FRAME_SIZES,
  PINNED_VERDICTS_SHA256,
  randomStream,
  runDraw,
  WRONG_STRATUM,
  WRONG_TIERS,
  wrongFrame,
  type DrawEntry,
  type Frame,
  type VerdictRecord,
} from "../draw.ts";

const DRAW_SCRIPT = join(import.meta.dirname, "..", "draw.ts");
const SEED = "fixture-seed";

function record(instance_id: string, agent_id: string, original: boolean, sweAbs: boolean): VerdictRecord {
  return { instance_id, agent_id, original_tests_passed: original, swe_abs_tests_passed: sweAbs };
}

function instanceId(index: number): string {
  return `django__django-${String(20000 + index)}`;
}

function agentId(index: number): string {
  return `agent-${String(index).padStart(2, "0")}`;
}

function syntheticFrame(instances: number, agents: number): Frame {
  const agentIds = Array.from({ length: agents }, (_, index) => agentId(index));
  return Array.from({ length: instances }, (_, index) => ({ instance_id: instanceId(index), agents: agentIds }));
}

function syntheticRecords(wrongInstances: number, correctInstances: number, agents: number): VerdictRecord[] {
  const records: VerdictRecord[] = [];
  for (let i = 0; i < wrongInstances; i += 1) {
    for (let a = 0; a < agents; a += 1) {
      records.push(record(instanceId(i), agentId(a), true, false));
      if (i < correctInstances) records.push(record(instanceId(i), `correct-${agentId(a)}`, true, true));
    }
  }
  return records;
}

function countAgents(entries: readonly DrawEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.agent_id, (counts.get(entry.agent_id) ?? 0) + 1);
  return counts;
}

function highestCount(entries: readonly DrawEntry[]): number {
  return Math.max(0, ...countAgents(entries).values());
}

function writeVerdicts(records: VerdictRecord[]): { dir: string; path: string; sha256: string } {
  const dir = mkdtempSync(join(tmpdir(), "draw-test-"));
  const path = join(dir, "verdicts.json");
  const body = JSON.stringify({ records });
  writeFileSync(path, body);
  return { dir, path, sha256: createHash("sha256").update(body).digest("hex") };
}

describe("frames", () => {
  const records = [
    record("django__django-20001", "agent-b", true, false),
    record("django__django-20001", "agent-a", true, false),
    record("django__django-20001", "agent-c", true, true),
    record("django__django-20001", "agent-d", false, false),
    record("django__django-20002", "agent-a", true, true),
    record("django__django-20003", "agent-a", false, true),
    record("django__django-10097", "agent-a", true, false),
    record("django__django-10097", "agent-b", true, true),
    record("django__django-10973", "agent-a", true, false),
    record("django__django-10880", "agent-a", true, false),
    record("sympy__sympy-20001", "agent-a", true, false),
    record("xdjango__django-20001", "agent-a", true, false),
  ];

  test("the wrong frame holds agents that passed the scored tests and failed SWE-ABS", () => {
    assert.deepEqual(wrongFrame(records), [{ instance_id: "django__django-20001", agents: ["agent-a", "agent-b"] }]);
  });

  test("the correct frame holds agents that passed both, only where the instance has a wrong patch", () => {
    assert.deepEqual(correctFrame(records), [{ instance_id: "django__django-20001", agents: ["agent-c"] }]);
  });

  test("file order does not change a frame", () => {
    const reversed = [...records].reverse();
    assert.deepEqual(wrongFrame(reversed), wrongFrame(records));
    assert.deepEqual(correctFrame(reversed), correctFrame(records));
  });
});

describe("excluded agents", () => {
  const excluded = "20260217_mini-v2.0.0_glm-5-high";
  const kept = "20260301_mini-v9.9.9_kept";
  const records = [
    record("django__django-20001", excluded, true, false),
    record("django__django-20001", kept, true, false),
    record("django__django-20001", excluded, true, true),
    record("django__django-20001", kept, true, true),
    record("django__django-20002", excluded, true, false),
    record("django__django-20002", kept, true, true),
    record("django__django-20003", kept, true, false),
    record("django__django-20003", excluded, true, true),
  ];

  test("the set holds the 11 agents with no public patches", () => {
    assert.equal(EXCLUDED_AGENTS.size, 11);
    assert.ok(EXCLUDED_AGENTS.has(excluded));
    assert.ok(!EXCLUDED_AGENTS.has(kept));
  });

  test("the wrong frame drops an excluded agent and any instance only it filled", () => {
    assert.deepEqual(wrongFrame(records), [
      { instance_id: "django__django-20001", agents: [kept] },
      { instance_id: "django__django-20003", agents: [kept] },
    ]);
  });

  test("the correct frame drops an excluded agent and needs a wrong patch from a kept agent", () => {
    assert.deepEqual(correctFrame(records), [{ instance_id: "django__django-20001", agents: [kept] }]);
  });
});

describe("randomStream", () => {
  test("replays from sha256 of seed, stratum and counter", () => {
    const digest = createHash("sha256").update("s:wrong:0").digest();
    assert.equal(randomStream("s", "wrong")(1000), digest.readUIntBE(0, 6) % 1000);
  });

  test("rejects values past the last whole multiple of the bound", () => {
    const bound = 2 ** 47 + 1;
    const raw = (counter: number) => createHash("sha256").update(`s:t:${counter}`).digest().readUIntBE(0, 6);
    const firstAccepted = Array.from({ length: 64 }, (_, counter) => raw(counter)).findIndex((value) => value < bound);
    assert.ok(firstAccepted > 0, "the fixture seed needs at least one rejected value");
    assert.equal(randomStream("s", "t")(bound), raw(firstAccepted));
  });
});

describe("drawStratum", () => {
  const options = { seed: SEED, stratum: WRONG_STRATUM, caps: WRONG_TIERS };

  test("the same inputs give identical output", () => {
    const frame = syntheticFrame(103, 30);
    assert.deepEqual(drawStratum(frame, options), drawStratum(frame, options));
  });

  test("a different seed gives a different order", () => {
    const frame = syntheticFrame(103, 30);
    const order = (seed: string) => drawStratum(frame, { ...options, seed }).entries.map((e) => e.instance_id);
    assert.notDeepEqual(order("seed-a"), order("seed-b"));
  });

  test("frame order does not change the result", () => {
    const frame = syntheticFrame(103, 30);
    const shuffled = [...frame].reverse().map((i) => ({ ...i, agents: [...i.agents].reverse() }));
    assert.deepEqual(drawStratum(shuffled, options), drawStratum(frame, options));
  });

  test("the wrong stratum labels roles by position and keeps every cap", () => {
    const { entries } = drawStratum(syntheticFrame(103, 16), options);
    assert.deepEqual(
      entries.map((entry) => entry.position),
      Array.from({ length: 103 }, (_, index) => index + 1),
    );
    for (const entry of entries) {
      const expected = entry.position <= 60 ? "main" : entry.position <= 75 ? "extension" : "reserve";
      assert.equal(entry.role, expected);
    }
    assert.ok(highestCount(entries.slice(0, 60)) <= 6);
    assert.ok(highestCount(entries.slice(0, 75)) <= 7);
    assert.ok(highestCount(entries) <= 7);
  });

  test("the correct stratum holds exactly 30 positions under a cap of 3", () => {
    const { entries } = drawStratum(syntheticFrame(93, 12), {
      seed: SEED,
      stratum: CORRECT_STRATUM,
      caps: CORRECT_TIERS,
    });
    assert.equal(entries.length, 30);
    assert.ok(entries.every((entry) => entry.role === "correct"));
    assert.ok(highestCount(entries) <= 3);
  });

  test("each entry carries the patch URL pattern", () => {
    const [entry] = drawStratum(syntheticFrame(1, 1), options).entries;
    assert.deepEqual(entry, {
      position: 1,
      instance_id: instanceId(0),
      agent_id: agentId(0),
      role: "main",
      patch_url: `https://swe-bench-submissions.s3.amazonaws.com/verified/${agentId(0)}/logs/${instanceId(0)}/patch.diff`,
    });
  });

  test("an instance with no agent under its cap moves to the end and is listed", () => {
    const frame: Frame = [
      { instance_id: "django__django-a", agents: [agentId(0)] },
      { instance_id: "django__django-b", agents: [agentId(0)] },
      { instance_id: "django__django-c", agents: [agentId(1)] },
    ];
    const caps = [
      { through: 2, cap: 1, role: "first" },
      { through: 3, cap: 2, role: "second" },
    ];
    const draws = Array.from({ length: 50 }, (_, index) => drawStratum(frame, { seed: SEED, stratum: `t${index}`, caps }));
    const deferring = draws.filter((draw) => draw.cap_deferred.length > 0);
    assert.ok(deferring.length > 0, "the fixture needs at least one draw that defers");
    for (const { entries, cap_deferred, unplaced } of deferring) {
      assert.equal(entries.length, 3);
      assert.equal(cap_deferred.length, 1);
      assert.equal(entries[2].instance_id, cap_deferred[0]);
      assert.equal(entries[2].role, "second");
      assert.deepEqual(unplaced, []);
    }
  });

  test("an instance that stays over its cap is listed as deferred and unplaced", () => {
    const frame = syntheticFrame(4, 1);
    const { entries, cap_deferred, unplaced } = drawStratum(frame, { ...options, caps: [{ through: 4, cap: 1, role: "only" }] });
    assert.equal(entries.length, 1);
    assert.equal(cap_deferred.length, 3);
    assert.deepEqual(unplaced, cap_deferred);
    assert.ok(!cap_deferred.includes(entries[0].instance_id));
  });
});

describe("pilot exclusion", () => {
  const pilotWrong = "django__django-15375";
  const pilotCorrect = "django__django-15930";
  const kept = "django__django-20001";
  const records = [pilotWrong, pilotCorrect, kept].flatMap((id) => [
    record(id, "agent-a", true, false),
    record(id, "agent-b", true, true),
  ]);
  const ids = (frame: Frame) => frame.map((instance) => instance.instance_id);

  test("the pilot sets equal pilot-patches.json by label stratum", () => {
    const patches: { instance_id: string; label_stratum: string }[] = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "checks", "pilot-patches.json"), "utf8"),
    );
    const inStratum = (stratum: string) =>
      new Set(patches.filter((patch) => patch.label_stratum === stratum).map((patch) => patch.instance_id));
    assert.equal(patches.length, 20);
    assert.deepEqual(new Set(PILOT_WRONG_INSTANCES), inStratum("swe_abs_wrong"));
    assert.deepEqual(new Set(PILOT_CORRECT_INSTANCES), inStratum("swe_abs_correct"));
  });

  test("a pilot-wrong id leaves both main frames", () => {
    const { wrong, correct } = mainFrames(records);
    assert.ok(!ids(wrong).includes(pilotWrong));
    assert.ok(!ids(correct).includes(pilotWrong));
  });

  test("a pilot-correct id leaves only the main correct frame", () => {
    const { wrong, correct } = mainFrames(records);
    assert.ok(ids(wrong).includes(pilotCorrect));
    assert.ok(!ids(correct).includes(pilotCorrect));
  });

  test("an id outside the pilot stays in both main frames", () => {
    const { wrong, correct } = mainFrames(records);
    assert.deepEqual(ids(wrong), [pilotCorrect, kept]);
    assert.deepEqual(ids(correct), [kept]);
  });

  test("wrongFrame and correctFrame still return the pilot ids", () => {
    assert.deepEqual(ids(wrongFrame(records)), [pilotWrong, pilotCorrect, kept].sort());
    assert.deepEqual(ids(correctFrame(records)), [pilotWrong, pilotCorrect, kept].sort());
  });

  test("runDraw draws from the main frames", () => {
    const { dir, path, sha256 } = writeVerdicts(records);
    const outPath = join(dir, "draw.json");
    assert.throws(
      () => runDraw({ verdictsPath: path, seed: SEED, outPath, pinnedSha256: sha256, frameSizes: { wrong: 3, correct: 3 } }),
      /frame sizes wrong=2 correct=1 differ/,
    );
  });
});

describe("runDraw", () => {
  const records = syntheticRecords(80, 40, 20);
  const sizes = { wrong: 80, correct: 40 };

  test("the pins match the approved verdict file and frame sizes", () => {
    assert.equal(PINNED_VERDICTS_SHA256, "8c9d31cca70b02852144111e85f72bfe749d6a95745556b156b984c5d650228d");
    assert.deepEqual(PINNED_FRAME_SIZES, { wrong: 83, correct: 70 });
  });

  test("writes the seed, hash, sizes, deferrals and entries, with no patch text", () => {
    const { dir, path, sha256 } = writeVerdicts(records);
    const outPath = join(dir, "nested", "draw.json");
    runDraw({ verdictsPath: path, seed: SEED, outPath, pinnedSha256: sha256, frameSizes: sizes });
    const output = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(output.seed, SEED);
    assert.equal(output.verdicts_sha256, sha256);
    assert.deepEqual(output.frame_sizes, sizes);
    assert.deepEqual(output.cap_deferred, { wrong: [], correct: [] });
    assert.equal(output.wrong.length, 80);
    assert.equal(output.correct.length, 30);
    assert.deepEqual(Object.keys(output.wrong[0]).sort(), ["agent_id", "instance_id", "patch_url", "position", "role"]);
  });

  test("refuses without writing on a missing seed", () => {
    const { dir, path, sha256 } = writeVerdicts(records);
    const outPath = join(dir, "draw.json");
    assert.throws(
      () => runDraw({ verdictsPath: path, seed: undefined, outPath, pinnedSha256: sha256, frameSizes: sizes }),
      DrawRefusal,
    );
    assert.equal(existsSync(outPath), false);
  });

  test("refuses without writing on a different file hash", () => {
    const { dir, path } = writeVerdicts(records);
    const outPath = join(dir, "draw.json");
    assert.throws(
      () => runDraw({ verdictsPath: path, seed: SEED, outPath, pinnedSha256: "0".repeat(64), frameSizes: sizes }),
      /differs from the pinned/,
    );
    assert.equal(existsSync(outPath), false);
  });

  test("refuses without writing on either wrong frame size", () => {
    const { dir, path, sha256 } = writeVerdicts(records);
    const outPath = join(dir, "draw.json");
    for (const frameSizes of [{ wrong: 79, correct: 40 }, { wrong: 80, correct: 41 }]) {
      assert.throws(
        () => runDraw({ verdictsPath: path, seed: SEED, outPath, pinnedSha256: sha256, frameSizes }),
        /frame sizes/,
      );
    }
    assert.equal(existsSync(outPath), false);
  });

  test("refuses without writing when the caps leave too few positions", () => {
    const tooFewAgents = syntheticRecords(80, 40, 1);
    const { dir, path, sha256 } = writeVerdicts(tooFewAgents);
    const outPath = join(dir, "draw.json");
    assert.throws(
      () => runDraw({ verdictsPath: path, seed: SEED, outPath, pinnedSha256: sha256, frameSizes: sizes }),
      /too few positions/,
    );
    assert.equal(existsSync(outPath), false);
  });
});

describe("CLI", () => {
  function runCli(args: string[]) {
    return spawnSync(process.execPath, [DRAW_SCRIPT, ...args], { encoding: "utf8" });
  }

  test("exits non-zero without writing when --seed is missing", () => {
    const { dir, path } = writeVerdicts([]);
    const outPath = join(dir, "draw.json");
    const result = runCli(["--verdicts", path, "--out", outPath]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--seed is required/);
    assert.equal(existsSync(outPath), false);
  });

  test("exits non-zero without writing when the file hash differs from the pin", () => {
    const { dir, path } = writeVerdicts([]);
    const outPath = join(dir, "draw.json");
    const result = runCli(["--verdicts", path, "--seed", SEED, "--out", outPath]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /differs from the pinned/);
    assert.equal(existsSync(outPath), false);
  });

  test("offers no flag that overrides the pins", () => {
    const { dir, path, sha256 } = writeVerdicts([]);
    const outPath = join(dir, "draw.json");
    const result = runCli(["--verdicts", path, "--seed", SEED, "--out", outPath, "--pinned-sha256", sha256]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(outPath), false);
  });
});
