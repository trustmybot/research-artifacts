import { readFileSync } from "node:fs";

import { loadSources, type Instance } from "../sources.ts";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node harness/subagent/fetch-patches.ts <patches.json>...");
  process.exit(2);
}

const seen = new Set<string>();
let failed = 0;
for (const file of files) {
  for (const entry of JSON.parse(readFileSync(file, "utf8")) as Instance[]) {
    const key = `${entry.instance_id}/${entry.agent_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await loadSources(entry);
      console.log(`ok   ${key}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${key}: ${(error as Error).message}`);
    }
  }
}
console.log(`${seen.size - failed} of ${seen.size} patches cached in runs/cache with matching sha256`);
process.exit(failed === 0 ? 0 : 1);
