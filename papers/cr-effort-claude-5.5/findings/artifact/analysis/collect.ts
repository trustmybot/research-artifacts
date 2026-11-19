import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decode } from "@toon-format/toon";
import { mulberry32, wilson } from "../../../artifact/analysis/stats.ts";
import { insideCheckout } from "./extract.ts";
import { FINDINGS } from "./packet-lib.ts";
import { PASSES, type BlindKeyEntry, type Pass } from "./packets.ts";

export const CODERS = ["A", "B"] as const;
export type Coder = (typeof CODERS)[number];
export const DEFAULT_RESAMPLES = 2000;
export const DEFAULT_SEED = 20261118;
const MODEL_GUESS_CHANCE = 1 / 3;
const REASON_FLAGS = ["false_positive_issue", "redundant", "out_of_scope", "overcorrection", "environment_artifact"] as const;

type Value = string | number | boolean | null;
type Obj = Record<string, unknown>;

export interface MReviewLevel {
  review_level: "named" | "partial" | "other" | "no_codable_finding";
  binary: 0 | 1;
  sensitivity: 0 | 1;
  feedback_named: number | null;
}

export interface CodeRecord {
  pass: Pass;
  item: string;
  batch: string;
  model: string;
  effort: string;
  instance_id: string;
  agent_id: string;
  label: string;
  rule: string;
  is_decoy: boolean;
  A: Obj | null;
  B: Obj | null;
  derived?: Record<Coder, MReviewLevel | null>;
}

export interface CodedRecord extends CodeRecord {
  A: Obj;
  B: Obj;
  derived?: Record<Coder, MReviewLevel>;
}

export interface MissingItem { pass: Pass; batch: string; coder: Coder; item: string }

// An item one coder left out of its reply is reported, not fatal, and drops out of agreement and disagreements.
export function missingItems(records: CodeRecord[]): MissingItem[] {
  return records.flatMap((r) => CODERS.filter((c) => r[c] === null).map((coder) => ({ pass: r.pass, batch: r.batch, coder, item: r.item })));
}

const bothCoded = (records: CodeRecord[]) => records.filter((r): r is CodedRecord => r.A !== null && r.B !== null);

export interface Disagreement {
  pass: Pass;
  item: string;
  field: string;
  code_A: Value;
  why_A: string | null;
  code_B: Value;
  why_B: string | null;
}

