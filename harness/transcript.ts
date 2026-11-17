import { decode } from "@toon-format/toon";

export type VerdictValue = "pass" | "fail";

export interface Finding {
  location: string;
  problem: string;
}

export interface Verdict {
  verdict: VerdictValue;
  feedback: string;
  findings: Finding[];
}

export interface SkillFinding {
  file: string;
  line: number;
  summary: string;
  failure_scenario: string;
}

export interface SkillReview {
  skill_invocations: number;
  skill_args: string | null;
  skill_findings: SkillFinding[] | null;
  skill_verdict: VerdictValue | null;
  skill_failure: string | null;
}

export interface TranscriptSummary extends SkillReview {
  verdict: VerdictValue | null;
  feedback: string | null;
  findings: Finding[] | null;
  stop_reason: string;
  model: string | null;
  model_usage_models: string[] | null;
  cli_version: string | null;
  turns: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  thinking_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  tool_calls: number;
  effective_effort: string | null;
  thinking_blocks: number;
  thinking_chars: number;
  test_files_written: number;
  bash_commands: number;
  bash_test_runs: number;
  bash_inline_code_runs: number;
  bash_test_files_written: number;
  bash_failures: number;
}

type JsonObject = Record<string, unknown>;

interface FencedBlock {
  tag: string;
  body: string;
}

const TEST_FILE_PATTERN = /(^|\/)(tests?\/|test_[^/]*$|[^/]*_test\.[^/]*$|conftest\.py$)/;
const SOURCE_FILE_PATTERN = /\.(py|pyi|pyx|sh|bash|js|jsx|mjs|cjs|ts|tsx|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|php|pl|lua)$/i;
const TEMP_SCRIPT_PATTERN = /^(\/tmp|\/var\/tmp|\$TMPDIR|\$\{TMPDIR\})\/.*\.(py|sh)$/;
const HEREDOC_BODY = /(<<-?[ \t]*)(['"]?)(\w+)\2([^\n]*)\n(?:[\s\S]*?\n)?[ \t]*\3[ \t]*(?=\n|$)/g;
const REDIRECT_TARGET = /(?<!<)>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s"';|&<>()]+))/g;

const SHELL_WRAPPER = String.raw`(?:\S*\/)?(?:ba|da|k|z)?sh(?:\s+-\S+)*\s+-\w*c\s+\\*["']?`;
const COMMAND_PREFIX = String.raw`(?:[A-Za-z_]\w*=\S*\s+|(?:env|time|exec|if|elif|while|until|do|then|else|!)\s+|timeout\s+(?:-\S+\s+)*\S+\s+|${SHELL_WRAPPER})*`;
const COMMAND_START = String.raw`(?:^|[;&|\n({\x60])\s*${COMMAND_PREFIX}`;
const COMMAND_END = String.raw`(?=\s|$|\\*["']|[;&|)}\x60])`;
const PYTHON = String.raw`(?:\S*\/)?python[\d.]*(?:\s+-W\s*\S+|\s+-(?![cm]\b)\S+)*`;
const RUNNER_SCRIPT = String.raw`(?:\S*\/)?(?:runtests\.py|manage\.py\s+test)`;
const RUNNER_MODULE = String.raw`-m\s+(?:unittest|pytest|tox|nose2?)`;
const RUNNER_BINARY = String.raw`(?:\S*\/)?(?:pytest|py\.test|tox|nose2?|nosetests)`;
const TEST_RUNNER = new RegExp(
  `${COMMAND_START}(?:${PYTHON}\\s+(?:${RUNNER_SCRIPT}|${RUNNER_MODULE})|${RUNNER_SCRIPT}|${RUNNER_BINARY})${COMMAND_END}`,
);
const PYTHON_INLINE = new RegExp(`${COMMAND_START}${PYTHON}(?:\\s+-c${COMMAND_END}|\\s*(?:-\\s*)?<<)`);
const PYTHON_FROM_HEREDOC = new RegExp(
  String.raw`<<-?[ \t]*['"]?\w+['"]?[^\n]*\|&?\s*${COMMAND_PREFIX}${PYTHON}(?:\s+-(?=\s|$)|(?=[ \t]*(?:$|[\n;&|)}"'\\\x60]|\d*[<>])))`,
);
const TEE_TARGETS = new RegExp(`${COMMAND_START}tee((?:\\s+[^\\s;&|<>)]+)+)`, "g");
const REVIEW_SKILL = "code-review";
const SKILL_FINDING_TEXT_FIELDS = ["file", "summary", "failure_scenario"] as const;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseEvents(stream: string): JsonObject[] {
  const events: JsonObject[] = [];
  for (const line of stream.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isObject(parsed)) events.push(parsed);
    } catch {
      continue;
    }
  }
  return events;
}

