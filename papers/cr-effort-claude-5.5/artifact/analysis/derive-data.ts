import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { toCsv } from "./lib.ts";

const { values } = parseArgs({
  options: {
    audit: { type: "string" },
    checks: { type: "string" },
    cache: { type: "string" },
    patches: { type: "string" },
    out: { type: "string" },
  },
});
for (const key of ["audit", "checks", "cache", "patches", "out"] as const) {
  if (!values[key]) {
    console.error("usage: node derive-data.ts --audit <memory audit dir> --checks <checks run dir> --cache <instance cache> --patches <main-patches.json> --out <data dir>");
    process.exit(2);
  }
}
const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const out = (name: string, columns: string[], rows: Record<string, unknown>[]) => writeFileSync(join(values.out!, name), toCsv(columns, rows));
const patches: any[] = readJson(values.patches!);

const MEMORY_FIELDS = ["memory_cited", "memory_proven", "memory_in_thinking_decisive", "memory_in_final_reasons", "memory_sole_basis", "evidence_supports_verdict", "guess"];
const key: Record<string, { run_id: string; run: string }> = readJson(join(values.audit!, "key-do-not-share.json"));
const batches: string[][] = readJson(join(values.audit!, "batches.json"));
const coded: Record<string, unknown>[] = [];
batches.forEach((codes, i) => {
  const rows: any[] = readJson(join(values.audit!, `coded-${i + 1}.json`));
  for (const row of rows) {
    if (!codes.includes(row.code)) throw new Error(`code ${row.code} not in batch ${i + 1}`);
    coded.push({ coder_batch: i + 1, code: row.code, run_id: key[row.code].run_id, run: key[row.code].run, ...Object.fromEntries(MEMORY_FIELDS.map((f) => [f, row[f]])) });
  }
});
out("memory-coding.csv", ["coder_batch", "code", "run_id", "run", ...MEMORY_FIELDS], coded);

const recallDir = join(values.checks!, "recall", "instances");
const mainInstances = new Set(patches.map((p) => p.instance_id));
const SCORE_FIELDS = ["parsed", "files_official", "files_answer", "files_overlap", "lines_official", "lines_recovered", "lines_official_not_in_issue", "lines_recovered_not_in_issue"];
const recall = readdirSync(recallDir).sort().map((file) => {
  const r = readJson(join(recallDir, file));
  return { instance_id: r.instance_id, in_main_sample: mainInstances.has(r.instance_id), status: r.status, model: r.model, cost_usd: r.cost_usd, ...Object.fromEntries(SCORE_FIELDS.map((f) => [f, r.scores?.[f]])) };
});
out("recall-scores.csv", ["instance_id", "in_main_sample", "status", "model", "cost_usd", ...SCORE_FIELDS], recall);

const verdicts: any[] = readJson(join(values.checks!, "label-check", "label-check.json")).verdicts;
const exclusions: any[] = readJson(join(values.checks!, "label-check", "exclusions.json"));
const labelRows = patches.map((p) => {
  const v = verdicts.find((x) => x.instance_id === p.instance_id && x.agent_id === p.agent_id);
  return {
    instance_id: p.instance_id,
    agent_id: p.agent_id,
    label_stratum: p.label_stratum,
    verified_pass: v?.verified_pass,
    abs_pass: v?.abs_pass,
    repeats_agree: v?.repeats_agree,
    control_ok: v?.control_ok,
    matches_label: v?.matches_label,
    abs_failing_tests_run1: v?.abs_failing_tests?.[0]?.length ?? "",
    official_abs_failing_tests: v?.official_abs_failing_tests?.length ?? "",
  };
});
out("label-check-summary.csv", ["instance_id", "agent_id", "label_stratum", "verified_pass", "abs_pass", "repeats_agree", "control_ok", "matches_label", "abs_failing_tests_run1", "official_abs_failing_tests"], labelRows);
out("label-check-exclusions.csv", ["instance_id", "agent_id", "reason"], exclusions.map((e) => ({ instance_id: e.instance_id, agent_id: e.agent_id, reason: e.reason ?? e.exclusion_reason ?? "" })));

