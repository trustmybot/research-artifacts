import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { decode } from "@toon-format/toon";

import { fillBriefSlot } from "../brief.ts";
import { auditOne, hostSide } from "../subagent/audit.ts";
import { problems, scan } from "../subagent/integrity.ts";
import { launchedWorkspaces, workerPrompt } from "../subagent/manager.ts";
import { cloneArgs, environmentFile, taskBrief, tbScript, wrapperPrompt, type PlanEntry } from "../subagent/prepare.ts";
import { Queue, type QueueItem } from "../subagent/queue.ts";

const PROMPT = readFileSync(new URL("../review-prompt.md", import.meta.url), "utf8");
const PAPER_ENVIRONMENT = readFileSync(new URL("../environments/django.txt", import.meta.url), "utf8");
const FORBIDDEN_TERMS = /swe.?abs|swe.?bench|django__|sweagent|false success/i;
const WORKSPACE = "/private/tmp/crx/0a1b2c3d";
const scratch: string[] = [];

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagent-test-"));
  scratch.push(dir);
  return dir;
}

const entry: PlanEntry = {
  id: "0a1b2c3d",
  model: "test-model",
  instance_id: "django__django-1",
  agent_id: "agent",
  label_stratum: "swe_abs_wrong",
  workspace: WORKSPACE,
  container: "crx-0a1b2c3d",
  image: "image@sha256:0",
  commit_sha: "f".repeat(40),
  prompt_sha256: "",
  environment_sha256: "",
  log: "/private/tmp/crx/logs/0a1b2c3d.tsv",
  task_prompt: "",
  prepared_at: "",
};

function transcript(uses: Array<{ name: string; input: Record<string, unknown> }>): string {
  const file = join(tempDir(), "agent.jsonl");
  const lines = [
    { role: "user", message: { content: [{ type: "text", text: `Your task is in ${WORKSPACE}/review/task.md.` }] } },
    { role: "assistant", message: { content: uses.map((use) => ({ type: "tool_use", ...use })) } },
    { type: "turn_ended", status: "success" },
  ];
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
  return file;
}

describe("taskBrief", () => {
  test("fills the approved prompt with the control keys and the host checkout as repo_path", () => {
    const brief = taskBrief("abc123", WORKSPACE, "Fix the validator\n");
    assert.deepEqual(brief, {
      commit_sha: "abc123",
      repo_path: `${WORKSPACE}/testbed`,
      environment_path: `${WORKSPACE}/review/environment.txt`,
      spec: "Fix the validator\n",
    });
    const slot = /<task>\n([\s\S]*)\n<\/task>/.exec(fillBriefSlot(PROMPT, brief))?.[1] ?? "";
    assert.deepEqual(decode(slot, { strict: true }), brief);
  });
});

