import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const FINDINGS = resolve(import.meta.dirname, "..", "..");
export const PAPER = resolve(FINDINGS, "..");
export const REPO = resolve(PAPER, "..", "..");
export const PROMPTS = join(FINDINGS, "prompts");
export const LABEL_CHECK_BATCH = "20261102t124549z-5e7b1da";

export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
export const patchKey = (instanceId: string, agentId: string) => `${instanceId}|${agentId}`;

export function promptBlock(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const at = lines.indexOf(`## ${heading}`);
  if (at < 0) throw new Error(`no section "## ${heading}"`);
  const open = lines.findIndex((l, i) => i > at && /^`{3,}text\s*$/.test(l));
  if (open < 0) throw new Error(`no text block under "## ${heading}"`);
  const fence = lines[open].match(/^`+/)![0];
  const close = lines.findIndex((l, i) => i > open && l === fence);
  if (close < 0) throw new Error(`unterminated text block under "## ${heading}"`);
  return lines.slice(open + 1, close).join("\n");
}

// One pass over the template, so slot values that contain {{...}} (Django templates do) are never filled in turn.
export function fillSlots(template: string, slots: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!Object.hasOwn(slots, name)) throw new Error(`slot {{${name}}} has no value`);
    return slots[name];
  });
}

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], rand: () => number): T[] {
  return items.map((item) => [rand(), item] as const).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
}

export interface MainPatchPin {
  instance_id: string;
  agent_id: string;
  patch_sha256: string;
  gold_patch_sha256: string;
  problem_statement_sha256: string;
}

export function readMainPatches(path: string): Map<string, MainPatchPin> {
  const pins = JSON.parse(readFileSync(path, "utf8")) as MainPatchPin[];
  return new Map(pins.map((p) => [patchKey(p.instance_id, p.agent_id), p]));
}

export interface OfficialRow { problem_statement: string; patch: string }

export function officialRow(runs: string, pin: MainPatchPin): OfficialRow {
  const path = join(runs, "cache", pin.instance_id, "dataset-row.json");
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  const row = JSON.parse(readFileSync(path, "utf8")) as OfficialRow;
  if (sha256(row.patch) !== pin.gold_patch_sha256) throw new Error(`hash pin failed for the official fix in ${path}`);
  if (sha256(row.problem_statement) !== pin.problem_statement_sha256) throw new Error(`hash pin failed for the issue text in ${path}`);
  return row;
}

export function candidatePatch(runs: string, instanceId: string, agentId: string, expectedSha: string): string {
  const path = join(runs, "cache", instanceId, `${agentId}.diff`);
  if (!existsSync(path)) throw new Error(`missing patch ${path}`);
  const diff = readFileSync(path);
  if (sha256(diff) !== expectedSha) throw new Error(`hash pin failed for ${path}`);
  return diff.toString("utf8");
}
