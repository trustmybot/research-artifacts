import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { readCsv, readLabels, type Label, type Row } from "./lib.ts";

const { values } = parseArgs({ options: { reviews: { type: "string" }, results: { type: "string" }, labels: { type: "string" }, out: { type: "string" } } });
if (!values.reviews || !values.results || !values.labels || !values.out) {
  console.error("usage: node shallow-pass.ts --reviews <reviews.csv> --results <results.csv> --labels <labels.csv> --out <shallow-pass.json>");
  process.exit(2);
}
const MODELS = ["opus", "sonnet", "haiku"] as const;
const ARMS = ["low", "medium", "high"] as const;
const MAX_SHALLOW_TOOL_CALLS = 1;

const reviews = readCsv(values.reviews);
const opusMain = readCsv(values.results).filter((r) => r.study_part === "main");
if (reviews.length !== 810) throw new Error(`expected 810 reviews, got ${reviews.length}`);
if (opusMain.length !== 270) throw new Error(`expected 270 Opus main reviews, got ${opusMain.length}`);

const keyOf = (r: Row) => `${r.instance_id}|${r.agent_id}|${r.effort}`;
const opusInReviews = new Map(reviews.filter((r) => r.model === "opus").map((r) => [keyOf(r), r]));
const shared = ["verdict", "label", "tool_calls", "thinking_tokens", "bash_test_runs"];
const mismatches = opusMain.filter((r) => {
  const o = opusInReviews.get(keyOf(r));
  return !o || shared.some((f) => o[f] !== r[f]);
});
if (mismatches.length) throw new Error(`${mismatches.length} Opus main rows differ between results.csv and reviews.csv`);

const labels = readLabels(values.labels, reviews);
type LabelColumn = "label" | "original_label";
const labelOf = (r: Row, column: LabelColumn): Label => labels.get(`${r.instance_id}|${r.agent_id}`)![column];

const num = (r: Row, f: string) => Number(r[f]);
const signals = {
  no_thinking: (r: Row) => num(r, "thinking_tokens") === 0,
  at_most_one_tool_call: (r: Row) => num(r, "tool_calls") <= MAX_SHALLOW_TOOL_CALLS,
  no_test_run: (r: Row) => num(r, "bash_test_runs") === 0,
};
type Signal = keyof typeof signals;

function tally(rows: Row[], signal: Signal, column: LabelColumn) {
  const hit = rows.filter(signals[signal]);
  const pass = hit.filter((r) => r.verdict === "pass");
  return {
    reviews: hit.length,
    pass: pass.length,
    fail: hit.filter((r) => r.verdict === "fail").length,
    malformed: hit.filter((r) => !["pass", "fail"].includes(r.verdict)).length,
    pass_on_correct: pass.filter((r) => labelOf(r, column) === "correct").length,
    pass_on_wrong: pass.filter((r) => labelOf(r, column) === "wrong").length,
  };
}

const tallies = (column: LabelColumn) => Object.fromEntries(MODELS.map((model) => [model, Object.fromEntries(ARMS.map((arm) => {
  const rows = reviews.filter((r) => r.model === model && r.effort === arm);
  if (rows.length !== 90) throw new Error(`expected 90 reviews for ${model} ${arm}`);
  const passes = rows.filter((r) => r.verdict === "pass");
  return [arm, {
    reviews: rows.length,
    pass: passes.length,
    pass_on_correct: passes.filter((r) => labelOf(r, column) === "correct").length,
    pass_on_wrong: passes.filter((r) => labelOf(r, column) === "wrong").length,
    no_thinking: tally(rows, "no_thinking", column),
    at_most_one_tool_call: tally(rows, "at_most_one_tool_call", column),
    no_test_run: tally(rows, "no_test_run", column),
  }];
}))]));
const byModel = tallies("label");

const results = {
  generated_from: [values.reviews, values.results, values.labels],
  definitions: {
    no_thinking: "thinking_tokens = 0",
    at_most_one_tool_call: `tool_calls <= ${MAX_SHALLOW_TOOL_CALLS}`,
    no_test_run: "bash_test_runs = 0",
  },
  opus_main_rows_checked_against_reviews: opusMain.length,
  by_model: byModel,
  original_labels: { by_model: tallies("original_label") },
};
mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(values.out, JSON.stringify(results, null, 2) + "\n");
for (const model of MODELS) for (const arm of ARMS) {
  const c = byModel[model][arm];
  const fmt = (t: ReturnType<typeof tally>) => `${t.reviews} reviews, pass ${t.pass} (correct ${t.pass_on_correct}, wrong ${t.pass_on_wrong}), fail ${t.fail}, malformed ${t.malformed}`;
  console.log(`${model} ${arm}: pass ${c.pass} | no thinking: ${fmt(c.no_thinking)} | <=1 tool: ${fmt(c.at_most_one_tool_call)} | no test: ${fmt(c.no_test_run)}`);
}
