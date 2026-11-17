import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { COLUMNS, csvField } from "../../../../harness/results-csv.ts";

export const MAIN_FINAL_BATCHES = [
  "20261102t232020z-a83c3e6-s0of6",
  "20261102t200744z-a83c3e6-s1of6",
  "20261102t200806z-a83c3e6-s2of6",
  "20261102t232104z-a83c3e6-s3of6",
  "20261102t232152z-a83c3e6-s4of6",
  "20261102t232227z-a83c3e6-s5of6",
];
export const REPEAT_BATCH = "20261103t051423z-9d882cf-r2";

const EXTRA = ["study_part", "label", "batch_run_id", "origin_run_id", "harness_commit", "origin_vm_type"] as const;
const ATTEMPT_COLUMNS = ["batch_run_id", "harness_commit", "run", "instance_id", "effort", "verdict", "stop_reason", "api_error_status", "cost_usd", "kept_in_results"] as const;

type Json = Record<string, any>;
const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const commitOf = (runId: string): string => runId.split("-")[1];

function apiErrorStatus(transcript: string): string {
  if (!existsSync(transcript)) return "";
  const lines = readFileSync(transcript, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = JSON.parse(lines[i]);
    if (event.type === "result") return event.api_error_status == null ? "" : String(event.api_error_status);
  }
  return "";
}

export function build(runsDir: string) {
  const summary = (batch: string): Json => readJson(join(runsDir, batch, "summary.json"));
  const origin = (batch: string, run: string): string => {
    let current = batch;
    for (;;) {
      const s = summary(current);
      const entry = (s.runs as Json[]).find((r) => r.run === run);
      if (!entry) throw new Error(`${run} missing from ${current}`);
      if (!entry.reused) return current;
      current = s.resumed_from;
    }
  };
  const lineage = new Set<string>();
  for (const batch of MAIN_FINAL_BATCHES) {
    for (let b: string | null = batch; b; b = summary(b).resumed_from ?? null) lineage.add(b);
  }

  const kept = new Set<string>();
  const rows: string[] = [[...COLUMNS, ...EXTRA].join(",")];
  const push = (batch: string, run: string, part: string, from: string) => {
    const record = readJson(join(runsDir, batch, "runs", run, "run.json"));
    kept.add(`${from}/${run}`);
    const extra: Json = {
      study_part: part,
      label: record.label_stratum === "swe_abs_wrong" ? "wrong" : "correct",
      batch_run_id: batch,
      origin_run_id: from,
      harness_commit: commitOf(from),
      origin_vm_type: summary(from).vm_type,
    };
    rows.push([...COLUMNS.map((c) => csvField(c === "run" ? run : record[c])), ...EXTRA.map((c) => csvField(extra[c]))].join(","));
  };
  for (const batch of MAIN_FINAL_BATCHES) for (const e of summary(batch).runs as Json[]) push(batch, e.run, "main", origin(batch, e.run));
  for (const e of summary(REPEAT_BATCH).runs as Json[]) push(REPEAT_BATCH, e.run, "repeat", REPEAT_BATCH);

  const attempts: string[] = [ATTEMPT_COLUMNS.join(",")];
  for (const batch of [...[...lineage].sort(), REPEAT_BATCH]) {
    for (const e of summary(batch).runs as Json[]) {
      if (e.reused) continue;
      const dir = join(runsDir, batch, "runs", e.run);
      const record = existsSync(join(dir, "run.json")) ? readJson(join(dir, "run.json")) : {};
      const cells: Json = {
        batch_run_id: batch,
        harness_commit: commitOf(batch),
        run: e.run,
        instance_id: record.instance_id ?? "",
        effort: record.effort ?? "",
        verdict: e.verdict ?? "",
        stop_reason: e.stop_reason ?? "",
        api_error_status: apiErrorStatus(join(dir, "transcript.jsonl")),
        cost_usd: e.cost_usd ?? 0,
        kept_in_results: kept.has(`${batch}/${e.run}`),
      };
      attempts.push(ATTEMPT_COLUMNS.map((c) => csvField(cells[c])).join(","));
    }
  }

  const ledger: string[] = ["batch_run_id,item,cost_usd"];
  for (const batch of readdirSync(runsDir).sort()) {
    for (const sub of ["runs", "pilot/runs"]) {
      const dir = join(runsDir, batch, sub);
      if (!existsSync(dir)) continue;
      const summaryPath = join(dir, "..", "summary.json");
      const reused = new Set<string>(existsSync(summaryPath) ? readJson(summaryPath).reused_runs ?? [] : []);
      for (const run of readdirSync(dir).sort()) {
        if (reused.has(run)) continue;
        const path = join(dir, run, "run.json");
        if (existsSync(path)) ledger.push([batch, `${sub}/${run}`, readJson(path).cost_usd ?? 0].map(csvField).join(","));
      }
    }
    const recall = join(runsDir, batch, "recall", "summary.json");
    if (existsSync(recall)) ledger.push([batch, "recall", readJson(recall).spent_usd ?? 0].map(csvField).join(","));
  }
  const crlf = (lines: string[]) => lines.join("\r\n") + "\r\n";
  return { results: crlf(rows), attempts: crlf(attempts), ledger: crlf(ledger) };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { runs: { type: "string" }, out: { type: "string" } } });
  if (!values.runs || !values.out) {
    console.error("usage: node build-results.ts --runs <gcs runs dir> --out <data dir>");
    process.exit(2);
  }
  const { results, attempts, ledger } = build(values.runs);
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "results.csv"), results);
  writeFileSync(join(values.out, "attempts.csv"), attempts);
  writeFileSync(join(values.out, "spend-ledger.csv"), ledger);
}
