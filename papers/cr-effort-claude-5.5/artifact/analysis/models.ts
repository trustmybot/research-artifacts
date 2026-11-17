import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { countBy, EFFORT_STEPS, effortStep, LABEL_ERROR_RATES, labelChanges, labelErrorCorrectedFalseSuccess, median, quantile, readCsv, readLabels, sum, TRUE_SUCCESS_WRONG_SHARES, trueSuccess, type ArmOutcome, type Label, type PatchLabel, type Row } from "./lib.ts";
import { bcaMean, holm, mcnemarOneSided, newcombePaired, tangoCi, tangoNonInferiorityP, wilcoxonSignedRank, wilson } from "./stats.ts";

const MODELS = ["opus", "sonnet", "haiku"] as const;
type Model = (typeof MODELS)[number];
const ARMS = ["low", "medium", "high"] as const;
type Arm = (typeof ARMS)[number];
const SEED = 20261102;
const RESAMPLES = 10000;
const MARGIN = 0.15;
export const COST_THRESHOLD = 0.7;
const FAMILY_ALPHA = 0.025;
const GUARDRAIL_K = 4;
const CEILING = 6;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

export type LabelColumn = "label" | "original_label";
interface Patch { key: string; label: Label; rows: Record<Arm, Row>; }

export const readRequiresCoding = (path: string) =>
  new Map(readCsv(path).map((r) => [`${r.instance_id}|${r.agent_id}`, r.issue_requires_failing_test]));

const accepts = (row: Row, malformedAsAccept: boolean) => row.verdict === "pass" || (row.verdict !== "fail" && malformedAsAccept);

function armRates(set: Patch[], malformedAsAccept = false) {
  const wrong = set.filter((p) => p.label === "wrong");
  const correct = set.filter((p) => p.label === "correct");
  return Object.fromEntries(ARMS.map((arm) => {
    const fs = wrong.filter((p) => accepts(p.rows[arm], malformedAsAccept)).length;
    const fa = correct.filter((p) => !accepts(p.rows[arm], malformedAsAccept)).length;
    const fsRate = fs / wrong.length, faRate = correct.length ? fa / correct.length : NaN;
    return [arm, {
      false_success: { k: fs, n: wrong.length, rate: r3(fsRate), ci: wilson(fs, wrong.length).map(r3) },
      false_alarm: { k: fa, n: correct.length, rate: r3(faRate), ci: wilson(fa, correct.length).map(r3) },
      balanced_agreement: r3(((1 - fsRate) + (1 - faRate)) / 2),
    }];
  })) as Record<Arm, { false_success: { k: number; n: number; rate: number; ci: number[] }; false_alarm: { k: number; n: number; rate: number; ci: number[] }; balanced_agreement: number }>;
}

function paired(set: Patch[], a: Arm, b: Arm, malformedAsAccept: boolean) {
  let both = 0, onlyA = 0, onlyB = 0, neither = 0;
  for (const p of set) {
    const x = accepts(p.rows[a], malformedAsAccept), y = accepts(p.rows[b], malformedAsAccept);
    if (x && y) both++; else if (x) onlyA++; else if (y) onlyB++; else neither++;
  }
  return { both, onlyA, onlyB, neither, n: set.length };
}

function hypotheses(set: Patch[], malformedAsAccept = false) {
  const wrong = set.filter((p) => p.label === "wrong");
  const lh = paired(wrong, "low", "high", malformedAsAccept);
  const h1 = mcnemarOneSided(lh.onlyA, lh.onlyB);
  const h1ci = tangoCi(lh.onlyB, lh.onlyA, lh.n);
  const mh = paired(wrong, "medium", "high", malformedAsAccept);
  const tango = tangoCi(mh.onlyA, mh.onlyB, mh.n);
  const newcombe = newcombePaired(mh.both, mh.onlyA, mh.onlyB, mh.neither);
  const logRatios = set.map((p) => Math.log(Number(p.rows.medium.cost_usd) / Number(p.rows.high.cost_usd)));
  const boot = bcaMean(logRatios, RESAMPLES, SEED);
  const wilcoxon = wilcoxonSignedRank(logRatios.map((x) => x - Math.log(COST_THRESHOLD)));
  return {
    H1: { low_accepts_high_rejects: lh.onlyA, high_accepts_low_rejects: lh.onlyB, n: lh.n, difference_high_minus_low: r3(h1ci.estimate), difference_ci_tango: [r3(h1ci.lower), r3(h1ci.upper)], exact_p: r4(h1.exact_p), mid_p: r4(h1.mid_p) },
    H2: { medium_accepts_high_rejects: mh.onlyA, high_accepts_medium_rejects: mh.onlyB, n: mh.n, difference_medium_minus_high: r3(tango.estimate), tango_ci: [r3(tango.lower), r3(tango.upper)], newcombe_ci: [r3(newcombe.lower), r3(newcombe.upper)], p_noninferiority: r4(tangoNonInferiorityP(mh.onlyA, mh.onlyB, mh.n, MARGIN)), noninferior: tango.upper < MARGIN },
    H3: { n: set.length, ratio: r3(Math.exp(boot.estimate)), bca_ci: [r3(Math.exp(boot.lower)), r3(Math.exp(boot.upper))], wilcoxon_v: wilcoxon.v, wilcoxon_n: wilcoxon.n, wilcoxon_z: r3(wilcoxon.z), p_one_sided: r4(wilcoxon.p_less), supported: Math.exp(boot.upper) < COST_THRESHOLD },
  };
}

