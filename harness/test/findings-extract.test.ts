import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { MAIN_FINAL_BATCHES } from "../../papers/cr-effort-claude-5.5/artifact/analysis/build-results.ts";
import { parseCsv } from "../../papers/cr-effort-claude-5.5/artifact/analysis/lib.ts";
import { COLUMNS, extract, finalMessage, recoverFindings } from "../../papers/cr-effort-claude-5.5/findings/artifact/analysis/extract.ts";
import { locationCodes } from "../../papers/cr-effort-claude-5.5/findings/artifact/analysis/location.ts";
import { ELIDED, redact } from "../../papers/cr-effort-claude-5.5/findings/artifact/analysis/redact.ts";

const DIFF = [
  "diff --git a/django/db/models/sql/query.py b/django/db/models/sql/query.py",
  "--- a/django/db/models/sql/query.py",
  "+++ b/django/db/models/sql/query.py",
  "@@ -740,7 +740,7 @@ def deferred_to_data(self, target):",
  "             opts = cur_model._meta",
  "-            must_include[old_model].add(source)",
  "+            must_include[old_model].add(resolve_proxy(source))",
  "diff --git a/tests/requirements/py3.txt b/tests/requirements/py3.txt",
  "--- a/tests/requirements/py3.txt",
  "+++ b/tests/requirements/py3.txt",
  "@@ -1,1 +1,2 @@",
  "+asgiref",
  "",
].join("\n");

const codes = (location: string, problem = "") => locationCodes(location, problem, DIFF);

describe("location codes", () => {
  test("loc_file is set by a source path in the text", () => {
    assert.equal(codes("django/forms/models.py").loc_file, 1);
    assert.equal(codes("the forms module", "see /testbed/django/forms/models.py").loc_file, 1);
  });

  test("loc_file is set by the basename of a patch file that is not a source file", () => {
    assert.equal(codes("py3.txt").loc_file, 1);
    assert.equal(codes("notes.txt").loc_file, 0);
  });

  test("loc_file is 0 when no file is named", () => {
    assert.equal(codes("the query compiler", "self.model._meta.pk is wrong").loc_file, 0);
  });

  test("loc_line_or_function is set by a line number", () => {
    assert.equal(codes("query.py:745").loc_line_or_function, 1);
    assert.equal(codes("query.py", "see lines 745-759").loc_line_or_function, 1);
    assert.equal(codes("query.py", "no numbers here").loc_line_or_function, 0);
  });

  test("loc_line_or_function is set by a function named in the patch's hunk headers or changed lines", () => {
    assert.equal(codes("deferred_to_data").loc_line_or_function, 1);
    assert.equal(codes("query.py", "resolve_proxy drops the proxy key").loc_line_or_function, 1);
    assert.equal(codes("query.py", "it calls `add` twice").loc_line_or_function, 1);
    assert.equal(codes("query.py", "we add the source twice").loc_line_or_function, 0);
    assert.equal(codes("query.py", "get_related_selections is wrong").loc_line_or_function, 0);
  });

  test("loc_in_patch_files is set only for a file the patch changes", () => {
    assert.equal(codes("django/db/models/sql/query.py:745").loc_in_patch_files, 1);
    assert.equal(codes("/testbed/django/db/models/sql/query.py").loc_in_patch_files, 1);
    assert.equal(codes("sql/query.py").loc_in_patch_files, 1);
    assert.equal(codes("query.py").loc_in_patch_files, 1);
    assert.equal(codes("django/db/models/query.py").loc_in_patch_files, 0);
    assert.equal(codes("tests/defer/tests.py").loc_in_patch_files, 0);
  });
});

