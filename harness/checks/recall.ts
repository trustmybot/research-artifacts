import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { scrubber } from "../network.ts";
import { loadSources as loadHashCheckedSources, type Instance } from "../sources.ts";

export const MODEL = "claude-opus-5-5";
export const MAX_OUTPUT_TOKENS = 12000;
export const BUDGET_USD = 5;
export const PROMPT =
  "This is an issue from the Django project. You have no access to the repository. Write the source code change that fixes it as a unified diff with real file paths. Reply with only the diff.";

const INPUT_USD_PER_TOKEN = 4 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 20 / 1_000_000;
const CHARACTERS_PER_TOKEN = 4;
const USAGE = "usage: node harness/checks/recall.ts --out <dir> --patches <path>";
const ISSUE_INPUTS = ["problem_statement_sha256", "base_commit", "gold_patch_sha256"] as const;

export interface RecallScores {
  parsed: boolean;
  files_official: number;
  files_answer: number;
  files_overlap: number;
  lines_official: number;
  lines_recovered: number;
  lines_official_not_in_issue: number;
  lines_recovered_not_in_issue: number;
}

export type RecallStatus = "completed" | "refused" | "error" | "skipped_budget";

export interface InstanceResult {
  instance_id: string;
  status: RecallStatus;
  stop_reason: string | null;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number;
  answer_text: string | null;
  scores: RecallScores | null;
}

export interface RecallSummary {
  spent_usd: number;
  instances_total: number;
  completed: number;
  refused: number;
  errors: number;
  skipped_budget: number;
  files_overlap_rate: number | null;
  lines_recovered_rate: number | null;
  lines_recovered_not_in_issue_rate: number | null;
}

export interface RecallRequest {
  model: string;
  max_tokens: number;
  thinking: { type: "adaptive" };
  output_config: { effort: "high" };
  messages: { role: "user"; content: string }[];
}

export interface RecallMessage {
  model: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
  content: ({ type: "text"; text: string } | { type: string })[];
}

export interface RecallClient {
  messages: {
    stream(request: RecallRequest): { finalMessage(): Promise<RecallMessage> };
  };
}

export interface RecallDeps {
  createClient(): Promise<RecallClient>;
  loadSources(instance: Instance): Promise<{ problemStatement: string; goldPatch: string }>;
  env: NodeJS.ProcessEnv;
  log(message: string): void;
}

interface ParsedDiff {
  parsed: boolean;
  files: Set<string>;
  lines: string[];
}

function headerPath(header: string): string | null {
  const path = header.slice(4).split("\t")[0].trim();
  return path === "/dev/null" ? null : path.replace(/^[ab]\//, "");
}

function parseDiff(text: string): ParsedDiff {
  const rows = text.split("\n");
  const files = new Set<string>();
  const lines: string[] = [];
  let parsed = false;
  let inHunk = false;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.startsWith("diff --git ")) {
      parsed = true;
      inHunk = false;
      const target = /^diff --git a\/.+ b\/(.+?)\s*$/.exec(row)?.[1];
      if (target) files.add(target);
    } else if (
      row.startsWith("--- ") &&
      rows[index + 1]?.startsWith("+++ ") &&
      (!inHunk || rows[index + 2]?.startsWith("@@"))
    ) {
      const path = headerPath(rows[index + 1]) ?? headerPath(row);
      if (path) files.add(path);
      parsed = true;
      inHunk = false;
      index += 1;
    } else if (row.startsWith("@@")) {
      parsed = true;
      inHunk = true;
    } else if (row.startsWith("```")) {
      inHunk = false;
    } else if (inHunk && (row.startsWith("+") || row.startsWith("-"))) {
      const line = row.slice(1).trim();
      if (line) lines.push(line);
    }
  }
  return { parsed, files, lines };
}

function linesAlsoIn(wanted: string[], available: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const line of available) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  return wanted.filter((line) => {
    const count = remaining.get(line) ?? 0;
    remaining.set(line, count - 1);
    return count > 0;
  });
}

export function scoreAnswer(answer: string, officialFix: string, issueText: string): RecallScores {
  const given = parseDiff(answer);
  if (!given.parsed) {
    return {
      parsed: false,
      files_official: 0,
      files_answer: 0,
      files_overlap: 0,
      lines_official: 0,
      lines_recovered: 0,
      lines_official_not_in_issue: 0,
      lines_recovered_not_in_issue: 0,
    };
  }
  const official = parseDiff(officialFix);
  const recovered = linesAlsoIn(official.lines, given.lines);
  const notInIssue = (line: string): boolean => !issueText.includes(line);
  return {
    parsed: true,
    files_official: official.files.size,
    files_answer: given.files.size,
    files_overlap: [...official.files].filter((file) => given.files.has(file)).length,
    lines_official: official.lines.length,
    lines_recovered: recovered.length,
    lines_official_not_in_issue: official.lines.filter(notInIssue).length,
    lines_recovered_not_in_issue: recovered.filter(notInIssue).length,
  };
}

export function buildRequest(issueText: string): RecallRequest {
  return {
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    messages: [{ role: "user", content: `${PROMPT}\n\n${issueText}` }],
  };
}

export function worstCaseCostUsd(issueText: string): number {
  const estimatedInputTokens = Math.ceil(issueText.length / CHARACTERS_PER_TOKEN);
  return estimatedInputTokens * INPUT_USD_PER_TOKEN + MAX_OUTPUT_TOKENS * OUTPUT_USD_PER_TOKEN;
}

