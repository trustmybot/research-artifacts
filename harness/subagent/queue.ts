import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const USAGE = "usage: node harness/subagent/queue.ts [--queue <dir>] claim <worker> | done <id> <reply> | fail <id> [error]";
export const DEFAULT_QUEUE = join(import.meta.dirname, "..", "..", "runs", "subagent", "queue");
export const QUEUE_DIRS = ["ready", "claimed", "done", "failed"] as const;
export type QueueDir = (typeof QUEUE_DIRS)[number];

export interface QueueItem {
  seq: number;
  id: string;
  unit: string;
  model: string;
  description: string;
  prompt: string;
  workspace: string;
  attempts?: number;
  worker?: string;
  claimed_at?: string;
  done_at?: string;
  failed_at?: string;
  reply?: string;
}

export interface QueueConfig {
  max_in_flight: number;
  claim_wait_ms: number;
}

// Cursor runs at most 32 local subagents, nested ones included, so workers plus reviews must stay under it.
// A claim waits under the Shell tool's default 30 s, so a worker's call returns before the tool backgrounds it.
export const DEFAULT_CONFIG: QueueConfig = { max_in_flight: 15, claim_wait_ms: 25_000 };

export class Queue {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  ensure(config?: Partial<QueueConfig>): void {
    for (const d of QUEUE_DIRS) mkdirSync(join(this.dir, d), { recursive: true });
    if (config) writeFileSync(join(this.dir, "config.json"), `${JSON.stringify({ ...DEFAULT_CONFIG, ...config }, null, 2)}\n`);
  }

  config(): QueueConfig {
    const path = join(this.dir, "config.json");
    return existsSync(path) ? { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<QueueConfig>) } : DEFAULT_CONFIG;
  }

  marker(name: "ALL_PREPARED" | "FINISHED"): string {
    return join(this.dir, name);
  }

  file(d: QueueDir, item: Pick<QueueItem, "seq" | "id">): string {
    return join(this.dir, d, `${String(item.seq).padStart(5, "0")}-${item.id}.json`);
  }

  list(d: QueueDir): string[] {
    return readdirSync(join(this.dir, d)).filter((name) => name.endsWith(".json")).sort();
  }

  read(d: QueueDir, name: string): QueueItem {
    return JSON.parse(readFileSync(join(this.dir, d, name), "utf8")) as QueueItem;
  }

  find(d: QueueDir, id: string): string | null {
    return this.list(d).find((name) => name.endsWith(`-${id}.json`)) ?? null;
  }

  add(item: QueueItem): void {
    writeFileSync(this.file("ready", item), `${JSON.stringify(item, null, 2)}\n`);
  }

  move(from: QueueDir, to: QueueDir, name: string, update: Partial<QueueItem> = {}): QueueItem {
    const target = join(this.dir, to, name);
    renameSync(join(this.dir, from, name), target);
    const item = { ...(JSON.parse(readFileSync(target, "utf8")) as QueueItem), ...update };
    writeFileSync(target, `${JSON.stringify(item, null, 2)}\n`);
    return item;
  }

  // The rename is atomic, so two workers never claim the same item.
  async claim(worker: string): Promise<string> {
    const { max_in_flight, claim_wait_ms } = this.config();
    const deadline = Date.now() + claim_wait_ms;
    while (Date.now() < deadline && (this.list("claimed").length >= max_in_flight || this.list("ready").length === 0)) {
      if (this.list("ready").length === 0 && existsSync(this.marker("ALL_PREPARED"))) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (this.list("claimed").length >= max_in_flight) return "WAIT";
    for (const name of this.list("ready")) {
      try {
        renameSync(join(this.dir, "ready", name), join(this.dir, "claimed", name));
      } catch {
        continue;
      }
      const path = join(this.dir, "claimed", name);
      const item = JSON.parse(readFileSync(path, "utf8")) as QueueItem;
      writeFileSync(path, `${JSON.stringify({ ...item, worker, claimed_at: new Date().toISOString(), attempts: (item.attempts ?? 0) + 1 }, null, 2)}\n`);
      return `ID: ${item.id}\nMODEL: ${item.model}\nDESCRIPTION: ${item.description}\nPROMPT:\n${item.prompt}`;
    }
    return existsSync(this.marker("ALL_PREPARED")) ? "EMPTY" : "WAIT";
  }

  finish(id: string, to: "done" | "failed", reply: string): void {
    const name = this.find("claimed", id);
    if (name === null) throw new Error(`no claimed item ${id}`);
    const now = new Date().toISOString();
    this.move("claimed", to, name, to === "done" ? { done_at: now, reply } : { failed_at: now, reply });
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ options: { queue: { type: "string" } }, allowPositionals: true });
  const queue = new Queue(values.queue ?? DEFAULT_QUEUE);
  const [command, arg, ...rest] = positionals;
  if (!["claim", "done", "fail"].includes(command) || !arg) {
    console.error(USAGE);
    process.exit(2);
  }
  queue.ensure();
  try {
    if (command === "claim") console.log(await queue.claim(arg));
    else {
      queue.finish(arg, command === "done" ? "done" : "failed", rest.join(" "));
      console.log(`${command} ${arg}`);
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