const holmOf = (h: ReturnType<typeof hypotheses>, useMid = false) =>
  holm({ H1: useMid ? h.H1.mid_p : h.H1.exact_p, H2: h.H2.p_noninferiority, H3: h.H3.p_one_sided }, FAMILY_ALPHA);

const geo = (xs: number[]) => Math.exp(sum(xs.map(Math.log)) / xs.length);
const youden = (fs: { k: number; n: number }, fa: { k: number; n: number }) => {
  const catchRate = 1 - fs.k / fs.n, faRate = fa.k / fa.n;
  const [cl, cu] = wilson(fs.n - fs.k, fs.n), [fl, fu] = wilson(fa.k, fa.n);
  const j = catchRate - faRate;
  return { j: r3(j), ci_mover: [r3(j - Math.sqrt((catchRate - cl) ** 2 + (fu - faRate) ** 2)), r3(j + Math.sqrt((cu - catchRate) ** 2 + (faRate - fl) ** 2))] };
};

export const METHOD = {
  seed: SEED,
  resamples: RESAMPLES,
  malformed_rule: "primary: a malformed verdict is no acceptance (on a wrong patch not a false success, on a correct patch a false alarm); sensitivity: acceptance",
};

export interface ComparisonInput {
  reviews: Row[];
  labels: Map<string, PatchLabel>;
  requiresByKey: Map<string, string>;
}
export interface ComparisonOptions {
  // A wrong patch without an issue-requirement code stops the run unless the caller opts to drop label_question instead.
  uncodedRequires?: "error" | "skip";
  // Without it, original_labels.by_model keeps only the rates; with it, every block, hypothesis tests included.
  originalLabelsInFull?: boolean;
}