export function lastToonBlock(reply: string): string | null {
  const blocks = [...reply.matchAll(/^```toon[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
  return blocks.length ? blocks[blocks.length - 1][1] : null;
}

const REQUIRED: Record<Pass, { item: string[]; lists: Record<string, string[]> }> = {
  T: { item: ["reproduction", "model_guess", "no_codable_finding"], lists: { findings: ["n", "class", "type", "subtype", "quality_flag", "multi_claim"] } },
  M: { item: ["no_codable_finding"], lists: { pairs: ["finding", "gold", "score"], feedback: ["gold", "score"] } },
  C: { item: ["reality", ...REASON_FLAGS], lists: {} },
  A: { item: ["concern"], lists: { feedback: ["gold", "score"] } },
};

function shapeErrors(pass: Pass, item: Obj): string[] {
  const spec = REQUIRED[pass];
  const errors = spec.item.filter((k) => !(k in item)).map((k) => `missing "${k}"`);
  for (const [list, keys] of Object.entries(spec.lists)) {
    const entries = item[list];
    if (!Array.isArray(entries)) { errors.push(`"${list}" is not a list`); continue; }
    entries.forEach((e, i) => {
      for (const k of keys) if (!(k in (e as Obj))) errors.push(`${list}[${i}] missing "${k}"`);
    });
  }
  if (pass === "T") {
    const ns = (item.findings as Obj[] ?? []).map((f) => f.n);
    const dup = ns.find((n, i) => ns.indexOf(n) !== i);
    if (dup !== undefined) errors.push(`finding n ${dup} appears twice`);
  }
  return errors;
}

function parseReply(path: string, pass: Pass, where: string, errors: string[]): Obj[] | null {
  const block = lastToonBlock(readFileSync(path, "utf8"));
  if (block === null) { errors.push(`${where}: no fenced toon block`); return null; }
  let decoded: unknown;
  try {
    decoded = decode(block, { strict: false });
  } catch (error) {
    errors.push(`${where}: toon block does not decode: ${(error as Error).message}`);
    return null;
  }
  const items = (decoded as Obj)?.items;
  if (!Array.isArray(items)) { errors.push(`${where}: toon block has no items list`); return null; }
  let ok = true;
  for (const item of items as Obj[]) {
    item.item = normalizeCode(item.item);
    for (const e of shapeErrors(pass, item)) { errors.push(`${where}: item ${String(item.item)}: ${e}`); ok = false; }
  }
  return ok ? items as Obj[] : null;
}

// The prompts show the item as "ITEM CODE", and some coders copy the label with the code.
export const normalizeCode = (value: unknown) => String(value).trim().replace(/^ITEM\s+/, "").trim();

function itemSetErrors(where: string, expected: string[], got: Obj[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const c of got.map((i) => String(i.item))) {
    if (seen.has(c)) errors.push(`${where}: item ${c} appears twice`);
    seen.add(c);
    if (!expected.includes(c)) errors.push(`${where}: item ${c} is not in the batch`);
  }
  return errors;
}

const maxOf = (xs: number[]) => (xs.length ? Math.max(...xs) : null);

export function reviewLevel(item: Obj): MReviewLevel {
  const feedbackNamed = maxOf((item.feedback as Obj[]).map((f) => Number(f.score)));
  if (item.no_codable_finding === true) return { review_level: "no_codable_finding", binary: 0, sensitivity: 0, feedback_named: feedbackNamed };
  const top = maxOf((item.pairs as Obj[]).map((p) => Number(p.score))) ?? 0;
  const review_level = top >= 2 ? "named" : top === 1 ? "partial" : "other";
  return { review_level, binary: top >= 2 ? 1 : 0, sensitivity: top >= 1 ? 1 : 0, feedback_named: feedbackNamed };
}

export interface CollectInput {
  replies: string;
  batches: string;
  blindKey: BlindKeyEntry[];
}

export function collectCodes({ replies, batches, blindKey }: CollectInput): { errors: string[]; records: CodeRecord[] } {
  const errors: string[] = [];
  const records: CodeRecord[] = [];
  const key = new Map(blindKey.map((e) => [e.code, e]));
  const batched = new Set<string>();
  for (const pass of PASSES) {
    const dir = join(batches, pass);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
    for (const file of files) {
      const batch = JSON.parse(readFileSync(join(dir, file), "utf8")) as { batch: number; pass: Pass; items: { code: string }[] };
      const name = file.replace(/\.json$/, "");
      if (batch.pass !== pass) errors.push(`batch ${name}: pass ${batch.pass} in the ${pass} directory`);
      const codes = batch.items.map((i) => i.code);
      for (const code of codes) {
        batched.add(code);
        const entry = key.get(code);
        if (!entry) errors.push(`batch ${name}: item ${code} is not in blind-key.json`);
        else if (entry.pass !== pass) errors.push(`batch ${name}: item ${code} is pass ${entry.pass} in blind-key.json`);
      }
      const parsed = {} as Record<Coder, Map<string, Obj> | null>;
      for (const coder of CODERS) {
        const where = `batch ${name} coder ${coder}`;
        const path = join(replies, pass, `${name}.${coder}.md`);
        if (!existsSync(path)) { errors.push(`${where}: reply ${path} is missing`); parsed[coder] = null; continue; }
        const items = parseReply(path, pass, where, errors);
        if (!items) { parsed[coder] = null; continue; }
        const setErrors = itemSetErrors(where, codes, items);
        errors.push(...setErrors);
        parsed[coder] = setErrors.length ? null : new Map(items.map((i) => [String(i.item), i]));
      }
      if (!parsed.A || !parsed.B) continue;
      for (const code of codes) {
        const entry = key.get(code);
        if (!entry) continue;
        const { pass: _pass, code: _code, ...fields } = entry;
        const A = parsed.A.get(code) ?? null, B = parsed.B.get(code) ?? null;
        const record: CodeRecord = { pass, item: code, batch: name, ...fields, A, B };
        if (pass === "M") record.derived = { A: A && reviewLevel(A), B: B && reviewLevel(B) };
        records.push(record);
      }
    }
  }
  for (const e of blindKey) if (!batched.has(e.code)) errors.push(`blind-key.json: pass ${e.pass} item ${e.code} is in no batch`);
  return { errors, records };
}

// Nominal-scale agreement: Cohen (1960) with each coder's own marginals, Gwet (2008) AC1 over the q categories of the scale.
export function nominalAgreement(pairs: [Value, Value][], categories: Value[] = []): { n: number; percent: number; kappa: number; ac1: number } {
  const n = pairs.length;
  const keyOf = (v: Value) => JSON.stringify(v);
  const cats = new Set(categories.map(keyOf));
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  let agree = 0;
  for (const [a, b] of pairs) {
    const ka = keyOf(a), kb = keyOf(b);
    cats.add(ka); cats.add(kb);
    countA.set(ka, (countA.get(ka) ?? 0) + 1);
    countB.set(kb, (countB.get(kb) ?? 0) + 1);
    if (ka === kb) agree++;
  }
  const po = agree / n;
  let peKappa = 0, sumPi = 0;
  for (const c of cats) {
    const pa = (countA.get(c) ?? 0) / n, pb = (countB.get(c) ?? 0) / n;
    peKappa += pa * pb;
    const pi = (pa + pb) / 2;
    sumPi += pi * (1 - pi);
  }
  const q = cats.size;
  const peAc1 = q > 1 ? sumPi / (q - 1) : 1;
  const chanceCorrected = (pe: number) => (pe === 1 ? 1 : (po - pe) / (1 - pe));
  return { n, percent: po, kappa: chanceCorrected(peKappa), ac1: chanceCorrected(peAc1) };
}

export interface Interval { value: number; lower: number; upper: number }
export interface AgreementStats { n: number; n_items: number; percent: Interval; kappa: Interval; ac1: Interval }

// Percentile bootstrap that resamples items (reviews), so every pair of an item travels with it.
export function clusteredAgreement(clusters: [Value, Value][][], categories: Value[], resamples: number, seed: number): AgreementStats | null {
  const filled = clusters.filter((c) => c.length > 0);
  if (!filled.length) return null;
  const point = nominalAgreement(filled.flat(), categories);
  const rand = mulberry32(seed);
  const boot = { percent: [] as number[], kappa: [] as number[], ac1: [] as number[] };
  for (let r = 0; r < resamples; r++) {
    const sample: [Value, Value][] = [];
    for (let i = 0; i < filled.length; i++) sample.push(...filled[Math.floor(rand() * filled.length)]);
    const s = nominalAgreement(sample, categories);
    boot.percent.push(s.percent); boot.kappa.push(s.kappa); boot.ac1.push(s.ac1);
  }
  const interval = (value: number, xs: number[]): Interval => {
    xs.sort((x, y) => x - y);
    const pick = (q: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.floor(q * xs.length)))];
    return { value, lower: pick(0.025), upper: pick(0.975) };
  };
  return {
    n: point.n, n_items: filled.length,
    percent: interval(point.percent, boot.percent), kappa: interval(point.kappa, boot.kappa), ac1: interval(point.ac1, boot.ac1),
  };
}

const findingsOf = (item: Obj) => (item.findings as Obj[]) ?? [];
const triple = (f: Obj) => `${f.class}/${f.type}/${f.subtype}`;
const why = (o: Obj) => (typeof o.why === "string" ? o.why : null);

interface AlignedFinding { n: number; A: Obj; B: Obj }
export interface Unaligned { item: string; n: number; coder: Coder }

export function alignFindings(r: CodedRecord): { aligned: AlignedFinding[]; unaligned: Unaligned[] } {
  const byN = (item: Obj) => new Map(findingsOf(item).map((f) => [Number(f.n), f]));
  const a = byN(r.A), b = byN(r.B);
  const aligned: AlignedFinding[] = [];
  const unaligned: Unaligned[] = [];
  for (const [n, f] of a) if (b.has(n)) aligned.push({ n, A: f, B: b.get(n)! }); else unaligned.push({ item: r.item, n, coder: "A" });
  for (const n of b.keys()) if (!a.has(n)) unaligned.push({ item: r.item, n, coder: "B" });
  return { aligned: aligned.sort((x, y) => x.n - y.n), unaligned };
}

const scoreKey = (entry: Obj, keys: string[]) => keys.map((k) => String(entry[k])).join("|");

function alignScores(r: CodedRecord, list: string, keys: string[]): { key: string; A: Obj; B: Obj }[] {
  const b = new Map((r.B[list] as Obj[]).map((e) => [scoreKey(e, keys), e]));
  return (r.A[list] as Obj[]).flatMap((e) => {
    const other = b.get(scoreKey(e, keys));
    return other ? [{ key: scoreKey(e, keys), A: e, B: other }] : [];
  });
}

const BOOL: Value[] = [true, false];
const SCORES: Value[] = [0, 1, 2];

export function agreement(all: CodeRecord[], resamples = DEFAULT_RESAMPLES, seed = DEFAULT_SEED) {
  const records = bothCoded(all);
  const of = (pass: Pass) => records.filter((r) => r.pass === pass);
  const codes: Record<string, AgreementStats | null> = {};
  const add = (name: string, clusters: [Value, Value][][], categories: Value[] = []) => {
    codes[name] = clusteredAgreement(clusters, categories, resamples, seed);
  };
  const itemLevel = (rs: CodedRecord[], get: (o: Obj) => Value) => rs.map((r) => [[get(r.A), get(r.B)]] as [Value, Value][]);

  const T = of("T");
  const tAligned = T.map(alignFindings);
  const findingPairs = (get: (f: Obj) => Value) => tAligned.map((t) => t.aligned.map((f) => [get(f.A), get(f.B)] as [Value, Value]));
  add("T.class_type_subtype", findingPairs(triple));
  add("T.quality_flag", findingPairs((f) => f.quality_flag as Value), ["none", "performance", "security", "compatibility"]);
  add("T.multi_claim", findingPairs((f) => f.multi_claim as Value), BOOL);
  add("T.reproduction", itemLevel(T, (o) => o.reproduction as Value), ["R0", "R1", "R2"]);

  const types = [...new Set(tAligned.flatMap((t) => t.aligned.flatMap((f) => [String(f.A.type), String(f.B.type)])))].sort();
  const perType = Object.fromEntries(types.map((type) => {
    const flags = findingPairs((f) => f.type === type);
    const coded = (c: Coder) => tAligned.reduce((s, t) => s + t.aligned.filter((f) => f[c].type === type).length, 0);
    return [type, { coded_A: coded("A"), coded_B: coded("B"), ...clusteredAgreement(flags, BOOL, resamples, seed) }];
  }));
  const unaligned = tAligned.flatMap((t) => t.unaligned);

  const modelGuess = Object.fromEntries(CODERS.map((c) => {
    const correct = T.filter((r) => r[c].model_guess === r.model).length;
    const unsure = T.filter((r) => r[c].model_guess === "unsure").length;
    const [lower, upper] = T.length ? wilson(correct, T.length) : [0, 0];
    return [c, { n: T.length, correct, unsure, accuracy: T.length ? correct / T.length : null, wilson_95: [lower, upper] }];
  }));

  const M = of("M");
  const mLevel = (get: (d: MReviewLevel) => Value) => M.map((r) => [[get(r.derived!.A), get(r.derived!.B)]] as [Value, Value][]);
  add("M.review_level", mLevel((d) => d.review_level), ["named", "partial", "other", "no_codable_finding"]);
  add("M.review_level_binary", mLevel((d) => d.binary), [0, 1]);
  add("M.feedback_named", mLevel((d) => d.feedback_named), SCORES);

  const C = of("C");
  add("C.reality", itemLevel(C, (o) => o.reality as Value), ["real_in_scope", "real_shared", "real_outside_issue", "not_real", "unverifiable"]);
  for (const flag of REASON_FLAGS) add(`C.${flag}`, itemLevel(C, (o) => o[flag] as Value), BOOL);

  const A = of("A");
  add("A.concern", itemLevel(A, (o) => o.concern as Value), ["C0", "C1", "C2"]);
  add("A.feedback_score", A.map((r) => alignScores(r, "feedback", ["gold"]).map((p) => [p.A.score, p.B.score] as [Value, Value])), SCORES);

  return {
    resamples, seed,
    codes,
    T_per_type: perType,
    T_unaligned: { count: unaligned.length, findings: unaligned },
    T_model_guess: { chance: MODEL_GUESS_CHANCE, ...modelGuess },
    missing: missingItems(all),
  };
}

const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

export function disagreements(records: CodeRecord[]): Disagreement[] {
  const out: Disagreement[] = [];
  for (const r of bothCoded(records)) {
    const push = (field: string, code_A: unknown, code_B: unknown, why_A: string | null, why_B: string | null) => {
      if (differs(code_A, code_B)) out.push({ pass: r.pass, item: r.item, field, code_A: code_A as Value, why_A, code_B: code_B as Value, why_B });
    };
    switch (r.pass) {
      case "T":
        for (const f of alignFindings(r).aligned) {
          push(`findings[${f.n}].class_type_subtype`, triple(f.A), triple(f.B), why(f.A), why(f.B));
          push(`findings[${f.n}].quality_flag`, f.A.quality_flag, f.B.quality_flag, why(f.A), why(f.B));
          push(`findings[${f.n}].multi_claim`, f.A.multi_claim, f.B.multi_claim, why(f.A), why(f.B));
        }
        push("reproduction", r.A.reproduction, r.B.reproduction, null, null);
        break;
      case "M": {
        push("review_level", r.derived!.A.review_level, r.derived!.B.review_level, null, null);
        const deciding = new Set<string>();
        for (const c of CODERS) {
          const pairs = r[c].pairs as Obj[];
          const top = maxOf(pairs.map((p) => Number(p.score)));
          for (const p of pairs) if (Number(p.score) === top) deciding.add(String(p.finding));
        }
        for (const p of alignScores(r, "pairs", ["finding", "gold"])) {
          if (deciding.has(String(p.A.finding))) push(`pairs[finding=${p.A.finding},gold=${p.A.gold}].score`, p.A.score, p.B.score, why(p.A), why(p.B));
        }
        break;
      }
      case "C":
        push("reality", r.A.reality, r.B.reality, why(r.A), why(r.B));
        for (const flag of REASON_FLAGS) push(flag, r.A[flag], r.B[flag], why(r.A), why(r.B));
        break;
      case "A":
        push("concern", r.A.concern, r.B.concern, why(r.A), why(r.B));
        for (const p of alignScores(r, "feedback", ["gold"])) push(`feedback[gold=${p.A.gold}].score`, p.A.score, p.B.score, why(p.A), why(p.B));
        break;
    }
  }
  return out;
}

const writeJson = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data, null, 1) + "\n");

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      replies: { type: "string" },
      batches: { type: "string" },
      out: { type: "string" },
      resamples: { type: "string", default: String(DEFAULT_RESAMPLES) },
      seed: { type: "string", default: String(DEFAULT_SEED) },
      "blind-key": { type: "string", default: join(FINDINGS, "artifact", "data", "blind-key.json") },
    },
  });
  const resamples = Number(values.resamples);
  const seed = Number(values.seed);
  if (!values.replies || !values.batches || !values.out || !Number.isInteger(resamples) || resamples < 1 || !Number.isInteger(seed)) {
    console.error("usage: node collect.ts --replies <dir> --batches <dir> --out <dir outside the repo> [--resamples 2000] [--seed 20261118]");
    process.exit(2);
  }
  const checkout = insideCheckout(values.out);
  if (checkout) {
    console.error(`--out ${values.out} is inside the checkout ${checkout}; coder codes quote reviews and must stay outside the repo`);
    process.exit(2);
  }
  const blindKey = JSON.parse(readFileSync(values["blind-key"]!, "utf8")) as BlindKeyEntry[];
  const { errors, records } = collectCodes({ replies: values.replies, batches: values.batches, blindKey });
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  const found = disagreements(records);
  mkdirSync(values.out, { recursive: true });
  writeJson(join(values.out, "codes.json"), records);
  writeJson(join(values.out, "agreement.json"), agreement(records, resamples, seed));
  writeJson(join(values.out, "disagreements.json"), found);
  const perPass = PASSES.map((p) => `${p} ${records.filter((r) => r.pass === p).length}`).join(", ");
  const missing = missingItems(records).map((m) => `${m.batch} ${m.coder} ${m.item}`);
  console.log(`items: ${perPass}; ${found.length} disagreements; ${missing.length} items missing from a reply${missing.length ? ` (${missing.join(", ")})` : ""}`);
}
