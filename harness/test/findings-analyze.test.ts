import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { analyze, PATCH_OUTCOMES } from "../../papers/cr-effort-claude-5.5/findings/artifact/analysis/analyze.ts";
import { reviewLevel, type CodeRecord } from "../../papers/cr-effort-claude-5.5/findings/artifact/analysis/collect.ts";
import { fig7 } from "../../papers/cr-effort-claude-5.5/findings/artifact/analysis/figures.ts";
import { FINDINGS } from "../../papers/cr-effort-claude-5.5/findings/artifact/analysis/packet-lib.ts";
import type { Pass } from "../../papers/cr-effort-claude-5.5/findings/artifact/analysis/packets.ts";
import { coerceFinal, loadVerdicts, settle, type JOrder, type SettledRecord } from "../../papers/cr-effort-claude-5.5/findings/artifact/analysis/settle.ts";
import { ARMS, MODELS } from "../../papers/cr-effort-claude-5.5/artifact/analysis/svg.ts";

const SETTLE = join(FINDINGS, "artifact", "analysis", "settle.ts");
const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "findings-analyze-")); roots.push(d); return d; };

const record = (pass: Pass, item: string, A: Record<string, unknown> | null, B: Record<string, unknown> | null): CodeRecord => ({
  pass, item, batch: `${pass}-01`, model: "opus", effort: "low", instance_id: "django__django-1", agent_id: "agent", label: "wrong", rule: "L1", is_decoy: false,
  A, B, ...(pass === "M" ? { derived: { A: A && reviewLevel(A), B: B && reviewLevel(B) } } : {}),
});
const mItem = (item: string, scores: [number, string, number][], feedback: [string, number][] = []) => ({
  item, no_codable_finding: false, claims: [], pairs: scores.map(([finding, gold, score]) => ({ finding, gold, score, why: "w" })), feedback: feedback.map(([gold, score]) => ({ gold, score, why: "w" })),
});
const aItem = (item: string, concern: string, feedback: [string, number][]) => ({ item, concern, why: "w", feedback: feedback.map(([gold, score]) => ({ gold, score, why: "w" })) });

const reply = (o: { final: string; basis: string; item?: string; field?: string }) =>
  `reasoning\n\n\`\`\`toon\nitem: "${o.item ?? "X"}"\nfield: "${o.field ?? "f"}"\nfinal: "${o.final}"\nbasis: "${o.basis}"\nrule_cited: "Section 7, score table"\nwhy: "secret"\n\`\`\`\n`;

function jDir(entries: { order: JOrder; reply?: string }[]): string {
  const dir = tmp();
  mkdirSync(join(dir, "prompts"));
  for (const { order, reply: r } of entries) {
    const id = `${order.pass}.${order.item}.${order.field.replace(/[^A-Za-z0-9]+/g, "_").replace(/_$/, "")}`;
    writeFileSync(join(dir, "prompts", `${id}.order.json`), JSON.stringify(order));
    if (r !== undefined) writeFileSync(join(dir, `${id}.J.md`), r);
  }
  return dir;
}

const pairField = "pairs[finding=1,gold=G1].score";
const fixture = () => {
  const records = [
    record("M", "M1", mItem("M1", [[1, "G1", 2]]), mItem("M1", [[1, "G1", 0]])),
    record("A", "A1", aItem("A1", "C2", [["G1", 1]]), aItem("A1", "C2", [["G1", 0], ["G2", 2]])),
    record("A", "A2", null, aItem("A2", "C0", [["G1", 0]])),
  ];
  const entries = [
    { order: { pass: "M", item: "M1", field: pairField, code_A: 2, code_B: 0, X: "A", Y: "B" } as JOrder, reply: reply({ final: "0", basis: "Y" }) },
    { order: { pass: "A", item: "A1", field: "feedback[gold=G1].score", code_A: 1, code_B: 0, X: "B", Y: "A" } as JOrder, reply: reply({ final: "0", basis: "X" }) },
  ];
  return { records, entries };
};

