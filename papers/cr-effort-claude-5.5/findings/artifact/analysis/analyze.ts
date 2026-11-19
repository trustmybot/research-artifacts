import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { countBy, median, readCsv, sum, type Row } from "../../../artifact/analysis/lib.ts";
import { wilson } from "../../../artifact/analysis/stats.ts";
import { ARMS, MODELS } from "../../../artifact/analysis/svg.ts";
import { FINDINGS, patchKey } from "./packet-lib.ts";
import type { Pass } from "./packets.ts";
import type { GoldSummary, SettledRecord, Source } from "./settle.ts";

type Obj = Record<string, unknown>;

export const PATCH_OUTCOMES = ["rejected_named", "rejected_partial", "rejected_other", "accepted_seen", "accepted_not_named"] as const;
export type PatchOutcome = (typeof PATCH_OUTCOMES)[number];
const STEPS = [["low", "medium"], ["medium", "high"]] as const;
const REASON_FLAGS = ["false_positive_issue", "redundant", "out_of_scope", "overcorrection", "environment_artifact"] as const;
const L7 = "L7";

export interface Settled { gold: Record<string, GoldSummary>; records: SettledRecord[] }

const tally = <T>(items: T[], key: (item: T) => string) =>
  Object.fromEntries(Object.entries(countBy(items, key)).sort(([a], [b]) => a.localeCompare(b)));
export const share =(k: number, n: number) => ({ share: n ? k / n : null, ci95: n ? wilson(k, n) : null });
const cellOf = (r: { model: string; effort: string }) => `${r.model}.${r.effort}`;
const keyOf = (r: { instance_id: string; agent_id: string }) => patchKey(r.instance_id, r.agent_id);
const reviewId = (r: SettledRecord) => `${r.model}-${r.effort}-${r.instance_id}-${r.agent_id}`;
const maxScore = (entries: unknown) => Math.max(-1, ...((entries as Obj[]) ?? []).map((e) => Number(e.score)));

export function patchOutcome(r: SettledRecord): PatchOutcome {
  if (r.pass === "M") {
    const level = r.derived!.review_level;
    return level === "named" ? "rejected_named" : level === "partial" ? "rejected_partial" : "rejected_other";
  }
  return maxScore(r.final.feedback) === 2 ? "accepted_seen" : "accepted_not_named";
}

// Every cell reviewed every wrong patch once: rejected (pass M) or accepted (pass A).
export function wrongPatches(records: SettledRecord[]): { patches: string[]; byCell: Map<string, Map<string, SettledRecord>> } {
  const byCell = new Map<string, Map<string, SettledRecord>>();
  for (const r of records.filter((x) => x.pass === "M" || x.pass === "A")) {
    const cell = byCell.get(cellOf(r)) ?? new Map<string, SettledRecord>();
    if (cell.has(keyOf(r))) throw new Error(`${cellOf(r)} reviewed ${keyOf(r)} twice in passes M and A`);
    cell.set(keyOf(r), r);
    byCell.set(cellOf(r), cell);
  }
  const patches = [...new Set([...byCell.values()].flatMap((c) => [...c.keys()]))].sort();
  for (const [model] of MODELS) for (const effort of ARMS) {
    const cell = byCell.get(`${model}.${effort}`);
    const missing = patches.filter((p) => !cell?.has(p));
    if (missing.length) throw new Error(`${model}.${effort} has no pass M or A item for ${missing.join(", ")}`);
  }
  return { patches, byCell };
}

function namedOver(rejections: SettledRecord[], patches: number, named: (r: SettledRecord) => boolean) {
  const k = rejections.filter(named).length;
  return { patches, rejections: rejections.length, k, of_patches: share(k, patches), of_rejections: share(k, rejections.length) };
}

function findingsPerReview(rows: Row[]): Map<string, { n_findings: number; verdict_status: string }> {
  return new Map(rows.map((r) => [r.review_id, { n_findings: Number(r.n_findings), verdict_status: r.verdict_status }]));
}

