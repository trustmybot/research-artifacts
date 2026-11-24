import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const USAGE = "usage: node harness/subagent/integrity.ts --transcripts <agent-transcripts dir> --root <workspace root>";
const OWN = /Your task is in (\S+)\/review\/task\.md\./;

export interface TranscriptRecord {
  file: string;
  own: string | null;
  users: number;
  touched: string[];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export function scan(transcripts: string, root: string): TranscriptRecord[] {
  // prepare.ts puts workspaces at <root>/<id>, manager.ts at <root>/<unit>/<id>.
  const workspacePath = new RegExp(`${escape(root)}(?:\\/[\\w-]+)?\\/[0-9a-f]{8}(?![0-9a-f])`, "g");
  const records: TranscriptRecord[] = [];
  for (const parent of readdirSync(transcripts)) {
    const dir = join(transcripts, parent, "subagents");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      const lines = readFileSync(file, "utf8").trim().split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, any>];
        } catch {
          return [];
        }
      });
      const userTexts = lines.filter((l) => l.role === "user").map((l) => ((l.message?.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n"));
      const own = OWN.exec(userTexts[0] ?? "")?.[1] ?? null;
      const toolInputs = lines
        .filter((l) => l.role === "assistant")
        .flatMap((l) => (l.message?.content ?? []) as Array<Record<string, any>>)
        .filter((b) => b.type === "tool_use" && !(b.name === "CallDynamicTool" && b.input?.toolName === "Task"))
        .map((b) => JSON.stringify(b.input ?? {}));
      const touched = [...new Set(toolInputs.join("\n").match(workspacePath) ?? [])];
      if (own === null && touched.length === 0) continue;
      records.push({ file, own, users: userTexts.length, touched });
    }
  }
  return records;
}

export function problems(records: TranscriptRecord[]): string[] {
  const out: string[] = [];
  const perWorkspace = new Map<string, number>();
  for (const r of records) if (r.own) perWorkspace.set(r.own, (perWorkspace.get(r.own) ?? 0) + 1);
  for (const [ws, n] of perWorkspace) if (n > 1) out.push(`${ws}: ${n} review transcripts`);
  for (const r of records) {
    const id = r.file.split("/").slice(-3).join("/");
    if (r.own && r.users > 1) out.push(`${r.own}: ${r.users} user messages in ${id}`);
    // Workspace ids are random and unique, so a mistyped path to a reviewer's own id is still its own workspace.
    const foreign = r.touched.filter((ws) => ws.split("/").at(-1) !== r.own?.split("/").at(-1));
    if (foreign.length > 0) out.push(`${r.own ?? "no review prompt"} (${id}) touched ${foreign.join(", ")}`);
  }
  return out;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { transcripts: { type: "string" }, root: { type: "string" } } });
  if (!values.transcripts || !values.root) {
    console.error(USAGE);
    process.exit(2);
  }
  const records = scan(values.transcripts, values.root);
  const found = problems(records);
  console.log(`${records.filter((r) => r.own).length} review transcripts, ${records.filter((r) => !r.own).length} other transcripts touching workspaces, ${found.length} problems`);
  for (const p of found) console.log(`  ${p}`);
  process.exit(found.length === 0 ? 0 : 1);
}
