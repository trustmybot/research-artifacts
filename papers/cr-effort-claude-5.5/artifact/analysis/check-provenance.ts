import { join } from "node:path";
import { countBy, readCsv, sum } from "./lib.ts";

const dir = process.argv[2];
const results = readCsv(join(dir, "results.csv"));
const main = results.filter((r) => r.study_part === "main");
const short = (s: string) => s.slice(0, 12);
console.log("main rows", main.length, "repeat rows", results.length - main.length);
console.log("prompt", countBy(main, (r) => short(r.prompt_sha256)));
console.log("environment", countBy(main, (r) => short(r.environment_sha256)));
console.log("origin", countBy(main, (r) => `${r.harness_commit}/${r.origin_vm_type}`));
console.log("stop", countBy(main, (r) => r.stop_reason));
console.log("verdict", countBy(main, (r) => r.verdict));
console.log("cli/model", countBy(main, (r) => `${r.cli_version}/${r.model}`));
console.log("effective", countBy(main, (r) => `${r.effort}->${r.effective_effort}`));
console.log("arm/label", countBy(main, (r) => `${r.effort}/${r.label}`));
console.log("patches", new Set(main.map((r) => `${r.instance_id}|${r.agent_id}`)).size, "instances", new Set(main.map((r) => r.instance_id)).size);
console.log("main cost", sum(main.map((r) => +r.cost_usd)).toFixed(4));
const repeat = results.filter((r) => r.study_part === "repeat");
console.log("repeat cost", sum(repeat.map((r) => +r.cost_usd)).toFixed(4), countBy(repeat, (r) => `${r.prompt_sha256 === main[0].prompt_sha256}/${r.cli_version}/${r.label}`));

const attempts = readCsv(join(dir, "attempts.csv"));
const dropped = attempts.filter((a) => a.kept_in_results === "false");
console.log("attempts", attempts.length, "not kept", dropped.length, sum(dropped.map((a) => +a.cost_usd)).toFixed(4));
console.log(countBy(dropped, (a) => `${a.stop_reason}|${a.api_error_status}|${a.effort}`));
console.log(dropped.filter((a) => +a.cost_usd > 0).map((a) => `${a.batch_run_id} ${a.run} ${a.cost_usd}`));

const ledger = readCsv(join(dir, "spend-ledger.csv"));
const byBatch: Record<string, number> = {};
for (const l of ledger) byBatch[l.batch_run_id] = (byBatch[l.batch_run_id] ?? 0) + +l.cost_usd;
console.log(Object.fromEntries(Object.entries(byBatch).map(([k, v]) => [k, +v.toFixed(4)])));
console.log("ledger total", sum(Object.values(byBatch)).toFixed(4));
