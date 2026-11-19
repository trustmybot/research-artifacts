import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decode } from "@toon-format/toon";
import { toCsv } from "../../../artifact/analysis/lib.ts";
import { alignFindings, CODERS, disagreements, lastToonBlock, reviewLevel, type CodedRecord, type CodeRecord, type Coder, type MReviewLevel } from "./collect.ts";
import { insideCheckout } from "./extract.ts";
import { FINDINGS, patchKey } from "./packet-lib.ts";
import type { Pass } from "./packets.ts";

type Value = string | number | boolean | null;
type Obj = Record<string, unknown>;

const REASON_FLAGS = ["false_positive_issue", "redundant", "out_of_scope", "overcorrection", "environment_artifact"] as const;
// collect.ts derives review_level from the pair scores, so the settled pairs decide it and J never sees it.
const DERIVED_FIELDS: Partial<Record<Pass, string[]>> = { M: ["review_level"] };

export type Basis = "a" | "b" | "third";
export type Source = "agree" | Basis | "one_coder" | "lower_unadjudicated";

export interface JOrder { pass: Pass; item: string; field: string; code_A: Value; code_B: Value; X: Coder; Y: Coder }
export interface Verdict { final: Value; basis: Basis; rule_cited: string }
export interface LogRow { pass: Pass; item: string; field: string; code_a: Value; code_b: Value; final: Value; basis: Basis; rule_cited: string }

export interface SettledRecord extends Omit<CodeRecord, "A" | "B" | "derived"> {
  coders: "both" | Coder;
  final: Obj;
  sources: Record<string, Source>;
  derived?: MReviewLevel;
}

export interface GoldSummary { behaviours: string[]; contested: string[]; dropped: string[]; changed: string[] }

export const verdictKey = (pass: string, item: string, field: string) => `${pass}|${item}|${field}`;

const BASES: Record<string, (o: JOrder) => Basis> = { X: (o) => o.X === "A" ? "a" : "b", Y: (o) => o.Y === "A" ? "a" : "b", third: () => "third" };

// J writes every final as a string; the coders' own codes fix its type.
export function coerceFinal(final: unknown, like: Value, field: string): Value {
  const text = String(final).trim();
  if (typeof like === "number") {
    const n = Number(text);
    if (!Number.isInteger(n)) throw new Error(`final ${JSON.stringify(final)} is not an integer score`);
    return n;
  }
  if (typeof like === "boolean") {
    if (text !== "true" && text !== "false") throw new Error(`final ${JSON.stringify(final)} is not true or false`);
    return text === "true";
  }
  if (field.endsWith("class_type_subtype") && !text.includes("/")) {
    const parts = text.match(/^([^_]+)_([^_]+)_(.+)$/);
    if (!parts) throw new Error(`final ${JSON.stringify(final)} is not class/type/subtype`);
    return parts.slice(1).join("/");
  }
  return text;
}

export function parseVerdict(reply: string, order: JOrder): Verdict {
  const block = lastToonBlock(reply);
  if (block === null) throw new Error("no fenced toon block");
  const decoded = decode(block, { strict: false }) as Obj;
  if (decoded?.final === undefined || decoded.final === null || String(decoded.final).trim() === "") throw new Error("no final");
  const toBasis = BASES[String(decoded.basis).trim()];
  if (!toBasis) throw new Error(`basis ${JSON.stringify(decoded.basis)} is not X, Y or third`);
  const basis = toBasis(order);
  const final = coerceFinal(decoded.final, order.code_A ?? order.code_B, order.field);
  if (basis !== "third") {
    const chosen = basis === "a" ? order.code_A : order.code_B;
    if (JSON.stringify(final) !== JSON.stringify(chosen)) throw new Error(`final ${JSON.stringify(final)} is not coder ${basis.toUpperCase()}'s code ${JSON.stringify(chosen)}`);
  }
  return { final, basis, rule_cited: decoded.rule_cited === undefined ? "" : String(decoded.rule_cited) };
}