function fileChanges(diff: string): Map<string, string> {
  const files = new Map<string, string>();
  let current = "";
  let body: string[] = [];
  const flush = () => { if (current) files.set(current, body.join("\n")); };
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (header) { flush(); current = header[2]; body = []; continue; }
    if (!current) {
      const plain = /^\+\+\+ b\/(\S+)/.exec(line);
      if (plain) { flush(); current = plain[1]; body = []; }
      continue;
    }
    if (/^(\+|-)/.test(line) && !/^(\+\+\+|---) /.test(line)) body.push(line.replace(/\s+$/, ""));
  }
  flush();
  return files;
}

const similarity = patches.map((p) => {
  const row = readJson(join(values.cache!, p.instance_id, "dataset-row.json"));
  const candidate = fileChanges(readFileSync(join(values.cache!, p.instance_id, `${p.agent_id}.diff`), "utf8"));
  const official = fileChanges(row.patch);
  const tests = fileChanges(row.test_patch);
  const sameFiles = [...official.keys()].filter((f) => candidate.get(f) === official.get(f));
  const sourceFiles = [...candidate.keys()].filter((f) => !tests.has(f) && !/(^|\/)tests?\//.test(f));
  const identical = official.size > 0 && sourceFiles.length === official.size && sourceFiles.every((f) => candidate.get(f) === official.get(f));
  return {
    instance_id: p.instance_id,
    agent_id: p.agent_id,
    label_stratum: p.label_stratum,
    candidate_files: candidate.size,
    official_files: official.size,
    official_files_touched: [...official.keys()].filter((f) => candidate.has(f)).length,
    identical_to_official: identical,
    official_file_identical: sameFiles.length > 0,
    test_patch_file_identical: [...tests.keys()].some((f) => candidate.get(f) === tests.get(f)),
    touches_test_files: [...candidate.keys()].some((f) => tests.has(f) || /(^|\/)tests?\//.test(f)),
  };
});
out("patch-similarity.csv", ["instance_id", "agent_id", "label_stratum", "candidate_files", "official_files", "official_files_touched", "identical_to_official", "official_file_identical", "test_patch_file_identical", "touches_test_files"], similarity);

const UPSTREAM = /github\.com\/django\/django\/(pull|commit)\/|code\.djangoproject\.com\/ticket\/|\bPR\b|pull request/i;
const issues = [...new Set(patches.map((p) => p.instance_id))].sort().map((id) => {
  const text: string = readJson(join(values.cache!, id, "dataset-row.json")).problem_statement;
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length >= 40);
  const seen = new Set<string>();
  const duplicated = sentences.some((s) => (seen.has(s) ? true : (seen.add(s), false)));
  const tail = text.slice(-300);
  return {
    instance_id: id,
    issue_chars: text.length,
    mentions_upstream_pr_or_commit: /github\.com\/django\/django\/(pull|commit)\//.test(text),
    upstream_reference_in_last_300_chars: UPSTREAM.test(tail),
    proposes_code_change: /should be changed|the fix is|solution is|replacing the above|I rewrite|proposed solution|patch/i.test(text),
    contains_traceback: /Traceback \(most recent call last\)/.test(text),
    duplicated_sentence: duplicated,
  };
});
out("issue-properties.csv", ["instance_id", "issue_chars", "mentions_upstream_pr_or_commit", "upstream_reference_in_last_300_chars", "proposes_code_change", "contains_traceback", "duplicated_sentence"], issues);
console.log(`memory ${coded.length}, recall ${recall.length}, label ${labelRows.length}, similarity ${similarity.length}, issues ${issues.length}`);
if (!existsSync(join(values.out!, "issue-requires-coding.csv"))) console.warn("issue-requires-coding.csv is missing");
