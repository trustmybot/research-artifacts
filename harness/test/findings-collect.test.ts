import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  agreement, clusteredAgreement, collectCodes, disagreements, lastToonBlock, nominalAgreement, normalizeCode, reviewLevel,
  type CodeRecord,
} from "../../papers/cr-effort-claude-5.5/findings/artifact/analysis/collect.ts";
import { FINDINGS } from "../../papers/cr-effort-claude-5.5/findings/artifact/analysis/packet-lib.ts";
import type { BlindKeyEntry, Pass } from "../../papers/cr-effort-claude-5.5/findings/artifact/analysis/packets.ts";

const COLLECT = join(FINDINGS, "artifact", "analysis", "collect.ts");
const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

describe("nominal agreement", () => {
  test("binary κ and AC1 match the hand-computed values", () => {
    const pairs: [number, number][] = [
      ...Array(4).fill([1, 1]), [1, 0], ...Array(2).fill([0, 1]), ...Array(3).fill([0, 0]),
    ];
    const s = nominalAgreement(pairs);
    // po = 0.7; κ: pe = 0.5·0.6 + 0.5·0.4 = 0.5; AC1: π1 = 0.55, π0 = 0.45, pe = (0.55·0.45 + 0.45·0.55) / (2 − 1) = 0.495.
    close(s.percent, 0.7);
    close(s.kappa, 0.4);
    close(s.ac1, 0.205 / 0.505);
  });

  test("three-category κ and AC1 match the hand-computed values", () => {
    const pairs: [string, string][] = [["a", "a"], ["b", "b"], ["c", "c"], ["a", "b"], ["b", "a"], ["c", "a"]];
    const s = nominalAgreement(pairs);
    // A: a, b, c at 1/3 each; B: a 3/6, b 2/6, c 1/6. κ pe = 1/3. AC1 π = 5/12, 4/12, 3/12, pe = (94/144) / 2 = 47/144.
    close(s.percent, 0.5);
    close(s.kappa, 0.25);
    close(s.ac1, 25 / 97);
  });

  test("declared categories the coders never used still count toward the AC1 q", () => {
    const pairs: [boolean, boolean][] = [[true, true], [true, true], [true, false]];
    // π_true = 5/6, π_false = 1/6, q = 2: pe = 10/36; po = 2/3.
    close(nominalAgreement(pairs, [true, false]).ac1, (2 / 3 - 10 / 36) / (1 - 10 / 36));
  });

  test("perfect agreement on one category is 1, not NaN", () => {
    const s = nominalAgreement([["x", "x"], ["x", "x"]]);
    assert.equal(s.kappa, 1);
    assert.equal(s.ac1, 1);
  });

  test("the bootstrap resamples whole items, is seeded, and brackets the estimate", () => {
    const clusters: [number, number][][] = [[[1, 1], [0, 0], [1, 0]], [[1, 1]], [[0, 1], [0, 0]], [[1, 1], [1, 1]], []];
    const s = clusteredAgreement(clusters, [0, 1], 500, 7)!;
    assert.equal(s.n, 8);
    assert.equal(s.n_items, 4);
    for (const k of ["percent", "kappa", "ac1"] as const) assert.ok(s[k].lower <= s[k].value && s[k].value <= s[k].upper, k);
    assert.deepEqual(clusteredAgreement(clusters, [0, 1], 500, 7), s);
    assert.equal(clusteredAgreement([[], []], [], 10, 1), null);
  });
});