describe("redaction", () => {
  const line40 = "x".repeat(20) + "=compute(a, b)" + "y".repeat(6);
  const line39 = line40.slice(0, 39);

  test("a quoted 40-character added line is elided and a 39-character one is kept", () => {
    assert.equal(line40.length, 40);
    assert.equal(redact(`The commit adds ${line40} here.`, `+++ b/a.py\n+${line40}\n`), `The commit adds ${ELIDED} here.`);
    assert.equal(redact(`The commit adds ${line39} here.`, `+++ b/a.py\n+${line39}\n`), `The commit adds ${line39} here.`);
  });

  test("a 40-character run inside a longer added line is elided, removed and context lines are not", () => {
    const long = `    if value is not None and ${line40} and other:`;
    assert.equal(redact(`uses ${line40}!`, `+++ b/a.py\n+${long}\n`), `uses ${ELIDED}!`);
    assert.equal(redact(`uses ${line40}!`, `--- a/a.py\n-${line40}\n ${line40}\n`), `uses ${line40}!`);
  });
});

describe("malformed verdict recovery", () => {
  const finding = { location: "a.py:3", problem: "breaks b" };

  test("non-strict TOON in the last fenced block is recovered", () => {
    const message = 'Done.\n```toon\nverdict: fail\nfeedback: "x"\nfindings[2]:\n  - location: "a.py:3"\n    problem: "breaks b"\n```';
    assert.deepEqual(recoverFindings(message), [finding]);
  });

  test("JSON is recovered when the block is not TOON, and an unterminated block is read to the end", () => {
    const json = JSON.stringify({ verdict: "fail", feedback: "x", findings: [finding] });
    assert.deepEqual(recoverFindings("```toon\n{bad\n```\n```json\n" + json + "\n```"), [finding]);
    assert.deepEqual(recoverFindings("```json\n" + json), [finding]);
  });

  test("when the whole block fails to decode, the findings key is decoded on its own", () => {
    const message = '```toon\nverdict: "fail"\nfeedback: "breaks b.\\"\nfindings[1]:\n  - location: "a.py:3"\n    problem: "breaks b"\n```';
    assert.deepEqual(recoverFindings(message), [finding]);
    assert.deepEqual(recoverFindings('```toon\nverdict: "fail\nfindings[1]:\n  - location: "a.py"\n```'), [{ location: "a.py", problem: "" }]);
  });

  test("nothing is recovered from a message without a parseable block", () => {
    assert.deepEqual(recoverFindings("I pass this commit."), []);
    assert.deepEqual(recoverFindings('```toon\nverdict: "fail\nfindings[1]:\n  - location: "a.py\n```'), []);
    assert.deepEqual(recoverFindings('```toon\nverdict: "fail"\nfeedback: "x.\\"\\nfindings[1]:\\n  - location: \\"a.py\\"\n```'), []);
  });

  test("the final message is the result event's text", () => {
    const events = [
      { type: "assistant", message: { content: [{ type: "text", text: "draft" }] } },
      { type: "result", result: "final" },
    ];
    assert.equal(finalMessage(events.map((e) => JSON.stringify(e)).join("\n")), "final");
  });
});

