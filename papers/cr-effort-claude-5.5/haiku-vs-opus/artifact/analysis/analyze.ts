import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: { reviews: { type: "string" }, requires: { type: "string" }, labels: { type: "string" }, out: { type: "string" }, codes: { type: "string" }, key: { type: "string" } },
});
if (!args.reviews || !args.labels || !args.out) {
  console.error("usage: node analyze.ts --reviews <reviews.csv> --labels <labels.csv> --out <results.json> [--requires <issue-requires-coding.csv>] [--codes <manual-codes.json> --key <blind-key.json>]");
  process.exit(2);
}

type Row = Record<string, string>;
function parseCsv(text: string): Row[] {
  const [head, ...lines] = text.trim().split("\n");
  const cols = head.split(",");
  return lines.map((l) => {
    const out: string[] = [];
    let f = "", q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) { if (ch === '"' && l[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch; }
      else if (ch === '"') q = true;
      else if (ch === ",") { out.push(f); f = ""; }
      else f += ch;
    }
    out.push(f.replace(/\r$/, ""));
    return Object.fromEntries(cols.map((c, i) => [c, out[i] ?? ""]));
  });
}

const SEED = 20261107;
const B = 10000;
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function wilson(k: number, n: number, z = 1.959964) {
  if (n === 0) return [NaN, NaN];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [r3((c - h) / d), r3((c + h) / d)];
}
const prop = (k: number, n: number) => ({ k, n, p: r3(k / n), ci: wilson(k, n) });
function binom(n: number, k: number) { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; }
function mcnemar(b: number, c: number) {
  const n = b + c, k = Math.min(b, c);
  let p = 0; for (let i = 0; i <= k; i++) p += binom(n, i);
  return Math.min(1, 2 * p / 2 ** n);
}
function kappa(x: number[], y: number[]) {
  const n = x.length;
  const po = x.filter((v, i) => v === y[i]).length / n;
  const px = mean(x), py = mean(y);
  const pe = px * py + (1 - px) * (1 - py);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}