describe("reply parsing", () => {
  test("takes the last toon block and strips an ITEM label from the code", () => {
    const reply = "text\n```toon\nitems[0]:\n```\nmore\n```toon\nitems[1]:\n  - item: \"X\"\n```\n";
    assert.equal(lastToonBlock(reply), "items[1]:\n  - item: \"X\"\n");
    assert.equal(normalizeCode(" ITEM ABC123 "), "ABC123");
    assert.equal(normalizeCode("ABC123"), "ABC123");
  });

  test("derives the pass M review-level codes from the scores", () => {
    const item = (scores: number[], feedback: number[], none = false) => ({
      no_codable_finding: none, pairs: scores.map((score, i) => ({ finding: i + 1, gold: "G1", score })), feedback: feedback.map((score) => ({ gold: "G1", score })),
    });
    assert.deepEqual(reviewLevel(item([0, 2, 1], [1])), { review_level: "named", binary: 1, sensitivity: 1, feedback_named: 1 });
    assert.deepEqual(reviewLevel(item([1, 0], [0, 2])), { review_level: "partial", binary: 0, sensitivity: 1, feedback_named: 2 });
    assert.deepEqual(reviewLevel(item([0, 0], [0])), { review_level: "other", binary: 0, sensitivity: 0, feedback_named: 0 });
    assert.deepEqual(reviewLevel(item([], [], true)), { review_level: "no_codable_finding", binary: 0, sensitivity: 0, feedback_named: null });
  });
});

type Replies = Record<string, string>;

const key = (code: string, pass: Pass, model = "opus"): BlindKeyEntry => ({
  code, pass, model, effort: "high", instance_id: `django__django-${code}`, agent_id: "agent", label: "wrong", rule: "L2", is_decoy: false,
});

const tFinding = (n: number, type: string, subtype: string, flag = "none", multi = false) =>
  `      - n: ${n}\n        claim: null\n        class: "${type[0]}"\n        type: "${type}"\n        subtype: "${subtype}"\n        quality_flag: "${flag}"\n        multi_claim: ${multi}\n        unsure: false\n        why: "${type} because"`;
const tItem = (code: string, repro: string, guess: string, findings: string[]) =>
  `  - item: "${code}"\n    reproduction: "${repro}"\n    model_guess: "${guess}"\n    no_codable_finding: false\n    findings[${findings.length}]:\n${findings.join("\n")}`;
const mItem = (code: string, scores: number[], feedback: number) =>
  `  - item: "${code}"\n    no_codable_finding: false\n    claims[0]:\n    pairs[${scores.length}]:\n${scores.map((s, i) => `      - finding: ${i + 1}\n        gold: "G1"\n        score: ${s}\n        unsure: false\n        why: "pair ${i + 1} scores ${s}"`).join("\n")}\n    feedback[1]:\n      - gold: "G1"\n        score: ${feedback}\n        unsure: false\n        why: "fb"`;
const cItem = (code: string, reality: string, outOfScope: boolean) =>
  `  - item: "${code}"\n    claims[0]:\n    main_finding: 1\n    reality: "${reality}"\n    false_positive_issue: false\n    redundant: false\n    out_of_scope: ${outOfScope}\n    overcorrection: false\n    environment_artifact: false\n    open: ""\n    unsure: false\n    why: "${reality} why"`;
const aItem = (code: string, concern: string, score: number) =>
  `  - item: "${code}"\n    concern: "${concern}"\n    unsure: false\n    why: "${concern} why"\n    feedback[1]:\n      - gold: "G1"\n        score: ${score}\n        unsure: false\n        why: "score ${score}"`;
const reply = (items: string[], header = items.length) => `Reasoning.\n\n\`\`\`toon\nitems[${header}]:\n${items.join("\n")}\n\`\`\`\n`;

