import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunRecord } from "../run-review.ts";
import type { Sources } from "../sources.ts";
import type { Finding, VerdictValue } from "../transcript.ts";

export type LabelStratum = "swe_abs_wrong" | "swe_abs_correct";

export interface CompletedRun {
  run: string;
  record: RunRecord;
  sources: Sources;
}

export interface DiscrepancyRow {
  run: string;
  run_order: number | null;
  instance_id: string | null;
  label_stratum: string | null;
  effort: string | null;
  verdict: VerdictValue | null;
  discrepancy: boolean | null;
  audit_tier: null;
  audit_packet: string | null;
}

export interface AuditPacket {
  id: string;
  problem_statement: string;
  patch: string;
  verdict: VerdictValue;
  feedback: string | null;
  findings: Finding[] | null;
}

export interface ArmRollup {
  runs: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  wall_ms: number;
  effort_unverified: boolean;
}

const LABEL_VERDICT: Record<LabelStratum, VerdictValue> = {
  swe_abs_wrong: "fail",
  swe_abs_correct: "pass",
};

export function isDiscrepancy(stratum: LabelStratum, verdict: VerdictValue | null): boolean | null {
  return verdict === null ? null : verdict !== LABEL_VERDICT[stratum];
}

export function writeDiscrepancies(outDir: string, runs: CompletedRun[]): DiscrepancyRow[] {
  const packetsDir = join(outDir, "audit-packets");
  mkdirSync(packetsDir, { recursive: true });
  const rows = runs.map(({ run, record, sources }) => {
    const discrepancy = isDiscrepancy(record.label_stratum as LabelStratum, record.verdict);
    const packetId = discrepancy === true ? randomBytes(8).toString("hex") : null;
    if (packetId !== null) {
      const packet: AuditPacket = {
        id: packetId,
        problem_statement: sources.problemStatement,
        patch: sources.patch,
        verdict: record.verdict as VerdictValue,
        feedback: record.feedback,
        findings: record.findings,
      };
      writeFileSync(join(packetsDir, `${packetId}.json`), `${JSON.stringify(packet, null, 2)}\n`);
    }
    return {
      run,
      run_order: record.run_order ?? null,
      instance_id: record.instance_id,
      label_stratum: record.label_stratum ?? null,
      effort: record.effort,
      verdict: record.verdict,
      discrepancy,
      audit_tier: null,
      audit_packet: packetId,
    };
  });
  writeFileSync(join(outDir, "discrepancies.json"), `${JSON.stringify(rows, null, 2)}\n`);
  return rows;
}

export function rollUpArms(records: RunRecord[]): Record<string, ArmRollup> {
  const arms: Record<string, ArmRollup> = {};
  for (const record of records) {
    const arm = (arms[record.effort ?? "unknown"] ??= {
      runs: 0,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      wall_ms: 0,
      effort_unverified: false,
    });
    arm.runs += 1;
    arm.cost_usd += record.cost_usd ?? 0;
    arm.input_tokens += record.input_tokens ?? 0;
    arm.output_tokens += record.output_tokens ?? 0;
    arm.cache_read_tokens += record.cache_read_tokens ?? 0;
    arm.cache_write_tokens += record.cache_write_tokens ?? 0;
    arm.wall_ms += record.wall_ms ?? 0;
    arm.effort_unverified ||= record.effective_effort === null;
  }
  return arms;
}