function boot(n: number, stat: (idx: number[]) => number, seed = SEED) {
  const rand = mulberry32(seed);
  const vals: number[] = [];
  for (let b = 0; b < B; b++) {
    const idx = Array.from({ length: n }, () => Math.floor(rand() * n));
    const v = stat(idx);
    if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  return [r3(vals[Math.floor(0.025 * vals.length)]), r3(vals[Math.floor(0.975 * vals.length) - 1])];
}

const labelByPatch = new Map<string, Row>();
for (const l of parseCsv(readFileSync(args.labels, "utf8")).filter((x) => x.set === "main")) {
  const patch = `${l.instance_id}|${l.agent_id}`;
  if (labelByPatch.has(patch)) throw new Error(`duplicate main label for ${patch}`);
  labelByPatch.set(patch, l);
}
const rows = parseCsv(readFileSync(args.reviews, "utf8")).map((r) => {
  const patch = `${r.instance_id}|${r.agent_id}`;
  const l = labelByPatch.get(patch);
  if (!l) throw new Error(`no main label in ${args.labels} for ${patch}`);
  if (l.original_label !== r.label) throw new Error(`original_label ${l.original_label} in ${args.labels} for ${patch} differs from the raw label ${r.label}`);
  if (l.label !== "wrong" && l.label !== "correct") throw new Error(`label for ${patch} is not wrong or correct`);
  return { ...r, label: l.label };
});
const num = (r: Row, k: string) => Number(r[k] || 0);
const MODELS = ["opus", "sonnet", "haiku"];
const EFFORTS = ["low", "medium", "high"];
const cells = MODELS.flatMap((m) => EFFORTS.map((e) => `${m}-${e}`));
const key = (r: Row) => `${r.instance_id}|${r.agent_id}|${r.patch_sha256}`;
const byCell = (c: string) => rows.filter((r) => `${r.model}-${r.effort}` === c);
const wrongKeys = [...new Set(rows.filter((r) => r.label === "wrong").map(key))].sort();
const correctKeys = [...new Set(rows.filter((r) => r.label === "correct").map(key))].sort();
const lookup = new Map(rows.map((r) => [`${r.model}-${r.effort}|${key(r)}`, r]));
const get = (c: string, k: string) => lookup.get(`${c}|${k}`)!;
const caught = (c: string, k: string) => (get(c, k).verdict === "fail" ? 1 : 0);

const ran = (r: Row) => num(r, "suite_runs") + num(r, "adhoc_runs") > 0;
const sawFail = (r: Row) => num(r, "suite_fail_runs") + num(r, "adhoc_fail_runs") > 0;

const perCell: Record<string, unknown> = {};
for (const c of cells) {
  const rs = byCell(c);
  const w = rs.filter((r) => r.label === "wrong");
  const cr = rs.filter((r) => r.label === "correct");
  const caughtRows = w.filter((r) => r.verdict === "fail");
  const exposed = w.filter(sawFail);
  const notExposed = w.filter((r) => !sawFail(r));
  const cExposed = cr.filter(sawFail);
  perCell[c] = {
    caught: prop(caughtRows.length, w.length),
    false_alarms: prop(cr.filter((r) => r.verdict === "fail").length, cr.length),
    ran_suite: prop(rs.filter((r) => num(r, "suite_runs") > 0).length, rs.length),
    ran_own_code: prop(rs.filter((r) => num(r, "adhoc_runs") > 0).length, rs.length),
    ran_any: prop(rs.filter(ran).length, rs.length),
    differential: prop(rs.filter((r) => num(r, "differential_runs") > 0).length, rs.length),
    wrong_saw_failure: prop(exposed.length, w.length),
    catch_given_failure: prop(exposed.filter((r) => r.verdict === "fail").length, exposed.length),
    catch_given_no_failure: prop(notExposed.filter((r) => r.verdict === "fail").length, notExposed.length),
    correct_saw_failure: prop(cExposed.length, cr.length),
    false_alarm_given_failure: prop(cExposed.filter((r) => r.verdict === "fail").length, cExposed.length),
    catches_with_failure_seen: prop(caughtRows.filter(sawFail).length, caughtRows.length),
    catches_with_suite_failure: prop(caughtRows.filter((r) => num(r, "suite_fail_runs") > 0).length, caughtRows.length),
    catches_with_own_code_failure_only: prop(caughtRows.filter((r) => num(r, "adhoc_fail_runs") > 0 && num(r, "suite_fail_runs") === 0).length, caughtRows.length),
    catches_without_failure: caughtRows.length - caughtRows.filter(sawFail).length,
    median: Object.fromEntries(["turns", "tool_calls", "output_tokens", "thinking_tokens", "wall_ms", "suite_runs", "adhoc_runs", "test_writes"].map((k) => [k, median(rs.map((r) => num(r, k)))])),
    mean_cost: r3(mean(rs.map((r) => num(r, "cost_usd"))) * 1000) / 1000,
  };
}

const vec = (c: string) => wrongKeys.map((k) => caught(c, k));
const pairs: Record<string, unknown>[] = [];
for (let i = 0; i < cells.length; i++)
  for (let j = i + 1; j < cells.length; j++) {
    const x = vec(cells[i]), y = vec(cells[j]);
    const both = x.filter((v, t) => v && y[t]).length;
    const b = x.filter((v, t) => v && !y[t]).length, c = x.filter((v, t) => !v && y[t]).length;
    pairs.push({ a: cells[i], b: cells[j], both, only_a: b, only_b: c, neither: wrongKeys.length - both - b - c, agreement: r3((wrongKeys.length - b - c) / wrongKeys.length), kappa: r3(kappa(x, y)) });
  }
pairs.sort((p, q) => (q.kappa as number) - (p.kappa as number));

function pairDetail(a: string, b: string, seed: number) {
  const x = vec(a), y = vec(b);
  const bb = x.filter((v, t) => v && !y[t]).length, cc = x.filter((v, t) => !v && y[t]).length;
  return {
    a, b, only_a: bb, only_b: cc,
    mcnemar_exact_p: r3(mcnemar(bb, cc)),
    diff_pp: r3(mean(x) - mean(y)),
    diff_ci: boot(wrongKeys.length, (idx) => mean(idx.map((i) => x[i])) - mean(idx.map((i) => y[i])), seed),
    kappa: r3(kappa(x, y)),
    kappa_ci: boot(wrongKeys.length, (idx) => kappa(idx.map((i) => x[i]), idx.map((i) => y[i])), seed),
  };
}

const counts = wrongKeys.map((k) => cells.reduce((s, c) => s + caught(c, k), 0));
const hist = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, counts.filter((n) => n === i).length]));

