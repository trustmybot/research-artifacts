import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { median, readCsv, readLabels, type Label, type Row } from "../../../artifact/analysis/lib.ts";
import { mcnemarOneSided, newcombePaired, wilson } from "../../../artifact/analysis/stats.ts";

const USAGE = "usage: node analysis/analyze.ts --reviews <reviews.csv> --discarded <discarded.csv> --labels <labels.csv> --requires <issue-requires-coding.csv> --main-reviews <haiku-vs-opus reviews.csv> --out <json>";

export const MODELS: Record<string, string> = {
  "claude-sonnet-5-5-high": "Claude Sonnet 5.5, high",
  "claude-opus-5-5-max": "Claude Opus 5.5, max",
  "gpt-5.6-luna-medium": "GPT-5.6 Luna, medium",
  "gpt-5.6-sol-medium": "GPT-5.6 Sol, medium",
  "gpt-5.6-terra-medium": "GPT-5.6 Terra, medium",
  "gpt-5.5-medium": "GPT-5.5, medium",
  "gemini-4-carbon-medium": "Gemini 4 Carbon, medium",
  "gemini-4-neon-high": "Gemini 4 Neon, high",
  "kimi-k3-high": "Kimi K3, high",
  "muse-wonder-1.0-high": "MUSE Wonder 1.0, high",
  "composer-2.5-fast": "Composer 2.5, fast",
};
export const MAIN_SETTINGS = ["opus-medium", "opus-high", "sonnet-high", "haiku-high"];
const REQUIREMENT_GROUPS = ["required", "unclear", "not_required", "no_failing_test"];

type Verdict = "pass" | "fail" | null;
type Cell = Map<string, Verdict>;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const keyOf = (r: Row) => `${r.instance_id}|${r.agent_id}`;
const verdictOf = (v: string): Verdict => (v === "pass" || v === "fail" ? v : null);
const accepts = (v: Verdict | undefined) => v === "pass";

export interface AnalyzeInput {
  reviews: Row[];
  discarded: Row[];
  labelsPath: string;
  requires: Row[];
  mainReviews: Row[];
}

