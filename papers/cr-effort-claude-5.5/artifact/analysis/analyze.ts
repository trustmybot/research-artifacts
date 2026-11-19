import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { countBy, EFFORT_STEPS, effortStep, LABEL_ERROR_RATES, labelChanges, labelErrorCorrectedMissRate, median, negativePredictiveValue, NPV_WRONG_SHARES, quantile, readCsv, readLabels, reviewerScores, sum, type ArmOutcome, type Label, type Row } from "./lib.ts";
import { bcaMean, cohenKappa, holm, mcnemarOneSided, newcombePaired, tangoCi, tangoNonInferiorityP, wilcoxonSignedRank, wilson } from "./stats.ts";

const { values } = parseArgs({ options: { data: { type: "string" }, out: { type: "string" } } });
if (!values.data || !values.out) {
  console.error("usage: node analyze.ts --data <data dir> --out <outputs dir>");
  process.exit(2);
}
const data = values.data;
const ARMS = ["low", "medium", "high"] as const;
type Arm = (typeof ARMS)[number];
const SEED = 20261102;
const RESAMPLES = 10000;
const MARGIN = 0.15;
const COST_THRESHOLD = 0.7;
const FAMILY_ALPHA = 0.025;
const GUARDRAIL_K = 4;
const CEILING = 6;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

const all = readCsv(join(data, "results.csv"));
const main = all.filter((r) => r.study_part === "main");
const repeat = all.filter((r) => r.study_part === "repeat");
const patchKey = (r: { instance_id: string; agent_id: string }) => `${r.instance_id}|${r.agent_id}`;
const labelsPath = join(data, "labels.csv");
const labels = readLabels(labelsPath, all);
const labelOf = (r: Row) => labels.get(patchKey(r))!.label;

interface Patch { key: string; instance_id: string; agent_id: string; label: Label; original_label: Label; first_order: number; rows: Record<Arm, Row>; }
const patchMap = new Map<string, Patch>();
for (const r of main) {
  const key = patchKey(r);
  const p = patchMap.get(key) ?? { key, instance_id: r.instance_id, agent_id: r.agent_id, label: labelOf(r), original_label: labels.get(key)!.original_label, first_order: Infinity, rows: {} as Record<Arm, Row> };
  p.rows[r.effort as Arm] = r;
  p.first_order = Math.min(p.first_order, Number(r.run_order));
  patchMap.set(key, p);
}
const patches = [...patchMap.values()];
if (patches.length !== 90 || patches.some((p) => ARMS.some((a) => !p.rows[a]))) throw new Error("expected 90 complete patches");

const accepts = (p: Patch, arm: Arm, incompleteAsAccept = false) => {
  const v = p.rows[arm].verdict;
  if (v === "pass") return true;
  if (v === "fail") return false;
  return incompleteAsAccept;
};

function armRates(set: Patch[], incompleteAsAccept = false) {
  const wrong = set.filter((p) => p.label === "wrong");
  const correct = set.filter((p) => p.label === "correct");
  return Object.fromEntries(ARMS.map((arm) => {
    const missed = wrong.filter((p) => accepts(p, arm, incompleteAsAccept)).length;
    const fa = correct.filter((p) => !accepts(p, arm, incompleteAsAccept)).length;
    const missRate = wrong.length ? missed / wrong.length : NaN;
    const faRate = correct.length ? fa / correct.length : NaN;
    return [arm, {
      miss_rate: { k: missed, n: wrong.length, rate: r3(missRate), ci: wilson(missed, wrong.length).map(r3) },
      false_alarm_rate: { k: fa, n: correct.length, rate: r3(faRate), ci: wilson(fa, correct.length).map(r3) },
      balanced_accuracy: r3(((1 - missRate) + (1 - faRate)) / 2),
    }];
  }));
}

// Primary malformed rule: a verdict other than pass is a rejection.
const scoredRates = (set: Patch[]) => {
  const rates = armRates(set);
  return Object.fromEntries(ARMS.map((arm) => [arm, {
    ...rates[arm],
    ...reviewerScores(set.map((p) => ({ positive: p.label === "wrong", flagged: !accepts(p, arm) })), RESAMPLES, SEED),
  }])) as Record<Arm, (typeof rates)[Arm] & ReturnType<typeof reviewerScores>>;
};

