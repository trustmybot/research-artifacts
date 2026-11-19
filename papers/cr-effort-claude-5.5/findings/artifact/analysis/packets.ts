import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { extract, insideCheckout, type ExtractOptions, type Finding } from "./extract.ts";
import {
  candidatePatch, FINDINGS, fillSlots, mulberry32, officialRow, PAPER, patchKey, PROMPTS, promptBlock, readMainPatches, REPO, shuffle,
  type MainPatchPin, type OfficialRow,
} from "./packet-lib.ts";

export const PASSES = ["T", "M", "C", "A"] as const;
export type Pass = (typeof PASSES)[number];

const PROMPT_FILES: Record<Pass, string> = { T: "T-type.md", M: "M-match.md", C: "C-claim.md", A: "A-accepted.md" };
export const BATCH_SIZE: Record<Pass, number> = { T: 15, M: 15, C: 9, A: 15 };
export const SHUFFLE_SEED: Record<Pass, number> = { T: 20261118, M: 20261119, C: 20261120, A: 20261121 };
export const DECOY_SEED = 20261118;
export const EXPECTED_ITEMS = { T: 232, M: 205, falseAlarms: 27, A: 290 };
const ISSUE_EXCERPT_CHARS = 1400;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const EFFORT_ORDER = ["low", "medium", "high"];

export interface ReviewRecord {
  review_id: string;
  model: string;
  effort: string;
  instance_id: string;
  agent_id: string;
  label: string;
  rule: string;
  verdict_status: "pass" | "fail" | "malformed";
  feedback: string | null;
  findings: Finding[];
  final_message: string | null;
}

export interface Item { code: string; review: ReviewRecord; isDecoy: boolean; slots: Record<string, string | null> }
export interface Batch { pass: Pass; batch: number; items: Item[] }

export interface BlindKeyEntry {
  code: string;
  pass: Pass;
  model: string;
  effort: string;
  instance_id: string;
  agent_id: string;
  label: string;
  rule: string;
  is_decoy: boolean;
}

const rejected = (r: ReviewRecord) => r.verdict_status !== "pass";
const cellOf = (r: ReviewRecord) => `${r.model}|${r.effort}`;
const byCell = (a: string, b: string) => {
  const [ma, ea] = a.split("|");
  const [mb, eb] = b.split("|");
  return (ma < mb ? -1 : ma > mb ? 1 : 0) || EFFORT_ORDER.indexOf(ea) - EFFORT_ORDER.indexOf(eb);
};

export function drawDecoys(falseAlarms: ReviewRecord[], pool: ReviewRecord[], seed = DECOY_SEED): ReviewRecord[] {
  const rand = mulberry32(seed);
  const need = new Map<string, number>();
  for (const r of falseAlarms) need.set(cellOf(r), (need.get(cellOf(r)) ?? 0) + 1);
  return [...need.keys()].sort(byCell).flatMap((cell) => {
    const candidates = pool.filter((r) => cellOf(r) === cell);
    const n = need.get(cell)!;
    if (candidates.length < n) throw new Error(`cell ${cell} has ${candidates.length} wrong-patch rejections, ${n} decoys needed`);
    return shuffle(candidates, rand).slice(0, n);
  });
}

export function selectPasses(records: ReviewRecord[], seed = DECOY_SEED) {
  const T = records.filter(rejected);
  const M = T.filter((r) => r.label === "wrong");
  const falseAlarms = T.filter((r) => r.label === "correct");
  const decoys = drawDecoys(falseAlarms, M, seed);
  const A = records.filter((r) => r.verdict_status === "pass" && r.label === "wrong");
  return { T, M, falseAlarms, decoys, A };
}

const findingLines = (findings: Finding[]) =>
  findings.length === 0 ? "none parsed" : findings.map((f, i) => `[${i + 1}] location: ${f.location} | problem: ${f.problem}`).join("\n");

function itemSlots(pass: Pass, r: ReviewRecord, code: string, patch: string, official: OfficialRow): Record<string, string | null> {
  const feedback = r.feedback?.trim() ? r.feedback : "none parsed";
  const review = { findings: findingLines(r.findings), final_message: r.final_message ?? "not needed" };
  const excerpt = official.problem_statement.slice(0, ISSUE_EXCERPT_CHARS);
  switch (pass) {
    case "T": return { item_code: code, problem_statement_1400: excerpt, candidate_patch: patch, feedback, ...review };
    case "M": return { item_code: code, problem_statement_1400: excerpt, gold_behaviours: null, candidate_patch: patch, feedback, ...review };
    case "C": return { item_code: code, problem_statement: official.problem_statement, candidate_patch: patch, gold_patch: official.patch, feedback, ...review };
    case "A": return { item_code: code, problem_statement_1400: excerpt, gold_behaviours: null, candidate_patch: patch, feedback };
  }
}

export interface PacketSources {
  patch: (r: ReviewRecord) => string;
  official: (instanceId: string) => OfficialRow;
}