// One batch per pass, with one coded disagreement in each, a model_guess disagreement, an "ITEM " label,
// a miscounted bracket and one item coder B left out.
function fixture(edit: (replies: Replies, key: BlindKeyEntry[]) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "findings-collect-"));
  roots.push(root);
  const batches: Record<Pass, string[]> = { T: ["T1", "T2"], M: ["M1", "M2", "M3"], C: ["C1"], A: ["A1"] };
  const blindKey = Object.entries(batches).flatMap(([pass, codes]) => codes.map((c) => key(c, pass as Pass)));
  for (const [pass, codes] of Object.entries(batches)) {
    mkdirSync(join(root, "batches", pass), { recursive: true });
    mkdirSync(join(root, "replies", pass), { recursive: true });
    writeFileSync(join(root, "batches", pass, `${pass}-01.json`), JSON.stringify({ pass, batch: 1, items: codes.map((code) => ({ code, slots: {} })) }));
  }
  const replies: Replies = {
    "T/T-01.A.md": reply([
      tItem("T1", "R0", "opus", [tFinding(1, "F-LOG", "cmp"), tFinding(2, "E-TXT", "none")]),
      tItem("T2", "R2", "opus", [tFinding(1, "F-CHK", "var")]),
    ], 3),
    "T/T-01.B.md": reply([
      tItem("ITEM T1", "R0", "haiku", [tFinding(1, "F-CHK", "var")]),
      tItem("ITEM T2", "R2", "unsure", [tFinding(1, "F-CHK", "var")]),
    ]),
    "M/M-01.A.md": reply([mItem("M1", [2, 0], 2), mItem("M2", [2, 0], 1), mItem("M3", [1], 1)]),
    "M/M-01.B.md": reply([mItem("M1", [1, 0], 2), mItem("M2", [2, 1], 1)]),
    "C/C-01.A.md": reply([cItem("C1", "not_real", true)]),
    "C/C-01.B.md": reply([cItem("C1", "real_shared", true)]),
    "A/A-01.A.md": reply([aItem("A1", "C2", 2)]),
    "A/A-01.B.md": reply([aItem("A1", "C2", 1)]),
  };
  edit(replies, blindKey);
  for (const [path, text] of Object.entries(replies)) writeFileSync(join(root, "replies", path), text);
  return { root, replies: join(root, "replies"), batches: join(root, "batches"), blindKey };
}

const collect = (f: ReturnType<typeof fixture>) => collectCodes({ replies: f.replies, batches: f.batches, blindKey: f.blindKey });

describe("collect on fixtures", () => {
  const f = fixture();
  const { errors, records } = collect(f);
  const found = disagreements(records);
  const stats = agreement(records, 200, 1);
  const fields = (pass: Pass) => found.filter((d) => d.pass === pass).map((d) => `${d.item} ${d.field}`);

  test("validates cleanly despite the ITEM label and the miscounted bracket", () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(records.map((r) => r.item), ["T1", "T2", "M1", "M2", "M3", "C1", "A1"]);
  });

  test("joins the blind-key fields and derives the pass M codes per coder", () => {
    const m1 = records.find((r) => r.item === "M1")!;
    assert.equal(m1.instance_id, "django__django-M1");
    assert.equal(m1.batch, "M-01");
    assert.equal(m1.derived!.A!.review_level, "named");
    assert.equal(m1.derived!.B!.review_level, "partial");
  });

  test("a missing item is reported, kept with null codes and left out of agreement and disagreements", () => {
    const m3 = records.find((r) => r.item === "M3")!;
    assert.equal(m3.B, null);
    assert.equal(m3.derived!.B, null);
    assert.deepEqual(stats.missing, [{ pass: "M", batch: "M-01", coder: "B", item: "M3" }]);
    assert.equal(stats.codes["M.review_level"]!.n, 2);
    assert.ok(!found.some((d) => d.item === "M3"));
  });

  test("lists one disagreement per pass on the adjudicable fields, never model_guess", () => {
    assert.deepEqual(fields("T"), ["T1 findings[1].class_type_subtype"]);
    const t = found.find((d) => d.pass === "T")!;
    assert.deepEqual([t.code_A, t.code_B, t.why_A, t.why_B], ["F/F-LOG/cmp", "F/F-CHK/var", "F-LOG because", "F-CHK because"]);
    // M2's pair 2 differs, but neither coder's maximum is on finding 2, so it is not a deciding finding.
    assert.deepEqual(fields("M"), ["M1 review_level", "M1 pairs[finding=1,gold=G1].score"]);
    assert.deepEqual(fields("C"), ["C1 reality"]);
    assert.deepEqual(fields("A"), ["A1 feedback[gold=G1].score"]);
    assert.ok(!found.some((d) => d.field.includes("model_guess")));
  });

  test("reports unaligned T findings, per-type agreement and the model guess against chance", () => {
    assert.deepEqual(stats.T_unaligned, { count: 1, findings: [{ item: "T1", n: 2, coder: "A" }] });
    assert.equal(stats.codes["T.class_type_subtype"]!.n, 2);
    assert.equal(stats.codes["T.class_type_subtype"]!.percent.value, 0.5);
    assert.deepEqual(Object.keys(stats.T_per_type), ["F-CHK", "F-LOG"]);
    assert.equal(stats.T_per_type["F-CHK"].coded_B, 2);
    assert.equal(stats.T_model_guess.chance, 1 / 3);
    assert.equal(stats.T_model_guess.A.correct, 2);
    assert.equal(stats.T_model_guess.B.correct, 0);
    assert.equal(stats.T_model_guess.B.unsure, 1);
  });

  test("covers every code the codebook names", () => {
    assert.deepEqual(Object.keys(stats.codes), [
      "T.class_type_subtype", "T.quality_flag", "T.multi_claim", "T.reproduction",
      "M.review_level", "M.review_level_binary", "M.feedback_named",
      "C.reality", "C.false_positive_issue", "C.redundant", "C.out_of_scope", "C.overcorrection", "C.environment_artifact",
      "A.concern", "A.feedback_score",
    ]);
  });
});