function paired(set: Patch[], a: Arm, b: Arm) {
  let both = 0, onlyA = 0, onlyB = 0, neither = 0;
  for (const p of set) {
    const x = accepts(p, a), y = accepts(p, b);
    if (x && y) both++; else if (x) onlyA++; else if (y) onlyB++; else neither++;
  }
  return { both, onlyA, onlyB, neither, n: set.length };
}

function hypotheses(set: Patch[]) {
  const wrong = set.filter((p) => p.label === "wrong");
  const lh = paired(wrong, "low", "high");
  const h1 = mcnemarOneSided(lh.onlyA, lh.onlyB);
  const mh = paired(wrong, "medium", "high");
  const tango = tangoCi(mh.onlyA, mh.onlyB, mh.n);
  const newcombe = newcombePaired(mh.both, mh.onlyA, mh.onlyB, mh.neither);
  const h2p = tangoNonInferiorityP(mh.onlyA, mh.onlyB, mh.n, MARGIN);
  const logRatios = set.map((p) => Math.log(Number(p.rows.medium.cost_usd) / Number(p.rows.high.cost_usd)));
  const boot = bcaMean(logRatios, RESAMPLES, SEED);
  const wilcoxon = wilcoxonSignedRank(logRatios.map((x) => x - Math.log(COST_THRESHOLD)));
  return {
    H1: {
      claim: "high has lower miss rate than low",
      low_accepts_high_rejects: lh.onlyA,
      high_accepts_low_rejects: lh.onlyB,
      difference_high_minus_low: r3((lh.onlyB - lh.onlyA) / lh.n),
      difference_ci_tango: (() => { const t = tangoCi(lh.onlyB, lh.onlyA, lh.n); return [r3(t.lower), r3(t.upper)]; })(),
      exact_p: r4(h1.exact_p),
      mid_p: r4(h1.mid_p),
    },
    H2: {
      claim: `medium miss rate is no more than ${MARGIN} above high`,
      medium_accepts_high_rejects: mh.onlyA,
      high_accepts_medium_rejects: mh.onlyB,
      n: mh.n,
      difference_medium_minus_high: r3(tango.estimate),
      tango_ci: [r3(tango.lower), r3(tango.upper)],
      newcombe_ci: [r3(newcombe.lower), r3(newcombe.upper)],
      p_noninferiority: r4(h2p),
      noninferior: tango.upper < MARGIN,
    },
    H3: {
      claim: `geometric-mean cost ratio medium/high is below ${COST_THRESHOLD}`,
      n: set.length,
      ratio: r3(Math.exp(boot.estimate)),
      bca_ci: [r3(Math.exp(boot.lower)), r3(Math.exp(boot.upper))],
      bca_z0: r4(boot.z0),
      bca_acceleration: r4(boot.acceleration),
      wilcoxon_v: wilcoxon.v,
      wilcoxon_n: wilcoxon.n,
      wilcoxon_z: r3(wilcoxon.z),
      p_one_sided: r4(wilcoxon.p_less),
    },
  };
}

const primary = hypotheses(patches);
const holmResult = holm({ H1: primary.H1.exact_p, H2: primary.H2.p_noninferiority, H3: primary.H3.p_one_sided }, FAMILY_ALPHA);
const holmMidP = holm({ H1: primary.H1.mid_p, H2: primary.H2.p_noninferiority, H3: primary.H3.p_one_sided }, FAMILY_ALPHA);
const rates = scoredRates(patches);
const originalPatches = patches.map((p) => ({ ...p, label: p.original_label }));
const originalHypotheses = hypotheses(originalPatches);
const originalLabels = {
  rates: scoredRates(originalPatches),
  hypotheses: originalHypotheses,
  holm: holm({ H1: originalHypotheses.H1.exact_p, H2: originalHypotheses.H2.p_noninferiority, H3: originalHypotheses.H3.p_one_sided }, FAMILY_ALPHA),
  holm_with_mid_p: holm({ H1: originalHypotheses.H1.mid_p, H2: originalHypotheses.H2.p_noninferiority, H3: originalHypotheses.H3.p_one_sided }, FAMILY_ALPHA),
};
const correct = patches.filter((p) => p.label === "correct");
const extraRejected = correct.filter((p) => !accepts(p, "medium") && accepts(p, "high")).length;
const guardrail = { medium_rejects_high_accepts: extraRejected, k: GUARDRAIL_K, within: extraRejected <= GUARDRAIL_K };
const ceiling = Object.fromEntries(ARMS.map((arm) => [arm, { false_alarms: rates[arm].false_alarm_rate.k, ceiling: CEILING, within: rates[arm].false_alarm_rate.k <= CEILING }]));

