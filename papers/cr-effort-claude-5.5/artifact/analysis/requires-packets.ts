import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function excerpt(log: string, test: string): string {
  const lines = log.split("\n");
  const start = lines.findIndex((l) => /^(FAIL|ERROR):/.test(l) && l.includes(test.split(" ")[0]));
  if (start < 0) return "  (no traceback found)";
  const block: string[] = [];
  for (let i = start + 1; i < lines.length && !/^(=====|-----)/.test(lines[i]) || i === start + 2; i++) if (i > start) block.push(lines[i]);
  const end = lines.slice(start + 2).findIndex((l) => /^(=====|-----)/.test(l));
  const trace = lines.slice(start + 2, end < 0 ? start + 40 : start + 2 + end);
  const doc = lines[start + 1] && !/^-----/.test(lines[start + 1]) ? lines[start + 1].trim() : "";
  const frameIdx = trace.findIndex((l) => l.includes("/testbed/tests/"));
  const frame = frameIdx >= 0 ? `${trace[frameIdx].trim()} :: ${(trace[frameIdx + 1] ?? "").trim()}` : "";
  const final = trace.filter((l) => l.trim()).slice(-3).map((l) => l.trim()).join(" | ");
  return [doc && `  doc: ${doc}`, frame && `  at: ${frame}`, `  err: ${final.slice(0, 500)}`].filter(Boolean).join("\n");
}

if (import.meta.main) {
  const [checksDir, cacheDir, patchesPath] = process.argv.slice(2);
  const verdicts = JSON.parse(readFileSync(join(checksDir, "label-check.json"), "utf8")).verdicts as any[];
  const patches = (JSON.parse(readFileSync(patchesPath, "utf8")) as any[]).filter((p) => p.label_stratum === "swe_abs_wrong");
  const logs = readdirSync(join(checksDir, "logs"));

  patches.sort((a, b) => a.draw_position - b.draw_position).forEach((p, idx) => {
    const v = verdicts.find((x) => x.instance_id === p.instance_id && x.agent_id === p.agent_id);
    const row = JSON.parse(readFileSync(join(cacheDir, p.instance_id, "dataset-row.json"), "utf8"));
    const issue = String(row.problem_statement).replace(/\s+/g, " ").trim();
    console.log(`### W${String(idx + 1).padStart(2, "0")} ${p.instance_id} ${p.agent_id}`);
    console.log(`ISSUE (${issue.length} chars): ${issue.slice(0, 1400)}${issue.length > 1400 ? " [...]" : ""}`);
    const failing: string[] = v?.abs_failing_tests?.[0] ?? [];
    console.log(`FAILING (run1): ${failing.length}; official fix fails: ${JSON.stringify(v?.official_abs_failing_tests ?? [])}`);
    const logName = logs.find((l) => l.startsWith(`${p.instance_id}.${p.agent_id}.candidate.abs.1`));
    const log = logName ? readFileSync(join(checksDir, "logs", logName), "utf8") : "";
    for (const test of failing.slice(0, 3)) console.log(`- ${test}\n${excerpt(log, test)}`);
    if (!failing.length && log) console.log(`  log tail: ${log.trim().split("\n").slice(-4).join(" | ").slice(0, 400)}`);
    console.log();
  });
}