const countSources = (records: SettledRecord[], source: Source) => Object.fromEntries((["T", "M", "C", "A"] as Pass[]).map((pass) => {
  const fields = records.filter((r) => r.pass === pass).flatMap((r) => Object.entries(r.sources).filter(([, s]) => s === source).map(([f]) => f));
  return [pass, tally(fields, (f) => f === "item" ? "items" : f.replace(/\[.*$/, ""))];
}));

export interface AnalyzeInput { settled: Settled; agreement: Obj; findingsCsv: Row[] }

export function analyze({ settled, agreement, findingsCsv }: AnalyzeInput) {
  const { records, gold } = settled;
  const { patches, byCell } = wrongPatches(records);
  const reviews = findingsPerReview(findingsCsv);
  const review = (r: SettledRecord) => {
    const found = reviews.get(reviewId(r));
    if (!found) throw new Error(`no row in findings.csv for rejection ${reviewId(r)}`);
    return found;
  };
  const ofPass = (pass: Pass) => records.filter((r) => r.pass === pass);
  const inCell = (rs: SettledRecord[], model: string, effort: string) => rs.filter((r) => r.model === model && r.effort === effort);
  const isNamed = (r: SettledRecord) => r.derived!.review_level === "named";
  const contested = new Set(Object.entries(gold).filter(([, g]) => g.contested.length).map(([k]) => k));
  const l7 = new Set(records.filter((r) => r.rule === L7).map(keyOf));

  const byModel: Obj = {};
  const sensitivity: Obj = { two_or_one: {}, no_contested: {}, no_malformed: {}, no_L7: {} };
  for (const [model] of MODELS) {
    const perEffort: Obj = {};
    for (const effort of ARMS) {
      const M = inCell(ofPass("M"), model, effort);
      const A = inCell(ofPass("A"), model, effort);
      const T = inCell(ofPass("T"), model, effort);
      const levels = tally(M, (r) => r.derived!.review_level);
      const k = levels.named ?? 0;
      const feedbackTop = A.map((r) => maxScore(r.final.feedback));
      const counts = M.map((r) => review(r).n_findings);
      perEffort[effort] = {
        right_reason: {
          rejections: M.length,
          named: { k, [`of_${patches.length}`]: share(k, patches.length), of_rejections: share(k, M.length) },
          partial: levels.partial ?? 0,
          other: levels.other ?? 0,
          no_codable_finding: levels.no_codable_finding ?? 0,
        },
        patch_outcomes: Object.fromEntries(PATCH_OUTCOMES.map((o) => [o, [...byCell.get(`${model}.${effort}`)!.values()].filter((r) => patchOutcome(r) === o).length])),
        accepted: {
          n: A.length,
          feedback_named: feedbackTop.filter((s) => s === 2).length,
          feedback_partial: feedbackTop.filter((s) => s === 1).length,
          concern: Object.fromEntries(["C2", "C1", "C0"].map((c) => [c, A.filter((r) => r.final.concern === c).length])),
        },
        findings_per_rejection: { n: counts.length, mean: counts.length ? sum(counts) / counts.length : null, median: counts.length ? median(counts) : null },
        finding_types: tally(T.flatMap((r) => r.final.findings as Obj[]), (f) => `${f.class}/${f.type}/${f.subtype}`),
        reproduction: tally(T, (r) => String(r.final.reproduction)),
      };
      const s = sensitivity as Record<string, Record<string, Obj>>;
      const variant = (name: string, value: Obj) => { (s[name][model] ??= {})[effort] = value; };
      variant("two_or_one", namedOver(M, patches.length, (r) => r.derived!.sensitivity === 1));
      const notContested = M.filter((r) => !contested.has(keyOf(r)));
      variant("no_contested", namedOver(notContested, patches.filter((p) => !contested.has(p)).length, isNamed));
      variant("no_malformed", namedOver(M.filter((r) => review(r).verdict_status !== "malformed"), patches.length, isNamed));
      variant("no_L7", namedOver(M.filter((r) => !l7.has(keyOf(r))), patches.filter((p) => !l7.has(p)).length, isNamed));
    }
    byModel[model] = perEffort;
  }

  const effortSteps = Object.fromEntries(MODELS.map(([model]) => [model, Object.fromEntries(STEPS.map(([from, to]) => {
    const named = (effort: string) => (p: string) => patchOutcome(byCell.get(`${model}.${effort}`)!.get(p)!) === "rejected_named";
    const [lo, hi] = [named(from), named(to)];
    return [`${from}_${to}`, {
      gained: patches.filter((p) => !lo(p) && hi(p)).length,
      lost: patches.filter((p) => lo(p) && !hi(p)).length,
      both: patches.filter((p) => lo(p) && hi(p)).length,
      neither: patches.filter((p) => !lo(p) && !hi(p)).length,
    }];
  }))]));

  const C = ofPass("C");
  const falseAlarms = C.filter((r) => !r.is_decoy);
  const decoys = C.filter((r) => r.is_decoy);
  const reviewKey = (r: SettledRecord) => `${cellOf(r)}|${keyOf(r)}`;
  const mByReview = new Map(ofPass("M").map((r) => [reviewKey(r), r]));
  const decoyLevel = (r: SettledRecord) => {
    const m = mByReview.get(reviewKey(r));
    if (!m) throw new Error(`decoy ${r.item} has no pass M item`);
    return m.derived!.review_level;
  };
  const crossTab: Record<string, Record<string, number>> = {};
  for (const d of decoys) {
    const row = (crossTab[String(d.final.reality)] ??= {});
    row[decoyLevel(d)] = (row[decoyLevel(d)] ?? 0) + 1;
  }

  const adjudication = Object.fromEntries((["T", "M", "C", "A"] as Pass[]).map((pass) => {
    const bases = ofPass(pass).flatMap((r) => Object.values(r.sources)).filter((s) => s === "a" || s === "b" || s === "third");
    return [pass, { n: bases.length, a: bases.filter((s) => s === "a").length, b: bases.filter((s) => s === "b").length, third: bases.filter((s) => s === "third").length }];
  }));

  const goldCount = (field: "changed" | "dropped" | "contested") => {
    const hit = Object.entries(gold).filter(([, g]) => g[field].length);
    return { behaviours: sum(hit.map(([, g]) => g[field].length)), patches: hit.length };
  };

  return {
    patches: patches.length,
    by_model: byModel,
    effort_steps: effortSteps,
    false_alarms: {
      n: falseAlarms.length,
      by_cell: tally(falseAlarms, cellOf),
      by_rule: tally(falseAlarms, (r) => r.rule),
      reality: tally(falseAlarms, (r) => String(r.final.reality)),
      reasons: Object.fromEntries(REASON_FLAGS.map((f) => [f, falseAlarms.filter((r) => r.final[f] === true).length])),
    },
    decoy_crosscheck: { n: decoys.length, reality: tally(decoys, (r) => String(r.final.reality)), reality_by_review_level: crossTab },
    agreement,
    adjudication,
    gold_check: { changed: goldCount("changed"), dropped: goldCount("dropped"), contested: goldCount("contested") },
    blinding_guess: agreement.T_model_guess ?? null,
    one_coder: countSources(records, "one_coder"),
    lower_unadjudicated: countSources(records, "lower_unadjudicated"),
    sensitivity,
  };
}

export const DEFAULT_OUT = join(FINDINGS, "artifact", "outputs", "findings.json");

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      settled: { type: "string" },
      agreement: { type: "string" },
      findings: { type: "string", default: join(FINDINGS, "artifact", "data", "findings.csv") },
      out: { type: "string", default: DEFAULT_OUT },
    },
  });
  if (!values.settled || !values.agreement) {
    console.error("usage: node analyze.ts --settled <settled.json> --agreement <agreement.json> [--findings data/findings.csv] [--out outputs/findings.json]");
    process.exit(2);
  }
  const result = analyze({
    settled: JSON.parse(readFileSync(values.settled, "utf8")),
    agreement: JSON.parse(readFileSync(values.agreement, "utf8")),
    findingsCsv: readCsv(values.findings!),
  });
  mkdirSync(dirname(values.out!), { recursive: true });
  writeFileSync(values.out!, JSON.stringify(result, null, 1) + "\n");
  console.log(`${values.out}: ${result.patches} wrong patches`);
}
