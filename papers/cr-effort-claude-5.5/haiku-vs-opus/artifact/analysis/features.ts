import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    opus: { type: "string" },
    gcs: { type: "string" },
    vault: { type: "string" },
    out: { type: "string" },
    texts: { type: "string" },
  },
});

type Row = Record<string, string>;
type Json = Record<string, any>;

function parseCsv(text: string): Row[] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { record.push(field); field = ""; }
    else if (ch === "\n") { record.push(field.replace(/\r$/, "")); records.push(record); record = []; field = ""; }
    else field += ch;
  }
  if (field || record.length) { record.push(field); records.push(record); }
  const [header, ...body] = records;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

const cell = (v: unknown) => {
  const t = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

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
const PYTHON_RUN = new RegExp(`${COMMAND_START}${PYTHON}(?:\\s+-c${COMMAND_END}|\\s*(?:-\\s*)?<<|\\s+[^\\s-][^\\s]*\\.py)`);
const PIPE_TO_PYTHON = /\|\s*(?:\S*\/)?python[\d.]*\b/;
const WRITES_TEST_FILE = /(^|\/)(tests?\/[^\s]*\.py|test_[^\s/]*\.py|[^\s/]*_test\.py)/;

const SUITE_FAIL = /^(FAIL|ERROR): \w|^FAILED \((failures|errors)=|^FAILED [\w/.]+::|=+ \d+ failed/m;
const SETUP_ERROR = /ModuleNotFoundError|ImportError|ImproperlyConfigured|AppRegistryNotReady|No such file or directory|command not found|SyntaxError|IndentationError|NameError: name '(?:django|settings|models)'/;
const ADHOC_FAIL = /Traceback \(most recent call last\)|\b[A-Z]\w*(?:Error|Exception)\b|AssertionError|\bFAIL(?:ED)?\b|\bBUG\b|\bMISMATCH\b|\bWRONG\b/;
const DIFFERENTIAL = /HEAD~|HEAD\^|git stash|git worktree|\/tmp\/base|\/tmp\/parent|\/tmp\/orig|git checkout [0-9a-f]{7,}|git show HEAD~|PARENT|BASE/;

function events(path: string): Json[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
  return "";
}

function measure(ev: Json[]) {
  const uses = new Map<string, { name: string; input: Json; order: number }>();
  const results = new Map<string, string>();
  let order = 0;
  for (const e of ev) {
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (e.type === "assistant" && b.type === "tool_use" && !uses.has(b.id)) uses.set(b.id, { name: b.name, input: b.input ?? {}, order: order++ });
      if (e.type === "user" && b.type === "tool_result") results.set(b.tool_use_id, resultText(b.content));
    }
  }
  let suiteRuns = 0, suiteFailRuns = 0, adhocRuns = 0, adhocFailRuns = 0, diffRuns = 0, testWrites = 0;
  let firstFail: number | null = null;
  const snippets: string[] = [];
  const snip = (kind: string, cmd: string, out: string, re: RegExp) => { const i = out.search(re); snippets.push(`${kind} | ${cmd.replace(/\s+/g, " ").slice(0, 160)} => ${out.slice(Math.max(0, i - 120), i + 200).replace(/\s+/g, " ")}`); };
  let suiteFailFirst = false;
  for (const [id, u] of uses) {
    if (u.name === "Write") {
      if (WRITES_TEST_FILE.test(String(u.input.file_path ?? ""))) testWrites++;
      continue;
    }
    if (u.name !== "Bash") continue;
    const cmd = String(u.input.command ?? "");
    const out = results.get(id) ?? "";
    if (WRITES_TEST_FILE.test(cmd) && /(cat|tee|>)/.test(cmd) && /<</.test(cmd)) testWrites++;
    const suite = TEST_RUNNER.test(cmd);
    const adhoc = !suite && (PYTHON_RUN.test(cmd) || PIPE_TO_PYTHON.test(cmd));
    if (DIFFERENTIAL.test(cmd) && (suite || adhoc)) diffRuns++;
    if (suite) {
      suiteRuns++;
      if (SUITE_FAIL.test(out)) {
        suiteFailRuns++;
        snip("suite", cmd, out, SUITE_FAIL);
        if (firstFail === null) { firstFail = u.order; suiteFailFirst = true; }
      }
    }
    if (adhoc) {
      adhocRuns++;
      if (ADHOC_FAIL.test(out) && !SETUP_ERROR.test(out)) {
        adhocFailRuns++;
        snip("own", cmd, out, ADHOC_FAIL);
        if (firstFail === null) firstFail = u.order;
      }
    }
  }
  return {
    suite_runs: suiteRuns,
    suite_fail_runs: suiteFailRuns,
    adhoc_runs: adhocRuns,
    adhoc_fail_runs: adhocFailRuns,
    differential_runs: diffRuns,
    test_writes: testWrites,
    first_fail_from_suite: firstFail === null ? "" : suiteFailFirst ? 1 : 0,
    tool_uses: uses.size,
    snippets,
  };
}

const opusRows = parseCsv(readFileSync(args.opus!, "utf8")).filter((r) => r.study_part === "main");
const reviews: Json[] = [];
for (const r of opusRows) {
  const dir = join(args.gcs!, r.batch_run_id, "runs", r.run);
  const run: Json = existsSync(join(dir, "run.json")) ? JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) : {};
  reviews.push({ ...run, ...r, model: "opus", dir, run_name: r.run, feedback: run.feedback ?? "", findings: run.findings ?? [], verdict: r.verdict, label: r.label });
}