describe("fatal validation", () => {
  const fails = (edit: Parameters<typeof fixture>[0], pattern: RegExp) => {
    const { errors } = collect(fixture(edit));
    assert.ok(errors.some((e) => pattern.test(e)), errors.join("\n"));
  };

  test("an item that is not in the batch", () => fails((r) => { r["C/C-01.B.md"] = reply([cItem("C1", "not_real", true), cItem("ZZZ", "not_real", true)]); }, /batch C-01 coder B: item ZZZ is not in the batch/));
  test("a duplicate item in one reply", () => fails((r) => { r["C/C-01.B.md"] = reply([cItem("C1", "not_real", true), cItem("ITEM C1", "not_real", true)]); }, /batch C-01 coder B: item C1 appears twice/));
  test("a missing reply file", () => fails((r) => { delete r["A/A-01.B.md"]; }, /batch A-01 coder B: reply .* is missing/));
  test("an undecodable reply", () => fails((r) => { r["A/A-01.A.md"] = "no block here\n"; }, /batch A-01 coder A: no fenced toon block/));
  test("an item missing from blind-key.json", () => fails((_, k) => { k.splice(k.findIndex((e) => e.code === "C1"), 1); }, /batch C-01: item C1 is not in blind-key.json/));
  test("an item with the wrong pass in blind-key.json", () => fails((_, k) => { k.find((e) => e.code === "A1")!.pass = "C"; }, /batch A-01: item A1 is pass C in blind-key.json/));
});

describe("collect.ts CLI", () => {
  const run = (f: ReturnType<typeof fixture>, out: string) => {
    const keyPath = join(f.root, "blind-key.json");
    writeFileSync(keyPath, JSON.stringify(f.blindKey));
    return spawnSync(process.execPath, [COLLECT, "--replies", f.replies, "--batches", f.batches, "--out", out, "--blind-key", keyPath, "--resamples", "50"], { encoding: "utf8", timeout: 60_000 });
  };

  test("writes the three files outside the repo", () => {
    const f = fixture();
    const out = join(f.root, "out");
    const res = run(f, out);
    assert.equal(res.status, 0, res.stderr);
    for (const file of ["codes.json", "agreement.json", "disagreements.json"]) assert.ok(existsSync(join(out, file)), file);
    assert.equal((JSON.parse(readFileSync(join(out, "codes.json"), "utf8")) as CodeRecord[]).length, 7);
    assert.match(res.stdout, /1 items missing from a reply \(M-01 B M3\)/);
  });

  test("exits non-zero and writes nothing on a fatal error", () => {
    const f = fixture((r) => { delete r["T/T-01.A.md"]; });
    const out = join(f.root, "out");
    const res = run(f, out);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /batch T-01 coder A/);
    assert.ok(!existsSync(out));
  });

  test("refuses an --out inside the checkout", () => {
    const res = run(fixture(), join(FINDINGS, "artifact", "collect-out"));
    assert.equal(res.status, 2);
    assert.ok(!existsSync(join(FINDINGS, "artifact", "collect-out")));
  });
});
