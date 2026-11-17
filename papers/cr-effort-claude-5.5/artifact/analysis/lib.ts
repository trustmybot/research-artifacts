import { readFileSync } from "node:fs";

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
export const TRUE_SUCCESS_WRONG_SHARES = [0.167, 0.5];
export const LABEL_ERROR_RATES = [0, 0.05, 0.1, 0.2];

interface Count { k: number; n: number; }
export interface ArmOutcome { total_cost: number; false_success: Count; false_alarm: Count; }

export function effortStep(from: ArmOutcome, to: ArmOutcome) {
  const extraCost = to.total_cost - from.total_cost;
  const extraCaught = from.false_success.k - to.false_success.k;
  return { extraCost, extraCaught, extraFalseAlarms: to.false_alarm.k - from.false_alarm.k, usdPerExtraCaught: extraCaught > 0 ? extraCost / extraCaught : null };
}

// Share of accepted patches that are correct when a fraction wrongShare of incoming patches is wrong.
export function trueSuccess(arm: ArmOutcome, wrongShare: number) {
  const fs = arm.false_success.k / arm.false_success.n, ta = 1 - arm.false_alarm.k / arm.false_alarm.n;
  return ((1 - wrongShare) * ta) / ((1 - wrongShare) * ta + wrongShare * fs);
}

// False success corrected for a fraction labelError of "wrong" labels that are in fact correct patches.
export function labelErrorCorrectedFalseSuccess(arm: ArmOutcome, labelError: number) {
  const observed = arm.false_success.k / arm.false_success.n, acceptCorrect = 1 - arm.false_alarm.k / arm.false_alarm.n;
  return (observed - labelError * acceptCorrect) / (1 - labelError);
}
