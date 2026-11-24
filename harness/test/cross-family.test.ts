import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { readCsv } from "../../papers/cr-effort-claude-5.5/artifact/analysis/lib.ts";
import { analyze } from "../../papers/cr-effort-claude-5.5/cross-family/artifact/analysis/analyze.ts";
import { buildReviews, outsideKind } from "../../papers/cr-effort-claude-5.5/cross-family/artifact/analysis/build-reviews.ts";
import type { Audit } from "../subagent/audit.ts";
import type { ReviewResult } from "../subagent/collect.ts";

const PAPER = join(import.meta.dirname, "..", "..", "papers", "cr-effort-claude-5.5");
const ARTIFACT = join(PAPER, "cross-family", "artifact");
const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "cross-family-")); roots.push(d); return d; };

const result = (id: string, model: string): ReviewResult => ({
  id, model, instance_id: "django__django-1", agent_id: "agent", label_stratum: "swe_abs_wrong", verdict: "fail", verdict_failure: null,
  findings: 1, container_commands: 3, container_test_runs: 1, wall_s: 90, checkout_unchanged: true, checkout_detail: "",
});
const audit = (id: string, outside: string[] = [], tmpPaths: string[] = []): Audit => ({
  id, model: "m", agent_id: "a", parent_id: "p", prompt_exact: true, assistant_turns: 4, tool_calls: 6, tool_counts: {}, dynamic_calls: [],
  shell_test_runs: 1, forbidden_tools: [], outside_paths: outside, tmp_paths: tmpPaths, network_commands: [], status: "completed",
});

function unit(runs: string, name: string, results: ReviewResult[], audits: Audit[] | null): void {
  mkdirSync(join(runs, name, "collected"), { recursive: true });
  writeFileSync(join(runs, name, "collected", "results.json"), JSON.stringify(results));
  if (audits) writeFileSync(join(runs, name, "audit.json"), JSON.stringify(audits));
}

describe("outsideKind", () => {
  test("sorts the audit's outside-path flags without keeping the paths", () => {
    assert.equal(outsideKind("ReadFile.path=/Users/someone/.cursor/projects/p/terminals/1.txt"), "tool_output");
    assert.equal(outsideKind("Read.path=/Users/someone/.cursor/projects/p/agent-tools/x.txt"), "tool_output");
    assert.equal(outsideKind("rg without a path (searches the Cursor workspace)"), "pathless_search");
    assert.equal(outsideKind("Write.path=/tmp/scratch.py"), "tmp");
    assert.equal(outsideKind("ApplyPatch: /tmp/x.py"), "tmp");
    assert.equal(outsideKind("Shell: /private/tmp/crx/0a1b2c3d/bin/tb"), "other");
  });
});

describe("buildReviews", () => {
  test("joins each result to its audit, counts the flags by kind and leaves out discarded reviews", () => {
    const runs = tmp();
    unit(runs, "g01", [result("aaaaaaaa", "kimi-k3-high")], [audit("aaaaaaaa", ["Glob without a path (searches the Cursor workspace)", "Write.path=/tmp/a.py"], ["Shell: /tmp/b"])]);
    unit(join(runs, "units"), "u000", [result("bbbbbbbb", "gpt-5.5-medium"), result("cccccccc", "gpt-5.5-medium")], [audit("bbbbbbbb"), audit("cccccccc")]);
    writeFileSync(join(runs, "discarded.json"), JSON.stringify([{ group: "u000", id: "cccccccc", model: "gpt-5.5-medium", instance_id: "django__django-1", agent_id: "agent", reason: "resumed" }]));
    const { reviews, discarded } = buildReviews(runs);
    assert.deepEqual(reviews.map((r) => r.id), ["bbbbbbbb", "aaaaaaaa"]);
    assert.deepEqual(
      [reviews[1].outside_pathless_search, reviews[1].outside_tmp, reviews[1].outside_tool_output, reviews[1].outside_other, reviews[1].host_tmp_paths],
      [1, 1, 0, 0, 1],
    );
    assert.deepEqual(discarded, [{ id: "cccccccc", model: "gpt-5.5-medium", instance_id: "django__django-1", agent_id: "agent", reason: "resumed" }]);
    assert.ok(!JSON.stringify(reviews).includes("/tmp/"));
  });

  test("stops on a unit with no audit", () => {
    const runs = tmp();
    unit(runs, "u000", [result("aaaaaaaa", "kimi-k3-high")], null);
    assert.throws(() => buildReviews(runs), /has no audit\.json/);
  });
});

describe("analyze", () => {
  test("recomputes the committed output from the committed data", () => {
    const computed = analyze({
      reviews: readCsv(join(ARTIFACT, "data", "reviews.csv")),
      discarded: readCsv(join(ARTIFACT, "data", "discarded.csv")),
      labelsPath: join(PAPER, "artifact", "data", "labels.csv"),
      requires: readCsv(join(PAPER, "artifact", "data", "issue-requires-coding.csv")),
      mainReviews: readCsv(join(PAPER, "haiku-vs-opus", "artifact", "data", "reviews.csv")),
    });
    assert.deepEqual(JSON.parse(JSON.stringify(computed)), JSON.parse(readFileSync(join(ARTIFACT, "outputs", "cross-family.json"), "utf8")));
  });
});