export function buildBatches(records: ReviewRecord[], sources: PacketSources, expected = EXPECTED_ITEMS) {
  const sets = selectPasses(records);
  const errors: string[] = [];
  const counts = { T: sets.T.length, M: sets.M.length, falseAlarms: sets.falseAlarms.length, A: sets.A.length };
  for (const [name, n] of Object.entries(counts)) {
    const want = expected[name as keyof typeof expected];
    if (n !== want) errors.push(`${n} ${name} items, expected ${want}`);
  }
  if (sets.decoys.length !== sets.falseAlarms.length) errors.push(`${sets.decoys.length} decoys for ${sets.falseAlarms.length} false alarms`);
  const decoyIds = new Set(sets.decoys.map((r) => r.review_id));
  const members: Record<Pass, ReviewRecord[]> = { T: sets.T, M: sets.M, C: [...sets.falseAlarms, ...sets.decoys], A: sets.A };
  const used = new Set<string>();
  const batches: Batch[] = [];
  for (const pass of PASSES) {
    const rand = mulberry32(SHUFFLE_SEED[pass]);
    const order = shuffle(members[pass], rand);
    const newCode = () => {
      for (;;) {
        const code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)]).join("");
        if (!used.has(code)) { used.add(code); return code; }
      }
    };
    const items = order.map((review) => {
      const code = newCode();
      const isDecoy = pass === "C" && decoyIds.has(review.review_id);
      return { code, review, isDecoy, slots: itemSlots(pass, review, code, sources.patch(review), sources.official(review.instance_id)) };
    });
    for (let at = 0, batch = 1; at < items.length; at += BATCH_SIZE[pass], batch++) {
      batches.push({ pass, batch, items: items.slice(at, at + BATCH_SIZE[pass]) });
    }
  }
  return { errors, batches, counts: { ...counts, decoys: sets.decoys.length } };
}

export function blindKey(batches: Batch[]): BlindKeyEntry[] {
  return batches.flatMap((b) => b.items.map(({ code, review: r, isDecoy }) => ({
    code, pass: b.pass, model: r.model, effort: r.effort, instance_id: r.instance_id, agent_id: r.agent_id, label: r.label, rule: r.rule, is_decoy: isDecoy,
  })));
}

export const batchName = (b: Batch) => `${b.pass}-${String(b.batch).padStart(2, "0")}`;

// M and A items wait for the settled gold: their prompts render once every item's gold_behaviours is filled.
export function renderBatch(batch: Batch, codebook: string): string | null {
  const file = readFileSync(join(PROMPTS, PROMPT_FILES[batch.pass]), "utf8");
  if (batch.items.some((i) => Object.values(i.slots).some((v) => v === null))) return null;
  const itemTemplate = promptBlock(file, "Item Template");
  const items = batch.items.map((i) => fillSlots(itemTemplate, i.slots as Record<string, string>)).join("\n\n");
  return fillSlots(promptBlock(file, "Prompt"), { codebook, items });
}

export function loadSources(runs: string, mainPatches: string): PacketSources {
  const pins = readMainPatches(mainPatches);
  const byInstance = new Map<string, MainPatchPin>([...pins.values()].map((p) => [p.instance_id, p]));
  const official = new Map<string, OfficialRow>();
  return {
    patch: (r) => {
      const pin = pins.get(patchKey(r.instance_id, r.agent_id));
      if (!pin) throw new Error(`${r.instance_id}|${r.agent_id} is not in the main patch pins`);
      return candidatePatch(runs, r.instance_id, r.agent_id, pin.patch_sha256);
    },
    official: (instanceId) => {
      if (!official.has(instanceId)) {
        const pin = byInstance.get(instanceId);
        if (!pin) throw new Error(`${instanceId} is not in the main patch pins`);
        official.set(instanceId, officialRow(runs, pin));
      }
      return official.get(instanceId)!;
    },
  };
}

export function writePackets(batches: Batch[], privateOut: string, codebook: string): number {
  let rendered = 0;
  for (const b of batches) {
    const dir = join(privateOut, "batches", b.pass);
    mkdirSync(dir, { recursive: true });
    const record = { pass: b.pass, batch: b.batch, items: b.items.map((i) => ({ code: i.code, slots: i.slots })) };
    writeFileSync(join(dir, `${batchName(b)}.json`), JSON.stringify(record, null, 1) + "\n");
    const prompt = renderBatch(b, codebook);
    if (prompt === null) continue;
    writeFileSync(join(dir, `${batchName(b)}.md`), prompt.endsWith("\n") ? prompt : prompt + "\n");
    rendered++;
  }
  return rendered;
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
      "main-patches": { type: "string", default: join(REPO, "harness", "checks", "main-patches.json") },
    },
  });
  if (!values.runs || !values.vault || !values["private-out"] || !values.out) {
    console.error("usage: node packets.ts --runs <runs dir> --vault <vault repo> --private-out <dir outside the repo> --out <data dir>");
    process.exit(2);
  }
  const privateOut = values["private-out"];
  const checkout = insideCheckout(privateOut);
  if (checkout) {
    console.error(`--private-out ${privateOut} is inside the checkout ${checkout}; packets must stay outside the repo`);
    process.exit(2);
  }
  const options: ExtractOptions = { runs: values.runs, vault: values.vault, reviews: values.reviews!, labels: values.labels! };
  const extracted = extract(options);
  if (extracted.errors.length) {
    console.error(extracted.errors.join("\n"));
    process.exit(1);
  }
  let built: ReturnType<typeof buildBatches>;
  try {
    built = buildBatches(extracted.privateRecords as ReviewRecord[], loadSources(values.runs, values["main-patches"]!));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  if (built.errors.length) {
    console.error(built.errors.join("\n"));
    process.exit(1);
  }
  const rendered = writePackets(built.batches, privateOut, readFileSync(join(FINDINGS, "codebook.md"), "utf8"));
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "blind-key.json"), JSON.stringify(blindKey(built.batches), null, 1) + "\n");
  const perPass = PASSES.map((p) => `${p} ${built.batches.filter((b) => b.pass === p).length}`).join(", ");
  const c = built.counts;
  console.log(`items: T ${c.T}, M ${c.M}, C ${c.falseAlarms} + ${c.decoys} decoys, A ${c.A}; batches: ${perPass}; ${rendered} prompts rendered (M and A wait for the gold)`);
}