const costOf = (arm: Arm) => patches.map((p) => Number(p.rows[arm].cost_usd));
const wallOf = (arm: Arm) => patches.map((p) => Number(p.rows[arm].wall_ms) / 60000);
const geo = (xs: number[]) => Math.exp(sum(xs.map(Math.log)) / xs.length);
const cost = Object.fromEntries(ARMS.map((arm) => {
  const c = costOf(arm);
  return [arm, {
    total: r3(sum(c)), mean: r4(sum(c) / c.length), median: r4(median(c)), p90: r4(quantile(c, 0.9)), max: r4(Math.max(...c)), geometric_mean: r4(geo(c)),
    wall_min_mean: r3(sum(wallOf(arm)) / 90), wall_min_median: r3(median(wallOf(arm))),
    p95: r4(quantile(c, 0.95)), wall_min_p95: r3(quantile(wallOf(arm), 0.95)), wall_min_max: r3(Math.max(...wallOf(arm))),
  }];
}));
const wallByVm = Object.fromEntries(ARMS.map((arm) => [arm, Object.fromEntries(["e2-standard-4", "e2-standard-2"].map((vm) => {
  const xs = patches.filter((p) => p.rows[arm].origin_vm_type === vm).map((p) => Number(p.rows[arm].wall_ms) / 60000);
  return [vm, { n: xs.length, median_min: xs.length ? r3(median(xs)) : null }];
}))]));

const outcome = (arm: Arm): ArmOutcome => ({ total_cost: sum(costOf(arm)), ...rates[arm] });
const incremental = Object.fromEntries(EFFORT_STEPS.map(([from, to]) => {
  const { extraCost, extraCaught, extraFalseAlarms, usdPerExtraCaught } = effortStep(outcome(from), outcome(to));
  const gain = rates[to].balanced_accuracy - rates[from].balanced_accuracy;
  return [`${from}_to_${to}`, { extra_cost_usd: r3(extraCost), extra_wrong_caught: extraCaught, usd_per_extra_wrong_caught: usdPerExtraCaught === null ? null : r3(usdPerExtraCaught), extra_false_alarms: extraFalseAlarms, extra_usd_per_review: r4(extraCost / 90), balanced_accuracy_gain_pp: r3(gain * 100), usd_per_review_per_pp: gain > 0 ? r4(extraCost / 90 / (gain * 100)) : null }];
}));
const npvByShare = Object.fromEntries(NPV_WRONG_SHARES.map((w) => [String(w), Object.fromEntries(ARMS.map((arm) => [arm, r3(negativePredictiveValue(outcome(arm), w))]))]));
const labelError = Object.fromEntries(LABEL_ERROR_RATES.map((e) => [String(e), Object.fromEntries(ARMS.map((arm) => [arm, r3(labelErrorCorrectedMissRate(outcome(arm), e))]))]));

const tokens = (arm: Arm, field: string) => patches.map((p) => Number(p.rows[arm][field]));
const manipulation = Object.fromEntries(["output_tokens", "thinking_tokens", "tool_calls", "turns", "bash_test_runs"].map((field) => [field, {
  median: Object.fromEntries(ARMS.map((arm) => [arm, median(tokens(arm, field))])),
  mean: Object.fromEntries(ARMS.map((arm) => [arm, r3(sum(tokens(arm, field)) / 90)])),
  median_paired_diff_high_minus_low: median(patches.map((p) => Number(p.rows.high[field]) - Number(p.rows.low[field]))),
  median_paired_diff_high_minus_medium: median(patches.map((p) => Number(p.rows.high[field]) - Number(p.rows.medium[field]))),
  share_high_greater_than_medium: r3(patches.filter((p) => Number(p.rows.high[field]) > Number(p.rows.medium[field])).length / 90),
}]));

