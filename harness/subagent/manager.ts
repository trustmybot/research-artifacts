import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import type { PlanEntry } from "./prepare.ts";
import { Queue, type QueueItem } from "./queue.ts";

const USAGE = [
  "usage: node harness/subagent/manager.ts init --runs <dir> --patches <json> --models <a,b,...> --root <dir> [--max-in-flight <n>] [--low-water <n>]",
  "       node harness/subagent/manager.ts add --runs <dir> --patches <json> --models <a,b,...>",
  "       node harness/subagent/manager.ts run --runs <dir> --transcripts <agent-transcripts dir>",
  "       node harness/subagent/manager.ts prompt --runs <dir> --worker <name>",
].join("\n");
const REPO = join(import.meta.dirname, "..", "..");
const QUEUE_SCRIPT = join(import.meta.dirname, "queue.ts");
const MAX_ATTEMPTS = 10;
const STALE_MS = 2 * 3600_000;
const POLL_MS = 15_000;

type Entry = { instance_id: string; agent_id: string; image: string; image_digest: string; label_stratum: string };
interface Task {
  entry: Entry;
  models: string[];
}
interface Unit {
  name: string;
  plan: string;
  root: string;
  images: string[];
  status: "prepared" | "done";
}
export interface State {
  root: string;
  low_water: number;
  tasks: Task[];
  units: Unit[];
  seq: number;
  failed_prepares: Task[];
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const node = (args: string[]) => spawnSync("node", args, { cwd: REPO, encoding: "utf8" });
const imageOf = (entry: Entry) => `${entry.image}@${entry.image_digest}`;

export function workerPrompt(name: string, queueDir: string): string {
  const command = `node ${QUEUE_SCRIPT} --queue ${queueDir}`;
  return [
    `You run code reviews from a queue, one at a time, until the queue is empty. Your worker name is ${name}.`,
    "",
    "Repeat these steps:",
    `1. Run this shell command: ${command} claim ${name}`,
    "   - If it prints WAIT, run the shell command sleep 20, then go back to step 1. WAIT only means every review slot is busy or the next patch is still being prepared. Keep claiming until you get EMPTY, however many times you see WAIT; do not stop early and do not ask anyone.",
    "   - If it prints EMPTY, stop and reply with the number of reviews you launched.",
    "   - Otherwise it prints lines starting ID:, MODEL: and DESCRIPTION:, then a line PROMPT: followed by the prompt text on all remaining lines.",
    '2. Call CallDynamicTool with namespace "cursor", toolName "Task" and arguments {"description": the DESCRIPTION value, "subagent_type": "generalPurpose", "model": the MODEL value, "run_in_background": false, "prompt": the prompt text}. Copy the prompt text exactly, character for character, including its line breaks. Wait for the review to return.',
    `3. If the call returned the review's reply, run: ${command} done <ID> <verdict>, where <verdict> is pass or fail as the reply says, or other. If the call returned an error instead of a reply, even an error that includes an agent ID, run: ${command} fail <ID> and carry on; another process checks whether that launch ever started before the item is offered again.`,
    "4. Go back to step 1.",
    "",
    "Rules: launch exactly one review per claim, and only the one you claimed. Never use resume or interrupt, and never launch the same ID twice. Use no tools other than Shell and CallDynamicTool, and do not read, search or edit any file.",
  ].join("\n");
}

export function launchedWorkspaces(transcripts: string): Set<string> {
  const seen = new Set<string>();
  for (const parent of readdirSync(transcripts)) {
    const dir = join(transcripts, parent, "subagents");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const line = readFileSync(join(dir, name), "utf8").split("\n", 1)[0];
      const match = /Your task is in (\S+)\/review\/task\.md\./.exec(line);
      if (match) seen.add(match[1]);
    }
  }
  return seen;
}

class Manager {
  readonly runs: string;
  readonly queue: Queue;

  constructor(runs: string) {
    this.runs = resolve(runs);
    this.queue = new Queue(join(this.runs, "queue"));
  }