export function compareModels({ reviews, labels, requiresByKey }: ComparisonInput, options: ComparisonOptions = {}) {
  const labelOf = (r: Row, column: LabelColumn): Label => labels.get(`${r.instance_id}|${r.agent_id}`)![column];

  function patchesOf(model: Model, column: LabelColumn = "label"): Patch[] {
    const map = new Map<string, Patch>();
    for (const r of reviews.filter((x) => x.model === model)) {
      const key = `${r.instance_id}|${r.agent_id}`;
      const p = map.get(key) ?? { key, label: labelOf(r, column), rows: {} as Record<Arm, Row> };
      p.rows[r.effort as Arm] = r;
      map.set(key, p);
    }
    const out = [...map.values()];
    if (out.length !== 90 || out.some((p) => ARMS.some((a) => !p.rows[a]))) throw new Error(`expected 90 complete patches for ${model}`);
    return out;
  }

  function modelBlock(model: Model, column: LabelColumn) {
    const patches = patchesOf(model, column);
    const rates = armRates(patches);
    const primary = hypotheses(patches);
    const sensitivity = hypotheses(patches, true);
    const correct = patches.filter((p) => p.label === "correct");
    const extraRejected = correct.filter((p) => !accepts(p.rows.medium, false) && accepts(p.rows.high, false)).length;
    const costOf = (arm: Arm) => patches.map((p) => Number(p.rows[arm].cost_usd));
    const outcome = (arm: Arm): ArmOutcome => ({ total_cost: sum(costOf(arm)), ...rates[arm] });
    const wallOf = (arm: Arm) => patches.map((p) => Number(p.rows[arm].wall_ms) / 60000);
    const field = (arm: Arm, f: string) => patches.map((p) => Number(p.rows[arm][f]));
    const notRequired = (p: Patch) => p.label === "wrong" && requiresByKey.get(p.key) === "not_required";
    const uncoded = patches.filter((p) => p.label === "wrong" && !requiresByKey.has(p.key));
    if (uncoded.length && options.uncodedRequires !== "skip") throw new Error(`missing issue-requirement code for ${uncoded.map((p) => p.key).join(", ")}`);
    return {
      reviews: patches.length * 3,
      malformed: Object.fromEntries(ARMS.map((arm) => [arm, countBy(patches.filter((p) => !["pass", "fail"].includes(p.rows[arm].verdict)), (p) => p.label)])),
      rates,
      rates_malformed_as_accept: armRates(patches, true),
      youden: Object.fromEntries(ARMS.map((arm) => [arm, youden(rates[arm].false_success, rates[arm].false_alarm)])),
      hypotheses: primary,
      holm: holmOf(primary),
      holm_with_mid_p: holmOf(primary, true),
      hypotheses_malformed_as_accept: sensitivity,
      holm_malformed_as_accept: holmOf(sensitivity),
      guardrail: { medium_rejects_high_accepts: extraRejected, k: GUARDRAIL_K, within: extraRejected <= GUARDRAIL_K },
      ceiling: Object.fromEntries(ARMS.map((arm) => [arm, { false_alarms: rates[arm].false_alarm.k, ceiling: CEILING, within: rates[arm].false_alarm.k <= CEILING }])),
      cost: Object.fromEntries(ARMS.map((arm) => {
        const c = costOf(arm);
        return [arm, { total: r4(sum(c)), mean: r4(sum(c) / c.length), geometric_mean: r4(geo(c)), median: r4(median(c)), p95: r4(quantile(c, 0.95)), max: r4(Math.max(...c)), wall_min_median: r3(median(wallOf(arm))), wall_min_p95: r3(quantile(wallOf(arm), 0.95)), wall_min_max: r3(Math.max(...wallOf(arm))) }];
      })),
      total_cost: r4(sum(ARMS.flatMap((arm) => costOf(arm)))),
      incremental: Object.fromEntries(EFFORT_STEPS.map(([from, to]) => {
        const step = effortStep(outcome(from), outcome(to));
        return [`${from}_${to}`, { extra_cost_per_review: r4(step.extraCost / patches.length), extra_wrong_caught: step.extraCaught, extra_false_alarms: step.extraFalseAlarms, usd_per_extra_wrong_caught: step.usdPerExtraCaught === null ? null : r3(step.usdPerExtraCaught) }];
      })),
      true_success: Object.fromEntries(TRUE_SUCCESS_WRONG_SHARES.map((w) => [String(w), Object.fromEntries(ARMS.map((arm) => [arm, r3(trueSuccess(outcome(arm), w))]))])),
      label_error_sensitivity: Object.fromEntries(LABEL_ERROR_RATES.map((e) => [String(e), Object.fromEntries(ARMS.map((arm) => [arm, r3(labelErrorCorrectedFalseSuccess(outcome(arm), e))]))])),
      manipulation: Object.fromEntries(["output_tokens", "thinking_tokens", "tool_calls", "turns", "bash_test_runs"].map((f) => [f, {
        median: Object.fromEntries(ARMS.map((arm) => [arm, median(field(arm, f))])),
        median_paired_diff_high_minus_low: median(patches.map((p) => Number(p.rows.high[f]) - Number(p.rows.low[f]))),
        median_paired_diff_high_minus_medium: median(patches.map((p) => Number(p.rows.high[f]) - Number(p.rows.medium[f]))),
        share_high_greater_than_low: r3(patches.filter((p) => Number(p.rows.high[f]) > Number(p.rows.low[f])).length / patches.length),
        share_high_greater_than_medium: r3(patches.filter((p) => Number(p.rows.high[f]) > Number(p.rows.medium[f])).length / patches.length),
      }])),
      disagreement: {
        all_three_agree: patches.filter((p) => new Set(ARMS.map((a) => p.rows[a].verdict)).size === 1).length,
        medium_vs_high_wrong: patches.filter((p) => p.label === "wrong" && accepts(p.rows.medium, false) !== accepts(p.rows.high, false)).length,
      },
      ...(uncoded.length ? {} : {
        label_question: {
          by_group: Object.fromEntries(["required", "unclear", "not_required", "no_failing_test"].map((g) => [g, armRates(patches.filter((p) => p.label === "correct" || requiresByKey.get(p.key) === g))])),
          without_not_required: hypotheses(patches.filter((p) => !notRequired(p))),
        },
      }),
    };
  }

  const cellKey = (model: Model, arm: Arm) => `${model}_${arm}`;
  const rowsByCell = new Map<string, Map<string, Row>>();
  for (const r of reviews) {
    const k = cellKey(r.model as Model, r.effort as Arm);
    if (!rowsByCell.has(k)) rowsByCell.set(k, new Map());
    rowsByCell.get(k)!.set(`${r.instance_id}|${r.agent_id}`, r);
  }
  function versusOpusMedium(model: Model, arm: Arm, column: LabelColumn) {
    const ref = rowsByCell.get(cellKey("opus", "medium"))!, cell = rowsByCell.get(cellKey(model, arm))!;
    const strata = (["wrong", "correct"] as const).map((label) => {
      let a = 0, b = 0, c = 0, d = 0;
      for (const [key, r] of cell) {
        if (labelOf(r, column) !== label) continue;
        const x = !accepts(r, false), y = !accepts(ref.get(key)!, false);
        if (x && y) a++; else if (x) b++; else if (y) c++; else d++;
      }
      return { a, b, c, d, diff: newcombePaired(a, b, c, d) };
    });
    const [w, cr] = strata;
    const dj = w.diff.estimate - cr.diff.estimate;
    return {
      reject_both: w.a, reject_only_cell: w.b, reject_only_opus_medium: w.c,
      reject_exact_p_two_sided: r4(Math.min(1, 2 * mcnemarOneSided(Math.max(w.b, w.c), Math.min(w.b, w.c)).exact_p)),
      alarm_only_cell: cr.b, alarm_only_opus_medium: cr.c,
      delta_j: r3(dj),
      delta_j_ci_mover: [r3(dj - Math.sqrt((w.diff.estimate - w.diff.lower) ** 2 + (cr.diff.upper - cr.diff.estimate) ** 2)), r3(dj + Math.sqrt((w.diff.upper - w.diff.estimate) ** 2 + (cr.diff.estimate - cr.diff.lower) ** 2))],
    };
  }
  const crossModel = (column: LabelColumn) => Object.fromEntries(MODELS.flatMap((m) => ARMS.filter((a) => !(m === "opus" && a === "medium")).map((a) => [cellKey(m, a), versusOpusMedium(m, a, column)])));

  return {
    by_model: Object.fromEntries(MODELS.map((m) => [m, modelBlock(m, "label")])) as Record<Model, ReturnType<typeof modelBlock>>,
    versus_opus_medium: crossModel("label"),
    original_labels: {
      by_model: Object.fromEntries(MODELS.map((m) => [m, options.originalLabelsInFull ? modelBlock(m, "original_label") : { rates: armRates(patchesOf(m, "original_label")) }])),
      versus_opus_medium: crossModel("original_label"),
    },
  };
}

