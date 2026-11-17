import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  BUDGET_USD,
  MAX_OUTPUT_TOKENS,
  main,
  MODEL,
  PROMPT,
  runRecall,
  scoreAnswer,
  worstCaseCostUsd,
  type RecallClient,
  type RecallDeps,
  type RecallMessage,
  type RecallRequest,
} from "../checks/recall.ts";
import type { Instance } from "../sources.ts";

const OFFICIAL = [
  "diff --git a/django/core/validators.py b/django/core/validators.py",
  "index 1111111..2222222 100644",
  "--- a/django/core/validators.py",
  "+++ b/django/core/validators.py",
  "@@ -1,3 +1,3 @@ class URLValidator:",
  " context",
  "-    old_regex = 1",
  "+    new_regex = 2",
  "+",
  "+    copied_from_issue = 3",
  "diff --git a/django/utils/http.py b/django/utils/http.py",
  "--- a/django/utils/http.py",
  "+++ b/django/utils/http.py",
  "@@ -9 +9 @@",
  "-    return False",
  "+    return True",
  "",
].join("\n");
const ISSUE = "URLValidator is wrong. Maybe set copied_from_issue = 3 somewhere.";
const API_KEY = "sk-ant-secret-for-test";

function answerWith(path: string, ...changes: string[]): string {
  return [`--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", ...changes, ""].join("\n");
}

function message(overrides: Partial<RecallMessage> = {}): RecallMessage {
  return {
    model: MODEL,
    stop_reason: "end_turn",
    usage: { input_tokens: 1000, output_tokens: 500 },
    content: [
      { type: "thinking" },
      { type: "text", text: answerWith("django/core/validators.py", "+new_regex = 2") },
    ],
    ...overrides,
  };
}

function entry(instance_id: string): Instance {
  return { instance_id } as Instance;
}

type Reply = RecallMessage | Error;

function harness(ids: string[], replies: Reply[], issue: string | ((id: string) => string) = ISSUE) {
  const dir = mkdtempSync(join(tmpdir(), "recall-"));
  const patches = join(dir, "patches.json");
  writeFileSync(patches, JSON.stringify(ids.map(entry)));
  const out = join(dir, "out");
  const requests: RecallRequest[] = [];
  const logs: string[] = [];
  const queue = [...replies];
  const client: RecallClient = {
    messages: {
      stream(request) {
        requests.push(request);
        return {
          finalMessage: async () => {
            const reply = queue.shift() as Reply;
            if (reply instanceof Error) throw reply;
            return reply;
          },
        };
      },
    },
  };
  const deps: RecallDeps = {
    createClient: async () => client,
    loadSources: async ({ instance_id }) => ({
      problemStatement: typeof issue === "string" ? issue : issue(instance_id),
      goldPatch: OFFICIAL,
    }),
    env: { ANTHROPIC_API_KEY: API_KEY },
    log: (line) => logs.push(line),
  };
  const readInstance = (id: string) =>
    JSON.parse(readFileSync(join(out, "instances", `${id}.json`), "utf8"));
  const readSummary = () => JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
  return { out, patches, requests, logs, deps, readInstance, readSummary };
}

describe("scoreAnswer", () => {
  test("an exact answer recovers every line and file", () => {
    assert.deepEqual(scoreAnswer(OFFICIAL, OFFICIAL, ISSUE), {
      parsed: true,
      files_official: 2,
      files_answer: 2,
      files_overlap: 2,
      lines_official: 5,
      lines_recovered: 5,
      lines_official_not_in_issue: 4,
      lines_recovered_not_in_issue: 4,
    });
  });

  test("a partial answer counts only the lines and files it shares", () => {
    const answer = answerWith("django/core/validators.py", "-old_regex = 1", "+something_else");
    assert.deepEqual(scoreAnswer(answer, OFFICIAL, ISSUE), {
      parsed: true,
      files_official: 2,
      files_answer: 1,
      files_overlap: 1,
      lines_official: 5,
      lines_recovered: 1,
      lines_official_not_in_issue: 4,
      lines_recovered_not_in_issue: 1,
    });
  });

  test("a diff sharing nothing scores no overlap but stays parsed", () => {
    const scores = scoreAnswer(answerWith("other.py", "+unrelated"), OFFICIAL, ISSUE);
    assert.equal(scores.parsed, true);
    assert.equal(scores.files_answer, 1);
    assert.equal(scores.files_overlap, 0);
    assert.equal(scores.lines_recovered, 0);
    assert.equal(scores.lines_official, 5);
  });

  test("lines copied from the issue do not count as recovered from memory", () => {
    const scores = scoreAnswer(
      answerWith("django/core/validators.py", "+copied_from_issue = 3"),
      OFFICIAL,
      ISSUE,
    );
    assert.equal(scores.lines_recovered, 1);
    assert.equal(scores.lines_recovered_not_in_issue, 0);
    assert.equal(scores.lines_official_not_in_issue, 4);
  });

  test("an answer with no diff scores zeros and parsed false", () => {
    assert.deepEqual(scoreAnswer("- I cannot\n+ recall this", OFFICIAL, ISSUE), {
      parsed: false,
      files_official: 0,
      files_answer: 0,
      files_overlap: 0,
      lines_official: 0,
      lines_recovered: 0,
      lines_official_not_in_issue: 0,
      lines_recovered_not_in_issue: 0,
    });
  });

  test("a repeated answer line recovers one official line per occurrence", () => {
    const official = answerWith("a.py", "+)", "+)", "+)");
    assert.equal(scoreAnswer(answerWith("a.py", "+)"), official, "").lines_recovered, 1);
  });

  test("a removed line reading like a file header stays a changed line", () => {
    const official = answerWith("a.py", "--- a comment", "+++ another", " context");
    const scores = scoreAnswer(official, official, "");
    assert.equal(scores.files_official, 1);
    assert.equal(scores.lines_official, 2);
  });

  test("a fence ends the hunk and new or deleted files keep their real path", () => {
    const answer = [
      "```diff",
      "--- /dev/null",
      "+++ b/new.py",
      "@@ -0,0 +1 @@",
      "+added",
      "--- a/gone.py",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-removed",
      "```",
      "- a closing remark",
    ].join("\n");
    const official = [answerWith("new.py", "+added"), answerWith("gone.py", "-removed")].join("");
    const scores = scoreAnswer(answer, official, "");
    assert.equal(scores.files_overlap, 2);
    assert.equal(scores.lines_recovered, 2);
    assert.equal(scoreAnswer(official, answer, "").lines_official, 2);
  });
});

