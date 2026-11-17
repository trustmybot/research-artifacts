import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";

export const COLUMNS = [
  "run",
  "instance_id",
  "agent_id",
  "label_stratum",
  "effort",
  "effective_effort",
  "model",
  "arm",
  "cli_version",
  "verdict",
  "stop_reason",
  "skill_verdict",
  "skill_invocations",
  "cost_usd",
  "wall_ms",
  "turns",
  "tool_calls",
  "bash_commands",
  "bash_test_runs",
  "bash_inline_code_runs",
  "bash_test_files_written",
  "bash_failures",
  "test_files_written",
  "input_tokens",
  "output_tokens",
  "thinking_tokens",
  "thinking_blocks",
  "thinking_chars",
  "cache_read_tokens",
  "cache_write_tokens",
  "run_order",
  "repeat_number",
  "seed",
  "vm_type",
  "platform",
  "patch_sha256",
  "prompt_sha256",
  "environment_sha256",
  "image_digest",
] as const;

export const LIMIT_RERUN_SUFFIX = "-limitrerun";
const LIMIT_RERUN_OF = "limit_rerun_of";
const RUN_FILE = "run.json";
const CRLF = "\r\n";
const USAGE = "usage: node harness/results-csv.ts --runs <dir> --out <file>";

export class ResultsRefusal extends Error {}

export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function findRunFiles(runsDir: string): string[] {
  let entries;
  try {
    entries = readdirSync(runsDir, { recursive: true, withFileTypes: true });
  } catch (error) {
    throw new ResultsRefusal(`cannot read ${runsDir}: ${(error as Error).message}`);
  }
  const relativePaths = entries
    .filter((entry) => entry.isFile() && entry.name === RUN_FILE)
    .map((entry) => relative(runsDir, join(entry.parentPath, entry.name)))
    .sort();
  if (relativePaths.length === 0) throw new ResultsRefusal(`no ${RUN_FILE} below ${runsDir}`);
  return relativePaths;
}

function readRunRecord(path: string): Record<string, unknown> {
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ResultsRefusal(`cannot parse ${path}: ${(error as Error).message}`);
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new ResultsRefusal(`cannot parse ${path}: not a JSON object`);
  }
  return record as Record<string, unknown>;
}

function limitRerunOf(run: string, record: Record<string, unknown>, path: string): string | null {
  const folder = basename(run);
  const isCompanion = folder.endsWith(LIMIT_RERUN_SUFFIX);
  if (!isCompanion && !Object.hasOwn(record, LIMIT_RERUN_OF)) return null;
  const marker = record[LIMIT_RERUN_OF];
  const main = folder.slice(0, -LIMIT_RERUN_SUFFIX.length);
  if (isCompanion && typeof marker === "string" && marker !== "" && !marker.includes("/") && marker === main) {
    return join(dirname(run), marker);
  }
  throw new ResultsRefusal(
    `cannot use ${path}: ${LIMIT_RERUN_OF} must name the main run of a ${LIMIT_RERUN_SUFFIX} folder`,
  );
}

function csvRow(relativePath: string, record: Record<string, unknown>, path: string): string {
  const run = dirname(relativePath);
  const cells = COLUMNS.map((column) => {
    const value = column === "run" ? run : record[column];
    if (typeof value === "object" && value !== null) {
      throw new ResultsRefusal(`cannot use ${path}: ${column} is not a single value`);
    }
    return csvField(value);
  });
  cells.push(csvField(limitRerunOf(run, record, path)));
  return cells.join(",") + CRLF;
}

export function resultsCsv(runsDir: string): string {
  const rows = findRunFiles(runsDir).map((relativePath) => {
    const path = join(runsDir, relativePath);
    return csvRow(relativePath, readRunRecord(path), path);
  });
  return [[...COLUMNS, LIMIT_RERUN_OF].join(",") + CRLF, ...rows].join("");
}

function parseCli(args: string[]): { runsDir: string; outPath: string } {
  const { values } = parseArgs({
    args,
    options: {
      runs: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.runs) throw new ResultsRefusal("--runs is required");
  if (!values.out) throw new ResultsRefusal("--out is required");
  return { runsDir: values.runs, outPath: values.out };
}

function main(): number {
  try {
    const { runsDir, outPath } = parseCli(process.argv.slice(2));
    const csv = resultsCsv(runsDir);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, csv);
    console.log(outPath);
    return 0;
  } catch (error) {
    const isUsage = error instanceof ResultsRefusal || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    if (!isUsage) throw error;
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = main();
}
