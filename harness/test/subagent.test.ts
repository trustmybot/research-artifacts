import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { decode } from "@toon-format/toon";

import { fillBriefSlot } from "../brief.ts";
import { auditOne } from "../subagent/audit.ts";
import { environmentFile, taskBrief, tbScript, wrapperPrompt, type PlanEntry } from "../subagent/prepare.ts";

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
});