  private get statePath(): string {
    return join(this.runs, "state.json");
  }

  load(): State {
    return readJson<State>(this.statePath);
  }

  save(state: State): void {
    writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  log(line: string): void {
    appendFileSync(join(this.runs, "manager.log"), `${new Date().toISOString()} ${line}\n`);
  }

  static tasksFrom(patches: string, models: string): Task[] {
    const list = models.split(",").map((m) => m.trim()).filter(Boolean);
    return readJson<Entry[]>(patches).map((entry) => ({ entry, models: list }));
  }

  init(patches: string, models: string, root: string, maxInFlight: number, lowWater: number): void {
    if (existsSync(this.statePath)) throw new Error(`${this.statePath} exists; use add to extend a run`);
    mkdirSync(this.runs, { recursive: true });
    this.queue.ensure({ max_in_flight: maxInFlight });
    const state: State = { root: resolve(root), low_water: lowWater, tasks: Manager.tasksFrom(patches, models), units: [], seq: 1, failed_prepares: [] };
    this.save(state);
    this.log(`init: ${state.tasks.length} patches, max ${maxInFlight} reviews in flight`);
    console.log(`${state.tasks.length} patches to prepare in ${this.runs}`);
  }

  add(patches: string, models: string): void {
    const state = this.load();
    const tasks = Manager.tasksFrom(patches, models);
    state.tasks.push(...tasks);
    this.save(state);
    for (const marker of ["ALL_PREPARED", "FINISHED"] as const) rmSync(this.queue.marker(marker), { force: true });
    this.log(`add: ${tasks.length} patches`);
    console.log(`${tasks.length} patches added`);
  }

  private enqueue(state: State, unit: string, plan: PlanEntry[]): void {
    for (const e of plan) {
      const item: QueueItem = { seq: state.seq++, id: e.id, unit, model: e.model, description: `Review ${e.id} (${e.model})`, prompt: e.task_prompt, workspace: e.workspace };
      this.queue.add(item);
    }
  }

  private prepareNext(state: State): void {
    const task = state.tasks.shift()!;
    const name = `u${String(state.units.length + state.failed_prepares.length).padStart(3, "0")}`;
    const dir = join(this.runs, "units", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "patches.json"), `${JSON.stringify([task.entry], null, 2)}\n`);
    const result = node(["harness/subagent/prepare.ts", "--patches", join(dir, "patches.json"), "--models", task.models.join(","), "--root", join(state.root, name), "--out", join(dir, "plan.json")]);
    writeFileSync(join(dir, "prepare.log"), `${result.stdout}${result.stderr}`);
    const plan = existsSync(join(dir, "plan.json")) ? readJson<PlanEntry[]>(join(dir, "plan.json")) : [];
    if (result.status !== 0) {
      this.log(`prepare ${name} ${task.entry.instance_id} failed; removing ${plan.length} containers`);
      if (plan.length > 0) node(["harness/subagent/teardown.ts", "--plan", join(dir, "plan.json"), "--root", join(state.root, name), "--remove-workspaces"]);
      state.failed_prepares.push(task);
      return;
    }
    state.units.push({ name, plan: join(dir, "plan.json"), root: join(state.root, name), images: [imageOf(task.entry)], status: "prepared" });
    this.enqueue(state, name, plan);
    this.log(`prepared ${name} ${task.entry.instance_id}/${task.entry.agent_id} with ${plan.length} reviews`);
  }

  private closeUnit(state: State, unit: Unit): void {
    const plan = readJson<PlanEntry[]>(unit.plan);
    const dir = join(unit.plan, "..");
    const launched = Object.fromEntries(plan.map((e) => [e.id, this.queue.read("done", this.queue.find("done", e.id)!).claimed_at]));
    writeFileSync(join(dir, "launched.json"), `${JSON.stringify(launched, null, 2)}\n`);
    const collected = node(["harness/subagent/collect.ts", "--plan", unit.plan, "--launched", join(dir, "launched.json"), "--out", join(dir, "collected")]);
    writeFileSync(join(dir, "collect.log"), `${collected.stdout}${collected.stderr}`);
    node(["harness/subagent/teardown.ts", "--plan", unit.plan, "--root", unit.root, "--remove-workspaces"]);
    unit.status = "done";
    const needed = new Set([...state.tasks.map((t) => imageOf(t.entry)), ...state.units.filter((u) => u.status === "prepared").flatMap((u) => u.images)]);
    for (const image of unit.images) if (!needed.has(image)) spawnSync("docker", ["image", "rm", image]);
    this.log(`closed ${unit.name}: collect exit ${collected.status}`);
  }