export const summarize = (byModel: ReturnType<typeof compareModels>["by_model"]) =>
  JSON.stringify(Object.fromEntries(MODELS.map((m) => [m, { rates: byModel[m].rates, hypotheses: byModel[m].hypotheses, holm: byModel[m].holm }])), null, 1);

if (import.meta.main) {
  const { values } = parseArgs({ options: { reviews: { type: "string" }, requires: { type: "string" }, labels: { type: "string" }, out: { type: "string" } } });
  if (!values.reviews || !values.requires || !values.labels || !values.out) {
    console.error("usage: node models.ts --reviews <reviews.csv> --requires <issue-requires-coding.csv> --labels <labels.csv> --out <models.json>");
    process.exit(2);
  }
  const reviews = readCsv(values.reviews);
  // The original-label tests of Sonnet and Haiku (supplement Table S5c) need every block, not only the rates.
  const comparison = compareModels({ reviews, labels: readLabels(values.labels, reviews), requiresByKey: readRequiresCoding(values.requires) }, { originalLabelsInFull: true });
  const results = {
    generated_from: [values.reviews, values.requires, values.labels],
    ...METHOD,
    label_changes: labelChanges(values.labels),
    ...comparison,
  };
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, JSON.stringify(results, null, 2) + "\n");
  console.log(summarize(comparison.by_model));
}