export function analyze({ reviews, discarded, labelsPath, requires, mainReviews }: AnalyzeInput) {
  const patchLabels = readLabels(labelsPath, reviews.map((r) => ({ ...r, label: r.label_stratum.replace(/^swe_abs_/, "") })));
  const label = new Map([...patchLabels].map(([k, l]) => [k, l.label]));
  const original = new Map([...patchLabels].map(([k, l]) => [k, l.original_label]));
  const requiresGroup = new Map(requires.map((r) => [keyOf(r), r.issue_requires_failing_test]));

  const cells = new Map<string, Cell>(Object.keys(MODELS).map((m) => [m, new Map()]));
  const duplicates: string[] = [];
  for (const r of reviews) {
    const cell = cells.get(r.model);
    if (!cell) throw new Error(`unknown model ${r.model}`);
    if (cell.has(keyOf(r))) duplicates.push(`${r.model} ${keyOf(r)}`);
    cell.set(keyOf(r), verdictOf(r.verdict));
  }
  const main = new Map<string, Cell>();
  for (const r of mainReviews) {
    const setting = `${r.model}-${r.effort}`;
    if (!main.has(setting)) main.set(setting, new Map());
    main.get(setting)!.set(keyOf(r), verdictOf(r.verdict));
  }

  function rates(cell: Cell) {
    const keys = [...cell.keys()].filter((k) => label.has(k));
    const wrong = keys.filter((k) => label.get(k) === "wrong");
    const correct = keys.filter((k) => label.get(k) === "correct");
    const fsK = wrong.filter((k) => accepts(cell.get(k))).length;
    const faK = correct.filter((k) => !accepts(cell.get(k))).length;
    const ba = (1 - fsK / wrong.length + (1 - faK / correct.length)) / 2;
    return {
      reviews: keys.length,
      wrong: wrong.length,
      correct: correct.length,
      no_verdict: keys.filter((k) => cell.get(k) === null).length,
      false_success: { k: fsK, n: wrong.length, rate: r3(fsK / wrong.length), ci: wilson(fsK, wrong.length).map(r3) },
      false_alarm: { k: faK, n: correct.length, rate: r3(faK / correct.length), ci: wilson(faK, correct.length).map(r3) },
      balanced_agreement: r3(ba),
      youden_j: r3(2 * ba - 1),
    };
  }

  // Paired against a reference setting on the patches both reviewed; ΔJ takes a MOVER interval from the two Newcombe intervals.
  function versus(cell: Cell, ref: Cell) {
    const [w, cr] = (["wrong", "correct"] as Label[]).map((stratum) => {
      let a = 0, b = 0, c = 0, d = 0;
      for (const [key, verdict] of cell) {
        if (label.get(key) !== stratum || !ref.has(key)) continue;
        const x = !accepts(verdict), y = !accepts(ref.get(key));
        if (x && y) a++; else if (x) b++; else if (y) c++; else d++;
      }
      return { a, b, c, d, diff: newcombePaired(a, b, c, d) };
    });
    const dj = w.diff.estimate - cr.diff.estimate;
    const shared = [...cell.keys()].filter((k) => ref.has(k) && label.has(k));
    return {
      patches: shared.length,
      same_verdict: shared.filter((k) => accepts(cell.get(k)) === accepts(ref.get(k))).length,
      wrong_reject_both: w.a, wrong_reject_only_this: w.b, wrong_reject_only_ref: w.c, wrong_reject_neither: w.d,
      wrong_exact_p_two_sided: r4(Math.min(1, 2 * mcnemarOneSided(Math.max(w.b, w.c), Math.min(w.b, w.c)).exact_p)),
      false_success_diff: { estimate: r3(-w.diff.estimate), ci: [r3(-w.diff.upper), r3(-w.diff.lower)] },
      correct_alarm_only_this: cr.b, correct_alarm_only_ref: cr.c,
      delta_j: r3(dj),
      delta_j_ci_mover: [
        r3(dj - Math.sqrt((w.diff.estimate - w.diff.lower) ** 2 + (cr.diff.upper - cr.diff.estimate) ** 2)),
        r3(dj + Math.sqrt((w.diff.upper - w.diff.estimate) ** 2 + (cr.diff.estimate - cr.diff.lower) ** 2)),
      ],
    };
  }

  function byRequirement(cell: Cell) {
    return Object.fromEntries(REQUIREMENT_GROUPS.map((g) => {
      const wrong = [...cell.keys()].filter((k) => label.get(k) === "wrong" && requiresGroup.get(k) === g);
      const k = wrong.filter((key) => accepts(cell.get(key))).length;
      return [g, { k, n: wrong.length, rate: wrong.length ? r3(k / wrong.length) : null }];
    }));
  }

  function originalRates(cell: Cell) {
    const keys = [...cell.keys()].filter((k) => original.has(k));
    const wrong = keys.filter((k) => original.get(k) === "wrong");
    const correct = keys.filter((k) => original.get(k) === "correct");
    const fsK = wrong.filter((k) => accepts(cell.get(k))).length;
    const faK = correct.filter((k) => !accepts(cell.get(k))).length;
    return {
      false_success: { k: fsK, n: wrong.length, rate: r3(fsK / wrong.length) },
      false_alarm: { k: faK, n: correct.length, rate: r3(faK / correct.length) },
      balanced_accuracy: r3((1 - fsK / wrong.length + 1 - faK / correct.length) / 2),
    };
  }

  function work(model: string) {
    const rows = reviews.filter((r) => r.model === model);
    const timed = rows.filter((r) => r.wall_s !== "");
    const count = (r: Row, column: string) => Number(r[column]);
    return {
      wall_min_median: timed.length ? r3(median(timed.map((r) => Number(r.wall_s) / 60))) : null,
      container_test_runs_median: rows.length ? median(rows.map((r) => count(r, "container_test_runs"))) : null,
      tool_calls_median: rows.length ? median(rows.map((r) => count(r, "tool_calls"))) : null,
      audited: rows.length,
      audit_flagged: rows
        .filter((r) => r.prompt_exact !== "true" || ["forbidden_tools", "network_commands", "outside_tool_output", "outside_pathless_search", "outside_tmp", "outside_other"].some((c) => count(r, c) > 0))
        .map((r) => r.id)
        .sort(),
      host_tmp_writes: rows.filter((r) => count(r, "host_tmp_paths") > 0).length,
      checkout_changed: rows.filter((r) => r.checkout_unchanged !== "true").length,
    };
  }

  function panel(models: string[]) {
    const wrong = [...label].filter(([, l]) => l === "wrong").map(([k]) => k);
    const correct = [...label].filter(([, l]) => l === "correct").map(([k]) => k);
    const rejecters = (key: string) => models.filter((m) => !accepts(cells.get(m)!.get(key))).length;
    const majority = Math.floor(models.length / 2) + 1;
    return {
      models: models.length,
      wrong_rejected_by_any: wrong.filter((k) => rejecters(k) > 0).length,
      wrong_rejected_by_none: wrong.filter((k) => rejecters(k) === 0).length,
      correct_rejected_by_any: correct.filter((k) => rejecters(k) > 0).length,
      majority_vote: {
        false_success: { k: wrong.filter((k) => rejecters(k) < majority).length, n: wrong.length },
        false_alarm: { k: correct.filter((k) => rejecters(k) >= majority).length, n: correct.length },
      },
    };
  }

  const setting = (name: string) => {
    const cell = main.get(name);
    if (!cell) throw new Error(`the main-study reviews have no ${name} rows`);
    return cell;
  };
  const models = Object.keys(MODELS);
  const reviewsWith = (column: string) => reviews.filter((r) => Number(r[column]) > 0).length;
  return {
    coverage: { results: reviews.length, discarded: discarded.length, duplicates, audited: reviews.length },
    audit: {
      prompt_not_exact: reviews.filter((r) => r.prompt_exact !== "true").length,
      forbidden_tools: reviewsWith("forbidden_tools"),
      network_commands: reviewsWith("network_commands"),
      outside_tool_output: reviewsWith("outside_tool_output"),
      outside_pathless_search: reviewsWith("outside_pathless_search"),
      outside_tmp: reviewsWith("outside_tmp"),
      outside_other: reviewsWith("outside_other"),
      host_tmp_paths: reviewsWith("host_tmp_paths"),
      checkout_changed: reviews.filter((r) => r.checkout_unchanged !== "true").length,
      no_verdict: reviews.filter((r) => verdictOf(r.verdict) === null).length,
    },
    paper_reference: Object.fromEntries(MAIN_SETTINGS.map((s) => [s, rates(setting(s))])),
    by_model: Object.fromEntries(models.map((m) => {
      const cell = cells.get(m)!;
      return [m, { name: MODELS[m], ...rates(cell), by_requirement: byRequirement(cell), original_labels: originalRates(cell), versus_paper_opus_medium: versus(cell, setting("opus-medium")), work: work(m) }];
    })),
    paper_reference_by_requirement: Object.fromEntries(MAIN_SETTINGS.map((s) => [s, byRequirement(setting(s))])),
    panel_all: panel(models),
    panel_non_claude: panel(models.filter((m) => !m.startsWith("claude"))),
    bridge: {
      sonnet_high: versus(cells.get("claude-sonnet-5-5-high")!, setting("sonnet-high")),
      opus_max_vs_paper_opus_high: versus(cells.get("claude-opus-5-5-max")!, setting("opus-high")),
    },
  };
}

if (import.meta.main) {
  const options = { reviews: { type: "string" }, discarded: { type: "string" }, labels: { type: "string" }, requires: { type: "string" }, "main-reviews": { type: "string" }, out: { type: "string" } } as const;
  const { values } = parseArgs({ options });
  if (!values.reviews || !values.discarded || !values.labels || !values.requires || !values["main-reviews"] || !values.out) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const result = analyze({
      reviews: readCsv(values.reviews),
      discarded: readCsv(values.discarded),
      labelsPath: values.labels,
      requires: readCsv(values.requires),
      mainReviews: readCsv(values["main-reviews"]),
    });
    writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);
    for (const [model, b] of Object.entries(result.by_model)) {
      const v = b.versus_paper_opus_medium;
      console.log(`${model.padEnd(24)} false success ${b.false_success.k}/${b.false_success.n}, false alarm ${b.false_alarm.k}/${b.false_alarm.n}, J ${b.youden_j}, ΔJ vs Opus medium ${v.delta_j} [${v.delta_j_ci_mover.join(", ")}]`);
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