export interface LoadedVerdicts { verdicts: Map<string, Verdict>; orders: Map<string, JOrder>; errors: Map<string, string> }

export function loadVerdicts(jDir: string): LoadedVerdicts {
  const prompts = join(jDir, "prompts");
  const out: LoadedVerdicts = { verdicts: new Map(), orders: new Map(), errors: new Map() };
  for (const file of readdirSync(prompts).filter((f) => f.endsWith(".order.json")).sort()) {
    const order = JSON.parse(readFileSync(join(prompts, file), "utf8")) as JOrder;
    const key = verdictKey(order.pass, order.item, order.field);
    out.orders.set(key, order);
    const reply = join(jDir, file.replace(/\.order\.json$/, ".J.md"));
    if (!existsSync(reply)) { out.errors.set(key, `reply ${reply} is missing`); continue; }
    try {
      out.verdicts.set(key, parseVerdict(readFileSync(reply, "utf8"), order));
    } catch (error) {
      out.errors.set(key, `reply ${reply}: ${(error as Error).message}`);
    }
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const triple = (f: Obj) => `${f.class}/${f.type}/${f.subtype}`;

interface Settler {
  pick(field: string, a: unknown, b: unknown, lowerIfUnadjudicated?: boolean): Value;
  one(field: string): void;
}

function settleT(r: CodedRecord, s: Settler): Obj {
  const { aligned, unaligned } = alignFindings(r);
  const findings: Obj[] = aligned.map(({ n, A, B }) => {
    const [cls, type, subtype] = String(s.pick(`findings[${n}].class_type_subtype`, triple(A), triple(B))).split("/");
    return {
      n, class: cls, type, subtype,
      quality_flag: s.pick(`findings[${n}].quality_flag`, A.quality_flag, B.quality_flag),
      multi_claim: s.pick(`findings[${n}].multi_claim`, A.multi_claim, B.multi_claim),
    };
  });
  for (const u of unaligned) {
    const f = (r[u.coder].findings as Obj[]).find((x) => Number(x.n) === u.n)!;
    s.one(`findings[${u.n}]`);
    findings.push({ n: u.n, class: f.class, type: f.type, subtype: f.subtype, quality_flag: f.quality_flag, multi_claim: f.multi_claim });
  }
  findings.sort((x, y) => Number(x.n) - Number(y.n));
  return { reproduction: s.pick("reproduction", r.A.reproduction, r.B.reproduction), no_codable_finding: findings.length === 0, findings };
}

function settleScores(r: CodedRecord, s: Settler, list: string, keys: string[], fieldOf: (e: Obj) => string, lowerIfUnadjudicated: boolean): Obj[] {
  const keyOf = (e: Obj) => keys.map((k) => String(e[k])).join("|");
  const byCoder = Object.fromEntries(CODERS.map((c) => [c, new Map(((r[c][list] as Obj[]) ?? []).map((e) => [keyOf(e), e]))])) as Record<Coder, Map<string, Obj>>;
  const all = [...new Set([...byCoder.A.keys(), ...byCoder.B.keys()])];
  return all.map((k) => {
    const a = byCoder.A.get(k), b = byCoder.B.get(k);
    const base = Object.fromEntries(keys.map((key) => [key, (a ?? b)![key]]));
    if (a && b) return { ...base, score: s.pick(fieldOf(a), a.score, b.score, lowerIfUnadjudicated) };
    s.one(fieldOf((a ?? b)!));
    return { ...base, score: Number((a ?? b)!.score) };
  });
}

const pairField = (e: Obj) => `pairs[finding=${e.finding},gold=${e.gold}].score`;
const feedbackField = (e: Obj) => `feedback[gold=${e.gold}].score`;

// collect.ts sends only the deciding M pairs to J, and no M feedback; a lower-scoring pair cannot change review_level.
function settleM(r: CodedRecord, s: Settler): Obj {
  return {
    no_codable_finding: s.pick("no_codable_finding", r.A.no_codable_finding, r.B.no_codable_finding),
    pairs: settleScores(r, s, "pairs", ["finding", "gold"], pairField, true),
    feedback: settleScores(r, s, "feedback", ["gold"], feedbackField, true),
  };
}

function settleC(r: CodedRecord, s: Settler): Obj {
  return {
    reality: s.pick("reality", r.A.reality, r.B.reality),
    ...Object.fromEntries(REASON_FLAGS.map((f) => [f, s.pick(f, r.A[f], r.B[f])])),
  };
}

function settleA(r: CodedRecord, s: Settler): Obj {
  return { concern: s.pick("concern", r.A.concern, r.B.concern), feedback: settleScores(r, s, "feedback", ["gold"], feedbackField, false) };
}

const SETTLERS: Record<Pass, (r: CodedRecord, s: Settler) => Obj> = { T: settleT, M: settleM, C: settleC, A: settleA };

function oneCoderFinal(pass: Pass, item: Obj): Obj {
  switch (pass) {
    case "T": {
      const findings = ((item.findings as Obj[]) ?? []).map((f) => ({ n: f.n, class: f.class, type: f.type, subtype: f.subtype, quality_flag: f.quality_flag, multi_claim: f.multi_claim }));
      return { reproduction: item.reproduction, no_codable_finding: findings.length === 0, findings };
    }
    case "M": {
      const scores = (list: string, keys: string[]) => ((item[list] as Obj[]) ?? []).map((e) => ({ ...Object.fromEntries(keys.map((k) => [k, e[k]])), score: Number(e.score) }));
      return { no_codable_finding: item.no_codable_finding === true, pairs: scores("pairs", ["finding", "gold"]), feedback: scores("feedback", ["gold"]) };
    }
    case "C": return { reality: item.reality, ...Object.fromEntries(REASON_FLAGS.map((f) => [f, item[f]])) };
    case "A": return { concern: item.concern, feedback: ((item.feedback as Obj[]) ?? []).map((e) => ({ gold: e.gold, score: Number(e.score) })) };
  }
}

export interface SettleResult { errors: string[]; records: SettledRecord[]; log: LogRow[] }

export function settle(records: CodeRecord[], loaded: LoadedVerdicts): SettleResult {
  const errors: string[] = [];
  const log: LogRow[] = [];
  const required = new Set<string>();
  for (const d of disagreements(records)) {
    if (DERIVED_FIELDS[d.pass]?.includes(d.field)) continue;
    const key = verdictKey(d.pass, d.item, d.field);
    required.add(key);
    if (!loaded.verdicts.has(key)) errors.push(`${d.pass} ${d.item} ${d.field}: ${loaded.errors.get(key) ?? "no J reply"}`);
  }
  if (errors.length) return { errors, records: [], log };

  const settled = records.map((r): SettledRecord => {
    const { A, B, derived: _derived, ...meta } = r;
    const sources: Record<string, Source> = {};
    let final: Obj;
    let coders: SettledRecord["coders"] = "both";
    if (A && B) {
      const coded = r as CodedRecord;
      final = SETTLERS[r.pass](coded, {
        pick(field, a, b, lowerIfUnadjudicated = false) {
          if (same(a, b)) return a as Value;
          const key = verdictKey(r.pass, r.item, field);
          const verdict = required.has(key) ? loaded.verdicts.get(key) : undefined;
          if (verdict) {
            sources[field] = verdict.basis;
            log.push({ pass: r.pass, item: r.item, field, code_a: a as Value, code_b: b as Value, final: verdict.final, basis: verdict.basis, rule_cited: verdict.rule_cited });
            return verdict.final;
          }
          if (lowerIfUnadjudicated) {
            sources[field] = "lower_unadjudicated";
            return Math.min(Number(a), Number(b));
          }
          errors.push(`${r.pass} ${r.item} ${field}: coders differ (${JSON.stringify(a)} vs ${JSON.stringify(b)}) and no rule settles it`);
          return null;
        },
        one(field) { sources[field] = "one_coder"; },
      });
    } else {
      coders = A ? "A" : "B";
      sources.item = "one_coder";
      final = oneCoderFinal(r.pass, (A ?? B)!);
    }
    const out: SettledRecord = { ...meta, coders, final, sources };
    if (r.pass === "M") out.derived = reviewLevel(final);
    return out;
  });
  return { errors, records: errors.length ? [] : settled, log };
}

export function goldSummary(gold: Record<string, { behaviours: { id: string }[]; contested?: string[]; dropped?: string[]; changed?: string[] }>): Record<string, GoldSummary> {
  return Object.fromEntries(Object.entries(gold).map(([key, g]) => {
    const [instance, agent] = [key.slice(0, key.indexOf(".")), key.slice(key.indexOf(".") + 1)];
    return [patchKey(instance, agent), { behaviours: g.behaviours.map((b) => b.id), contested: g.contested ?? [], dropped: g.dropped ?? [], changed: g.changed ?? [] }];
  }));
}

// Pass M and A coders saw only the settled gold, so every scored behaviour must be one of it.
export function goldErrors(records: SettledRecord[], gold: Record<string, GoldSummary>): string[] {
  const errors: string[] = [];
  for (const r of records.filter((x) => x.pass === "M" || x.pass === "A")) {
    const g = gold[patchKey(r.instance_id, r.agent_id)];
    if (!g) { errors.push(`${r.pass} ${r.item}: no settled gold for ${r.instance_id} ${r.agent_id}`); continue; }
    const scored = [...((r.final.pairs as Obj[]) ?? []), ...((r.final.feedback as Obj[]) ?? [])].map((e) => String(e.gold));
    for (const id of new Set(scored)) if (!g.behaviours.includes(id)) errors.push(`${r.pass} ${r.item}: gold ${id} is not a settled behaviour of ${r.instance_id} ${r.agent_id}`);
  }
  return errors;
}

export const LOG_COLUMNS = ["pass", "item", "field", "code_a", "code_b", "final", "basis", "rule_cited"];

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      codes: { type: "string" },
      j: { type: "string" },
      gold: { type: "string" },
      out: { type: "string" },
      log: { type: "string", default: join(FINDINGS, "artifact", "data", "adjudication-log.csv") },
    },
  });
  if (!values.codes || !values.j || !values.gold || !values.out) {
    console.error("usage: node settle.ts --codes <codes.json> --j <j-coders dir> --gold <gold-settled.json> --out <dir outside the repo> [--log data/adjudication-log.csv]");
    process.exit(2);
  }
  const checkout = insideCheckout(values.out);
  if (checkout) {
    console.error(`--out ${values.out} is inside the checkout ${checkout}; settled codes are private and must stay outside the repo`);
    process.exit(2);
  }
  const records = JSON.parse(readFileSync(values.codes, "utf8")) as CodeRecord[];
  const gold = goldSummary(JSON.parse(readFileSync(values.gold, "utf8")));
  const result = settle(records, loadVerdicts(values.j));
  const errors = [...result.errors, ...goldErrors(result.records, gold)];
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "settled.json"), JSON.stringify({ gold, records: result.records }, null, 1) + "\n");
  writeFileSync(values.log, toCsv(LOG_COLUMNS, result.log as unknown as Record<string, unknown>[]));
  const count = (s: Source) => result.records.reduce((n, r) => n + Object.values(r.sources).filter((x) => x === s).length, 0);
  console.log(`${result.records.length} items settled; ${result.log.length} adjudicated codes; ${count("one_coder")} one-coder codes; ${count("lower_unadjudicated")} unadjudicated lower scores`);
}
