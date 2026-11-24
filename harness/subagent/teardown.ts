import { chmodSync, readFileSync, rmSync } from "node:fs";
import { parseArgs } from "node:util";

import { spawnCollect } from "../runners.ts";
import type { PlanEntry } from "./prepare.ts";

const USAGE = "usage: node harness/subagent/teardown.ts --plan <plan.json> --root <dir> [--remove-workspaces]";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { plan: { type: "string" }, root: { type: "string" }, "remove-workspaces": { type: "boolean", default: false } },
  });
  if (!values.plan || !values.root) {
    console.error(USAGE);
    process.exit(2);
  }
  const plan = JSON.parse(readFileSync(values.plan, "utf8")) as PlanEntry[];
  for (const entry of plan) {
    const removed = await spawnCollect("docker", ["rm", "-f", entry.container], { timeoutMs: 120_000 });
    if (removed.code !== 0) console.error(`${entry.container}: ${removed.stderr.trim()}`);
  }
  chmodSync(values.root, 0o755);
  if (values["remove-workspaces"]) rmSync(values.root, { recursive: true, force: true });
  console.error(`removed ${plan.length} containers${values["remove-workspaces"] ? " and the workspaces" : ""}`);
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
