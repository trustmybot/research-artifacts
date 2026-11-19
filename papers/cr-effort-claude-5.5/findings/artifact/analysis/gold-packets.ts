import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readCsv } from "../../../artifact/analysis/lib.ts";
import { excerpt } from "../../../artifact/analysis/requires-packets.ts";
import { insideCheckout } from "./extract.ts";
import {
  candidatePatch, fillSlots, LABEL_CHECK_BATCH, officialRow, PAPER, patchKey, PROMPTS, promptBlock, readMainPatches, REPO, sha256,
} from "./packet-lib.ts";

export const EXPECTED_GOLD = 55;
export const RUNS_PER_TEST = 3;
const DATASET_SERVER = "https://datasets-server.huggingface.co";
const ROWS_PAGE_LENGTH = 100;
const ABS_CACHE = join("cache", "swe-abs-rows.json");

export type Basis = "test" | "reading";

export interface AbsRow {
  instance_id: string;
  patch: string;
  test_patch: string;
  original_test_patch: string;
  FAIL_TO_PASS: string;
  PASS_TO_PASS: string;
}

export interface AbsInputs {
  source: { dataset: string; revision: string };
  instances: Record<string, { abs_test_patch_sha256: string; verified_test_patch_sha256: string; fail_to_pass_sha256: string; pass_to_pass_sha256: string }>;
}

interface Verdict { instance_id: string; agent_id: string; abs_failing_tests: string[][] }

export interface GoldPacket {
  instance_id: string;
  agent_id: string;
  basis: Basis;
  slots: Record<string, string>;
  prompt: string;
}

export interface GoldOptions {
  runs: string;
  labels: string;
  mainPatches: string;
  inputs: AbsInputs;
  labelCheck: string;
  absRows: Map<string, AbsRow>;
  expected?: number;
}

const NONE = "none";
const or = (text: string) => (text.trim() === "" ? NONE : text);

export function failingTestUnion(runs: string[][]): { test: string; runs: number[] }[] {
  const union = new Map<string, number[]>();
  runs.forEach((tests, i) => {
    for (const test of new Set(tests)) union.set(test, [...(union.get(test) ?? []), i + 1]);
  });
  return [...union].map(([test, failedIn]) => ({ test, runs: failedIn }));
}

function excerptsFor(labelCheck: string, instanceId: string, agentId: string, failing: { test: string; runs: number[] }[]): string {
  const logs = new Map<number, string>();
  const logOf = (run: number) => {
    if (!logs.has(run)) {
      const path = join(labelCheck, "logs", `${instanceId}.${agentId}.candidate.abs.${run}.log`);
      if (!existsSync(path)) throw new Error(`missing label-check log ${path}`);
      logs.set(run, readFileSync(path, "utf8"));
    }
    return logs.get(run)!;
  };
  return failing.map(({ test, runs }) => {
    const byText = new Map<string, number[]>();
    for (const run of runs) {
      const text = excerpt(logOf(run), test);
      byText.set(text, [...(byText.get(text) ?? []), run]);
    }
    const blocks = [...byText].map(([text, inRuns]) => `${inRuns.length === 1 ? "run" : "runs"} ${inRuns.join(", ")}:\n${text}`);
    return [`- ${test}`, ...blocks].join("\n");
  }).join("\n");
}

function requireAbsPins(row: AbsRow, pins: AbsInputs["instances"][string] | undefined): void {
  const id = row.instance_id;
  if (!pins) throw new Error(`no pinned SWE-ABS hashes for ${id}`);
  const checks: [string, string, string][] = [
    ["abs test patch", row.test_patch, pins.abs_test_patch_sha256],
    ["verified test patch", row.original_test_patch, pins.verified_test_patch_sha256],
    ["FAIL_TO_PASS", row.FAIL_TO_PASS, pins.fail_to_pass_sha256],
    ["PASS_TO_PASS", row.PASS_TO_PASS, pins.pass_to_pass_sha256],
  ];
  for (const [what, text, pin] of checks) if (sha256(text) !== pin) throw new Error(`hash pin failed for the SWE-ABS ${what} of ${id}`);
}