const disagreement = {
  all_three_agree: patches.filter((p) => new Set(ARMS.map((a) => p.rows[a].verdict)).size === 1).length,
  medium_vs_high_all: patches.filter((p) => p.rows.medium.verdict !== p.rows.high.verdict).length,
  medium_vs_high_wrong: patches.filter((p) => p.label === "wrong" && p.rows.medium.verdict !== p.rows.high.verdict).length,
  low_vs_high_all: patches.filter((p) => p.rows.low.verdict !== p.rows.high.verdict).length,
  low_vs_medium_all: patches.filter((p) => p.rows.low.verdict !== p.rows.medium.verdict).length,
  discrepancy_tiers: (() => {
    const disagreeing = (p: Patch) => ARMS.filter((a) => (p.rows[a].verdict === "pass") !== (p.label === "correct")).length;
    const tier = (p: Patch) => (disagreeing(p) === 3 ? "tier1_all_arms_disagree" : disagreeing(p) > 0 ? "tier2_arms_split" : "tier3_all_agree_with_label");
    return Object.fromEntries(["wrong", "correct"].map((label) => [label, countBy(patches.filter((p) => p.label === label), tier)]));
  })(),
};

const firstThirtyWrong = patches.filter((p) => p.original_label === "wrong").sort((a, b) => a.first_order - b.first_order).slice(0, 30);
const discordantFirst30 = firstThirtyWrong.filter((p) => p.rows.medium.verdict !== p.rows.high.verdict).length;
const pDisc = discordantFirst30 / 30;
const blindedLook = { labels: "original_label, as run during the study", first_30_wrong_discordant: discordantFirst30, p_disc: r3(pDisc), n_final: Math.min(75, Math.max(60, Math.ceil((7.85 * pDisc) / MARGIN ** 2))), extension_triggered: Math.ceil((7.85 * pDisc) / MARGIN ** 2) > 60 };

const incomplete = Object.fromEntries(ARMS.map((arm) => [arm, patches.filter((p) => !["pass", "fail"].includes(p.rows[arm].verdict)).length]));
const sensitivityIncompleteAccept = armRates(patches, true);

const similarity = readCsv(join(data, "patch-similarity.csv"));
const simByKey = new Map(similarity.map((s) => [patchKey(s), s]));
const contamination = {
  classes: countBy(similarity, (s) => `${s.label_stratum}|identical=${s.identical_to_official}|official_file_identical=${s.official_file_identical}|test_patch_file_identical=${s.test_patch_file_identical}`),
  false_alarm_rate_without_identical: armRates(patches.filter((p) => simByKey.get(p.key)?.identical_to_official !== "true")),
};

