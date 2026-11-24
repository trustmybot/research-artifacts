import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import type { Audit } from "../../../../../harness/subagent/audit.ts";
import type { ReviewResult } from "../../../../../harness/subagent/collect.ts";
import { toCsv } from "../../../artifact/analysis/lib.ts";

const USAGE = "usage: node analysis/build-reviews.ts --runs <run dir> --out <data dir>";

export const REVIEW_COLUMNS = [
  "id", "model", "instance_id", "agent_id", "label_stratum",
  "verdict", "verdict_failure", "findings", "wall_s", "container_commands", "container_test_runs", "checkout_unchanged",
  "assistant_turns", "tool_calls", "shell_test_runs", "prompt_exact", "forbidden_tools", "network_commands",
  "outside_tool_output", "outside_pathless_search", "outside_tmp", "outside_other", "host_tmp_paths",
];
export const DISCARDED_COLUMNS = ["id", "model", "instance_id", "agent_id", "reason"];

export interface Discarded {
  id: string;
  model: string;
  instance_id: string;
  agent_id: string;
  reason: string;
}

export type OutsideKind = "tool_output" | "pathless_search" | "tmp" | "other";

// Cursor saves long tool output under ~/.cursor/projects/<project>/terminals or agent-tools, outside the workspace.
const TOOL_OUTPUT = /\/\.cursor\/projects\/[^/\s]+\/(?:terminals|agent-tools)\//;

export function outsideKind(flag: string): OutsideKind {
  if (flag.includes("without a path")) return "pathless_search";
  if (TOOL_OUTPUT.test(flag)) return "tool_output";
  if (/(?:=|: )\/tmp\//.test(flag)) return "tmp";
  return "other";
}

// The flags hold host paths, so the rows keep only their counts.
export function reviewRow(result: ReviewResult, audit: Audit): Record<string, unknown> {
  const kinds = audit.outside_paths.map(outsideKind);
  const count = (kind: OutsideKind) => kinds.filter((k) => k === kind).length;
  return {
    id: result.id,
    model: result.model,
    instance_id: result.instance_id,
    agent_id: result.agent_id,
    label_stratum: result.label_stratum,
    verdict: result.verdict,
    verdict_failure: result.verdict_failure,
    findings: result.findings,
    wall_s: result.wall_s,
    container_commands: result.container_commands,
    container_test_runs: result.container_test_runs,
    checkout_unchanged: result.checkout_unchanged,
    assistant_turns: audit.assistant_turns,
    tool_calls: audit.tool_calls,
    shell_test_runs: audit.shell_test_runs,
    prompt_exact: audit.prompt_exact,
    forbidden_tools: audit.forbidden_tools.length,
    network_commands: audit.network_commands.length,
    outside_tool_output: count("tool_output"),
    outside_pathless_search: count("pathless_search"),
    outside_tmp: count("tmp"),
    outside_other: count("other"),
    host_tmp_paths: audit.tmp_paths.length,
  };
}

export function unitDirs(runs: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    if (existsSync(join(dir, "collected", "results.json"))) found.push(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "collected" && entry.name !== "queue") walk(join(dir, entry.name));
    }
  };
  walk(runs);
  return found.sort();
}

export function buildReviews(runs: string): { reviews: Record<string, unknown>[]; discarded: Discarded[] } {
  const discardedPath = join(runs, "discarded.json");
  const discarded = existsSync(discardedPath) ? (JSON.parse(readFileSync(discardedPath, "utf8")) as Discarded[]) : [];
  const dropped = new Set(discarded.map((d) => d.id));
  const reviews: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const dir of unitDirs(runs)) {
    if (!existsSync(join(dir, "audit.json"))) throw new Error(`${dir} has no audit.json; run harness/subagent/audit.ts on its plan first`);
    const audits = new Map((JSON.parse(readFileSync(join(dir, "audit.json"), "utf8")) as Audit[]).map((a) => [a.id, a]));
    for (const result of JSON.parse(readFileSync(join(dir, "collected", "results.json"), "utf8")) as ReviewResult[]) {
      if (dropped.has(result.id)) continue;
      if (seen.has(result.id)) throw new Error(`review ${result.id} appears twice`);
      const audit = audits.get(result.id);
      if (!audit) throw new Error(`review ${result.id} in ${dir} has no audit`);
      seen.add(result.id);
      reviews.push(reviewRow(result, audit));
    }
  }
  const order = (r: Record<string, unknown>) => `${r.instance_id}|${r.agent_id}|${r.model}`;
  reviews.sort((a, b) => order(a).localeCompare(order(b)));
  return { reviews, discarded: discarded.map(({ id, model, instance_id, agent_id, reason }) => ({ id, model, instance_id, agent_id, reason })) };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { runs: { type: "string" }, out: { type: "string" } } });
  if (!values.runs || !values.out) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const { reviews, discarded } = buildReviews(values.runs);
    mkdirSync(values.out, { recursive: true });
    writeFileSync(join(values.out, "reviews.csv"), toCsv(REVIEW_COLUMNS, reviews));
    writeFileSync(join(values.out, "discarded.csv"), toCsv(DISCARDED_COLUMNS, discarded as unknown as Record<string, unknown>[]));
    console.log(`${reviews.length} reviews, ${discarded.length} discarded`);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