describe("settle", () => {
  test("maps X and Y back to coders A and B through the order file", () => {
    const { records, entries } = fixture();
    const { errors, records: settled, log } = settle(records, loadVerdicts(jDir(entries)));
    assert.deepEqual(errors, []);
    const a1 = settled.find((r) => r.item === "A1")!;
    assert.equal(a1.sources["feedback[gold=G1].score"], "b");
    assert.deepEqual((a1.final.feedback as object[])[0], { gold: "G1", score: 0 });
    assert.deepEqual(log.map((l) => [l.item, l.basis, l.final]), [["M1", "b", 0], ["A1", "b", 0]]);
    assert.ok(!JSON.stringify(log).includes("secret"));
  });

  test("a final that contradicts the chosen coder's code is rejected", () => {
    const { records, entries } = fixture();
    entries[1].reply = reply({ final: "1", basis: "X" });
    const { errors } = settle(records, loadVerdicts(jDir(entries)));
    assert.ok(errors.some((e) => /A A1 feedback\[gold=G1\]\.score: .*not coder B's code 0/.test(e)), errors.join("\n"));
  });

  test("re-derives review_level from the settled pair score, with no J reply on review_level", () => {
    const { records, entries } = fixture();
    const m1 = settle(records, loadVerdicts(jDir(entries))).records.find((r) => r.item === "M1")!;
    assert.deepEqual((m1.final.pairs as object[])[0], { finding: 1, gold: "G1", score: 0 });
    assert.equal(m1.derived!.review_level, "other");
    assert.equal(m1.derived!.binary, 0);
    assert.equal(m1.derived!.sensitivity, 0);
  });

  test("keeps the lower score on a non-deciding M pair that J never saw", () => {
    const records = [record("M", "M2", mItem("M2", [[1, "G1", 2], [2, "G1", 1]]), mItem("M2", [[1, "G1", 2], [2, "G1", 0]]))];
    const { errors, records: [m2] } = settle(records, loadVerdicts(jDir([])));
    assert.deepEqual(errors, []);
    assert.equal(m2.sources["pairs[finding=2,gold=G1].score"], "lower_unadjudicated");
    assert.equal(m2.derived!.review_level, "named");
  });

  test("tags entries and items present for one coder only", () => {
    const { records, entries } = fixture();
    const settled = settle(records, loadVerdicts(jDir(entries))).records;
    const a1 = settled.find((r) => r.item === "A1")!;
    assert.equal(a1.sources["feedback[gold=G2].score"], "one_coder");
    assert.deepEqual((a1.final.feedback as object[])[1], { gold: "G2", score: 2 });
    const a2 = settled.find((r) => r.item === "A2")!;
    assert.equal(a2.coders, "B");
    assert.equal(a2.sources.item, "one_coder");
    assert.equal(a2.final.concern, "C0");
  });

  test("fails when a disagreement has no parsable J reply", () => {
    const { records, entries } = fixture();
    const missing = settle(records, loadVerdicts(jDir([entries[0], { order: entries[1].order }])));
    assert.ok(missing.errors.some((e) => /^A A1 feedback\[gold=G1\]\.score: reply .* is missing/.test(e)), missing.errors.join("\n"));
    assert.deepEqual(missing.records, []);
    const garbled = settle(records, loadVerdicts(jDir([entries[0], { order: entries[1].order, reply: "no block\n" }])));
    assert.ok(garbled.errors.some((e) => /no fenced toon block/.test(e)), garbled.errors.join("\n"));
  });

  test("coerces string finals to the coders' types", () => {
    assert.equal(coerceFinal("2", 1, "x.score"), 2);
    assert.equal(coerceFinal("false", true, "multi_claim"), false);
    assert.equal(coerceFinal("F_F-LOG_comp", "F/F-CHK/var", "findings[1].class_type_subtype"), "F/F-LOG/comp");
    assert.equal(coerceFinal("F/F-LOG/comp", "F/F-CHK/var", "findings[1].class_type_subtype"), "F/F-LOG/comp");
    assert.throws(() => coerceFinal("maybe", true, "redundant"));
  });

  test("the CLI exits non-zero on a missing J reply and writes the log on success", () => {
    const { records, entries } = fixture();
    const dir = tmp();
    const codes = join(dir, "codes.json");
    writeFileSync(codes, JSON.stringify(records));
    const gold = join(dir, "gold.json");
    writeFileSync(gold, JSON.stringify({ "django__django-1.agent": { behaviours: [{ id: "G1" }, { id: "G2" }], contested: [], dropped: [], changed: [] } }));
    const run = (j: string, out: string, log: string) =>
      spawnSync(process.execPath, [SETTLE, "--codes", codes, "--j", j, "--gold", gold, "--out", out, "--log", log], { encoding: "utf8", timeout: 60_000 });
    const failed = run(jDir([entries[0]]), join(dir, "bad"), join(dir, "bad.csv"));
    assert.notEqual(failed.status, 0);
    assert.ok(!existsSync(join(dir, "bad", "settled.json")));
    const ok = run(jDir(entries), join(dir, "good"), join(dir, "log.csv"));
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(existsSync(join(dir, "good", "settled.json")));
    const log = readFileSync(join(dir, "log.csv"), "utf8").split("\r\n");
    assert.equal(log[0], "pass,item,field,code_a,code_b,final,basis,rule_cited");
    assert.equal(log[1], `M,M1,"${pairField}",2,0,0,b,"Section 7, score table"`);
  });
});

describe("analyze", () => {
  const settledRecord = (pass: Pass, model: string, effort: string, patch: string, final: object, level?: string): SettledRecord => ({
    pass, item: `${model}${effort}${patch}${pass}`, batch: `${pass}-01`, model, effort, instance_id: patch, agent_id: "agent", label: "wrong", rule: patch === "p3" ? "L7" : "L1", is_decoy: false,
    coders: "both", final, sources: {},
    ...(level ? { derived: { review_level: level as "named", binary: level === "named" ? 1 : 0, sensitivity: level === "named" || level === "partial" ? 1 : 0, feedback_named: null } } : {}),
  });

  function fixtureCells() {
    const records: SettledRecord[] = [];
    const csv: Record<string, string>[] = [];
    for (const [model] of MODELS) for (const effort of ARMS) {
      records.push(settledRecord("M", model, effort, "p1", { pairs: [] }, effort === "low" ? "partial" : "named"));
      records.push(settledRecord("M", model, effort, "p3", { pairs: [] }, "no_codable_finding"));
      records.push(settledRecord("A", model, effort, "p2", { concern: "C2", feedback: [{ gold: "G1", score: 2 }] }));
      for (const p of ["p1", "p3"]) csv.push({ review_id: `${model}-${effort}-${p}-agent`, n_findings: p === "p1" ? "2" : "0", verdict_status: p === "p1" ? "fail" : "malformed" });
    }
    return { records, csv };
  }

  test("patch outcomes sum to the patch count in every cell", () => {
    const { records, csv } = fixtureCells();
    const f = analyze({ settled: { gold: {}, records }, agreement: {}, findingsCsv: csv });
    assert.equal(f.patches, 3);
    for (const [model] of MODELS) for (const effort of ARMS) {
      const cell = (f.by_model as Record<string, Record<string, { patch_outcomes: Record<string, number>; right_reason: { named: { k: number } } }>>)[model][effort];
      assert.equal(PATCH_OUTCOMES.reduce((s, o) => s + cell.patch_outcomes[o], 0), 3);
      assert.equal(cell.patch_outcomes.accepted_seen, 1);
      assert.equal(cell.patch_outcomes.rejected_other, 1);
      assert.equal(cell.right_reason.named.k, effort === "low" ? 0 : 1);
    }
    assert.deepEqual((f.effort_steps.opus as Record<string, object>).low_medium, { gained: 1, lost: 0, both: 0, neither: 2 });
    const noL7 = (f.sensitivity as Record<string, Record<string, Record<string, { patches: number; rejections: number }>>>).no_L7.opus.high;
    assert.deepEqual([noL7.patches, noL7.rejections], [2, 1]);
    const svg = fig7(f.by_model as Parameters<typeof fig7>[0]);
    assert.match(svg, /<title id="t">/);
    assert.match(svg, /<desc id="d">100% stacked bars over the 3 wrong patches/);
  });

  test("refuses a cell that misses a wrong patch", () => {
    const { records, csv } = fixtureCells();
    const short = records.filter((r) => !(r.model === "haiku" && r.effort === "high" && r.instance_id === "p2"));
    assert.throws(() => analyze({ settled: { gold: {}, records: short }, agreement: {}, findingsCsv: csv }), /haiku\.high has no pass M or A item for p2\|agent/);
  });
});