const coding = readCsv(join(data, "memory-coding.csv"));
const flag = (r: Row) => r.memory_in_thinking_decisive === "true" || r.memory_in_final_reasons === "true";
const byCode = new Map<string, Row[]>();
for (const r of coding) byCode.set(r.code, [...(byCode.get(r.code) ?? []), r]);
const doubles = [...byCode.values()].filter((rs) => rs.length === 2);
const reviewFlag = new Map<string, Row & { flagged: boolean; cited: boolean; sole: boolean; final: boolean }>();
for (const rs of byCode.values()) {
  const any = (f: (r: Row) => boolean) => rs.some(f);
  reviewFlag.set(`${rs[0].run_id}/${rs[0].run}`, { ...rs[0], flagged: any(flag), cited: any((r) => r.memory_cited === "true"), sole: any((r) => r.memory_sole_basis === "true"), final: any((r) => r.memory_in_final_reasons === "true") });
}
const flagFor = (r: Row) => {
  const f = reviewFlag.get(`${r.origin_run_id}/${r.run}`) ?? reviewFlag.get(`${r.batch_run_id}/${r.run}`);
  if (!f) throw new Error(`no memory coding for ${r.run}`);
  return f;
};
const flaggedPatches = new Set(patches.filter((p) => ARMS.some((a) => flagFor(p.rows[a]).flagged)).map((p) => p.key));
const unflagged = patches.filter((p) => !flaggedPatches.has(p.key));
const memory = {
  reviews_coded: byCode.size,
  double_coded: doubles.length,
  kappa_flag: (() => { const k = cohenKappa(doubles.map(([a, b]) => [flag(a), flag(b)])); return { ...k, kappa: r3(k.kappa) }; })(),
  kappa_final_reasons: (() => { const k = cohenKappa(doubles.map(([a, b]) => [a.memory_in_final_reasons === "true", b.memory_in_final_reasons === "true"])); return { ...k, kappa: r3(k.kappa) }; })(),
  kappa_cited: (() => { const k = cohenKappa(doubles.map(([a, b]) => [a.memory_cited === "true", b.memory_cited === "true"])); return { ...k, kappa: r3(k.kappa) }; })(),
  flagged_reviews: Object.fromEntries(ARMS.map((arm) => [arm, patches.filter((p) => flagFor(p.rows[arm]).flagged).length])),
  cited_reviews: main.filter((r) => flagFor(r).cited).length,
  sole_basis_reviews: main.filter((r) => flagFor(r).sole).length,
  flagged_wrong_accepted: (() => {
    const wrongRows = main.filter((r) => labelOf(r) === "wrong");
    const f = wrongRows.filter((r) => flagFor(r).flagged), u = wrongRows.filter((r) => !flagFor(r).flagged);
    return { flagged: [f.filter((r) => r.verdict === "pass").length, f.length], unflagged: [u.filter((r) => r.verdict === "pass").length, u.length] };
  })(),
  flagged_correct_rejected: (() => {
    const correctRows = main.filter((r) => labelOf(r) === "correct");
    const f = correctRows.filter((r) => flagFor(r).flagged), u = correctRows.filter((r) => !flagFor(r).flagged);
    return { flagged: [f.filter((r) => r.verdict !== "pass").length, f.length], unflagged: [u.filter((r) => r.verdict !== "pass").length, u.length] };
  })(),
  patches_dropped: flaggedPatches.size,
  remaining: countBy(unflagged, (p) => p.label),
  rates_unflagged: armRates(unflagged),
  hypotheses_unflagged: hypotheses(unflagged),
};

const recall = readCsv(join(data, "recall-scores.csv"));
const recallById = new Map(recall.map((r) => [r.instance_id, r]));
const recallMain = recall.filter((r) => r.in_main_sample === "true");
const lineShare = (r: Row) => Number(r.lines_official_not_in_issue) > 0 ? Number(r.lines_recovered_not_in_issue) / Number(r.lines_official_not_in_issue) : NaN;
const shares = recallMain.map(lineShare).filter((x) => !Number.isNaN(x));
const recallMedian = median(shares);
const recallGroup = (p: Patch) => { const s = lineShare(recallById.get(p.instance_id)!); return Number.isNaN(s) ? "none" : s >= 1 ? "full_recall" : "partial_recall"; };
const recallSummary = {
  instances: recallMain.length,
  pooled_files_overlap: r3(sum(recallMain.map((r) => Number(r.files_overlap))) / sum(recallMain.map((r) => Number(r.files_official)))),
  pooled_lines_recovered: r3(sum(recallMain.map((r) => Number(r.lines_recovered))) / sum(recallMain.map((r) => Number(r.lines_official)))),
  pooled_lines_recovered_not_in_issue: r3(sum(recallMain.map((r) => Number(r.lines_recovered_not_in_issue))) / sum(recallMain.map((r) => Number(r.lines_official_not_in_issue)))),
  median_instance_share_not_in_issue: r3(recallMedian),
  instances_full_recall: shares.filter((s) => s >= 1).length,
  instances_zero_recall: shares.filter((s) => s === 0).length,
  cost_usd_main_instances: r3(sum(recallMain.map((r) => Number(r.cost_usd)))),
  cost_usd_all: r3(sum(recall.map((r) => Number(r.cost_usd)))),
  split: Object.fromEntries(["partial_recall", "full_recall", "none"].map((g) => [g, armRates(patches.filter((p) => recallGroup(p) === g))])),
  flag_rate_by_group: Object.fromEntries(["partial_recall", "full_recall", "none"].map((g) => {
    const rows = main.filter((r) => recallGroup(patchMap.get(patchKey(r))!) === g);
    return [g, [rows.filter((r) => flagFor(r).flagged).length, rows.length]];
  })),
};

