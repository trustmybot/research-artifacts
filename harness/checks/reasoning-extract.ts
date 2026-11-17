import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const USAGE = "usage: node harness/checks/reasoning-extract.ts <runDir> <outDir>";
const MEMORY_TERMS =
  /\b(upstream|actual (django )?fix|real (django )?fix|official fix|i recall|i remember|recall|remember|from memory|as i know|known fix|django('s)? (actual|real)|merged|ticket|#\d{4,6}|commit [0-9a-f]{7,}|later versions?|newer versions?|in django \d)/i;
const SENTENCE_BREAK = /(?<=[.!?\n])\s+/;
const TOOL_EXCERPT_CHARS = 1500;
const HIT_EXCERPT_CHARS = 400;

function memoryHits(label: string, text: string): string[] {
  return text
    .split(SENTENCE_BREAK)
    .filter((part) => MEMORY_TERMS.test(part))
    .map((part) => `[${label}] ${part.trim()}`);
}

function extractRun(runDir: string, outDir: string, name: string): Record<string, unknown> {
  const lines = readFileSync(join(runDir, "runs", name, "transcript.jsonl"), "utf8").split("\n").filter(Boolean);
  const out: string[] = [];
  const hits: string[] = [];
  let toolCalls = 0;
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.type === "result") {
      const result = String(event.result ?? "");
      out.push(`\n=== RESULT ===\n${result}`);
      hits.push(...memoryHits("result", result));
      continue;
    }
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "thinking") {
        out.push(`\n--- THINKING ---\n${block.thinking}`);
        hits.push(...memoryHits("thinking", String(block.thinking)));
      } else if (block.type === "text" && event.type === "assistant") {
        out.push(`\n--- TEXT ---\n${block.text}`);
        hits.push(...memoryHits("text", String(block.text)));
      } else if (block.type === "tool_use") {
        toolCalls += 1;
        out.push(`\n--- TOOL ${block.name} ---\n${JSON.stringify(block.input).slice(0, TOOL_EXCERPT_CHARS)}`);
      } else if (block.type === "tool_result") {
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        out.push(`\n--- TOOL RESULT ---\n${text.slice(0, TOOL_EXCERPT_CHARS)}`);
      }
    }
  }
  const record = JSON.parse(readFileSync(join(runDir, "runs", name, "run.json"), "utf8"));
  writeFileSync(join(outDir, `${name}.txt`), out.join("\n"));
  console.log(`\n##### ${name} verdict=${record.verdict} tools=${toolCalls} memory-term hits=${hits.length}`);
  for (const hit of hits) console.log(`  ${hit.slice(0, HIT_EXCERPT_CHARS)}`);
  return { name, verdict: record.verdict, toolCalls, thinkingBlocks: record.thinking_blocks, hits: hits.length };
}

const [runDir, outDir] = process.argv.slice(2);
if (!runDir || !outDir) {
  console.error(USAGE);
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
console.table(readdirSync(join(runDir, "runs")).sort().map((name) => extractRun(runDir, outDir, name)));