describe("request", () => {
  test("carries the pinned model and effort, and nothing beyond the issue", async () => {
    const run = harness(["a"], [message()]);
    await runRecall(run.out, run.patches, run.deps);
    assert.deepEqual(run.requests, [
      {
        model: "claude-opus-5-5",
        max_tokens: 12000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        messages: [{ role: "user", content: `${PROMPT}\n\n${ISSUE}` }],
      },
    ]);
    const [request] = run.requests;
    for (const absent of ["tools", "fallbacks", "system", "temperature"]) {
      assert.equal(absent in request, false, absent);
    }
    assert.equal(request.messages.at(-1)?.role, "user");
  });
});

describe("runRecall", () => {
  test("a success writes every instance field non-null", async () => {
    const run = harness(["a"], [message()]);
    await runRecall(run.out, run.patches, run.deps);
    const result = run.readInstance("a");
    assert.deepEqual(Object.keys(result), [
      "instance_id",
      "status",
      "stop_reason",
      "model",
      "input_tokens",
      "output_tokens",
      "cost_usd",
      "answer_text",
      "scores",
    ]);
    for (const [field, value] of Object.entries(result)) assert.notEqual(value, null, field);
    assert.equal(result.status, "completed");
    assert.equal(result.stop_reason, "end_turn");
    assert.ok(Math.abs(result.cost_usd - (1000 * 4 + 500 * 20) / 1_000_000) < 1e-12);
    assert.match(result.answer_text, /new_regex/);
    assert.equal(result.scores.lines_recovered, 1);
  });

  test("one success, one refusal, one API error and one budget skip fill the summary", async () => {
    const bigIssue = "x".repeat(50_000);
    const run = harness(
      ["ok", "no", "boom", "skip"],
      [
        message({ usage: { input_tokens: 0, output_tokens: 235_000 } }),
        message({ stop_reason: "refusal", content: [], usage: { input_tokens: 0, output_tokens: 1000 } }),
        new Error("overloaded"),
      ],
      (id) => (id === "skip" ? bigIssue : ISSUE),
    );
    const summary = await runRecall(run.out, run.patches, run.deps);
    assert.equal(run.requests.length, 3);
    assert.deepEqual(run.readSummary(), summary);
    assert.deepEqual(Object.keys(summary), [
      "spent_usd",
      "instances_total",
      "completed",
      "refused",
      "errors",
      "skipped_budget",
      "files_overlap_rate",
      "lines_recovered_rate",
      "lines_recovered_not_in_issue_rate",
    ]);
    assert.ok(Math.abs(summary.spent_usd - 4.72) < 1e-9);
    assert.equal(summary.instances_total, 4);
    assert.equal(summary.completed, 1);
    assert.equal(summary.refused, 1);
    assert.equal(summary.errors, 1);
    assert.equal(summary.skipped_budget, 1);
    assert.equal(summary.files_overlap_rate, 1 / 2);
    assert.equal(summary.lines_recovered_rate, 1 / 5);
    assert.equal(summary.lines_recovered_not_in_issue_rate, 1 / 4);

    const refusal = run.readInstance("no");
    assert.equal(refusal.status, "refused");
    assert.equal(refusal.stop_reason, "refusal");

    for (const [id, status] of [["boom", "error"], ["skip", "skipped_budget"]]) {
      const unanswered = run.readInstance(id);
      assert.equal(unanswered.status, status);
      for (const field of ["stop_reason", "input_tokens", "output_tokens", "answer_text", "scores"]) {
        assert.equal(unanswered[field], null, field);
      }
    }
  });

  test("the budget stop dispatches nothing once the worst case would pass the cap", async () => {
    const issue = "x".repeat(400);
    const worst = worstCaseCostUsd(issue);
    assert.ok(Math.abs(worst - (100 * 4 + MAX_OUTPUT_TOKENS * 20) / 1_000_000) < 1e-12);
    const spendTokens = Math.ceil(((BUDGET_USD - worst) / 20) * 1_000_000) + 1;
    const run = harness(
      ["first", "second", "third"],
      [message({ usage: { input_tokens: 0, output_tokens: spendTokens } })],
      issue,
    );
    const summary = await runRecall(run.out, run.patches, run.deps);
    assert.equal(run.requests.length, 1);
    assert.equal(summary.completed, 1);
    assert.equal(summary.skipped_budget, 2);
    for (const id of ["second", "third"]) {
      const skipped = run.readInstance(id);
      assert.equal(skipped.status, "skipped_budget");
      assert.equal(skipped.cost_usd, 0);
      for (const field of ["stop_reason", "input_tokens", "output_tokens", "answer_text", "scores"]) {
        assert.equal(skipped[field], null, field);
      }
    }
  });

  test("a call whose worst case stays under the cap is still dispatched", async () => {
    const issue = "x".repeat(400);
    const spendTokens = Math.floor(((BUDGET_USD - worstCaseCostUsd(issue)) / 20) * 1_000_000) - 1;
    const run = harness(
      ["first", "second"],
      [message({ usage: { input_tokens: 0, output_tokens: spendTokens } }), message()],
      issue,
    );
    await runRecall(run.out, run.patches, run.deps);
    assert.equal(run.requests.length, 2);
  });

  test("max_tokens is recorded as such, scored and not retried", async () => {
    const run = harness(["a"], [message({ stop_reason: "max_tokens" })]);
    const summary = await runRecall(run.out, run.patches, run.deps);
    assert.equal(run.requests.length, 1);
    assert.equal(run.readInstance("a").stop_reason, "max_tokens");
    assert.equal(summary.completed, 1);
  });

  test("an unparsable answer lowers the rate instead of leaving the denominator", async () => {
    const run = harness(
      ["good", "prose"],
      [message(), message({ content: [{ type: "text", text: "I do not remember." }] })],
    );
    const summary = await runRecall(run.out, run.patches, run.deps);
    assert.equal(run.readInstance("prose").scores.parsed, false);
    assert.equal(summary.lines_recovered_rate, 1 / 10);
    assert.equal(summary.files_overlap_rate, 1 / 4);
  });

  test("runs entries in file order", async () => {
    const run = harness(["b", "a"], [message(), message()], (id) => `issue ${id}`);
    await runRecall(run.out, run.patches, run.deps);
    assert.deepEqual(
      run.requests.map((request) => request.messages[0].content.endsWith("issue b")),
      [true, false],
    );
    assert.deepEqual(readdirSync(join(run.out, "instances")).sort(), ["a.json", "b.json"]);
  });

  test("the API key reaches no output or log", async () => {
    const run = harness(
      ["boom", "echo"],
      [
        new Error(`401 for ${API_KEY}`),
        message({ content: [{ type: "text", text: `echoed ${API_KEY}` }] }),
      ],
    );
    await runRecall(run.out, run.patches, run.deps);
    assert.equal(run.requests.length, 2);
    assert.match(run.logs.join("\n"), /boom: API error: 401 for \[REDACTED\]/);
    for (const text of [
      run.logs.join("\n"),
      readFileSync(join(run.out, "summary.json"), "utf8"),
      readFileSync(join(run.out, "instances", "boom.json"), "utf8"),
      readFileSync(join(run.out, "instances", "echo.json"), "utf8"),
    ]) {
      assert.equal(text.includes(API_KEY), false);
    }
  });
});