const recallAfterById = new Map(readCsv(join(data, "recall-after-main.csv")).map((r) => [r.instance_id, r]));
const recallRunSummary = (rows: Row[]) => {
  const total = (f: string) => sum(rows.map((r) => Number(r[f])));
  const scored = rows.map(lineShare).filter((x) => !Number.isNaN(x));
  return {
    instances: rows.length,
    files_overlap: total("files_overlap"),
    files_official: total("files_official"),
    lines_recovered: total("lines_recovered"),
    lines_official: total("lines_official"),
    lines_recovered_not_in_issue: total("lines_recovered_not_in_issue"),
    lines_official_not_in_issue: total("lines_official_not_in_issue"),
    instances_scored: scored.length,
    instances_full_recall: scored.filter((s) => s >= 1).length,
    instances_zero_recall: scored.filter((s) => s === 0).length,
    cost_usd: r3(total("cost_usd")),
  };
};
const recallPairs = recallMain.map((b) => [b, recallAfterById.get(b.instance_id)!] as const);
const notInIssueDelta = recallPairs.map(([b, a]) => Number(a.lines_recovered_not_in_issue) - Number(b.lines_recovered_not_in_issue));
const scoredPairs = recallPairs.filter(([b]) => !Number.isNaN(lineShare(b)));
const fullPairs = scoredPairs.map(([b, a]) => [lineShare(b) >= 1, lineShare(a) >= 1] as [boolean, boolean]);
const groupAgreement = cohenKappa(fullPairs);
const groupChanged = new Set(scoredPairs.filter(([b, a]) => (lineShare(b) >= 1) !== (lineShare(a) >= 1)).map(([b]) => b.instance_id));
const groupedWrong = patches.filter((p) => p.label === "wrong" && recallGroup(p) !== "none");
const recallRuns = {
  before: recallRunSummary(recallMain),
  after: recallRunSummary(recallPairs.map(([, a]) => a)),
  not_in_issue_lines_per_issue: { more: notInIssueDelta.filter((d) => d > 0).length, fewer: notInIssueDelta.filter((d) => d < 0).length, same: notInIssueDelta.filter((d) => d === 0).length },
  group_agreement: {
    n: groupAgreement.n,
    agree: groupAgreement.agree,
    kappa: r3(groupAgreement.kappa),
    partial_to_full: fullPairs.filter(([b, a]) => !b && a).length,
    full_to_partial: fullPairs.filter(([b, a]) => b && !a).length,
  },
  grouped_wrong_patches: groupedWrong.length,
  grouped_wrong_patches_changing_group: groupedWrong.filter((p) => groupChanged.has(p.instance_id)).length,
};

const requires = readCsv(join(data, "issue-requires-coding.csv"));
const requiresByKey = new Map(requires.map((r) => [patchKey(r), r.issue_requires_failing_test]));
const wrongPatches = patches.filter((p) => p.label === "wrong");
if (wrongPatches.some((p) => !requiresByKey.has(p.key))) throw new Error("missing issue-requirement code");
const requirementOf = (p: Patch) => (p.label === "wrong" ? requiresByKey.get(p.key) : undefined);
const withoutNotRequired = patches.filter((p) => requirementOf(p) !== "not_required");
const labelQuestion = {
  coding: countBy(wrongPatches, (p) => requiresByKey.get(p.key)!),
  by_group: Object.fromEntries(["required", "unclear", "not_required", "no_failing_test"].map((g) => [g, armRates(patches.filter((p) => requirementOf(p) === g))])),
  without_not_required: { rates: armRates(withoutNotRequired), hypotheses: hypotheses(withoutNotRequired) },
  required_only: { rates: armRates(patches.filter((p) => p.label === "correct" || requiresByKey.get(p.key) === "required")) },
};

