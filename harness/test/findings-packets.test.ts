import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { buildGoldPackets, failingTestUnion, type AbsRow } from "../../papers/cr-effort-claude-5.5/findings/artifact/analysis/gold-packets.ts";
import { fillSlots, FINDINGS, mulberry32, promptBlock } from "../../papers/cr-effort-claude-5.5/findings/artifact/analysis/packet-lib.ts";
import {
  blindKey, buildBatches, renderBatch, type PacketSources, type ReviewRecord,
} from "../../papers/cr-effort-claude-5.5/findings/artifact/analysis/packets.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const CODEBOOK = readFileSync(join(FINDINGS, "codebook.md"), "utf8");
const BLIND_KEY = join(FINDINGS, "artifact", "data", "blind-key.json");

describe("prompt slots", () => {
  test("fills every slot in one pass, so a value holding {{...}} stays as written", () => {
    assert.equal(fillSlots("a {{x}} b {{y}}", { x: "{{y}}", y: "2" }), "a {{y}} b 2");
  });

  test("refuses a slot with no value", () => {
    assert.throws(() => fillSlots("{{missing}}", {}), /missing/);
  });

  test("reads the text block under a heading, including a four-backtick fence around inner fences", () => {
    const md = ["## Prompt", "", "````text", "line", "```toon", "x: 1", "```", "````", "## Item Template", "```text", "ITEM {{item_code}}", "```"].join("\n");
    assert.equal(promptBlock(md, "Prompt"), "line\n```toon\nx: 1\n```");
    assert.equal(promptBlock(md, "Item Template"), "ITEM {{item_code}}");
  });

  test("mulberry32 matches the generator of haiku-vs-opus blind.ts for its seed", () => {
    let a = 20261107;
    const reference = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const rand = mulberry32(20261107);
    for (let i = 0; i < 5; i++) assert.equal(rand(), reference());
  });
});

