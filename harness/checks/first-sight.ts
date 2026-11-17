import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const USAGE = "usage: node harness/checks/first-sight.ts <runsDir> <needlesJson>";

interface TranscriptEvent {
  kind: string;
  text: string;
}

function readEvents(path: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const content = JSON.parse(line).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_result") {
        events.push({ kind: "OUTPUT", text: typeof block.content === "string" ? block.content : JSON.stringify(block.content) });
      } else if (block.type === "thinking") {
        events.push({ kind: "THINKING", text: block.thinking ?? "" });
      } else if (block.type === "text") {
        events.push({ kind: "TEXT", text: block.text ?? "" });
      } else if (block.type === "tool_use") {
        events.push({ kind: "COMMAND", text: JSON.stringify(block.input) });
      }
    }
  }
  return events;
}

const [runsDir, needlesPath] = process.argv.slice(2);
if (!runsDir || !needlesPath) {
  console.error(USAGE);
  process.exit(2);
}

const needlesByInstance = JSON.parse(readFileSync(needlesPath, "utf8")) as Record<string, string[]>;

for (const name of readdirSync(runsDir).sort()) {
  const { instance_id: instanceId } = JSON.parse(readFileSync(join(runsDir, name, "run.json"), "utf8"));
  const events = readEvents(join(runsDir, name, "transcript.jsonl"));
  const hits: string[] = [];
  for (const needle of needlesByInstance[instanceId] ?? []) {
    const escaped = JSON.stringify(needle).slice(1, -1);
    const sequence = events
      .map((event, index) => (event.text.includes(needle) || event.text.includes(escaped) ? `${index}:${event.kind}` : ""))
      .filter(Boolean);
    if (sequence.length) hits.push(`  ${needle} -> ${sequence.join(" ")}`);
  }
  console.log(`${name} (${events.length} events)\n${hits.join("\n") || "  no needle"}`);
}
