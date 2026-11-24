import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import type { PlanEntry } from "./prepare.ts";

const USAGE = "usage: node harness/subagent/audit.ts --plan <plan.json> --transcripts <agent-transcripts dir> --out <audit.json>";
const ALLOWED_TOOLS = new Set(["Read", "Grep", "Glob", "Shell", "Write", "StrReplace", "Delete", "UpdateCurrentStep", "TodoWrite", "ReadLints", "AwaitShell"]);
const BOOKKEEPING_TOOLS = new Set(["UpdateCurrentStep", "TodoWrite"]);
const PATH_FIELDS = ["path", "target_directory", "working_directory"];
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);
const HOST_PATH = /(?:^|[\s'"=(])((?:\/(?:Users|private|tmp|var|opt|etc|Volumes|Applications|home|Library|System)\b|~)[^\s'"`;|&)]*)/g;
const NETWORK_COMMAND = /\b(curl|wget|ssh|scp|nc|pip3? install|npm (?:install|i)\b|git (?:fetch|clone|pull|ls-remote))/;
const TEST_RUN = /runtests\.py|pytest|manage\.py test|python[0-9.]* -m unittest|\btox\b|\bnose/;

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}

export interface Audit {
  id: string;
  model: string;
  agent_id: string | null;
  assistant_turns: number;
  tool_calls: number;
  tool_counts: Record<string, number>;
  shell_test_runs: number;
  forbidden_tools: string[];
  outside_paths: string[];
  network_commands: string[];
  status: string | null;
}

function transcriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const parent of readdirSync(dir)) {
    const subagents = join(dir, parent, "subagents");
    if (!existsSync(subagents)) continue;
    for (const name of readdirSync(subagents)) if (name.endsWith(".jsonl")) files.push(join(subagents, name));
  }
  return files;
}

function insideWorkspace(path: string, workspace: string): boolean {
  return path === workspace || path.startsWith(`${workspace}/`);
}

export function auditOne(entry: PlanEntry, file: string): Audit {
  const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
  const uses: ToolUse[] = lines
    .filter((line) => line.role === "assistant")
    .flatMap((line) => (line.message?.content ?? []) as Array<Record<string, any>>)
    .filter((block) => block.type === "tool_use")
    .map((block) => ({ name: String(block.name), input: (block.input ?? {}) as Record<string, unknown> }));
  const ws = entry.workspace;
  const tb = join(ws, "bin", "tb");
  const outside = new Set<string>();
  const network: string[] = [];
  let testRuns = 0;
  for (const use of uses) {
    for (const field of PATH_FIELDS) {
      const value = use.input[field];
      if (typeof value === "string" && !insideWorkspace(value, ws)) outside.add(`${use.name}.${field}=${value}`);
    }
    if (SEARCH_TOOLS.has(use.name) && typeof use.input.path !== "string" && typeof use.input.target_directory !== "string") {
      outside.add(`${use.name} without a path (searches the Cursor workspace)`);
    }
    if (use.name === "Shell" && typeof use.input.command === "string") {
      const command = use.input.command;
      if (TEST_RUN.test(command)) testRuns += 1;
      const hostPart = command.startsWith(tb) ? "" : command;
      for (const match of hostPart.matchAll(HOST_PATH)) if (!insideWorkspace(match[1], ws)) outside.add(`Shell: ${match[1]}`);
      if (NETWORK_COMMAND.test(command)) network.push(command.slice(0, 200));
    }
  }
  const counts: Record<string, number> = {};
  for (const use of uses) counts[use.name] = (counts[use.name] ?? 0) + 1;
  return {
    id: entry.id,
    model: entry.model,
    agent_id: file.split("/").at(-1)?.replace(/\.jsonl$/, "") ?? null,
    assistant_turns: lines.filter((line) => line.role === "assistant").length,
    tool_calls: uses.filter((use) => !BOOKKEEPING_TOOLS.has(use.name)).length,
    tool_counts: counts,
    shell_test_runs: testRuns,
    forbidden_tools: [...new Set(uses.map((use) => use.name).filter((name) => !ALLOWED_TOOLS.has(name)))],
    outside_paths: [...outside],
    network_commands: network,
    status: lines.findLast((line) => line.type === "turn_ended")?.status ?? null,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { plan: { type: "string" }, transcripts: { type: "string" }, out: { type: "string" } } });
  if (!values.plan || !values.transcripts || !values.out) {
    console.error(USAGE);
    process.exit(2);
  }
  const plan = JSON.parse(readFileSync(values.plan, "utf8")) as PlanEntry[];
  const files = transcriptFiles(values.transcripts).map((file) => ({ file, head: readFileSync(file, "utf8").slice(0, 4000) }));
  const audits: Audit[] = [];
  for (const entry of plan) {
    const matches = files.filter(({ head }) => head.includes(`${entry.workspace}/review/task.md`));
    if (matches.length !== 1) {
      console.error(`${entry.id} ${entry.model}: ${matches.length} transcripts match its workspace`);
      continue;
    }
    audits.push(auditOne(entry, matches[0].file));
  }
  writeFileSync(values.out, `${JSON.stringify(audits, null, 2)}\n`);
  for (const a of audits) {
    const flags = [...a.forbidden_tools.map((t) => `tool:${t}`), ...a.outside_paths, ...a.network_commands.map((c) => `net:${c}`)];
    console.log(`${a.model.padEnd(24)} ${a.id} turns=${a.assistant_turns} tools=${a.tool_calls} tests=${a.shell_test_runs} ${flags.length ? `FLAGS: ${flags.join(" | ")}` : "clean"}`);
  }
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