describe("cloneArgs", () => {
  test("clones with clonefile on macOS and reflinks elsewhere", () => {
    assert.deepEqual(cloneArgs("darwin", "a", "b"), ["-c", "-pR", "a", "b"]);
    assert.deepEqual(cloneArgs("linux", "a", "b"), ["-a", "--reflink=auto", "a", "b"]);
  });

  test("copies a checkout with its content and modes on this platform", () => {
    const dir = tempDir();
    const from = join(dir, "from");
    mkdirSync(join(from, "pkg"), { recursive: true });
    writeFileSync(join(from, "pkg", "mod.py"), "value = 3\n");
    writeFileSync(join(from, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    execFileSync("cp", cloneArgs(process.platform, from, join(dir, "to")));
    assert.equal(readFileSync(join(dir, "to", "pkg", "mod.py"), "utf8"), "value = 3\n");
    assert.equal(statSync(join(dir, "to", "run.sh")).mode & 0o777, 0o755);
  });
});

describe("environmentFile", () => {
  const text = environmentFile(WORKSPACE);

  test("says how to reach the container and where scratch files go", () => {
    assert.ok(text.includes(`${WORKSPACE}/bin/tb '<command>' runs a shell command in /testbed inside it`));
    assert.ok(text.includes(`${WORKSPACE}/tmp on this machine is /tmp in the container`));
    assert.ok(text.includes(`run_tests: ${WORKSPACE}/bin/tb 'python tests/runtests.py <test_label>'`));
  });

  test("keeps the approved network line and names no dataset, instance or source agent", () => {
    const network = (file: string) => file.split("\n").find((line) => line.startsWith("network:"));
    assert.equal(network(text), network(PAPER_ENVIRONMENT));
    assert.doesNotMatch(text, FORBIDDEN_TERMS);
  });
});

describe("wrapperPrompt", () => {
  const text = wrapperPrompt(WORKSPACE);

  test("points at the task and the final response inside the workspace", () => {
    assert.ok(text.startsWith(`Your task is in ${WORKSPACE}/review/task.md.`));
    assert.ok(text.includes(`to ${WORKSPACE}/review/final.md.`));
    assert.ok(text.endsWith("Then reply with one line: the verdict, pass or fail."));
  });

  test("forbids web, MCP and subagents and names no dataset, instance, source agent or model", () => {
    assert.ok(text.includes("Do not use web search, web fetch, a browser, MCP tools or subagents."));
    assert.doesNotMatch(text, FORBIDDEN_TERMS);
    assert.doesNotMatch(text, /claude|gpt|gemini|kimi|muse|composer/i);
  });
});

describe("tbScript", () => {
  test("logs each command on one line and runs it in /testbed of the named container", () => {
    const dir = tempDir();
    const log = join(dir, "commands.tsv");
    const tb = join(dir, "tb");
    writeFileSync(tb, tbScript("crx-0a1b2c3d", log), { mode: 0o755 });
    writeFileSync(join(dir, "docker"), '#!/bin/sh\nprintf "%s|" "$@"\n', { mode: 0o755 });
    const out = execFileSync(tb, ["python -c 'print(1)'\nsecond line"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.equal(out, "exec|-i|-w|/testbed|crx-0a1b2c3d|bash|-c|python -c 'print(1)'\nsecond line|");
    const [line, ...rest] = readFileSync(log, "utf8").split("\n");
    assert.match(line, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\tpython -c 'print\(1\)' second line$/);
    assert.deepEqual(rest, [""]);
  });
});

describe("auditOne", () => {
  test("finds nothing to flag in a review that stays in its workspace and runs commands through tb", () => {
    const audit = auditOne(
      entry,
      transcript([
        { name: "UpdateCurrentStep", input: { current_step: "Reading" } },
        { name: "Read", input: { path: `${WORKSPACE}/review/task.md` } },
        { name: "Grep", input: { pattern: "URLValidator", path: `${WORKSPACE}/testbed/django` } },
        { name: "Shell", input: { command: `${WORKSPACE}/bin/tb 'cat /tmp/x.py && python tests/runtests.py validators'` } },
        { name: "Write", input: { path: `${WORKSPACE}/review/final.md`, contents: "review" } },
      ]),
    );
    assert.deepEqual(
      { forbidden: audit.forbidden_tools, outside: audit.outside_paths, network: audit.network_commands },
      { forbidden: [], outside: [], network: [] },
    );
    assert.equal(audit.tool_calls, 4);
    assert.equal(audit.shell_test_runs, 1);
    assert.equal(audit.status, "success");
  });

  test("flags web tools, paths outside the workspace, searches without a path and network commands", () => {
    const audit = auditOne(
      entry,
      transcript([
        { name: "WebSearch", input: { search_term: "upstream fix" } },
        { name: "Read", input: { path: "/Users/someone/labels.csv" } },
        { name: "Grep", input: { pattern: "URLValidator" } },
        { name: "Glob", input: { glob_pattern: "*.py", target_directory: "/tmp" } },
        { name: "Shell", input: { command: "cat ~/notes.md && curl https://example.com" } },
      ]),
    );
    assert.deepEqual(audit.forbidden_tools, ["WebSearch"]);
    assert.deepEqual(audit.outside_paths, [
      "Read.path=/Users/someone/labels.csv",
      "Grep without a path (searches the Cursor workspace)",
      "Glob.target_directory=/tmp",
      "Shell: ~/notes.md",
    ]);
    assert.equal(audit.network_commands.length, 1);
  });

  test("treats a sibling workspace that shares the prefix as outside", () => {
    const audit = auditOne(entry, transcript([{ name: "Read", input: { path: `${WORKSPACE}0/review/final.md` } }]));
    assert.deepEqual(audit.outside_paths, [`Read.path=${WORKSPACE}0/review/final.md`]);
  });

  test("accepts Cursor's other file tools and its local dynamic tools", () => {
    const patch = `*** Begin Patch\n*** Add File: ${WORKSPACE}/tmp/check.py\n+print(1)\n*** End Patch`;
    const audit = auditOne(
      entry,
      transcript([
        { name: "ReadFile", input: { path: `${WORKSPACE}/review/task.md` } },
        { name: "rg", input: { pattern: "Aggregate", path: `${WORKSPACE}/testbed` } },
        { name: "ApplyPatch", input: Object.fromEntries([...patch].map((char, index) => [String(index), char])) },
        { name: "CallDynamicTool", input: { namespace: "cursor", toolName: "AwaitShell", arguments: { shell_id: "1" } } },
      ]),
    );
    assert.deepEqual({ forbidden: audit.forbidden_tools, outside: audit.outside_paths }, { forbidden: [], outside: [] });
    assert.deepEqual(audit.dynamic_calls, ["cursor/AwaitShell"]);
  });

  test("flags web search through CallDynamicTool, patches outside the workspace and pathless rg", () => {
    const audit = auditOne(
      entry,
      transcript([
        { name: "CallDynamicTool", input: { namespace: "cursor", toolName: "WebSearch", arguments: { search_term: "fix" } } },
        { name: "ApplyPatch", input: { patch: "*** Begin Patch\n*** Update File: /Users/someone/notes.py\n*** End Patch" } },
        { name: "rg", input: { pattern: "URLValidator" } },
      ]),
    );
    assert.deepEqual(audit.forbidden_tools, ["CallDynamicTool:cursor/WebSearch"]);
    assert.deepEqual(audit.outside_paths, ["ApplyPatch: /Users/someone/notes.py", "rg without a path (searches the Cursor workspace)"]);
  });

  test("counts a local clone of the checkout as no network access", () => {
    const audit = auditOne(
      entry,
      transcript([
        { name: "Shell", input: { command: `git clone -q ${WORKSPACE}/testbed ${WORKSPACE}/tmp/parent` } },
        { name: "Shell", input: { command: "git clone https://github.com/django/django.git" } },
      ]),
    );
    assert.deepEqual(audit.network_commands, ["git clone https://github.com/django/django.git"]);
  });

  test("notes a prompt that differs from the plan", () => {
    assert.equal(auditOne({ ...entry, task_prompt: "the planned wrapper" }, transcript([])).prompt_exact, false);
  });
});

describe("hostSide", () => {
  test("drops tb arguments, including tb called through a variable, and heredoc bodies", () => {
    const command = [
      `B=${WORKSPACE}/bin/tb; $B "cd /tmp/scratch && python run.py"`,
      `./bin/tb 'python /tmp/repro.py' && cat > ${WORKSPACE}/tmp/x.py <<'EOF'`,
      "open('/tmp/inside').read()",
      "EOF",
      "cat /tmp/host_note.txt",
    ].join("\n");
    assert.equal(hostSide(command), `B=${WORKSPACE}/bin/tb; $B ARG\n./bin/tb ARG && cat > ${WORKSPACE}/tmp/x.py <<HEREDOC\ncat /tmp/host_note.txt`);
  });
});

function transcriptsDir(files: Record<string, Array<Record<string, unknown>>>): string {
  const dir = tempDir();
  for (const [path, lines] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), lines.map((line) => JSON.stringify(line)).join("\n"));
  }
  return dir;
}

const userMessage = (text: string) => ({ role: "user", message: { content: [{ type: "text", text }] } });
const toolCall = (name: string, input: Record<string, unknown>) => ({ role: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

describe("integrity", () => {
  const root = "/private/tmp/crx";
  const ws = (id: string) => `${root}/u001/${id}`;

  test("finds nothing wrong when each review stays in its own workspace", () => {
    const dir = transcriptsDir({
      "main/subagents/a.jsonl": [userMessage(`Your task is in ${ws("0000000a")}/review/task.md.`), toolCall("Read", { path: `${ws("0000000a")}/testbed/x.py` })],
      "main/subagents/b.jsonl": [userMessage(`Your task is in ${ws("0000000b")}/review/task.md.`), toolCall("Shell", { command: `cd ${root}/0000000b && ls` })],
    });
    assert.deepEqual(problems(scan(dir, root)), []);
  });

  test("reports a workspace reviewed twice, a review with a second message and a stray agent in a workspace", () => {
    const dir = transcriptsDir({
      "main/subagents/a.jsonl": [userMessage(`Your task is in ${ws("0000000a")}/review/task.md.`)],
      "launcher/subagents/a2.jsonl": [userMessage(`Your task is in ${ws("0000000a")}/review/task.md.`), userMessage("Continue")],
      "launcher/subagents/c.jsonl": [userMessage("Continue and reply with one line"), toolCall("Write", { path: `${ws("0000000c")}/review/final.md` })],
    });
    assert.deepEqual(problems(scan(dir, root)).sort(), [
      `${ws("0000000a")}: 2 review transcripts`,
      `${ws("0000000a")}: 2 user messages in launcher/subagents/a2.jsonl`,
      `no review prompt (launcher/subagents/c.jsonl) touched ${ws("0000000c")}`,
    ].sort());
  });
});

describe("Queue", () => {
  const item = (seq: number, id: string): QueueItem => ({ seq, id, unit: "u000", model: "m", description: `Review ${id} (m)`, prompt: `Your task is in /w/${id}/review/task.md.`, workspace: `/w/${id}` });

  function queue(maxInFlight = 15): Queue {
    const q = new Queue(join(tempDir(), "queue"));
    q.ensure({ max_in_flight: maxInFlight, claim_wait_ms: 0 });
    return q;
  }

  test("hands out items in order, one claim each, and files the result", async () => {
    const q = queue();
    q.add(item(2, "bbbbbbbb"));
    q.add(item(1, "aaaaaaaa"));
    assert.equal(await q.claim("w1"), "ID: aaaaaaaa\nMODEL: m\nDESCRIPTION: Review aaaaaaaa (m)\nPROMPT:\nYour task is in /w/aaaaaaaa/review/task.md.");
    assert.match(await q.claim("w2"), /^ID: bbbbbbbb/);
    q.finish("aaaaaaaa", "done", "pass");
    q.finish("bbbbbbbb", "failed", "");
    assert.deepEqual([q.list("claimed").length, q.list("done").length, q.list("failed").length], [0, 1, 1]);
    assert.equal(q.read("done", q.find("done", "aaaaaaaa")!).worker, "w1");
  });

  test("waits while the in-flight limit is reached or more items are coming, and empties once all are prepared", async () => {
    const q = queue(1);
    q.add(item(1, "aaaaaaaa"));
    q.add(item(2, "bbbbbbbb"));
    await q.claim("w1");
    assert.equal(await q.claim("w2"), "WAIT");
    q.finish("aaaaaaaa", "done", "pass");
    await q.claim("w2");
    q.finish("bbbbbbbb", "done", "fail");
    assert.equal(await q.claim("w1"), "WAIT");
    writeFileSync(q.marker("ALL_PREPARED"), "");
    assert.equal(await q.claim("w1"), "EMPTY");
  });
});

describe("manager", () => {
  test("gives workers the queue commands and forbids resuming a review", () => {
    const text = workerPrompt("w01", "/runs/x/queue");
    assert.ok(text.includes("--queue /runs/x/queue claim w01"));
    assert.ok(text.includes("Never use resume or interrupt"));
    assert.ok(text.includes("even an error that includes an agent ID"));
  });

  test("knows a workspace was launched only from a transcript whose first message is its prompt", () => {
    const dir = transcriptsDir({
      "w/subagents/a.jsonl": [userMessage("Your task is in /w/aaaaaaaa/review/task.md. Read that file first.")],
      "w/subagents/b.jsonl": [userMessage("Continue"), userMessage("Your task is in /w/bbbbbbbb/review/task.md.")],
    });
    assert.deepEqual([...launchedWorkspaces(dir)], ["/w/aaaaaaaa"]);
  });
});