describe("main", () => {
  test("exits zero when an entry completed", async () => {
    const run = harness(["a", "b"], [message(), new Error("overloaded")]);
    assert.equal(await main(["--out", run.out, "--patches", run.patches], run.deps), 0);
  });

  test("exits non-zero and still writes the summary when no entry completed", async () => {
    const run = harness(["a"], [new Error("overloaded")]);
    assert.equal(await main(["--out", run.out, "--patches", run.patches], run.deps), 1);
    assert.equal(run.readSummary().errors, 1);
  });

  test("exits non-zero before any call when a source fails its hash check", async () => {
    const run = harness(["a", "b"], [message()]);
    run.deps.loadSources = async (instance) => {
      if (instance.instance_id === "b") throw new Error(`hash mismatch ${API_KEY}`);
      return { problemStatement: ISSUE, goldPatch: OFFICIAL };
    };
    assert.equal(await main(["--out", run.out, "--patches", run.patches], run.deps), 1);
    assert.equal(run.requests.length, 0);
    assert.equal(existsSync(join(run.out, "summary.json")), false);
    assert.equal(run.logs.join("\n").includes(API_KEY), false);
  });

  test("exits non-zero when the patches file is missing", async () => {
    const run = harness(["a"], [message()]);
    assert.equal(await main(["--out", run.out, "--patches", `${run.patches}.absent`], run.deps), 1);
    assert.equal(run.requests.length, 0);
  });

  test("asks once per instance when the list repeats it under another agent", async () => {
    const run = harness(["a"], [message(), message()]);
    const pins = { problem_statement_sha256: "p", base_commit: "c", gold_patch_sha256: "g" };
    writeFileSync(
      run.patches,
      JSON.stringify([
        { ...pins, instance_id: "a", agent_id: "one" },
        { ...pins, instance_id: "b", agent_id: "one" },
        { ...pins, instance_id: "a", agent_id: "two" },
      ]),
    );
    assert.equal(await main(["--out", run.out, "--patches", run.patches], run.deps), 0);
    assert.equal(run.requests.length, 2);
    assert.equal(run.readSummary().instances_total, 2);
    assert.deepEqual(readdirSync(join(run.out, "instances")).sort(), ["a.json", "b.json"]);
  });

  for (const field of ["problem_statement_sha256", "base_commit", "gold_patch_sha256"]) {
    test(`refuses a repeated instance whose ${field} differs, before any call`, async () => {
      const run = harness(["a"], [message()]);
      const pins = { problem_statement_sha256: "p", base_commit: "c", gold_patch_sha256: "g" };
      writeFileSync(
        run.patches,
        JSON.stringify([
          { ...pins, instance_id: "a", agent_id: "one" },
          { ...pins, instance_id: "a", agent_id: "two", [field]: "other" },
        ]),
      );
      assert.equal(await main(["--out", run.out, "--patches", run.patches], run.deps), 1);
      assert.equal(run.requests.length, 0);
      assert.match(run.logs.join("\n"), new RegExp(`lists a twice with different ${field}`));
    });
  }

  test("refuses a missing flag as a usage error", async () => {
    const run = harness(["a"], [message()]);
    assert.equal(await main(["--out", run.out], run.deps), 2);
    assert.equal(run.requests.length, 0);
  });
});