const shards = readdirSync(args.vault!).filter((d) => d.includes("fa7afee"));
const resume = "20261105t192400z-fa7afee-models-sonnet-haiku-s4of5";
const original4 = "20261105t180720z-fa7afee-models-sonnet-haiku-s4of5";
const chosen = new Map<string, string>();
for (const shard of shards.filter((s) => s !== resume)) for (const run of readdirSync(join(args.vault!, shard, "runs"))) chosen.set(`${shard.slice(-5)}/${run}`, join(args.vault!, shard, "runs", run));
for (const run of readdirSync(join(args.vault!, resume, "runs"))) {
  const key = `s4of5/${run}`;
  if (!chosen.has(key)) chosen.set(key, join(args.vault!, resume, "runs", run));
}
for (const [key, dir] of chosen) {
  const run: Json = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
  const model = run.model.includes("haiku") ? "haiku" : "sonnet";
  reviews.push({
    ...run,
    model,
    dir,
    run_name: key,
    label: run.label_stratum === "swe_abs_wrong" ? "wrong" : "correct",
    verdict: run.verdict ?? "malformed",
  });
}

const columns = [
  "model", "effort", "instance_id", "agent_id", "patch_sha256", "label", "verdict", "caught", "false_alarm",
  "cost_usd", "wall_ms", "turns", "tool_calls", "output_tokens", "thinking_tokens", "bash_test_runs", "bash_inline_code_runs",
  "suite_runs", "suite_fail_runs", "adhoc_runs", "adhoc_fail_runs", "differential_runs", "test_writes", "first_fail_from_suite", "run_name",
];
const lines = [columns.join(",")];
const texts: Json[] = [];
for (const r of reviews) {
  const m = measure(events(join(r.dir, "transcript.jsonl")));
  const verdict = ["pass", "fail"].includes(r.verdict) ? r.verdict : "malformed";
  const row: Json = {
    ...r,
    ...m,
    verdict,
    caught: r.label === "wrong" ? (verdict === "fail" ? 1 : 0) : "",
    false_alarm: r.label === "correct" ? (verdict === "fail" ? 1 : 0) : "",
  };
  lines.push(columns.map((c) => cell(row[c])).join(","));
  texts.push({ model: r.model, effort: r.effort, instance_id: r.instance_id, agent_id: r.agent_id, label: r.label, verdict, feedback: r.feedback, findings: r.findings, ...m });
}
writeFileSync(args.out!, lines.join("\n") + "\n");
if (args.texts) writeFileSync(args.texts, JSON.stringify(texts, null, 1));
console.log(`${reviews.length} reviews`);