  // A launch refused at Cursor's subagent limit can still hand back an agent id; only an item with no transcript is offered again.
  private recover(transcripts: string): void {
    const launched = launchedWorkspaces(transcripts);
    for (const name of this.queue.list("failed")) {
      const item = this.queue.read("failed", name);
      if (launched.has(item.workspace)) {
        this.log(`failed item ${item.id} has a transcript; left in failed for review`);
        continue;
      }
      if ((item.attempts ?? 0) >= MAX_ATTEMPTS) continue;
      this.queue.move("failed", "ready", name);
      this.log(`requeued ${item.id} (${item.model}), never launched`);
    }
    for (const name of this.queue.list("claimed")) {
      const item = this.queue.read("claimed", name);
      if (Date.now() - Date.parse(item.claimed_at ?? new Date().toISOString()) < STALE_MS) continue;
      const final = join(item.workspace, "review", "final.md");
      if (existsSync(final)) {
        this.queue.move("claimed", "done", name, { done_at: new Date(statSync(final).mtimeMs).toISOString(), reply: "stale claim; final.md present" });
        this.log(`stale claim ${item.id} closed from final.md`);
      } else if (!launched.has(item.workspace)) {
        this.queue.move("claimed", "ready", name);
        this.log(`stale claim ${item.id} requeued, never launched`);
      }
    }
  }

  async run(transcripts: string): Promise<void> {
    this.log("manager started");
    for (;;) {
      const state = this.load();
      this.recover(transcripts);
      if (this.queue.list("ready").length < state.low_water && state.tasks.length > 0) this.prepareNext(state);
      const done = new Set(this.queue.list("done").map((name) => name.slice(6, -5)));
      for (const unit of state.units.filter((u) => u.status === "prepared")) {
        if (readJson<PlanEntry[]>(unit.plan).every((e) => done.has(e.id))) this.closeUnit(state, unit);
      }
      if (state.tasks.length === 0 && !existsSync(this.queue.marker("ALL_PREPARED"))) {
        writeFileSync(this.queue.marker("ALL_PREPARED"), "");
        this.log("all patches prepared");
      }
      this.save(state);
      if (state.tasks.length === 0 && state.units.every((u) => u.status === "done")) {
        writeFileSync(this.queue.marker("FINISHED"), "");
        this.log(`finished; ${state.failed_prepares.length} patches failed to prepare`);
        return;
      }
      await sleep(POLL_MS);
    }
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    options: {
      runs: { type: "string" }, patches: { type: "string" }, models: { type: "string" }, root: { type: "string" },
      transcripts: { type: "string" }, worker: { type: "string" }, "max-in-flight": { type: "string" }, "low-water": { type: "string" },
    },
    allowPositionals: true,
  });
  const [command] = positionals;
  const refuse = () => {
    console.error(USAGE);
    process.exit(2);
  };
  if (!values.runs) refuse();
  const manager = new Manager(values.runs!);
  try {
    if (command === "init" && values.patches && values.models && values.root) {
      manager.init(values.patches, values.models, values.root, Number(values["max-in-flight"] ?? 15), Number(values["low-water"] ?? 22));
    } else if (command === "add" && values.patches && values.models) {
      manager.add(values.patches, values.models);
    } else if (command === "run" && values.transcripts) {
      await manager.run(values.transcripts);
    } else if (command === "prompt" && values.worker) {
      console.log(workerPrompt(values.worker, manager.queue.dir));
    } else refuse();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