describe("gold packets", () => {
  test("the failing tests are the union over the runs, with the runs each failed in", () => {
    assert.deepEqual(failingTestUnion([["a", "b"], ["a"], ["a", "c"]]), [
      { test: "a", runs: [1, 2, 3] }, { test: "b", runs: [1] }, { test: "c", runs: [3] },
    ]);
  });

  function goldFixture() {
    const root = mkdtempSync(join(tmpdir(), "findings-gold-"));
    const runs = join(root, "runs");
    const labelCheck = join(root, "label-check");
    mkdirSync(join(labelCheck, "logs"), { recursive: true });
    const patches = [
      { instance_id: "django__django-1", agent_id: "agent", rule: "L2", failing: [["test_a (t.T.test_a)"], ["test_a (t.T.test_a)"], ["test_a (t.T.test_a)", "test_b (t.T.test_b)"]] },
      { instance_id: "django__django-2", agent_id: "agent", rule: "L7", failing: [[], [], []] },
    ];
    const pins: object[] = [];
    const absRows = new Map<string, AbsRow>();
    const inputs = { source: { dataset: "d", revision: "r" }, instances: {} as Record<string, object> };
    const labels = ["set,instance_id,agent_id,patch_sha256,original_label,rule,label,overlay"];
    for (const p of patches) {
      const diff = `+++ b/django/x.py\n+ candidate for ${p.instance_id}\n`;
      const row = { problem_statement: `Issue {{ template }} of ${p.instance_id}`, patch: `+ official fix of ${p.instance_id}\n`, test_patch: "verified tests\n" };
      mkdirSync(join(runs, "cache", p.instance_id), { recursive: true });
      writeFileSync(join(runs, "cache", p.instance_id, `${p.agent_id}.diff`), diff);
      writeFileSync(join(runs, "cache", p.instance_id, "dataset-row.json"), JSON.stringify(row));
      pins.push({ instance_id: p.instance_id, agent_id: p.agent_id, patch_sha256: sha256(diff), gold_patch_sha256: sha256(row.patch), problem_statement_sha256: sha256(row.problem_statement) });
      labels.push(`main,${p.instance_id},${p.agent_id},${sha256(diff)},wrong,${p.rule},wrong,`);
      const abs = { instance_id: p.instance_id, patch: row.patch, test_patch: `ABS TESTS ${p.instance_id}\n`, original_test_patch: "v", FAIL_TO_PASS: "[]", PASS_TO_PASS: "[]" };
      absRows.set(p.instance_id, abs);
      inputs.instances[p.instance_id] = { abs_test_patch_sha256: sha256(abs.test_patch), verified_test_patch_sha256: sha256("v"), fail_to_pass_sha256: sha256("[]"), pass_to_pass_sha256: sha256("[]") };
    }
    for (let run = 1; run <= 3; run++) {
      const log = ["FAIL: test_a (t.T.test_a)", "Docstring of a", "Traceback (most recent call last):", '  File "/testbed/tests/t.py", line 3, in test_a', "    self.assertEqual(1, 2)", `AssertionError: 1 != 2 in run ${run === 3 ? 3 : 1}`, "-----", "FAIL: test_b (t.T.test_b)", "Doc b", "Traceback:", "AssertionError: b", "====="].join("\n");
      writeFileSync(join(labelCheck, "logs", `django__django-1.agent.candidate.abs.${run}.log`), log);
    }
    writeFileSync(join(labelCheck, "label-check.json"), JSON.stringify({ verdicts: patches.map((p) => ({ instance_id: p.instance_id, agent_id: p.agent_id, abs_failing_tests: p.failing })) }));
    writeFileSync(join(root, "labels.csv"), labels.join("\n") + "\n");
    writeFileSync(join(root, "main-patches.json"), JSON.stringify(pins));
    return { root, runs, labelCheck, labels: join(root, "labels.csv"), mainPatches: join(root, "main-patches.json"), inputs, absRows, expected: 2 };
  }

  test("a test-defined packet holds every input and a reading packet holds only what the label check has", () => {
    const f = goldFixture();
    try {
      const { errors, packets } = buildGoldPackets(f);
      assert.deepEqual(errors, []);
      const [test, reading] = packets;
      assert.equal(test.basis, "test");
      assert.equal(test.slots.abs_test_patch, "ABS TESTS django__django-1\n");
      assert.equal(test.slots.tests_with_counts, "- test_a (t.T.test_a): failed in 3 of 3 runs\n- test_b (t.T.test_b): failed in 1 of 3 runs");
      assert.match(test.slots.excerpts, /runs 1, 2:\n {2}doc: Docstring of a\n.*\n {2}err: .*in run 1\nrun 3:/);
      assert.match(test.prompt, /BASIS: test/);
      assert.match(test.prompt, /CANDIDATE PATCH \(diff\):\n\+\+\+ b\/django\/x.py\n\+ candidate for django__django-1/);
      assert.match(test.prompt, /Issue \{\{ template \}\} of django__django-1/);
      assert.equal(reading.basis, "reading");
      assert.deepEqual([reading.slots.abs_test_patch, reading.slots.tests_with_counts, reading.slots.excerpts], ["none", "none", "none"]);
      assert.equal(reading.slots.gold_patch, "+ official fix of django__django-2\n");
      assert.doesNotMatch(reading.prompt, /\{\{\w+\}\}/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("reports a failed hash pin, a tampered SWE-ABS test patch and a count other than expected", () => {
    const f = goldFixture();
    try {
      writeFileSync(join(f.runs, "cache", "django__django-2", "agent.diff"), "tampered\n");
      f.absRows.set("django__django-1", { ...f.absRows.get("django__django-1")!, test_patch: "tampered\n" });
      const { errors, packets } = buildGoldPackets(f);
      assert.equal(packets.length, 0);
      assert.ok(errors.some((e) => e.startsWith("hash pin failed for") && e.includes("django__django-2")), errors.join("\n"));
      assert.ok(errors.includes("hash pin failed for the SWE-ABS abs test patch of django__django-1"), errors.join("\n"));
      assert.ok(errors.includes("0 gold packets, expected 2"), errors.join("\n"));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

const MODELS = ["opus", "sonnet", "haiku"];
const EFFORTS = ["low", "medium", "high"];

function records(): ReviewRecord[] {
  const out: ReviewRecord[] = [];
  let n = 0;
  for (const model of MODELS) for (const effort of EFFORTS) {
    const add = (label: string, verdict: ReviewRecord["verdict_status"]) => {
      n++;
      const instance = `django__django-${n}`;
      out.push({
        review_id: `${model}-${effort}-${instance}-agent`, model, effort, instance_id: instance, agent_id: "agent", label, rule: label === "wrong" ? "L2" : "L5",
        verdict_status: verdict, feedback: verdict === "malformed" ? null : `Feedback ${n} about the patch.`,
        findings: verdict === "fail" ? [{ location: "django/x.py:3", problem: `Problem ${n}` }] : [],
        final_message: verdict === "malformed" ? `Final message ${n}` : null,
      });
    };
    add("correct", "fail");
    add("wrong", "fail");
    add("wrong", "malformed");
    add("wrong", "pass");
  }
  return out;
}

const SOURCES: PacketSources = {
  patch: (r) => `+++ b/django/x.py\n+ change ${r.instance_id}\n`,
  official: (id) => ({ problem_statement: `Issue text ${id}. `.repeat(200), patch: `+ official ${id}\n` }),
};
const EXPECTED = { T: 27, M: 18, falseAlarms: 9, A: 9 };

describe("coder batches", () => {
  test("cuts each pass into batches of its size with codes unique across passes", () => {
    const { errors, batches } = buildBatches(records(), SOURCES, EXPECTED);
    assert.deepEqual(errors, []);
    const sizes = (pass: string) => batches.filter((b) => b.pass === pass).map((b) => b.items.length);
    assert.deepEqual(sizes("T"), [15, 12]);
    assert.deepEqual(sizes("M"), [15, 3]);
    assert.deepEqual(sizes("C"), [9, 9]);
    assert.deepEqual(sizes("A"), [9]);
    const key = blindKey(batches);
    assert.equal(new Set(key.map((e) => e.code)).size, key.length);
    assert.deepEqual(Object.keys(key[0]), ["code", "pass", "model", "effort", "instance_id", "agent_id", "label", "rule", "is_decoy"]);
  });

  test("decoys are wrong-patch rejections that match the false alarms' cell counts", () => {
    const key = blindKey(buildBatches(records(), SOURCES, EXPECTED).batches).filter((e) => e.pass === "C");
    const cells = (decoy: boolean) => key.filter((e) => e.is_decoy === decoy).map((e) => `${e.model}-${e.effort}`).sort();
    assert.deepEqual(cells(true), cells(false));
    assert.ok(key.filter((e) => e.is_decoy).every((e) => e.label === "wrong"));
    assert.ok(key.filter((e) => !e.is_decoy).every((e) => e.label === "correct"));
  });

  test("the same inputs give the same batches and key", () => {
    const once = JSON.stringify(blindKey(buildBatches(records(), SOURCES, EXPECTED).batches));
    assert.equal(JSON.stringify(blindKey(buildBatches(records(), SOURCES, EXPECTED).batches)), once);
  });

  test("an item carries no model, effort, run name or review id", () => {
    for (const batch of buildBatches(records(), SOURCES, EXPECTED).batches) {
      for (const item of batch.items) {
        const text = JSON.stringify(item.slots);
        for (const hidden of [item.review.review_id, item.review.model, `"${item.review.effort}"`]) assert.ok(!text.includes(hidden), `${hidden} in ${batch.pass} item`);
      }
    }
  });

  test("reports a count other than expected", () => {
    const { errors } = buildBatches(records(), SOURCES, { ...EXPECTED, A: 290 });
    assert.deepEqual(errors, ["9 A items, expected 290"]);
  });

  test("M and A prompts wait for the gold; T and C prompts render with the codebook", () => {
    const { batches } = buildBatches(records(), SOURCES, EXPECTED);
    for (const b of batches) {
      const prompt = renderBatch(b, CODEBOOK);
      if (b.pass === "M" || b.pass === "A") assert.equal(prompt, null);
      else {
        assert.ok(prompt!.includes(CODEBOOK));
        assert.doesNotMatch(prompt!, /\{\{\w+\}\}/);
        for (const item of b.items) assert.ok(prompt!.includes(`ITEM ${item.code}`));
      }
    }
  });
});

describe("SC4: pass C stays label-blind", () => {
  test("the codebook no longer says decoys are expected to be real_in_scope", () => {
    assert.ok(!CODEBOOK.includes("Expected for decoys"));
  });

  test("no rendered C packet names decoys, false alarms, a reviewer model or the review's effort", () => {
    const { batches } = buildBatches(records(), SOURCES, EXPECTED);
    const c = batches.filter((b) => b.pass === "C");
    assert.ok(c.length > 0);
    for (const b of c) {
      const packet = renderBatch(b, CODEBOOK)!.replace(CODEBOOK, "");
      for (const banned of [/decoy/i, /false alarm/i, /\bhaiku\b/i, /\bsonnet\b/i, /\bopus\b/i, /\b(low|medium|high)\b/i]) {
        assert.doesNotMatch(packet, banned);
      }
    }
  });
});

describe("committed blind key", () => {
  test("holds one entry per T, M, C and A item, with no review text", () => {
    const key = JSON.parse(readFileSync(BLIND_KEY, "utf8")) as Record<string, unknown>[];
    assert.equal(key.length, 232 + 205 + 54 + 290);
    const count = (pass: string) => key.filter((e) => e.pass === pass).length;
    assert.deepEqual([count("T"), count("M"), count("C"), count("A")], [232, 205, 54, 290]);
    assert.equal(key.filter((e) => e.is_decoy === true).length, 27);
    for (const e of key) assert.deepEqual(Object.keys(e), ["code", "pass", "model", "effort", "instance_id", "agent_id", "label", "rule", "is_decoy"]);
  });
});
