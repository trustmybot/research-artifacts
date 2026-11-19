import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { decode } from "@toon-format/toon";
import { MAIN_FINAL_BATCHES } from "../../../artifact/analysis/build-results.ts";
import { csvCell, readCsv, readLabels, type Row } from "../../../artifact/analysis/lib.ts";
import { locationCodes, NO_LOCATION } from "./location.ts";
import { redactor } from "./redact.ts";

export const COLUMNS = [
  "finding_id", "review_id", "model", "effort", "instance_id", "agent_id", "label", "rule", "verdict_status",
  "finding_index", "n_findings", "location", "problem", "loc_file", "loc_line_or_function", "loc_in_patch_files",
];
export const EXPECTED = { fail: 217, malformed: 15 };

const PAPER = resolve(import.meta.dirname, "..", "..", "..");
const VAULT_SHARD = "fa7afee-models-sonnet-haiku";
const VAULT_RUNS = (shard: string) => `c4-effort/c4-c-smoke/${shard}/runs`;
const RESUME_SHARD = "20261105t192400z-fa7afee-models-sonnet-haiku-s4of5";
const EFFORT_ORDER = ["low", "medium", "high"];

type Json = Record<string, any>;
export interface Finding { location: string; problem: string }
type Status = "pass" | "fail" | "malformed";

interface Source {
  runJson: string;
  transcript: string;
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : "");