function countToolCalls(events: JsonObject[]): number {
  const ids = new Set<string>();
  let unnamed = 0;
  for (const event of events) {
    if (event.type !== "assistant" || !isObject(event.message)) continue;
    const content = event.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObject(block) || block.type !== "tool_use") continue;
      if (typeof block.id === "string") ids.add(block.id);
      else unnamed += 1;
    }
  }
  return ids.size + unnamed;
}

function fencedBlocks(text: string): { blocks: FencedBlock[]; unterminated: boolean } {
  const blocks: FencedBlock[] = [];
  let open: { tag: string; lines: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (open === null) {
      const fence = /^ {0,3}```([^`]*)$/.exec(line);
      if (fence) open = { tag: fence[1].trim(), lines: [] };
    } else if (/^ {0,3}```\s*$/.test(line)) {
      blocks.push({ tag: open.tag, body: open.lines.join("\n") });
      open = null;
    } else {
      open.lines.push(line);
    }
  }
  return { blocks, unterminated: open !== null };
}

function assistantBlocks(events: JsonObject[]): JsonObject[] {
  return events.flatMap((event) => {
    if (event.type !== "assistant" || !isObject(event.message)) return [];
    const content = event.message.content;
    return Array.isArray(content) ? content.filter(isObject) : [];
  });
}

function uniqueToolUses(blocks: JsonObject[], name: string): JsonObject[] {
  const seen = new Set<unknown>();
  return blocks.filter((block) => {
    if (block.type !== "tool_use" || block.name !== name) return false;
    if (block.id !== undefined && seen.has(block.id)) return false;
    seen.add(block.id);
    return true;
  });
}

function bashCommands(toolUses: JsonObject[]): string[] {
  return toolUses
    .map((block) => (isObject(block.input) ? asString(block.input.command) : null))
    .filter((command): command is string => command !== null)
    .map((command) => command.replace(HEREDOC_BODY, "$1$3$4"));
}

function shellWriteTargets(command: string): string[] {
  const redirected = [...command.matchAll(REDIRECT_TARGET)].map((m) => m[1] ?? m[2] ?? m[3]);
  const teed = [...command.matchAll(TEE_TARGETS)].flatMap((m) =>
    m[1]
      .trim()
      .split(/\s+/)
      .filter((arg) => !arg.startsWith("-"))
      .map((arg) => arg.replace(/^\\*["']|\\*["']$/g, "")),
  );
  return [...redirected, ...teed];
}

function countBashFailures(events: JsonObject[], bashUses: JsonObject[]): number {
  const bashIds = new Set(bashUses.map((block) => block.id));
  const failed = new Set<unknown>();
  for (const event of events) {
    if (event.type !== "user" || !isObject(event.message)) continue;
    const content = event.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObject(block) || block.type !== "tool_result" || block.is_error !== true) continue;
      if (typeof block.tool_use_id === "string" && bashIds.has(block.tool_use_id)) failed.add(block.tool_use_id);
    }
  }
  return failed.size;
}

function measureWork(events: JsonObject[]) {
  const blocks = assistantBlocks(events);
  const thinking = blocks.filter((block) => block.type === "thinking");
  const written = uniqueToolUses(blocks, "Write")
    .map((block) => (isObject(block.input) ? asString(block.input.file_path) : null))
    .filter((path): path is string => path !== null && TEST_FILE_PATTERN.test(path));
  const bashUses = uniqueToolUses(blocks, "Bash");
  const commands = bashCommands(bashUses);
  const isInlineCodeRun = (command: string): boolean =>
    PYTHON_INLINE.test(command) ||
    PYTHON_FROM_HEREDOC.test(command) ||
    shellWriteTargets(command).some((path) => TEMP_SCRIPT_PATTERN.test(path));
  return {
    thinking_blocks: thinking.length,
    thinking_chars: thinking.reduce((sum, block) => sum + (asString(block.thinking)?.length ?? 0), 0),
    test_files_written: new Set(written).size,
    bash_commands: bashUses.length,
    bash_test_runs: commands.filter((command) => TEST_RUNNER.test(command)).length,
    bash_inline_code_runs: commands.filter(isInlineCodeRun).length,
    bash_test_files_written: new Set(
      commands
        .flatMap(shellWriteTargets)
        .filter((path) => TEST_FILE_PATTERN.test(path) && SOURCE_FILE_PATTERN.test(path)),
    ).size,
    bash_failures: countBashFailures(events, bashUses),
  };
}

function isMainAgentEvent(event: JsonObject): boolean {
  return event.parent_tool_use_id === undefined || event.parent_tool_use_id === null;
}

function toolResultFor(events: JsonObject[], toolUseId: unknown): JsonObject | null {
  if (typeof toolUseId !== "string") return null;
  for (const event of events) {
    if (event.type !== "user" || !isObject(event.message)) continue;
    const content = event.message.content;
    if (!Array.isArray(content)) continue;
    const match = content.find(
      (block) => isObject(block) && block.type === "tool_result" && block.tool_use_id === toolUseId,
    );
    if (isObject(match)) return match;
  }
  return null;
}

function toolResultText(result: JsonObject): string {
  if (typeof result.content === "string") return result.content;
  if (!Array.isArray(result.content)) return "";
  return result.content
    .map((part) => (isObject(part) && part.type === "text" ? asString(part.text) ?? "" : ""))
    .join("\n");
}

function closingBracket(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "[" || char === "{") {
      stack.push(char === "[" ? "]" : "}");
    } else if (char === "]" || char === "}") {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

function lastBareArray(text: string): unknown[] | null {
  let last: unknown[] | null = null;
  let i = text.indexOf("[");
  while (i !== -1) {
    const end = closingBracket(text, i);
    let parsed: unknown = null;
    if (end !== -1) {
      try {
        parsed = JSON.parse(text.slice(i, end + 1));
      } catch {
        parsed = null;
      }
    }
    if (Array.isArray(parsed)) {
      last = parsed;
      i = text.indexOf("[", end + 1);
    } else {
      i = text.indexOf("[", i + 1);
    }
  }
  return last;
}

function lastJsonArray(text: string): unknown[] | { failure: string } {
  const jsonBlock = fencedBlocks(text).blocks.findLast((block) => block.tag === "json");
  if (jsonBlock === undefined) {
    return lastBareArray(text) ?? { failure: "skill_malformed:no_json_array" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBlock.body);
  } catch {
    return { failure: "skill_malformed:invalid_json" };
  }
  return Array.isArray(parsed) ? parsed : { failure: "skill_malformed:not_an_array" };
}

function parseSkillFinding(value: unknown): SkillFinding | { failure: string } {
  if (!isObject(value)) return { failure: "skill_malformed:finding_not_an_object" };
  for (const field of SKILL_FINDING_TEXT_FIELDS) {
    if (nonEmpty(value[field]) === null) return { failure: `skill_malformed:finding_${field}_missing` };
  }
  const line = asNumber(value.line);
  if (line === null) return { failure: "skill_malformed:finding_line_missing" };
  return {
    file: value.file as string,
    line,
    summary: value.summary as string,
    failure_scenario: value.failure_scenario as string,
  };
}

function parseSkillFindings(text: string): SkillFinding[] | { failure: string } {
  const entries = lastJsonArray(text);
  if ("failure" in entries) return entries;
  const findings: SkillFinding[] = [];
  for (const entry of entries) {
    const finding = parseSkillFinding(entry);
    if ("failure" in finding) return finding;
    findings.push(finding);
  }
  return findings;
}

function reviewSkill(events: JsonObject[]): SkillReview {
  const calls = uniqueToolUses(assistantBlocks(events.filter(isMainAgentEvent)), "Skill").filter(
    (block) => isObject(block.input) && block.input.skill === REVIEW_SKILL,
  );
  const lastCall = calls.at(-1);
  const review: SkillReview = {
    skill_invocations: calls.length,
    skill_args: lastCall && isObject(lastCall.input) ? asString(lastCall.input.args) : null,
    skill_findings: null,
    skill_verdict: null,
    skill_failure: "skill_missing:no_invocation",
  };
  if (lastCall === undefined) return review;
  const result = toolResultFor(events, lastCall.id);
  if (result === null) return { ...review, skill_failure: "skill_missing:no_result" };
  if (result.is_error === true) return { ...review, skill_failure: "skill_malformed:tool_error" };
  const findings = parseSkillFindings(toolResultText(result));
  if ("failure" in findings) return { ...review, skill_failure: findings.failure };
  return {
    ...review,
    skill_findings: findings,
    skill_verdict: findings.length > 0 ? "fail" : "pass",
    skill_failure: null,
  };
}

function parseFinding(value: unknown): Finding | { failure: string } {
  const entry = isObject(value) ? value : {};
  const location = nonEmpty(entry.location);
  if (location === null) return { failure: "verdict_malformed:finding_location_missing" };
  const problem = nonEmpty(entry.problem);
  if (problem === null) return { failure: "verdict_malformed:finding_problem_missing" };
  return { location, problem };
}

export function extractVerdict(text: string): Verdict | { failure: string } {
  const { blocks, unterminated } = fencedBlocks(text);
  if (unterminated) return { failure: "verdict_malformed:unterminated_block" };
  const last = blocks.at(-1);
  if (last?.tag !== "toon") {
    return {
      failure: /"?verdict"?\s*:/.test(text)
        ? "verdict_malformed:not_in_a_toon_block"
        : "verdict_missing:no_toon_block",
    };
  }
  let parsed: unknown;
  try {
    parsed = decode(last.body, { strict: true });
  } catch {
    return { failure: "verdict_malformed:invalid_toon" };
  }
  if (!isObject(parsed)) return { failure: "verdict_malformed:not_an_object" };
  if (parsed.verdict !== "pass" && parsed.verdict !== "fail") {
    return { failure: "verdict_malformed:verdict_not_pass_or_fail" };
  }
  const feedback = nonEmpty(parsed.feedback);
  if (feedback === null) return { failure: "verdict_malformed:feedback_missing" };
  const entries = parsed.findings ?? [];
  if (!Array.isArray(entries)) return { failure: "verdict_malformed:findings_not_a_list" };
  if (parsed.verdict === "fail" && entries.length === 0) {
    return { failure: "verdict_malformed:findings_required_for_fail" };
  }
  if (parsed.verdict === "pass" && entries.length > 0) {
    return { failure: "verdict_malformed:findings_forbidden_for_pass" };
  }
  const findings: Finding[] = [];
  for (const entry of entries) {
    const finding = parseFinding(entry);
    if ("failure" in finding) return finding;
    findings.push(finding);
  }
  return { verdict: parsed.verdict, feedback, findings };
}

export function summarizeTranscript(
  stream: string,
  exitCode: number,
  timedOut = false,
): TranscriptSummary {
  const events = parseEvents(stream);
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const result = events.findLast((e) => e.type === "result");
  const usage = result && isObject(result.usage) ? result.usage : {};
  const outputDetails = isObject(usage.output_tokens_details) ? usage.output_tokens_details : {};

  const summary: TranscriptSummary = {
    verdict: null,
    feedback: null,
    findings: null,
    stop_reason: timedOut ? "verdict_absent:timeout" : `verdict_absent:no_result_event:exit_${exitCode}`,
    model: asString(init?.model),
    model_usage_models: result && isObject(result.modelUsage) ? Object.keys(result.modelUsage).sort() : null,
    cli_version: asString(init?.claude_code_version),
    turns: asNumber(result?.num_turns),
    input_tokens: asNumber(usage.input_tokens),
    output_tokens: asNumber(usage.output_tokens),
    thinking_tokens: asNumber(outputDetails.thinking_tokens),
    cache_read_tokens: asNumber(usage.cache_read_input_tokens),
    cache_write_tokens: asNumber(usage.cache_creation_input_tokens),
    cost_usd: asNumber(result?.total_cost_usd),
    duration_ms: asNumber(result?.duration_ms),
    tool_calls: countToolCalls(events),
    effective_effort: asString(init?.effort) ?? asString(init?.effort_level),
    ...measureWork(events),
    ...reviewSkill(events),
  };
  if (!result) return summary;

  if (result.subtype !== "success" || result.is_error === true) {
    const cause = result.subtype !== "success" ? asString(result.subtype) ?? "unknown" : "is_error";
    return { ...summary, stop_reason: `verdict_absent:${cause}` };
  }
  const extracted = extractVerdict(asString(result.result) ?? "");
  if ("failure" in extracted) return { ...summary, stop_reason: extracted.failure };
  return {
    ...summary,
    ...extracted,
    stop_reason: asString(result.stop_reason) ?? "end_turn",
  };
}