export function wrongPatches(labelsPath: string) {
  return readCsv(labelsPath)
    .filter((l) => l.set === "main" && l.label === "wrong")
    .sort((a, b) => (patchKey(a.instance_id, a.agent_id) < patchKey(b.instance_id, b.agent_id) ? -1 : 1));
}

export function buildGoldPackets(options: GoldOptions): { errors: string[]; packets: GoldPacket[] } {
  const template = promptBlock(readFileSync(join(PROMPTS, "G1-gold-draft.md"), "utf8"), "Prompt: Round 1");
  const pins = readMainPatches(options.mainPatches);
  const verdicts = new Map(
    (JSON.parse(readFileSync(join(options.labelCheck, "label-check.json"), "utf8")).verdicts as Verdict[])
      .map((v) => [patchKey(v.instance_id, v.agent_id), v]),
  );
  const errors: string[] = [];
  const packets: GoldPacket[] = [];
  for (const label of wrongPatches(options.labels)) {
    const { instance_id: instanceId, agent_id: agentId } = label;
    const key = patchKey(instanceId, agentId);
    try {
      const pin = pins.get(key);
      if (!pin) throw new Error(`${key} is not in the main patch pins`);
      if (pin.patch_sha256 !== label.patch_sha256) throw new Error(`${key}: patch_sha256 differs between labels.csv and the main patch pins`);
      const verdict = verdicts.get(key);
      if (!verdict) throw new Error(`${key} has no label-check verdict`);
      if (verdict.abs_failing_tests.length !== RUNS_PER_TEST) throw new Error(`${key}: label check has ${verdict.abs_failing_tests.length} runs, expected ${RUNS_PER_TEST}`);
      const basis: Basis = label.rule === "L7" ? "reading" : "test";
      const failing = failingTestUnion(verdict.abs_failing_tests);
      if (basis === "test" && failing.length === 0) throw new Error(`${key}: a test-defined wrong patch has no failing SWE-ABS test`);
      const official = officialRow(options.runs, pin);
      const diff = candidatePatch(options.runs, instanceId, agentId, label.patch_sha256);
      let absTestPatch = NONE;
      if (failing.length > 0) {
        const row = options.absRows.get(instanceId);
        if (!row) throw new Error(`no SWE-ABS row for ${instanceId}`);
        requireAbsPins(row, options.inputs.instances[instanceId]);
        if (sha256(row.patch) !== pin.gold_patch_sha256) throw new Error(`hash pin failed for the SWE-ABS official fix of ${instanceId}`);
        absTestPatch = or(row.test_patch);
      }
      const slots = {
        instance_id: instanceId,
        agent_id: agentId,
        basis,
        problem_statement: or(official.problem_statement),
        gold_patch: or(official.patch),
        abs_test_patch: absTestPatch,
        tests_with_counts: or(failing.map(({ test, runs }) => `- ${test}: failed in ${runs.length} of ${RUNS_PER_TEST} runs`).join("\n")),
        excerpts: or(excerptsFor(options.labelCheck, instanceId, agentId, failing)),
        candidate_patch: or(diff),
      };
      packets.push({ instance_id: instanceId, agent_id: agentId, basis, slots, prompt: fillSlots(template, slots) });
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  const expected = options.expected ?? EXPECTED_GOLD;
  if (packets.length !== expected) errors.push(`${packets.length} gold packets, expected ${expected}`);
  return { errors, packets };
}

const ABS_FIELDS = ["instance_id", "patch", "test_patch", "original_test_patch", "FAIL_TO_PASS", "PASS_TO_PASS"] as const;

async function fetchAbsRows(dataset: string, wanted: Set<string>): Promise<AbsRow[]> {
  const found = new Map<string, AbsRow>();
  for (let offset = 0; found.size < wanted.size; ) {
    const query = new URLSearchParams({ dataset, config: "default", split: "test", offset: String(offset), length: String(ROWS_PAGE_LENGTH) });
    const response = await fetch(`${DATASET_SERVER}/rows?${query}`);
    if (!response.ok) throw new Error(`GET ${DATASET_SERVER}/rows?${query} failed: ${response.status}`);
    const page = (await response.json()) as { rows?: { row: AbsRow; truncated_cells?: string[] }[] };
    if (!page.rows?.length) throw new Error(`SWE-ABS rows at offset ${offset} are empty, still missing ${[...wanted].filter((id) => !found.has(id)).join(", ")}`);
    for (const { row, truncated_cells: truncated } of page.rows) {
      if (!wanted.has(row.instance_id)) continue;
      if (truncated?.length !== 0) throw new Error(`SWE-ABS row for ${row.instance_id} is truncated`);
      found.set(row.instance_id, Object.fromEntries(ABS_FIELDS.map((f) => [f, row[f]])) as unknown as AbsRow);
    }
    offset += page.rows.length;
  }
  return [...found.values()].sort((a, b) => (a.instance_id < b.instance_id ? -1 : 1));
}

async function loadAbsRows(privateOut: string, dataset: string, wanted: Set<string>): Promise<Map<string, AbsRow>> {
  const path = join(privateOut, ABS_CACHE);
  let rows: AbsRow[] = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  if (![...wanted].every((id) => rows.some((r) => r.instance_id === id))) {
    rows = await fetchAbsRows(dataset, wanted);
    mkdirSync(join(privateOut, "cache"), { recursive: true });
    writeFileSync(path, JSON.stringify(rows, null, 1) + "\n");
  }
  return new Map(rows.map((r) => [r.instance_id, r]));
}

export const packetName = (p: { instance_id: string; agent_id: string }) => `${p.instance_id}.${p.agent_id}`;

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      runs: { type: "string" },
      "private-out": { type: "string" },
      labels: { type: "string", default: join(PAPER, "artifact", "data", "labels.csv") },
      "main-patches": { type: "string", default: join(REPO, "harness", "checks", "main-patches.json") },
      inputs: { type: "string", default: join(REPO, "harness", "checks", "label-check-inputs.json") },
      "label-check": { type: "string" },
    },
  });
  if (!values.runs || !values["private-out"]) {
    console.error("usage: node gold-packets.ts --runs <runs dir> --private-out <dir outside the repo> [--label-check <dir>]");
    process.exit(2);
  }
  const privateOut = values["private-out"];
  const checkout = insideCheckout(privateOut);
  if (checkout) {
    console.error(`--private-out ${privateOut} is inside the checkout ${checkout}; gold packets must stay outside the repo`);
    process.exit(2);
  }
  const inputs = JSON.parse(readFileSync(values.inputs!, "utf8")) as AbsInputs;
  const wanted = new Set(wrongPatches(values.labels!).map((l) => l.instance_id));
  const absRows = await loadAbsRows(privateOut, inputs.source.dataset, wanted);
  const { errors, packets } = buildGoldPackets({
    runs: values.runs,
    labels: values.labels!,
    mainPatches: values["main-patches"]!,
    inputs,
    labelCheck: values["label-check"] ?? join(values.runs, "gcs", LABEL_CHECK_BATCH, "label-check"),
    absRows,
  });
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  const dir = join(privateOut, "gold");
  mkdirSync(dir, { recursive: true });
  for (const p of packets) {
    writeFileSync(join(dir, `${packetName(p)}.json`), JSON.stringify({ instance_id: p.instance_id, agent_id: p.agent_id, basis: p.basis, slots: p.slots }, null, 1) + "\n");
    writeFileSync(join(dir, `${packetName(p)}.md`), p.prompt.endsWith("\n") ? p.prompt : p.prompt + "\n");
  }
  const byBasis = (b: Basis) => packets.filter((p) => p.basis === b).length;
  console.log(`${packets.length} gold packets (${byBasis("test")} test, ${byBasis("reading")} reading) in ${dir}`);
}