function lastFencedBlock(message: string): string | null {
  let last: string | null = null;
  let open: string[] | null = null;
  for (const line of message.split(/\r?\n/)) {
    if (open === null) {
      if (/^ {0,3}```[^`]*$/.test(line)) open = [];
    } else if (/^ {0,3}```\s*$/.test(line)) {
      last = open.join("\n");
      open = null;
    } else open.push(line);
  }
  return open === null ? last : open.join("\n");
}

const decodeToon = (body: string) => decode(body, { strict: false });

function parseObject(body: string, parse: (b: string) => unknown): Json | null {
  try {
    const parsed = parse(body);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const TOP_LEVEL_KEY = /^(?:"[^"]*"|[A-Za-z_][\w.]*)(?:\[[^\]]*\](?:\{[^}]*\})?)?:/;

function topLevelSegments(body: string): string[] {
  const segments: string[][] = [];
  for (const line of body.split("\n")) {
    if (TOP_LEVEL_KEY.test(line) || segments.length === 0) segments.push([line]);
    else segments[segments.length - 1].push(line);
  }
  return segments.map((lines) => lines.join("\n"));
}

// One bad value (often a stray \" escape in feedback) fails the whole decode; the other keys can still be read.
function parsePerKey(body: string): Json | null {
  const decoded = topLevelSegments(body).map((s) => parseObject(s, decodeToon)).filter((o): o is Json => o !== null);
  return decoded.length === 0 ? null : Object.assign({}, ...decoded);
}

function parseLenient(body: string): Json | null {
  return parseObject(body, decodeToon) ?? parseObject(body, JSON.parse) ?? parsePerKey(body);
}

export function recoverFindings(finalMessage: string): Finding[] {
  const body = lastFencedBlock(finalMessage);
  if (body === null) return [];
  const parsed = parseLenient(body);
  const entries = parsed && Array.isArray(parsed.findings) ? parsed.findings : [];
  return entries
    .filter(isObject)
    .map((e) => ({ location: text(e.location).trim(), problem: text(e.problem).trim() }))
    .filter((f) => f.location !== "" || f.problem !== "");
}

export function finalMessage(transcript: string): string {
  let result: string | null = null;
  let assistant = "";
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let event: Json;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "result" && typeof event.result === "string") result = event.result;
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      const t = event.message.content.filter((b: Json) => b?.type === "text").map((b: Json) => text(b.text)).join("\n");
      if (t.trim()) assistant = t;
    }
  }
  return result ?? assistant;
}

const GIT_TIMEOUT_MS = 300_000;
const git = (repo: string, args: string[], input?: string): Buffer =>
  execFileSync("git", ["-C", repo, ...args], { input, maxBuffer: 2 ** 31, timeout: GIT_TIMEOUT_MS });
const gitText = (repo: string, args: string[]) => git(repo, args).toString("utf8");

function catFileBatch(repo: string, specs: string[]): Map<string, Buffer | null> {
  const out = git(repo, ["cat-file", "--batch"], specs.join("\n") + "\n");
  const found = new Map<string, Buffer | null>();
  let at = 0;
  for (const spec of specs) {
    const eol = out.indexOf(0x0a, at);
    const header = out.subarray(at, eol).toString("utf8");
    at = eol + 1;
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) { found.set(spec, null); continue; }
    const size = Number(header.split(" ")[2]);
    found.set(spec, out.subarray(at, at + size));
    at += size + 1;
  }
  return found;
}

function vaultSources(vault: string, rows: Row[]): Map<string, Source & { read: (path: string) => Buffer | null }> {
  const branches = gitText(vault, ["branch", "-r", "--format=%(refname:short)"])
    .split("\n")
    .filter((b) => b.includes(VAULT_SHARD));
  const files = new Map<string, string>();
  const chosen = new Map<string, { ref: string; dir: string }>();
  for (const branch of [...branches].sort((a, b) => Number(a.endsWith(RESUME_SHARD)) - Number(b.endsWith(RESUME_SHARD)))) {
    const shard = branch.split("/").pop()!;
    const listing = gitText(vault, ["ls-tree", "-r", "--name-only", branch, "--", VAULT_RUNS(shard)]);
    const runs = new Set<string>();
    for (const path of listing.split("\n").filter(Boolean)) {
      files.set(`${branch}:${path}`, path);
      runs.add(path.slice(VAULT_RUNS(shard).length + 1).split("/")[0]);
    }
    for (const run of runs) {
      const key = `${shard.slice(-5)}/${run}`;
      if (!chosen.has(key)) chosen.set(key, { ref: branch, dir: `${VAULT_RUNS(shard)}/${run}` });
    }
  }
  const wanted = rows.filter((r) => r.model !== "opus");
  const runJsonSpecs = wanted.flatMap((r) => {
    const c = chosen.get(r.run_name);
    return c ? [`${c.ref}:${c.dir}/run.json`] : [];
  });
  const blobs = catFileBatch(vault, runJsonSpecs);
  const sources = new Map<string, Source & { read: (path: string) => Buffer | null }>();
  for (const r of wanted) {
    const c = chosen.get(r.run_name);
    if (!c) continue;
    const runJson = `${c.ref}:${c.dir}/run.json`;
    const transcript = `${c.ref}:${c.dir}/transcript.jsonl`;
    if (!files.has(runJson) || !files.has(transcript)) continue;
    sources.set(reviewKey(r), {
      runJson,
      transcript,
      read: (spec) => blobs.get(spec) ?? catFileBatch(vault, [spec]).get(spec) ?? null,
    });
  }
  return sources;
}

function opusSources(runs: string, rows: Row[]): Map<string, Source & { read: (path: string) => Buffer | null }> {
  const batchOf = new Map<string, string>();
  for (const batch of MAIN_FINAL_BATCHES) {
    for (const run of readdirSync(join(runs, "gcs", batch, "runs"))) {
      if (batchOf.has(run)) throw new Error(`run ${run} is in both ${batchOf.get(run)} and ${batch}`);
      batchOf.set(run, batch);
    }
  }
  const sources = new Map<string, Source & { read: (path: string) => Buffer | null }>();
  for (const r of rows.filter((x) => x.model === "opus")) {
    const batch = batchOf.get(r.run_name);
    if (!batch) continue;
    const dir = join(runs, "gcs", batch, "runs", r.run_name);
    const source = { runJson: join(dir, "run.json"), transcript: join(dir, "transcript.jsonl") };
    if (!existsSync(source.runJson) || !existsSync(source.transcript)) continue;
    sources.set(reviewKey(r), { ...source, read: (path) => (existsSync(path) ? readFileSync(path) : null) });
  }
  return sources;
}

// An instance can appear with several agents' patches, so the agent completes the review key.
const reviewKey = (r: Row) => `${r.model}-${r.effort}-${r.instance_id}-${r.agent_id}`;

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function compareReviews(a: Row, b: Row): number {
  return byText(a.model, b.model)
    || EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort)
    || byText(a.instance_id, b.instance_id)
    || byText(a.agent_id, b.agent_id);
}

export function insideCheckout(path: string): string | null {
  const roots = [
    gitText(PAPER, ["rev-parse", "--show-toplevel"]).trim(),
    dirname(resolve(PAPER, gitText(PAPER, ["rev-parse", "--git-common-dir"]).trim())),
  ];
  return roots.find((root) => {
    const rel = relative(root, resolve(path));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }) ?? null;
}

export interface ExtractOptions {
  runs: string;
  vault: string;
  reviews: string;
  labels: string;
  expected?: Record<"fail" | "malformed", number>;
}

export function extract(options: ExtractOptions) {
  const rows = readCsv(options.reviews);
  const labels = readLabels(options.labels, rows);
  const labelPins = new Map(readCsv(options.labels).filter((l) => l.set === "main").map((l) => [`${l.instance_id}|${l.agent_id}`, l.patch_sha256]));
  const sources = new Map([...opusSources(options.runs, rows), ...vaultSources(options.vault, rows)]);
  const errors: string[] = [];
  const keys = new Set<string>();
  const diffs = new Map<string, string>();
  const findingRows: Json[] = [];
  const privateRecords: Json[] = [];
  const counts: Record<Status, number> = { pass: 0, fail: 0, malformed: 0 };

  for (const r of [...rows].sort(compareReviews)) {
    const key = reviewKey(r);
    if (keys.has(key)) { errors.push(`duplicate review ${key}`); continue; }
    keys.add(key);
    const source = sources.get(key);
    if (!source) { errors.push(`no run.json and transcript for ${key} (${r.run_name})`); continue; }
    const run: Json = JSON.parse(source.read(source.runJson)!.toString("utf8"));
    for (const field of ["instance_id", "agent_id", "effort", "patch_sha256"] as const) {
      if (run[field] !== r[field]) errors.push(`${key}: run.json ${field} ${run[field]} differs from reviews.csv ${r[field]}`);
    }
    if (labelPins.get(`${r.instance_id}|${r.agent_id}`) !== r.patch_sha256) errors.push(`${key}: patch_sha256 differs from labels.csv`);
    const patchKey = `${r.instance_id}/${r.agent_id}`;
    if (!diffs.has(patchKey)) {
      const path = join(options.runs, "cache", r.instance_id, `${r.agent_id}.diff`);
      const diff = existsSync(path) ? readFileSync(path) : null;
      if (diff === null) { errors.push(`missing patch ${path}`); continue; }
      if (sha256(diff) !== r.patch_sha256) { errors.push(`hash pin failed for ${path}`); continue; }
      diffs.set(patchKey, diff.toString("utf8"));
    }
    const diff = diffs.get(patchKey)!;
    const status: Status = run.verdict === "pass" || run.verdict === "fail" ? run.verdict : "malformed";
    if (status !== r.verdict) errors.push(`${key}: verdict ${status} differs from reviews.csv ${r.verdict}`);
    counts[status]++;
    const label = labels.get(`${r.instance_id}|${r.agent_id}`)!;
    const base = { review_id: key, model: r.model, effort: r.effort, instance_id: r.instance_id, agent_id: r.agent_id, label: label.label, rule: label.rule, verdict_status: status };

    let findings: Finding[] = status === "fail" ? (run.findings as Json[]).map((f) => ({ location: text(f.location), problem: text(f.problem) })) : [];
    let message: string | null = null;
    if (status === "malformed") {
      const finalText = finalMessage(source.read(source.transcript)!.toString("utf8"));
      findings = recoverFindings(finalText);
      if (findings.length === 0) message = finalText;
    }
    privateRecords.push({ ...base, run_name: r.run_name, stop_reason: run.stop_reason ?? "", feedback: run.feedback ?? null, findings, final_message: message });
    if (status === "pass") continue;

    const elide = redactor(diff);
    if (findings.length === 0) {
      findingRows.push({ finding_id: `${key}-0`, ...base, finding_index: 0, n_findings: 0, location: "", problem: "", ...NO_LOCATION });
      continue;
    }
    findings.forEach((f, i) => {
      findingRows.push({
        finding_id: `${key}-${i + 1}`,
        ...base,
        finding_index: i + 1,
        n_findings: findings.length,
        location: elide(f.location),
        problem: elide(f.problem),
        ...locationCodes(f.location, f.problem, diff),
      });
    });
  }
  for (const status of ["fail", "malformed"] as const) {
    const expected = (options.expected ?? EXPECTED)[status];
    if (counts[status] !== expected) errors.push(`${counts[status]} ${status} reviews, expected ${expected}`);
  }
  const csv = [COLUMNS.join(","), ...findingRows.map((row) => COLUMNS.map((c) => csvCell(row[c])).join(","))].join("\n") + "\n";
  return { errors, counts, rows: findingRows.length, csv, privateRecords };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      runs: { type: "string" },
      vault: { type: "string" },
      "private-out": { type: "string" },
      out: { type: "string" },
      reviews: { type: "string", default: join(PAPER, "haiku-vs-opus", "artifact", "data", "reviews.csv") },
      labels: { type: "string", default: join(PAPER, "artifact", "data", "labels.csv") },
    },
  });
  if (!values.runs || !values.vault || !values["private-out"] || !values.out) {
    console.error("usage: node extract.ts --runs <runs dir> --vault <vault repo> --private-out <dir outside the repo> --out <data dir>");
    process.exit(2);
  }
  const privateOut = values["private-out"];
  const checkout = insideCheckout(privateOut);
  if (checkout) {
    console.error(`--private-out ${privateOut} is inside the checkout ${checkout}; private records must stay outside the repo`);
    process.exit(2);
  }
  const { errors, counts, rows, csv, privateRecords } = extract({ runs: values.runs, vault: values.vault, reviews: values.reviews!, labels: values.labels! });
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  mkdirSync(privateOut, { recursive: true });
  writeFileSync(join(privateOut, "reviews.jsonl"), privateRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "findings.csv"), csv);
  console.log(`${counts.fail} fail, ${counts.malformed} malformed, ${counts.pass} pass reviews; ${rows} finding rows`);
}
