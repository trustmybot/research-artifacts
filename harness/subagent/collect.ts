import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { spawnCollect } from "../runners.ts";
import { extractVerdict } from "../transcript.ts";
import type { PlanEntry } from "./prepare.ts";

const USAGE = "usage: node harness/subagent/collect.ts --plan <plan.json> --launched <launch-times.json> --out <dir>";
const TEST_RUN = /runtests\.py|pytest|manage\.py test|python[0-9.]* -m unittest|\btox\b|\bnose/;

export interface ReviewResult {
  id: string;
  model: string;
  instance_id: string;
  agent_id: string;
  label_stratum: string;
  verdict: "pass" | "fail" | null;
  verdict_failure: string | null;
  findings: number | null;
  container_commands: number;
  container_test_runs: number;
  wall_s: number | null;
  checkout_unchanged: boolean;
  checkout_detail: string;
}

async function checkout(entry: PlanEntry): Promise<{ unchanged: boolean; detail: string }> {
  const run = (args: string[]) => spawnCollect("docker", ["exec", entry.container, "git", "-C", "/testbed", ...args], { timeoutMs: 120_000 });
  const status = await run(["status", "--porcelain"]);
  const head = await run(["rev-parse", "HEAD"]);
  const unchanged = status.code === 0 && status.stdout.trim() === "" && head.stdout.trim() === entry.commit_sha;
  const detail = unchanged ? "" : `${status.stdout}${status.stderr} head ${head.stdout.trim()}`.trim().slice(0, 300);
  return { unchanged, detail };
}

const csvCell = (value: unknown): string => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { plan: { type: "string" }, launched: { type: "string" }, out: { type: "string" } } });
  if (!values.plan || !values.launched || !values.out) {
    console.error(USAGE);
    process.exit(2);
  }
  const plan = JSON.parse(readFileSync(values.plan, "utf8")) as PlanEntry[];
  const launched = JSON.parse(readFileSync(values.launched, "utf8")) as Record<string, string>;
  const results: ReviewResult[] = [];

  for (const entry of plan) {
    const final = join(entry.workspace, "review", "final.md");
    const text = existsSync(final) ? readFileSync(final, "utf8") : null;
    const parsed = text === null ? { failure: "final_missing" } : extractVerdict(text);
    const commands = existsSync(entry.log) ? readFileSync(entry.log, "utf8").split("\n").filter(Boolean) : [];
    const start = launched[entry.id] ? Date.parse(launched[entry.id]) : null;
    const end = text === null ? null : statSync(final).mtimeMs;
    const { unchanged, detail } = await checkout(entry);
    results.push({
      id: entry.id,
      model: entry.model,
      instance_id: entry.instance_id,
      agent_id: entry.agent_id,
      label_stratum: entry.label_stratum,
      verdict: "failure" in parsed ? null : parsed.verdict,
      verdict_failure: "failure" in parsed ? parsed.failure : null,
      findings: "failure" in parsed ? null : parsed.findings.length,
      container_commands: commands.length,
      container_test_runs: commands.filter((line) => TEST_RUN.test(line)).length,
      wall_s: start !== null && end !== null ? Math.round((end - start) / 1000) : null,
      checkout_unchanged: unchanged,
      checkout_detail: detail,
    });
    const keep = join(values.out, "reviews", entry.id);
    mkdirSync(keep, { recursive: true });
    if (text !== null) copyFileSync(final, join(keep, "final.md"));
    if (existsSync(entry.log)) copyFileSync(entry.log, join(keep, "container-commands.tsv"));
    writeFileSync(join(keep, "entry.json"), `${JSON.stringify(entry, null, 2)}\n`);
  }

  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  const columns = Object.keys(results[0] ?? {}) as (keyof ReviewResult)[];
  const csv = [columns.join(","), ...results.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n");
  writeFileSync(join(values.out, "results.csv"), `${csv}\n`);
  for (const r of results) {
    console.log(`${r.model.padEnd(24)} ${r.instance_id.padEnd(22)} ${r.label_stratum.padEnd(16)} ${String(r.verdict ?? r.verdict_failure).padEnd(32)} cmds=${r.container_commands} tests=${r.container_test_runs} wall=${r.wall_s === null ? "-" : `${r.wall_s}s`} unchanged=${r.checkout_unchanged}`);
  }
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