function unanswered(instance_id: string, status: RecallStatus): InstanceResult {
  return {
    instance_id,
    status,
    stop_reason: null,
    model: MODEL,
    input_tokens: null,
    output_tokens: null,
    cost_usd: 0,
    answer_text: null,
    scores: null,
  };
}

function answered(
  instance_id: string,
  message: RecallMessage,
  officialFix: string,
  issueText: string,
): InstanceResult {
  const answerText = message.content
    .map((block) => (block.type === "text" ? (block as { text: string }).text : ""))
    .join("");
  const { input_tokens, output_tokens } = message.usage;
  return {
    instance_id,
    status: message.stop_reason === "refusal" ? "refused" : "completed",
    stop_reason: message.stop_reason,
    model: message.model,
    input_tokens,
    output_tokens,
    cost_usd: input_tokens * INPUT_USD_PER_TOKEN + output_tokens * OUTPUT_USD_PER_TOKEN,
    answer_text: answerText,
    scores: scoreAnswer(answerText, officialFix, issueText),
  };
}

function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

function summarize(
  results: InstanceResult[],
  officialTotals: Map<string, RecallScores>,
): RecallSummary {
  const finished = results.filter((result) => result.status === "completed");
  const sum = (pick: (scores: RecallScores) => number): number =>
    finished.reduce((total, result) => total + pick(result.scores as RecallScores), 0);
  const officialSum = (pick: (scores: RecallScores) => number): number =>
    finished.reduce(
      (total, result) => total + pick(officialTotals.get(result.instance_id) as RecallScores),
      0,
    );
  const count = (status: RecallStatus): number =>
    results.filter((result) => result.status === status).length;
  return {
    spent_usd: results.reduce((total, result) => total + result.cost_usd, 0),
    instances_total: results.length,
    completed: finished.length,
    refused: count("refused"),
    errors: count("error"),
    skipped_budget: count("skipped_budget"),
    files_overlap_rate: rate(
      sum((scores) => scores.files_overlap),
      officialSum((scores) => scores.files_official),
    ),
    lines_recovered_rate: rate(
      sum((scores) => scores.lines_recovered),
      officialSum((scores) => scores.lines_official),
    ),
    lines_recovered_not_in_issue_rate: rate(
      sum((scores) => scores.lines_recovered_not_in_issue),
      officialSum((scores) => scores.lines_official_not_in_issue),
    ),
  };
}

function readEntries(patchesPath: string): Instance[] {
  const entries = JSON.parse(readFileSync(patchesPath, "utf8")) as Instance[];
  if (!Array.isArray(entries)) throw new Error(`${patchesPath} does not hold a list of entries`);
  const byId = new Map<string, Instance>();
  for (const entry of entries) {
    const first = byId.get(entry.instance_id);
    if (first === undefined) {
      byId.set(entry.instance_id, entry);
      continue;
    }
    const conflict = ISSUE_INPUTS.find((field) => first[field] !== entry[field]);
    if (conflict) throw new Error(`${patchesPath} lists ${entry.instance_id} twice with different ${conflict}`);
  }
  return [...byId.values()];
}

export async function runRecall(
  outDir: string,
  patchesPath: string,
  deps: RecallDeps,
): Promise<RecallSummary> {
  const scrub = scrubber(deps.env);
  const entries = readEntries(patchesPath);
  const sources = [];
  for (const entry of entries) sources.push(await deps.loadSources(entry));
  const client = await deps.createClient();

  mkdirSync(join(outDir, "instances"), { recursive: true });
  const writeJson = (path: string, value: unknown): void => {
    writeFileSync(path, scrub(`${JSON.stringify(value, null, 2)}\n`));
  };

  const results: InstanceResult[] = [];
  const officialTotals = new Map<string, RecallScores>();
  let spent = 0;
  let budgetStopped = false;
  for (const [index, { instance_id }] of entries.entries()) {
    const { problemStatement, goldPatch } = sources[index];
    officialTotals.set(instance_id, scoreAnswer(goldPatch, goldPatch, problemStatement));
    budgetStopped ||= spent + worstCaseCostUsd(problemStatement) > BUDGET_USD;
    let result: InstanceResult;
    if (budgetStopped) {
      result = unanswered(instance_id, "skipped_budget");
    } else {
      try {
        const message = await client.messages.stream(buildRequest(problemStatement)).finalMessage();
        result = answered(instance_id, message, goldPatch, problemStatement);
      } catch (error) {
        deps.log(scrub(`${instance_id}: API error: ${(error as Error).message}`));
        result = unanswered(instance_id, "error");
      }
    }
    spent += result.cost_usd;
    results.push(result);
    writeJson(join(outDir, "instances", `${instance_id}.json`), result);
  }

  const summary = summarize(results, officialTotals);
  writeJson(join(outDir, "summary.json"), summary);
  return summary;
}

const REAL_DEPS: RecallDeps = {
  createClient: async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    return new Anthropic() as unknown as RecallClient;
  },
  loadSources: (instance) => loadHashCheckedSources(instance),
  env: process.env,
  log: (message) => console.error(message),
};

export async function main(args: string[], deps: RecallDeps = REAL_DEPS): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: { out: { type: "string" }, patches: { type: "string" } },
    }));
  } catch (error) {
    deps.log(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const { out, patches } = values;
  if (!out || !patches) {
    deps.log(USAGE);
    return 2;
  }
  try {
    const summary = await runRecall(out, patches, deps);
    deps.log(`${join(out, "summary.json")} completed=${summary.completed}`);
    return summary.completed > 0 ? 0 : 1;
  } catch (error) {
    deps.log(scrubber(deps.env)(`recall failed: ${(error as Error).message}`));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
