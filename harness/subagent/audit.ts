import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import type { PlanEntry } from "./prepare.ts";

const USAGE = "usage: node harness/subagent/audit.ts --plan <plan.json> --transcripts <agent-transcripts dir> --out <audit.json>";
const ALLOWED_TOOLS = new Set([
  "Read", "ReadFile", "Grep", "rg", "Glob", "Shell", "Write", "StrReplace", "ApplyPatch", "Delete",
  "UpdateCurrentStep", "TodoWrite", "ReadLints", "AwaitShell", "GetDynamicTools", "CallDynamicTool",
]);
// Cursor serves these local tools through CallDynamicTool; anything else there, such as web search or Task, is forbidden.
const ALLOWED_DYNAMIC = new Set(["cursor/AwaitShell", "cursor/ReadLints", "cursor/TodoWrite", "cursor/Delete", "cursor/UpdateCurrentStep"]);
const BOOKKEEPING_TOOLS = new Set(["UpdateCurrentStep", "TodoWrite", "GetDynamicTools"]);
const PATH_FIELDS = ["path", "target_directory", "working_directory"];
const SEARCH_TOOLS = new Set(["Grep", "rg", "Glob"]);
const HOST_PATH = /(?:^|[\s'"=(<>])((?:\/(?:Users|private|var|opt|etc|Volumes|Applications|home|Library|System)\b|~\/)[^\s'"`;|&)<>]*)/g;
const TMP_PATH = /(?:^|[\s'"=(<>])(\/tmp\/[^\s'"`;|&)<>]*)/g;
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2(?=\n|$)/g;
const TB_ARGUMENT = /(\S*bin\/tb)\s+('(?:[^']|'\\'')*'|"(?:[^"\\]|\\.)*")/g;
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
// A git clone or fetch of a local path, such as the checkout itself, is not network access.
const NETWORK_COMMAND = /\b(curl|wget|ssh|scp|nc|pip3? install|npm (?:install|i)\b)\b|\bgit (?:fetch|clone|pull|ls-remote)\b[^;&|\n]*(?:https?:\/\/|git@|ssh:\/\/|git:\/\/)/;
const TEST_RUN = /runtests\.py|pytest|manage\.py test|python[0-9.]* -m unittest|\btox\b|\bnose/;

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}

export interface Audit {
  id: string;
  model: string;
  agent_id: string | null;
  parent_id: string | null;
  prompt_exact: boolean;
  assistant_turns: number;
  tool_calls: number;
  tool_counts: Record<string, number>;
  dynamic_calls: string[];
  shell_test_runs: number;
  forbidden_tools: string[];
  outside_paths: string[];
  tmp_paths: string[];
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

// Heredoc bodies are file content and tb arguments run in the offline container, so neither is a host-side command.
export function hostSide(command: string): string {
  let host = command.replace(HEREDOC, "<<HEREDOC").replace(TB_ARGUMENT, "$1 ARG");
  for (const [, name] of host.matchAll(/\b([A-Za-z_]\w*)=\S*bin\/tb\b/g)) {
    host = host.replace(new RegExp(`\\$\\{?${name}\\}?\\s+('(?:[^']|'\\\\'')*'|"(?:[^"\\\\]|\\\\.)*")`, "g"), `$${name} ARG`);
  }
  return host;
}

function patchText(input: Record<string, unknown>): string {
  for (const key of ["patch", "input"]) if (typeof input[key] === "string") return input[key] as string;
  const keys = Object.keys(input);
  if (keys.length === 0 || !keys.every((key) => /^\d+$/.test(key))) return "";
  return keys.sort((a, b) => Number(a) - Number(b)).map((key) => String(input[key])).join("");
}

export function firstUserText(lines: Array<Record<string, any>>): string {
  const first = lines.find((line) => line.role === "user");
  return ((first?.message?.content ?? []) as Array<Record<string, any>>).map((block) => String(block.text ?? "")).join("\n");
}

export function auditOne(entry: PlanEntry, file: string): Audit {
  const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
  const uses: ToolUse[] = lines
    .filter((line) => line.role === "assistant")
    .flatMap((line) => (line.message?.content ?? []) as Array<Record<string, any>>)
    .filter((block) => block.type === "tool_use")
    .map((block) => ({ name: String(block.name), input: (block.input ?? {}) as Record<string, unknown> }));
  const ws = entry.workspace;
  const outside = new Set<string>();
  const tmp = new Set<string>();
  const forbidden = new Set<string>();
  const dynamic: string[] = [];
  const network: string[] = [];
  let testRuns = 0;
  for (const use of uses) {
    if (!ALLOWED_TOOLS.has(use.name)) forbidden.add(use.name);
    if (use.name === "CallDynamicTool") {
      const call = `${String(use.input.namespace)}/${String(use.input.toolName)}`;
      dynamic.push(call);
      if (!ALLOWED_DYNAMIC.has(call)) forbidden.add(`CallDynamicTool:${call}`);
    }
    for (const field of PATH_FIELDS) {
      const value = use.input[field];
      if (typeof value === "string" && !insideWorkspace(value, ws)) outside.add(`${use.name}.${field}=${value}`);
    }
    if (SEARCH_TOOLS.has(use.name) && typeof use.input.path !== "string" && typeof use.input.target_directory !== "string") {
      outside.add(`${use.name} without a path (searches the Cursor workspace)`);
    }
    if (use.name === "ApplyPatch") {
      for (const match of patchText(use.input).matchAll(PATCH_FILE)) {
        const path = match[1].trim();
        if (!insideWorkspace(path, ws)) outside.add(`ApplyPatch: ${path}`);
      }
    }
    if (use.name === "Shell" && typeof use.input.command === "string") {
      const command = use.input.command;
      if (TEST_RUN.test(command)) testRuns += 1;
      const host = hostSide(command);
      for (const match of host.matchAll(HOST_PATH)) if (!insideWorkspace(match[1], ws)) outside.add(`Shell: ${match[1]}`);
      for (const match of host.matchAll(TMP_PATH)) tmp.add(`Shell: ${match[1]}`);
      if (NETWORK_COMMAND.test(host)) network.push(host.replace(/\s+/g, " ").slice(0, 200));
    }
  }
  const counts: Record<string, number> = {};
  for (const use of uses) counts[use.name] = (counts[use.name] ?? 0) + 1;
  const parts = file.split("/");
  return {
    id: entry.id,
    model: entry.model,
    agent_id: parts.at(-1)?.replace(/\.jsonl$/, "") ?? null,
    parent_id: parts.at(-3) ?? null,
    prompt_exact: firstUserText(lines).includes(entry.task_prompt),
    assistant_turns: lines.filter((line) => line.role === "assistant").length,
    tool_calls: uses.filter((use) => !BOOKKEEPING_TOOLS.has(use.name)).length,
    tool_counts: counts,
    dynamic_calls: dynamic,
    shell_test_runs: testRuns,
    forbidden_tools: [...forbidden],
    outside_paths: [...outside],
    tmp_paths: [...tmp],
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
  const files = transcriptFiles(values.transcripts).map((file) => ({ file, head: firstUserText(readFileSync(file, "utf8").split("\n", 1).map((line) => JSON.parse(line))) }));
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
    const flags = [
      ...(a.prompt_exact ? [] : ["prompt differs from the plan"]),
      ...a.forbidden_tools.map((t) => `tool:${t}`),
      ...a.outside_paths,
      ...a.network_commands.map((c) => `net:${c}`),
    ];
    const tmp = a.tmp_paths.length ? ` tmp:${a.tmp_paths.join(",")}` : "";
    console.log(`${a.model.padEnd(24)} ${a.id} turns=${a.assistant_turns} tools=${a.tool_calls} tests=${a.shell_test_runs} ${flags.length ? `FLAGS: ${flags.join(" | ")}` : "clean"}${tmp}`);
  }
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