function anova(matrix: number[][]) {
  const n = matrix.length, m = matrix[0].length;
  const grand = mean(matrix.flat());
  const rowM = matrix.map(mean), colM = Array.from({ length: m }, (_, j) => mean(matrix.map((r) => r[j])));
  const ssRow = m * rowM.reduce((s, v) => s + (v - grand) ** 2, 0);
  const ssCol = n * colM.reduce((s, v) => s + (v - grand) ** 2, 0);
  const ssTot = matrix.flat().reduce((s, v) => s + (v - grand) ** 2, 0);
  const ssRes = ssTot - ssRow - ssCol;
  const dfRow = n - 1, dfCol = m - 1, dfRes = dfRow * dfCol;
  const msRow = ssRow / dfRow, msCol = ssCol / dfCol, msRes = ssRes / dfRes;
  return {
    eta2_patch: r3(ssRow / ssTot), eta2_cell: r3(ssCol / ssTot), eta2_residual: r3(ssRes / ssTot),
    F_patch: r3(msRow / msRes), df_patch: [dfRow, dfRes], F_cell: r3(msCol / msRes), df_cell: [dfCol, dfRes],
    icc_patch: r3((msRow - msRes) / (msRow + (m - 1) * msRes)),
  };
}
const matrix = wrongKeys.map((k) => cells.map((c) => caught(c, k)));

const requires = args.requires ? parseCsv(readFileSync(args.requires, "utf8")) : [];
const reqOf = (k: string) => requires.find((q) => k.startsWith(`${q.instance_id}|${q.agent_id}|`))?.issue_requires_failing_test ?? "unknown";
const byReq: Record<string, unknown> = {};
for (const level of ["required", "unclear", "not_required", "no_failing_test"]) {
  const ks = wrongKeys.filter((k) => reqOf(k) === level);
  byReq[level] = {
    n: ks.length,
    never_caught: ks.filter((k) => cells.every((c) => !caught(c, k))).length,
    "haiku-high": ks.filter((k) => caught("haiku-high", k)).length,
    "opus-medium": ks.filter((k) => caught("opus-medium", k)).length,
  };
}

const HH = "haiku-high", OM = "opus-medium";
const discordant = wrongKeys
  .filter((k) => caught(HH, k) !== caught(OM, k))
  .map((k) => {
    const h = get(HH, k), o = get(OM, k);
    const others = cells.filter((c) => c !== HH && c !== OM).reduce((s, c) => s + caught(c, k), 0);
    return {
      patch: k.split("|").slice(0, 2).join(" "), caught_by: caught(HH, k) ? HH : OM, other_cells_caught: others, requires: reqOf(k),
      haiku_high: { verdict: h.verdict, saw_failure: sawFail(h), suite_fail: num(h, "suite_fail_runs"), own_fail: num(h, "adhoc_fail_runs"), runs: num(h, "suite_runs") + num(h, "adhoc_runs"), turns: num(h, "turns") },
      opus_medium: { verdict: o.verdict, saw_failure: sawFail(o), suite_fail: num(o, "suite_fail_runs"), own_fail: num(o, "adhoc_fail_runs"), runs: num(o, "suite_runs") + num(o, "adhoc_runs"), turns: num(o, "turns") },
    };
  });

const pairedExposure = (() => {
  const x = wrongKeys.map((k) => (sawFail(get(HH, k)) ? 1 : 0));
  const y = wrongKeys.map((k) => (sawFail(get(OM, k)) ? 1 : 0));
  const b = x.filter((v, t) => v && !y[t]).length, c = x.filter((v, t) => !v && y[t]).length;
  return { haiku_high_only: b, opus_medium_only: c, both: x.filter((v, t) => v && y[t]).length, mcnemar_exact_p: r3(mcnemar(b, c)), kappa: r3(kappa(x, y)) };
})();

const catchOnFailure = (() => {
  const yes = rows.filter((r) => r.label === "wrong" && sawFail(r));
  const no = rows.filter((r) => r.label === "wrong" && !sawFail(r));
  const a = yes.filter((r) => r.verdict === "fail").length, b = no.filter((r) => r.verdict === "fail").length;
  const p1 = a / yes.length, p0 = b / no.length;
  return { with_failure: prop(a, yes.length), without_failure: prop(b, no.length), risk_difference: r3(p1 - p0), odds_ratio: r3((a / (yes.length - a)) / (b / (no.length - b))) };
})();

