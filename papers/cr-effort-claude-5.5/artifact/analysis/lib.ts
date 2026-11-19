import { readFileSync } from "node:fs";
import { confusionOf, f1AndMccBootstrap, type Classified } from "./stats.ts";

export type Row = Record<string, string>;

export function parseCsv(text: string): Row[] {
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

export const readCsv = (path: string): Row[] => parseCsv(readFileSync(path, "utf8"));

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "number" ? String(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const toCsv = (columns: string[], rows: Record<string, unknown>[]): string =>
  [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";

export function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

export type Label = "wrong" | "correct";
export interface PatchLabel { label: Label; original_label: Label; rule: string; overlay: string; }
const isLabel = (x: string): x is Label => x === "wrong" || x === "correct";

export function readLabels(path: string, rows: Row[], sets: string[] = ["main"]): Map<string, PatchLabel> {
  const byKey = new Map<string, PatchLabel>();
  for (const r of readCsv(path).filter((x) => sets.includes(x.set))) {
    const key = `${r.instance_id}|${r.agent_id}`;
    if (byKey.has(key)) throw new Error(`duplicate ${sets.join(" or ")} label for ${key}`);
    if (!isLabel(r.label) || !isLabel(r.original_label)) throw new Error(`label for ${key} is not wrong or correct`);
    byKey.set(key, { label: r.label, original_label: r.original_label, rule: r.rule, overlay: r.overlay });
  }
  for (const r of rows) {
    const key = `${r.instance_id}|${r.agent_id}`;
    const l = byKey.get(key);
    if (!l) throw new Error(`no ${sets.join(" or ")} label in ${path} for ${key}`);
    if (l.original_label !== r.label) throw new Error(`original_label ${l.original_label} in ${path} for ${key} differs from the raw label ${r.label}`);
  }
  return byKey;
}

export function labelChanges(path: string) {
  const all = readCsv(path);
  return Object.fromEntries([...new Set(all.map((r) => r.set))].map((set) => {
    const rows = all.filter((r) => r.set === set);
    const changed = rows.filter((r) => r.label !== r.original_label);
    return [set, {
      patches: rows.length,
      unchanged: rows.length - changed.length,
      changes: countBy(changed, (r) => `${r.original_label}_to_${r.label}|${r.rule}`),
      overlays: countBy(rows.filter((r) => r.overlay), (r) => r.overlay),
    }];
  }));
}

export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
};

export const EFFORT_STEPS = [["low", "medium"], ["medium", "high"], ["low", "high"]] as const;
export const NPV_WRONG_SHARES = [0.167, 0.5];
export const LABEL_ERROR_RATES = [0, 0.05, 0.1, 0.2];

interface Count { k: number; n: number; }
export interface ArmOutcome { total_cost: number; miss_rate: Count; false_alarm_rate: Count; }

export function effortStep(from: ArmOutcome, to: ArmOutcome) {
  const extraCost = to.total_cost - from.total_cost;
  const extraCaught = from.miss_rate.k - to.miss_rate.k;
  return { extraCost, extraCaught, extraFalseAlarms: to.false_alarm_rate.k - from.false_alarm_rate.k, usdPerExtraCaught: extraCaught > 0 ? extraCost / extraCaught : null };
}

// Share of accepted patches that are correct when a fraction wrongShare of incoming patches is wrong.
export function negativePredictiveValue(arm: ArmOutcome, wrongShare: number) {
  const miss = arm.miss_rate.k / arm.miss_rate.n, ta = 1 - arm.false_alarm_rate.k / arm.false_alarm_rate.n;
  return ((1 - wrongShare) * ta) / ((1 - wrongShare) * ta + wrongShare * miss);
}

// Miss rate corrected for a fraction labelError of "wrong" labels that are in fact correct patches.
export function labelErrorCorrectedMissRate(arm: ArmOutcome, labelError: number) {
  const observed = arm.miss_rate.k / arm.miss_rate.n, acceptCorrect = 1 - arm.false_alarm_rate.k / arm.false_alarm_rate.n;
  return (observed - labelError * acceptCorrect) / (1 - labelError);
}

// A wrong patch is the positive class and a rejection the flag: TP wrong rejected, FN wrong accepted, FP correct rejected, TN correct accepted.
export function reviewerScores(cases: Classified[], resamples: number, seed: number) {
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const confusion = confusionOf(cases);
  const { tp, fn, fp, tn } = confusion;
  const { f1, mcc } = f1AndMccBootstrap(cases, resamples, seed);
  return {
    confusion,
    precision: r3(tp / (tp + fp)),
    recall: r3(tp / (tp + fn)),
    accuracy: r3((tp + tn) / cases.length),
    f1: { value: r3(f1.value), ci: [r3(f1.lower), r3(f1.upper)] },
    mcc: { value: r3(mcc.value), ci: [r3(mcc.lower), r3(mcc.upper)] },
  };
}

export const AUTHOR_FAMILIES = ["claude_named", "other_named", "unnamed"] as const;
export type AuthorFamily = (typeof AUTHOR_FAMILIES)[number];
const OTHER_MODEL_FAMILY = /gpt|gemini|kimi|doubao|qwen|deepseek|llama|glm/i;

export const authorFamily = (agentId: string): AuthorFamily =>
  /claude/i.test(agentId) ? "claude_named" : OTHER_MODEL_FAMILY.test(agentId) ? "other_named" : "unnamed";
