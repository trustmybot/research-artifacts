import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { decode } from "@toon-format/toon";

import { buildBrief, fillBriefSlot, type Brief } from "../brief.ts";

const PROMPT = readFileSync(new URL("../review-prompt.md", import.meta.url));
const ENVIRONMENT = readFileSync(new URL("../environments/django.txt", import.meta.url), "utf8");
const FORBIDDEN_TERMS = /swe.?abs|swe.?bench|django__|sweagent|false success/i;

const brief = (problemStatement: string): Brief =>
  buildBrief({ commitSha: "abc123", environmentPath: "/review/environment.txt", problemStatement });

function decodedSlot(rendered: string): unknown {
  const body = /^A([\s\S]*)Z$/.exec(rendered)?.[1] ?? "";
  return decode(body, { strict: true });
}

describe("buildBrief", () => {
  test("holds exactly the four keys", () => {
    assert.deepEqual(brief("Fix the validator\n"), {
      commit_sha: "abc123",
      repo_path: "/testbed",
      environment_path: "/review/environment.txt",
      spec: "Fix the validator\n",
    });
  });

  test("leaves out every key not given, rather than leaving it empty", () => {
    assert.deepEqual(buildBrief({ commitSha: "abc123" }), { commit_sha: "abc123", repo_path: "/testbed" });
  });

  test("orders the keys commit_sha, repo_path, diff for a diff-only brief", () => {
    const diffOnly = buildBrief({ commitSha: "abc123", diff: "diff --git a/x b/x\n" });
    assert.deepEqual(Object.keys(diffOnly), ["commit_sha", "repo_path", "diff"]);
    assert.equal(diffOnly.diff, "diff --git a/x b/x\n");
  });

  test("keeps the control order with an authors_note last", () => {
    const full = buildBrief({ commitSha: "abc123", environmentPath: "/e", problemStatement: "s", authorsNote: "n" });
    assert.deepEqual(Object.keys(full), ["commit_sha", "repo_path", "environment_path", "spec", "authors_note"]);
  });
});

describe("fillBriefSlot", () => {
  test("encodes the brief in TOON that decodes back to the brief", () => {
    const value = brief('Line one\n\n\t"quoted" and a back\\slash\r\n');
    assert.deepEqual(decodedSlot(fillBriefSlot("A{{task_brief}}Z", value)), value);
  });

  test("leaves $ sequences in the issue text uninterpreted", () => {
    const value = brief("Pattern $& and $1 and $` and $' and $$ all stay");
    assert.deepEqual(decodedSlot(fillBriefSlot("A{{task_brief}}Z", value)), value);
  });

  test("accepts template syntax in the issue text, which Django issues contain", () => {
    const value = brief("Rendering {{ value }} and {{task_brief}} fails");
    const rendered = fillBriefSlot("A{{task_brief}}Z", value);
    assert.ok(rendered.includes("{{ value }}"));
    assert.deepEqual(decodedSlot(rendered), value);
  });

  test("throws when the template has no slot", () => {
    assert.throws(() => fillBriefSlot("no slot here", brief("t")), /no \{\{task_brief\}\} slot/);
  });

  test("throws when another slot remains", () => {
    assert.throws(() => fillBriefSlot("{{task_brief}} {{other}}", brief("t")), /slot other than one/);
  });

  test("throws when the slot appears twice", () => {
    assert.throws(() => fillBriefSlot("{{task_brief}} {{task_brief}}", brief("t")), /slot other than one/);
  });
});

describe("the approved prompt", () => {
  test("is the approved text, byte for byte", () => {
    assert.equal(
      createHash("sha256").update(PROMPT).digest("hex"),
      "e8c1079255c225671aeedafa2bcac2563d58c7fac506947b835a2c9d84151612",
    );
  });

  test("renders with the brief in its one slot", () => {
    const value = brief("Rendering {{ value }} fails");
    const rendered = fillBriefSlot(PROMPT.toString("utf8"), value);
    const slot = /<task>\n([\s\S]*)\n<\/task>/.exec(rendered)?.[1] ?? "";
    assert.deepEqual(decode(slot, { strict: true }), value);
    assert.equal(rendered.includes("{{task_brief}}"), false);
  });

  test("names no dataset, instance or source agent", () => {
    assert.doesNotMatch(PROMPT.toString("utf8"), FORBIDDEN_TERMS);
  });
});

describe("the Django environment file", () => {
  test("has the approved content and names no dataset, instance or source agent", () => {
    assert.equal(
      ENVIRONMENT,
      [
        "language: Python",
        "interpreter: python, first on PATH",
        "import_path: PYTHONPATH=/testbed",
        "run_tests: python tests/runtests.py <test_label>",
        "network: none, apart from the model API",
        "",
      ].join("\n"),
    );
    assert.doesNotMatch(ENVIRONMENT, FORBIDDEN_TERMS);
  });
});