const highByKey = new Map(patches.map((p) => [p.key, p.rows.high]));
const flips = repeat.filter((r) => highByKey.get(patchKey(r))!.verdict !== r.verdict);
const repeats = {
  n: repeat.length,
  flips: flips.length,
  flip_rate_ci: wilson(flips.length, repeat.length).map(r3),
  same_prompt_as_main: repeat.filter((r) => highByKey.get(patchKey(r))!.prompt_sha256 === r.prompt_sha256).length,
  cost_usd: r3(sum(repeat.map((r) => Number(r.cost_usd)))),
  cost_abs_diff_median: r4(median(repeat.map((r) => Math.abs(Number(r.cost_usd) - Number(highByKey.get(patchKey(r))!.cost_usd))))),
  cost_log_ratio_rms: r3(Math.sqrt(sum(repeat.map((r) => Math.log(Number(r.cost_usd) / Number(highByKey.get(patchKey(r))!.cost_usd)) ** 2)) / repeat.length)),
  label_mix: countBy(repeat, labelOf),
  by_label: Object.fromEntries(["wrong", "correct"].map((label) => {
    const rows = repeat.filter((r) => labelOf(r) === label);
    const flipped = flips.filter((r) => labelOf(r) === label).length;
    return [label, { n: rows.length, flips: flipped, flip_rate_ci: wilson(flipped, rows.length).map(r3), verdicts: countBy(rows, (r) => r.verdict) }];
  })),
};

const issues = readCsv(join(data, "issue-properties.csv"));
const issueProperties = Object.fromEntries(["mentions_upstream_pr_or_commit", "upstream_reference_in_last_300_chars", "proposes_code_change", "contains_traceback", "duplicated_sentence"].map((f) => [f, issues.filter((i) => i[f] === "true").length]));

const attempts = readCsv(join(data, "attempts.csv"));
const ledger = readCsv(join(data, "spend-ledger.csv"));
const spendByBatch: Record<string, number> = {};
for (const l of ledger) spendByBatch[l.batch_run_id] = (spendByBatch[l.batch_run_id] ?? 0) + Number(l.cost_usd);
const provenance = {
  rows_by_origin: countBy(main, (r) => `${r.harness_commit}/${r.origin_vm_type}`),
  stop_reasons: countBy(main, (r) => r.stop_reason),
  verdicts: countBy(main, (r) => r.verdict),
  model_cli: countBy(main, (r) => `${r.model}/${r.cli_version}`),
  environment_hashes: new Set(main.map((r) => r.environment_sha256)).size,
  prompt_hash_per_patch_consistent: patches.every((p) => new Set(ARMS.map((a) => p.rows[a].prompt_sha256)).size === 1),
  attempts_total: attempts.length,
  attempts_not_kept: countBy(attempts.filter((a) => a.kept_in_results === "false"), (a) => `${a.stop_reason}|${a.api_error_status}`),
  attempts_not_kept_by_arm: countBy(attempts.filter((a) => a.kept_in_results === "false" && a.stop_reason.startsWith("verdict_absent")), (a) => a.effort),
  attempts_not_kept_cost: r4(sum(attempts.filter((a) => a.kept_in_results === "false").map((a) => Number(a.cost_usd)))),
  main_cost_kept: r4(sum(main.map((r) => Number(r.cost_usd)))),
  spend_by_batch: Object.fromEntries(Object.entries(spendByBatch).map(([k, v]) => [k, r4(v)])),
  spend_total_recorded: r4(sum(Object.values(spendByBatch))),
};

const results = {
  generated_from: "data/*.csv",
  seed: SEED,
  resamples: RESAMPLES,
  provenance,
  label_changes: labelChanges(labelsPath),
  rates,
  hypotheses: primary,
  holm: holmResult,
  holm_with_mid_p: holmMidP,
  original_labels: originalLabels,
  guardrail,
  ceiling,
  cost,
  wall_by_vm: wallByVm,
  incremental,
  negative_predictive_value: npvByShare,
  label_error_sensitivity: labelError,
  manipulation,
  disagreement,
  blinded_look: blindedLook,
  incomplete,
  sensitivity_incomplete_as_accept: sensitivityIncompleteAccept,
  malformed_verdicts: main.filter((r) => !["pass", "fail"].includes(r.verdict)).length,
  contamination,
  memory,
  recall: recallSummary,
  recall_runs: recallRuns,
  label_question: labelQuestion,
  repeats,
  issue_properties: { issues: issues.length, ...issueProperties },
};
mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, "results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify({ rates, hypotheses: primary, holm: holmResult, guardrail, disagreement, blindedLook, repeats }, null, 1));
