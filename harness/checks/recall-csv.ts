import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { csvField } from "../results-csv.ts";
import type { InstanceResult, RecallScores } from "./recall.ts";

export const COLUMNS = [
  "instance_id",
  "wrong_patches",
  "correct_patches",
  "status",
  "stop_reason",
  "model",
  "input_tokens",
  "output_tokens",
  "cost_usd",
  "parsed",
  "files_official",
  "files_answer",
  "files_overlap",
  "lines_official",
  "lines_recovered",
  "lines_official_not_in_issue",
  "lines_recovered_not_in_issue",
] as const;

const CRLF = "\r\n";
const USAGE = "usage: node harness/checks/recall-csv.ts --run <dir> --patches <path> --out <file>";
const STRATA = { swe_abs_wrong: "wrong_patches", swe_abs_correct: "correct_patches" } as const;

type PatchCounts = { wrong_patches: number; correct_patches: number };

export class RecallCsvRefusal extends Error {}

function patchCounts(patchesPath: string): Map<string, PatchCounts> {
  const entries = JSON.parse(readFileSync(patchesPath, "utf8")) as { instance_id: string; label_stratum: string }[];
  if (!Array.isArray(entries)) throw new RecallCsvRefusal(`${patchesPath} does not hold a list of entries`);
  const counts = new Map<string, PatchCounts>();
  for (const entry of entries) {
    const column = STRATA[entry.label_stratum as keyof typeof STRATA];
    if (!column) {
      throw new RecallCsvRefusal(`${patchesPath}: ${entry.instance_id} has label_stratum ${entry.label_stratum}`);
    }
    const count = counts.get(entry.instance_id) ?? { wrong_patches: 0, correct_patches: 0 };
    count[column] += 1;
    counts.set(entry.instance_id, count);
  }
  return counts;
}

function readResults(runDir: string): InstanceResult[] {
  const instancesDir = join(runDir, "instances");
  let names;
  try {
    names = readdirSync(instancesDir).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    throw new RecallCsvRefusal(`cannot read ${instancesDir}: ${(error as Error).message}`);
  }
  return names.map((name) => JSON.parse(readFileSync(join(instancesDir, name), "utf8")) as InstanceResult);
}

function csvRow(result: InstanceResult, counts: PatchCounts): string {
  const scores: Partial<RecallScores> = result.scores ?? {};
  const values: Record<(typeof COLUMNS)[number], unknown> = {
    instance_id: result.instance_id,
    wrong_patches: counts.wrong_patches,
    correct_patches: counts.correct_patches,
    status: result.status,
    stop_reason: result.stop_reason,
    model: result.model,
    input_tokens: result.input_tokens,
    output_tokens: result.output_tokens,
    cost_usd: result.cost_usd,
    parsed: scores.parsed,
    files_official: scores.files_official,
    files_answer: scores.files_answer,
    files_overlap: scores.files_overlap,
    lines_official: scores.lines_official,
    lines_recovered: scores.lines_recovered,
    lines_official_not_in_issue: scores.lines_official_not_in_issue,
    lines_recovered_not_in_issue: scores.lines_recovered_not_in_issue,
  };
  return COLUMNS.map((column) => csvField(values[column])).join(",") + CRLF;
}

export function recallCsv(runDir: string, patchesPath: string): string {
  const counts = patchCounts(patchesPath);
  const results = readResults(runDir);
  const seen = new Set<string>();
  const rows = results.map((result) => {
    const count = counts.get(result.instance_id);
    if (!count) throw new RecallCsvRefusal(`${result.instance_id} has a result but is not in ${patchesPath}`);
    seen.add(result.instance_id);
    return csvRow(result, count);
  });
  const missing = [...counts.keys()].filter((instanceId) => !seen.has(instanceId));
  if (missing.length > 0) throw new RecallCsvRefusal(`no result in ${runDir} for ${missing.join(", ")}`);
  return [COLUMNS.join(",") + CRLF, ...rows].join("");
}

function parseCli(args: string[]): { runDir: string; patchesPath: string; outPath: string } {
  const { values } = parseArgs({
    args,
    options: {
      run: { type: "string" },
      patches: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.run) throw new RecallCsvRefusal("--run is required");
  if (!values.patches) throw new RecallCsvRefusal("--patches is required");
  if (!values.out) throw new RecallCsvRefusal("--out is required");
  return { runDir: values.run, patchesPath: values.patches, outPath: values.out };
}

function main(): number {
  try {
    const { runDir, patchesPath, outPath } = parseCli(process.argv.slice(2));
    const csv = recallCsv(runDir, patchesPath);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, csv);
    console.log(outPath);
    return 0;
  } catch (error) {
    const isUsage = error instanceof RecallCsvRefusal || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    if (!isUsage) throw error;
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = main();
}