function normalCdf(z: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
function wilcoxon(x: number[], y: number[]) {
  const d = x.map((v, i) => v - y[i]).filter((v) => v !== 0);
  const ranked = d.map((v, i) => ({ a: Math.abs(v), s: Math.sign(v), i })).sort((p, q) => p.a - q.a);
  const ranks = new Array(ranked.length);
  for (let i = 0; i < ranked.length; ) {
    let j = i;
    while (j + 1 < ranked.length && ranked[j + 1].a === ranked[i].a) j++;
    for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1;
    i = j + 1;
  }
  const n = ranked.length;
  const wPlus = ranked.reduce((acc, r, k) => acc + (r.s > 0 ? ranks[k] : 0), 0);
  const total = n * (n + 1) / 2;
  const mu = total / 2, sd = Math.sqrt(n * (n + 1) * (2 * n + 1) / 24);
  const z = (wPlus - mu) / sd;
  return { n_nonzero: n, W_plus: wPlus, z: r3(z), p: r3(2 * (1 - normalCdf(Math.abs(z)))), rank_biserial: r3((wPlus - (total - wPlus)) / total) };
}
function pairedWork(a: string, b: string, metric: string, keys: string[], seed: number) {
  const x = keys.map((k) => num(get(a, k), metric)), y = keys.map((k) => num(get(b, k), metric));
  return {
    metric, median_a: median(x), median_b: median(y),
    median_paired_diff: median(x.map((v, i) => v - y[i])),
    median_paired_diff_ci: boot(keys.length, (idx) => median(idx.map((i) => x[i] - y[i])), seed),
    ...wilcoxon(x, y),
  };
}
const allKeys = [...wrongKeys, ...correctKeys];
const work = ["turns", "tool_calls", "adhoc_runs", "suite_runs", "differential_runs", "output_tokens", "thinking_tokens", "wall_ms", "cost_usd"].map((m, i) => pairedWork("haiku-high", "opus-medium", m, allKeys, SEED + 10 + i));

let manual: unknown = null;
if (args.codes && args.key) {
  const codes: Record<string, string> = JSON.parse(readFileSync(args.codes, "utf8"));
  const keyRows: { id: number; model: string; effort: string; instance_id: string; agent_id: string }[] = JSON.parse(readFileSync(args.key, "utf8"));
  const coded = keyRows.map((r) => ({ cell: `${r.model}-${r.effort}`, patch: `${r.instance_id}|${r.agent_id}`, code: codes[String(r.id)] }));
  const summary: Record<string, unknown> = {};
  for (const c of ["haiku-high", "opus-medium"]) {
    const cs = coded.filter((r) => r.cell === c);
    summary[c] = {
      existing_test_failure: prop(cs.filter((r) => r.code === "S").length, cs.length),
      own_reproduction: prop(cs.filter((r) => r.code === "R").length, cs.length),
      code_reading_only: prop(cs.filter((r) => r.code === "C").length, cs.length),
      execution_backed: prop(cs.filter((r) => r.code !== "C").length, cs.length),
    };
  }
  const shared = coded.filter((r) => r.cell === "haiku-high").flatMap((h) => {
    const o = coded.find((r) => r.cell === "opus-medium" && r.patch === h.patch);
    return o ? [h.code === o.code ? 1 : 0] : [];
  });
  manual = { ...summary, shared_catches: shared.length, same_evidence_class: prop(shared.reduce((p, q) => p + q, 0), shared.length) };
}

const out = {
  seed: SEED, resamples: B, n_reviews: rows.length, n_wrong: wrongKeys.length, n_correct: correctKeys.length,
  per_cell: perCell,
  haiku_high_vs_opus_medium: pairDetail(HH, OM, SEED),
  opus_medium_vs_opus_high: pairDetail(OM, "opus-high", SEED + 1),
  haiku_medium_vs_haiku_high: pairDetail("haiku-medium", HH, SEED + 2),
  haiku_low_vs_haiku_high: pairDetail("haiku-low", HH, SEED + 3),
  pairs_by_kappa: pairs,
  patch_catch_count_histogram: hist,
  variance_decomposition: anova(matrix),
  by_issue_requirement: byReq,
  exposure_haiku_high_vs_opus_medium: pairedExposure,
  catch_by_failure_seen_all_cells: catchOnFailure,
  discordant,
  paired_work_haiku_high_vs_opus_medium: work,
  manual_evidence_coding: manual,
};
writeFileSync(args.out!, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