const SHARD = "20261105t180558z-fa7afee-models-sonnet-haiku-s0of5";
const FEEDBACK = "PRIVATE-FEEDBACK-MARKER";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 30_000 });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "findings-extract-"));
  const runs = join(root, "runs");
  const vault = join(root, "vault");
  const patch = `+++ b/django/db/models/sql/query.py\n+        must_include[old_model].add(resolve_proxy(source))\n`;
  const pin = sha256(patch);
  mkdirSync(join(runs, "cache", "django__django-1"), { recursive: true });
  writeFileSync(join(runs, "cache", "django__django-1", "agent.diff"), patch);
  for (const batch of MAIN_FINAL_BATCHES) mkdirSync(join(runs, "gcs", batch, "runs"), { recursive: true });

  const base = { instance_id: "django__django-1", agent_id: "agent", patch_sha256: pin };
  const writeRun = (dir: string, run: object, transcript: object[]) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), JSON.stringify(run));
    writeFileSync(join(dir, "transcript.jsonl"), transcript.map((e) => JSON.stringify(e)).join("\n"));
  };
  writeRun(join(runs, "gcs", MAIN_FINAL_BATCHES[0], "runs", "01-opus"), {
    ...base, effort: "high", verdict: "fail", feedback: FEEDBACK, stop_reason: "end_turn",
    findings: [{ location: "django/db/models/sql/query.py:745", problem: "it adds must_include[old_model].add(resolve_proxy(source)) twice" }],
  }, [{ type: "result", result: FEEDBACK }]);

  mkdirSync(vault);
  git(vault, "init", "-q");
  const runsDir = join(vault, "c4-effort", "c4-c-smoke", SHARD, "runs");
  writeRun(join(runsDir, "01-sonnet"), { ...base, effort: "low", verdict: null, feedback: null, stop_reason: "verdict_malformed:invalid_toon" },
    [{ type: "result", result: `${FEEDBACK}\n\`\`\`toon\nverdict: "fail\n\`\`\`` }]);
  writeRun(join(runsDir, "02-haiku"), { ...base, effort: "low", verdict: "pass", feedback: FEEDBACK, findings: [], stop_reason: "end_turn" }, [{ type: "result", result: FEEDBACK }]);
  git(vault, "add", "-A");
  git(vault, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "runs");
  git(vault, "update-ref", `refs/remotes/origin/c4-c-smoke/${SHARD}`, "HEAD");

  const header = "model,effort,instance_id,agent_id,patch_sha256,label,verdict,run_name";
  const reviews = join(root, "reviews.csv");
  writeFileSync(reviews, [
    header,
    `opus,high,django__django-1,agent,${pin},wrong,fail,01-opus`,
    `sonnet,low,django__django-1,agent,${pin},wrong,malformed,s0of5/01-sonnet`,
    `haiku,low,django__django-1,agent,${pin},wrong,pass,s0of5/02-haiku`,
  ].join("\n") + "\n");
  const labels = join(root, "labels.csv");
  writeFileSync(labels, `set,instance_id,agent_id,patch_sha256,original_label,rule,label,overlay\nmain,django__django-1,agent,${pin},wrong,L2,wrong,\n`);
  return { root, runs, vault, reviews, labels, expected: { fail: 1, malformed: 1 } };
}

describe("extract", () => {
  test("writes one redacted row per finding for fail and malformed reviews, none for pass, and no feedback", () => {
    const f = fixture();
    try {
      const { errors, csv, privateRecords } = extract(f);
      assert.deepEqual(errors, []);
      const rows = parseCsv(csv);
      assert.equal(csv.split("\n")[0], COLUMNS.join(","));
      assert.deepEqual(rows.map((r) => [r.model, r.verdict_status, r.finding_index, r.n_findings]), [["opus", "fail", "1", "1"], ["sonnet", "malformed", "0", "0"]]);
      assert.equal(rows[0].problem, `it adds ${ELIDED} twice`);
      assert.deepEqual([rows[0].loc_file, rows[0].loc_line_or_function, rows[0].loc_in_patch_files], ["1", "1", "1"]);
      assert.deepEqual([rows[1].location, rows[1].problem, rows[1].loc_file, rows[1].loc_line_or_function, rows[1].loc_in_patch_files], ["", "", "0", "0", "0"]);
      assert.ok(!csv.includes(FEEDBACK));
      assert.match(privateRecords.find((r) => r.model === "sonnet")!.final_message, new RegExp(FEEDBACK));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("reports a missing transcript, a failed hash pin and a count mismatch", () => {
    const f = fixture();
    try {
      rmSync(join(f.runs, "gcs", MAIN_FINAL_BATCHES[0], "runs", "01-opus", "transcript.jsonl"));
      writeFileSync(join(f.runs, "cache", "django__django-1", "agent.diff"), "tampered\n");
      const { errors } = extract({ ...f, expected: { fail: 1, malformed: 1 } });
      assert.ok(errors.some((e) => e.startsWith("no run.json and transcript for opus-high")), errors.join("\n"));
      assert.ok(errors.some((e) => e.startsWith("hash pin failed")), errors.join("\n"));
      assert.ok(errors.some((e) => e === "0 fail reviews, expected 1"), errors.join("\n"));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
