import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  computeVerdicts,
  EXCLUSIONS_FILE,
  exclusionsOf,
  executeRun,
  failureHeaders,
  parseCli,
  parseDjangoLog,
  REPORT_FILE,
  RUN_TIMEOUT_MS,
  runLabelCheck,
  RUNNER_NOTE,
  runPin,
  runReverdict,
  testDirectives,
  testOutputOf,
  testResults,
  type Exclusion,
  type Exec,
  type Inputs,
  type LabelCheckDeps,
  type RunRecord,
  type SmokePatch,
  type Verdict,
} from "../checks/label-check.ts";
import { REVIEWER_ENV } from "../runners.ts";
import { sha256 } from "../sources.ts";

const LOG_FIXTURE = [
  "Testing against Django installed in '/testbed/django'",
  "test_ok (app.tests.Case) ... ok",
  "test_upper (app.tests.Case) ...  OK",
  "test_fail (app.tests.Case) ... FAIL",
  "test_error (app.tests.Case) ... ERROR",
  "test_bare_skip (app.tests.Case) ... skipped",
  "test_reason_skip (app.tests.Case) ... skipped 'needs a ... ok database'",
  "test_doc_same_line (app.tests.Case)",
  "A docstring on the status line ... ok",
  "test_doc_next_line (app.tests.Case)",
  "A docstring above its status",
  "... ok",
  "test_noisy (app.tests.Case) ... Internal Server Error: /x/",
  "Traceback (most recent call last):",
  "ok",
  "",
  "======================================================================",
  "FAIL: test_fail (app.tests.Case)",
  "----------------------------------------------------------------------",
  "Traceback (most recent call last):",
  "AssertionError: 1 != 2",
  "",
  "======================================================================",
  "ERROR: test_error (app.tests.Case)",
  "----------------------------------------------------------------------",
  "Traceback (most recent call last):",
  "ValueError: boom",
  "",
  "----------------------------------------------------------------------",
  "Ran 9 tests in 0.1s",
  "",
  "FAILED (failures=1, errors=1)",
].join("\n");

const LOG_TESTS = [
  "test_ok (app.tests.Case)",
  "test_upper (app.tests.Case)",
  "test_fail (app.tests.Case)",
  "test_error (app.tests.Case)",
  "test_bare_skip (app.tests.Case)",
  "test_reason_skip (app.tests.Case)",
  "A docstring on the status line",
  "A docstring above its status",
  "test_noisy (app.tests.Case)",
];

const VERIFIED_PATCH = "diff --git a/tests/app/tests.py b/tests/app/tests.py\n--- a/tests/app/tests.py\n+++ b/tests/app/tests.py\n";
const ABS_PATCH = "diff --git a/tests/app/test_new.py b/tests/app/test_new.py\nnew file mode 100644\n--- /dev/null\n+++ b/tests/app/test_new.py\n";
const CANDIDATE_PATCH = "candidate patch text";
const OFFICIAL_PATCH = "official patch text";
const CANDIDATE_APPLIED = `${CANDIDATE_PATCH}\n`;
const OFFICIAL_APPLIED = `${OFFICIAL_PATCH}\n`;
const CANDIDATE_URL ="https://example.invalid/candidate.diff";
const EXPECTED = ["test_ok (app.tests.Case)", "A docstring on the status line", "test_absent (app.tests.Case)"];

const PATCH: SmokePatch = {
  instance_id: "django__django-1",
  label_stratum: "swe_abs_wrong",
  patch_url: CANDIDATE_URL,
  patch_sha256: sha256(CANDIDATE_PATCH),
  gold_patch_sha256: sha256(OFFICIAL_PATCH),
  image: "swebench/image",
  image_digest: "sha256:abc",
  base_commit: "base123",
};

const LIST_PINS = {
  fail_to_pass_sha256: sha256(JSON.stringify([EXPECTED[0]])),
  pass_to_pass_sha256: sha256(JSON.stringify(EXPECTED.slice(1))),
};

const INPUTS: Inputs = {
  source: { dataset: "owner/name", revision: "rev" },
  instances: {
    [PATCH.instance_id]: {
      abs_test_patch_sha256: sha256(ABS_PATCH),
      verified_test_patch_sha256: sha256(VERIFIED_PATCH),
      ...LIST_PINS,
    },
  },
};

function rowsPage(truncated: string[] = [], overrides: Record<string, string> = {}): string {
  return JSON.stringify({
    rows: [
      { row: { instance_id: "other__other-1" }, truncated_cells: ["patch"] },
      {
        row: {
          instance_id: PATCH.instance_id,
          patch: OFFICIAL_PATCH,
          test_patch: ABS_PATCH,
          original_test_patch: VERIFIED_PATCH,
          FAIL_TO_PASS: JSON.stringify([EXPECTED[0]]),
          PASS_TO_PASS: JSON.stringify(EXPECTED.slice(1)),
          ...overrides,
        },
        truncated_cells: truncated,
      },
    ],
    num_rows_total: 2,
  });
}

interface FakeCall {
  args: string[];
  stdin?: string;
  timeoutMs: number;
}

type ExecAnswer = { code?: number; stdout?: string; stderr?: string; timedOut?: boolean };

function makeDeps(respond: (args: string[], stdin?: string) => ExecAnswer, page = rowsPage()) {
  const calls: FakeCall[] = [];
  const warnings: string[] = [];
  const exec: Exec = async (command, args, options) => {
    assert.equal(command, "docker");
    calls.push({ args, stdin: options.stdin, timeoutMs: options.timeoutMs });
    const answer = respond(args, options.stdin);
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...answer };
  };
  const deps: LabelCheckDeps = {
    exec,
    fetch: async (url) => new Response(url === CANDIDATE_URL ? CANDIDATE_PATCH : page),
    sleep: async () => {},
    warn: (message) => warnings.push(message),
  };
  return { deps, calls, warnings };
}

const isTestRun = (args: string[]) => args.includes("./tests/runtests.py");

async function runFake(deps: LabelCheckDeps, repeats = 2) {
  const outDir = mkdtempSync(join(tmpdir(), "label-check-"));
  const exitCode = await runLabelCheck({ outDir, repeats, patches: [PATCH], inputs: INPUTS }, deps);
  const reportPath = join(outDir, REPORT_FILE);
  const report = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, "utf8")) as {
        runner_note: string;
        runs: RunRecord[];
        verdicts: Verdict[];
      })
    : null;
  return { exitCode, outDir, report };
}

function run(overrides: Partial<RunRecord>): RunRecord {
  return {
    instance_id: PATCH.instance_id,
    agent_id: overrides.patch_kind === "official" ? null : "",
    patch_kind: "candidate",
    test_set: "verified",
    repeat: 1,
    exit_code: 0,
    timed_out: false,
    directives: ["app.tests"],
    directives_empty: false,
    tests_seen: ["a"],
    failed_tests: [],
    expected_missing: [],
    expected_failed: [],
    ...overrides,
  };
}

function caseRuns(
  candidateAbs: Array<Partial<RunRecord>>,
  options: { official?: Partial<RunRecord>; candidateVerified?: Array<Partial<RunRecord>> } = {},
): RunRecord[] {
  const verified = options.candidateVerified ?? candidateAbs.map(() => ({}));
  return [
    ...verified.map((extra, index) => run({ repeat: index + 1, ...extra })),
    ...candidateAbs.map((extra, index) => run({ test_set: "abs", repeat: index + 1, ...extra })),
    run({ patch_kind: "official", ...options.official }),
    run({ patch_kind: "official", test_set: "abs" }),
  ];
}

describe("testDirectives", () => {
  test("follows the SWE-bench Django rules", () => {
    const paths = [
      "tests/app/tests.py",
      "tests/app/sub/test_x.py",
      "django/core/thing.py",
      "tests/app/fixture.json",
      "tests/app/image.png",
      "tests/app/datacsv",
      "tests/app/urls.txt",
      "README.md",
      "a.jpg",
      "a.jpeg",
      "a.pkl",
      "a.yml",
      "a.yaml",
      "a.toml",
    ];
    const patch = paths.map((path) => `diff --git a/${path} b/${path}\n+  diff --git a/no b/no.py`).join("\n");
    assert.deepEqual(testDirectives(patch), ["app.tests", "app.sub.test_x", "django.core.thing"]);
  });

  test("is empty when only data files change", () => {
    assert.deepEqual(testDirectives("diff --git a/tests/v/urls.txt b/tests/v/urls.txt\n"), []);
  });
});

describe("parseDjangoLog", () => {
  test("reads every status form", () => {
    const statuses = parseDjangoLog(LOG_FIXTURE);
    assert.deepEqual([...statuses.entries()], [
      ["test_ok (app.tests.Case)", "passed"],
      ["test_upper (app.tests.Case)", "passed"],
      ["test_fail (app.tests.Case)", "failed"],
      ["test_error (app.tests.Case)", "failed"],
      ["test_bare_skip (app.tests.Case)", "skipped"],
      ["test_reason_skip (app.tests.Case)", "skipped"],
      ["A docstring on the status line", "passed"],
      ["A docstring above its status", "passed"],
      ["test_noisy (app.tests.Case)", "passed"],
    ]);
  });
});

describe("failure headers", () => {
  const SUBTEST_LOG = [
    "test_ok (app.tests.Case) ... ok",
    "test_sub (app.tests.Case) ... ",
    "test_doc (app.tests.Case)",
    "A failing docstring test ... FAIL",
    "",
    "======================================================================",
    "FAIL: test_sub (app.tests.Case) (value='a')",
    "----------------------------------------------------------------------",
    "AssertionError",
    "",
    "======================================================================",
    "FAIL: test_sub (app.tests.Case) (value='b')",
    "----------------------------------------------------------------------",
    "======================================================================",
    "FAIL: test_doc (app.tests.Case)",
    "A failing docstring test",
    "----------------------------------------------------------------------",
    "======================================================================",
    "ERROR: setUpClass (app.tests.Other)",
    "----------------------------------------------------------------------",
    "  FAIL: indented (not.a.Header)",
    "",
    "Ran 3 tests in 0.1s",
    "",
    "FAILED (failures=3, errors=1)",
  ].join("\n");

  test("lists each FAIL and ERROR header once, in log order", () => {
    assert.deepEqual(failureHeaders(SUBTEST_LOG), [
      "test_sub (app.tests.Case)",
      "test_doc (app.tests.Case)",
      "setUpClass (app.tests.Other)",
    ]);
    assert.deepEqual(failureHeaders(LOG_FIXTURE), ["test_fail (app.tests.Case)", "test_error (app.tests.Case)"]);
  });

  test("a subTest failure with no status on its verbose line counts as seen and failed", () => {
    const results = testResults(SUBTEST_LOG, ["test_sub (app.tests.Case)", "A failing docstring test", "test_ok (app.tests.Case)"]);
    assert.deepEqual(results.failed_tests, ["A failing docstring test", "test_sub (app.tests.Case)", "test_doc (app.tests.Case)", "setUpClass (app.tests.Other)"]);
    assert.deepEqual(results.expected_failed, ["test_sub (app.tests.Case)", "A failing docstring test"]);
    assert.deepEqual(results.expected_missing, []);
  });

  test("testOutputOf keeps only what follows the runtests step", () => {
    const runLog = ["$ docker exec c git apply", "noise", "$ docker exec c ./tests/runtests.py --verbosity 2 app", "body", "end"].join("\n");
    assert.equal(testOutputOf(runLog), "body\nend");
    assert.equal(testOutputOf("$ docker run image"), "");
  });

  test("testOutputOf keeps test output before a traceback that cites the runner", () => {
    const output = [
      "test_a (app.tests.Case) ... ok",
      "Traceback (most recent call last):",
      '  File "./tests/runtests.py", line 594, in <module>',
      "RuntimeError: boom",
    ];
    const runLog = ["$ docker exec -i c git apply -", "$ docker exec -i --env X=1 -w /testbed c ./tests/runtests.py --verbosity 2 app", ...output].join("\n");
    assert.equal(testOutputOf(runLog), output.join("\n"));
  });
});

describe("runLabelCheck", () => {
  test("runs each patch and test set in a fresh offline container and records every field", async () => {
    const { deps, calls } = makeDeps((args) => (isTestRun(args) ? { code: 1, stderr: LOG_FIXTURE } : {}));
    const { exitCode, outDir, report } = await runFake(deps);
    assert.equal(exitCode, 0);
    assert.ok(report);
    assert.equal(report.runner_note, RUNNER_NOTE);
    assert.match(report.runner_note, /this harness, not the official SWE-ABS runner/);
    assert.equal(report.runs.length, 6);
    assert.deepEqual(
      report.runs.map((entry) => [entry.patch_kind, entry.test_set, entry.repeat]),
      [
        ["candidate", "verified", 1],
        ["candidate", "verified", 2],
        ["candidate", "abs", 1],
        ["candidate", "abs", 2],
        ["official", "verified", 1],
        ["official", "abs", 1],
      ],
    );
    assert.deepEqual(report.runs[0], {
      instance_id: PATCH.instance_id,
      agent_id: "",
      patch_kind: "candidate",
      test_set: "verified",
      repeat: 1,
      exit_code: 1,
      timed_out: false,
      directives: ["app.tests"],
      directives_empty: false,
      tests_seen: LOG_TESTS,
      failed_tests: ["test_fail (app.tests.Case)", "test_error (app.tests.Case)"],
      expected_missing: ["test_absent (app.tests.Case)"],
      expected_failed: [],
    });
    assert.deepEqual(report.runs[2].directives, ["app.test_new"]);
    for (const entry of report.runs) {
      const name = `${entry.instance_id}.${entry.patch_kind}.${entry.test_set}.${entry.repeat}.log`;
      assert.match(readFileSync(join(outDir, "logs", name), "utf8"), /test_fail \(app\.tests\.Case\) \.\.\. FAIL/);
    }

    const starts = calls.filter((call) => call.args[0] === "run");
    const removals = calls.filter((call) => call.args[0] === "rm");
    assert.equal(starts.length, 6);
    assert.equal(removals.length, 6);
    const nameOf = (args: string[]) => args[args.indexOf("--name") + 1];
    assert.equal(new Set(starts.map((call) => nameOf(call.args))).size, 6);
    const first = starts[0].args;
    assert.deepEqual(first.slice(-3), ["swebench/image@sha256:abc", "sleep", "infinity"]);
    assert.ok(first.includes("-d"));
    assert.equal(first[first.indexOf("--network") + 1], "none");

    const firstRun = calls.slice(0, 5);
    const name = nameOf(first);
    assert.deepEqual(firstRun[1].args, ["exec", "-i", "-w", "/testbed", name, "git", "apply", "-"]);
    assert.equal(firstRun[1].stdin, CANDIDATE_APPLIED);
    assert.deepEqual(firstRun[2].args.slice(5), ["git", "checkout", "base123", "--", "tests/app/tests.py"]);
    assert.equal(firstRun[3].stdin, VERIFIED_PATCH);
    const testArgs = firstRun[4].args;
    const envs = REVIEWER_ENV.flatMap((assignment) => ["--env", assignment]);
    assert.deepEqual(testArgs, [
      "exec",
      "-i",
      ...envs,
      "-w",
      "/testbed",
      name,
      "./tests/runtests.py",
      "--verbosity",
      "2",
      "--settings=test_sqlite",
      "--parallel",
      "1",
      "app.tests",
    ]);
    assert.equal(firstRun[4].timeoutMs, RUN_TIMEOUT_MS);
    assert.equal(RUN_TIMEOUT_MS, 60 * 60_000);
    assert.equal(calls[5].args[0], "rm");
    assert.deepEqual(calls[5].args, ["rm", "-f", name]);
    assert.ok(calls.every((call) => !call.args.join(" ").includes("ANTHROPIC_API_KEY")));

    assert.ok(calls.some((call) => call.stdin === OFFICIAL_APPLIED));
    assert.ok(calls.some((call) => call.stdin === ABS_PATCH));
    const absRunCalls = calls.slice(calls.findIndex((call) => call.stdin === ABS_PATCH) - 1);
    assert.equal(absRunCalls[0].stdin, CANDIDATE_APPLIED);
  });

  test("records empty directives and runs the whole suite", async () => {
    const txtOnly = "diff --git a/tests/v/urls.txt b/tests/v/urls.txt\n--- a/tests/v/urls.txt\n+++ b/tests/v/urls.txt\n";
    const inputs: Inputs = {
      ...INPUTS,
      instances: {
        [PATCH.instance_id]: {
          abs_test_patch_sha256: sha256(ABS_PATCH),
          verified_test_patch_sha256: sha256(txtOnly),
          ...LIST_PINS,
        },
      },
    };
    const { deps, calls } = makeDeps(() => ({}), rowsPage([], { original_test_patch: txtOnly }));
    const outDir = mkdtempSync(join(tmpdir(), "label-check-"));
    await runLabelCheck({ outDir, repeats: 1, patches: [PATCH], inputs }, deps);
    const report = JSON.parse(readFileSync(join(outDir, REPORT_FILE), "utf8")) as { runs: RunRecord[] };
    assert.equal(report.runs[0].directives_empty, true);
    assert.deepEqual(report.runs[0].directives, []);
    const testRun = calls.find((call) => isTestRun(call.args));
    assert.ok(testRun);
    assert.equal(testRun.args.at(-1), "1");
  });

  test("records a patch that does not apply and continues, removing the container", async () => {
    let failures = 0;
    const { deps, calls } = makeDeps((_args, stdin) => {
      if (stdin === CANDIDATE_APPLIED && failures === 0) {
        failures += 1;
        return { code: 128, stderr: "error: patch failed" };
      }
      return {};
    });
    const { exitCode, outDir, report } = await runFake(deps);
    assert.equal(exitCode, 0);
    assert.ok(report);
    assert.equal(report.runs.length, 6);
    assert.equal(report.runs[0].exit_code, 128);
    assert.deepEqual(report.runs[0].tests_seen, []);
    assert.deepEqual(report.runs[0].expected_missing, EXPECTED);
    assert.equal(calls[2].args[0], "rm");
    const log = readFileSync(join(outDir, "logs", `${PATCH.instance_id}.candidate.verified.1.log`), "utf8");
    assert.match(log, /error: patch failed/);
  });

  test("a patch without a final newline is hash-checked raw and applied with one", async () => {
    const { deps, calls } = makeDeps((args, stdin) =>
      args.includes("apply") && !stdin?.endsWith("\n") ? { code: 128, stderr: "error: corrupt patch" } : {},
    );
    const { exitCode, report } = await runFake(deps);
    assert.equal(exitCode, 0);
    assert.ok(report);
    assert.ok(report.runs.every((record) => record.exit_code === 0));
    assert.equal(calls.filter((call) => isTestRun(call.args)).length, report.runs.length);
  });

  for (const patchKind of ["candidate", "official"] as const) {
    test(`git applies a ${patchKind} patch and test patch that lack a final newline`, async () => {
      const repo = mkdtempSync(join(tmpdir(), "label-check-repo-"));
      spawnSync("git", ["init", "-q", repo]);
      const newFile = (name: string, body: string) =>
        `diff --git a/${name} b/${name}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+${body}`;
      const testPatch = newFile("tests/app/tests.py", "y = 2");
      const exec: Exec = async (_command, args, options) => {
        const none = { code: 0, stdout: "", stderr: "", timedOut: false };
        if (args[0] !== "exec") return none;
        const argv = args.slice(args.findIndex((arg) => arg.startsWith("cr-label-check-")) + 1);
        if (argv[0] === "./tests/runtests.py") return { ...none, stderr: "t (app.tests.C) ... ok\n" };
        const result = spawnSync(argv[0], argv.slice(1), { cwd: repo, input: options.stdin ?? "", encoding: "utf8" });
        return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, timedOut: false };
      };
      const record = await executeRun(
        {
          input: {
            patch: PATCH,
            candidatePatch: newFile("candidate.py", "x = 1"),
            officialPatch: newFile("official.py", "x = 1"),
            testPatches: { verified: testPatch, abs: testPatch },
            expectedTests: [],
          },
          patchKind,
          testSet: "verified",
          repeat: 1,
          logsDir: mkdtempSync(join(tmpdir(), "label-check-logs-")),
        },
        { exec, fetch, sleep: async () => {}, warn: () => {} },
      );
      assert.equal(record.exit_code, 0);
      assert.deepEqual(record.tests_seen, ["t (app.tests.C)"]);
    });
  }

  test("records a timeout and continues", async () => {
    let timeouts = 0;
    const { deps } = makeDeps((args) => {
      if (isTestRun(args) && timeouts === 0) {
        timeouts += 1;
        return { code: 1, timedOut: true };
      }
      return {};
    });
    const { exitCode, report } = await runFake(deps);
    assert.equal(exitCode, 0);
    assert.ok(report);
    assert.equal(report.runs.length, 6);
    assert.equal(report.runs[0].timed_out, true);
    assert.equal(report.runs[1].timed_out, false);
  });

  test("exits non-zero when a run cannot be recorded, still removes it and continues", async () => {
    let thrown = false;
    const { deps, calls, warnings } = makeDeps((args) => {
      if (isTestRun(args) && !thrown) {
        thrown = true;
        throw new Error("spawn docker ENOENT");
      }
      return {};
    });
    const { exitCode, report } = await runFake(deps);
    assert.equal(exitCode, 1);
    assert.ok(report);
    assert.equal(report.runs.length, 5);
    assert.equal(calls.filter((call) => call.args[0] === "rm").length, 6);
    assert.match(warnings[0], /could not be recorded: spawn docker ENOENT/);
    assert.equal(report.verdicts[0].verified_pass, false);
  });

  test("a failed container removal warns and keeps the run", async () => {
    const { deps, warnings } = makeDeps((args) => (args[0] === "rm" ? { code: 1 } : {}));
    const { exitCode, report } = await runFake(deps);
    assert.equal(exitCode, 0);
    assert.equal(report?.runs.length, 6);
    assert.equal(warnings.length, 6);
  });

  for (const [label, page, deviate, refusal] of [
    ["a truncated row", rowsPage(["patch"]), false, /truncated/],
    ["a changed abs test patch", rowsPage([], { test_patch: "tampered" }), false, /abs test patch sha256 is/],
    ["a changed verified test patch", rowsPage([], { original_test_patch: "tampered" }), false, /verified test patch sha256 is/],
    ["a changed FAIL_TO_PASS list", rowsPage([], { FAIL_TO_PASS: "[]" }), false, /FAIL_TO_PASS sha256 is/],
    ["a changed PASS_TO_PASS list", rowsPage([], { PASS_TO_PASS: "[]" }), false, /PASS_TO_PASS sha256 is/],
    ["a changed official fix", rowsPage([], { patch: "tampered" }), false, /official fix sha256 is/],
    ["a changed candidate patch", rowsPage(), true, /candidate patch sha256 is/],
  ] as const) {
    test(`refuses ${label} before starting any container`, async () => {
      const { deps, calls } = makeDeps(() => ({}), page);
      if (deviate) deps.fetch = async (url) => new Response(url === CANDIDATE_URL ? "tampered" : page);
      await assert.rejects(runFake(deps), refusal);
      assert.equal(calls.length, 0);
    });
  }

  test("the CLI inputs pin both test lists for every smoke patch", () => {
    const pinned = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "checks", "label-check-inputs.json"), "utf8"),
    ) as Inputs;
    const patches = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "smoke", "smoke-patches.json"), "utf8"),
    ) as SmokePatch[];
    for (const patch of patches) assert.ok(Object.hasOwn(pinned.instances, patch.instance_id), patch.instance_id);
    for (const pins of Object.values(pinned.instances)) {
      assert.match(pins.fail_to_pass_sha256, /^[0-9a-f]{64}$/);
      assert.match(pins.pass_to_pass_sha256, /^[0-9a-f]{64}$/);
    }
  });

  test("a clean exit that reports no tests passes neither set and fails the control", async () => {
    const correct = { ...PATCH, label_stratum: "swe_abs_correct" };
    const { deps } = makeDeps(() => ({}));
    const outDir = mkdtempSync(join(tmpdir(), "label-check-"));
    const exitCode = await runLabelCheck({ outDir, repeats: 2, patches: [correct], inputs: INPUTS }, deps);
    assert.equal(exitCode, 0);
    const { verdicts } = JSON.parse(readFileSync(join(outDir, REPORT_FILE), "utf8")) as { verdicts: Verdict[] };
    assert.deepEqual(verdicts, [
      {
        instance_id: PATCH.instance_id,
        agent_id: "",
        label_stratum: "swe_abs_correct",
        verified_pass: false,
        abs_pass: false,
        repeats_agree: true,
        control_ok: false,
        matches_label: false,
        abs_failing_tests: [[], []],
        official_abs_failing_tests: [],
      },
    ]);
  });

  test("reads later rows pages and refuses when an instance is absent", async () => {
    const urls: string[] = [];
    const { deps } = makeDeps(() => ({}));
    const pages = [JSON.stringify({ rows: [{ row: { instance_id: "other__other-1" }, truncated_cells: [] }] }), rowsPage()];
    deps.fetch = async (url) => {
      if (url === CANDIDATE_URL) return new Response(CANDIDATE_PATCH);
      urls.push(url);
      return new Response(pages.shift() ?? JSON.stringify({ rows: [] }));
    };
    await runFake(deps);
    const offsets = urls.map((url) => new URL(url).searchParams);
    assert.deepEqual(offsets.map((params) => params.get("offset")), ["0", "1"]);
    assert.ok(offsets.every((params) => params.get("length") === "100"));
    assert.equal(offsets[0].get("dataset"), INPUTS.source.dataset);

    const { deps: emptyDeps } = makeDeps(() => ({}), JSON.stringify({ rows: [] }));
    await assert.rejects(runFake(emptyDeps), /still missing django__django-1/);
  });
});

describe("computeVerdicts", () => {
  const correct = { ...PATCH, label_stratum: "swe_abs_correct" };
  const failing = { exit_code: 1, failed_tests: ["t"] };

  test("a non-zero exit with no parsed failure never matches a label", () => {
    const unparsed = { exit_code: 1, failed_tests: [] };
    const wrong = computeVerdicts(caseRuns([unparsed, unparsed]), [PATCH], 2)[0];
    assert.equal(wrong.abs_pass, false);
    assert.equal(wrong.matches_label, false);
    const right = computeVerdicts(caseRuns([unparsed, unparsed]), [correct], 2)[0];
    assert.equal(right.matches_label, false);
  });

  test("a correct patch passes both test sets", () => {
    assert.deepEqual(computeVerdicts(caseRuns([{}, {}]), [correct], 2), [
      {
        instance_id: PATCH.instance_id,
        agent_id: "",
        label_stratum: "swe_abs_correct",
        verified_pass: true,
        abs_pass: true,
        repeats_agree: true,
        control_ok: true,
        matches_label: true,
        abs_failing_tests: [[], []],
        official_abs_failing_tests: [],
      },
    ]);
    assert.equal(computeVerdicts(caseRuns([{}, {}]), [PATCH], 2)[0].matches_label, false);
  });

  test("a wrong patch passes Verified and fails SWE-ABS", () => {
    const [verdict] = computeVerdicts(caseRuns([failing, failing]), [PATCH], 2);
    assert.deepEqual(verdict, {
      instance_id: PATCH.instance_id,
      agent_id: "",
      label_stratum: "swe_abs_wrong",
      verified_pass: true,
      abs_pass: false,
      repeats_agree: true,
      control_ok: true,
      matches_label: true,
      abs_failing_tests: [["t"], ["t"]],
      official_abs_failing_tests: [],
    });
    assert.equal(computeVerdicts(caseRuns([failing, failing]), [correct], 2)[0].matches_label, false);
  });

  test("a wrong label needs Verified to pass", () => {
    const [verdict] = computeVerdicts(
      caseRuns([failing, failing], {
        candidateVerified: [{ expected_missing: ["t"] }, { expected_missing: ["t"] }],
      }),
      [PATCH],
      2,
    );
    assert.equal(verdict.verified_pass, false);
    assert.equal(verdict.matches_label, false);
  });

  test("a broken SWE-ABS run does not count as a wrong patch's failure", () => {
    const broken: Record<string, Partial<RunRecord>> = {
      "zero tests seen": { exit_code: 1, tests_seen: [] },
      "timed out": { exit_code: 1, timed_out: true, failed_tests: ["a"] },
      "did not apply": { exit_code: 128, tests_seen: [] },
    };
    for (const [name, brokenRun] of Object.entries(broken)) {
      const [everyRepeat] = computeVerdicts(caseRuns([brokenRun, brokenRun]), [PATCH], 2);
      assert.equal(everyRepeat.verified_pass, true, name);
      assert.equal(everyRepeat.abs_pass, false, name);
      assert.equal(everyRepeat.matches_label, false, name);
      const [oneRepeat] = computeVerdicts(caseRuns([failing, brokenRun]), [PATCH], 2);
      assert.equal(oneRepeat.matches_label, false, name);
    }
  });

  test("a wrong patch needs every SWE-ABS repeat to fail", () => {
    assert.equal(computeVerdicts(caseRuns([failing, {}]), [PATCH], 2)[0].matches_label, false);
    const missing = caseRuns([failing, failing]).filter(
      (entry) => !(entry.test_set === "abs" && entry.repeat === 2),
    );
    assert.equal(computeVerdicts(missing, [PATCH], 2)[0].matches_label, false);
  });

  test("disagreeing repeats fail the set and clear repeats_agree", () => {
    const [verdict] = computeVerdicts(caseRuns([{}, failing]), [correct], 2);
    assert.equal(verdict.repeats_agree, false);
    assert.equal(verdict.abs_pass, false);
    assert.equal(verdict.matches_label, false);
    const [verifiedSplit] = computeVerdicts(
      caseRuns([{}, {}], { candidateVerified: [{}, { expected_failed: ["t"] }] }),
      [correct],
      2,
    );
    assert.equal(verifiedSplit.repeats_agree, false);
    assert.equal(verifiedSplit.verified_pass, false);
  });

  test("a failed control clears control_ok but not the candidate's fields", () => {
    const [verdict] = computeVerdicts(
      caseRuns([{}, {}], { official: { expected_failed: ["t"] } }),
      [correct],
      2,
    );
    assert.equal(verdict.control_ok, false);
    assert.equal(verdict.matches_label, true);
    const runs = caseRuns([{}, {}]).map((entry) =>
      entry.patch_kind === "official" && entry.test_set === "abs" ? { ...entry, timed_out: true } : entry,
    );
    assert.equal(computeVerdicts(runs, [correct], 2)[0].control_ok, false);
  });

  test("a missing repeat is not a pass", () => {
    const runs = caseRuns([{}, {}]).filter((entry) => entry.repeat !== 2);
    const [verdict] = computeVerdicts(runs, [correct], 2);
    assert.equal(verdict.verified_pass, false);
    assert.equal(verdict.abs_pass, false);
    assert.equal(verdict.repeats_agree, false);
  });

  test("zero tests seen is not a pass on either set", () => {
    const none = { tests_seen: [] };
    const [absNone] = computeVerdicts(caseRuns([none, none]), [correct], 2);
    assert.equal(absNone.abs_pass, false);
    assert.equal(absNone.verified_pass, true);
    assert.equal(absNone.matches_label, false);
    const [verifiedNone] = computeVerdicts(
      caseRuns([{}, {}], { candidateVerified: [none, none] }),
      [correct],
      2,
    );
    assert.equal(verifiedNone.verified_pass, false);
    assert.equal(verifiedNone.abs_pass, true);
    assert.equal(verifiedNone.matches_label, false);
    const [controlNone] = computeVerdicts(caseRuns([{}, {}], { official: none }), [correct], 2);
    assert.equal(controlNone.control_ok, false);
    assert.equal(computeVerdicts(caseRuns([{}, none]), [correct], 2)[0].abs_pass, false);
    assert.equal(computeVerdicts(caseRuns([{}, none]), [correct], 2)[0].repeats_agree, false);
  });

  test("verified_pass needs no timeout", () => {
    const late = { timed_out: true };
    const [verdict] = computeVerdicts(caseRuns([{}, {}], { candidateVerified: [late, late] }), [correct], 2);
    assert.equal(verdict.verified_pass, false);
    assert.equal(verdict.matches_label, false);
  });

  test("abs_pass needs exit 0 and no timeout", () => {
    assert.equal(computeVerdicts(caseRuns([{ exit_code: 1 }, { exit_code: 1 }]), [correct], 2)[0].abs_pass, false);
    assert.equal(computeVerdicts(caseRuns([{ timed_out: true }, { timed_out: true }]), [correct], 2)[0].abs_pass, false);
  });

  const withOfficialAbs = (runs: RunRecord[], failed: string[]) =>
    runs.map((entry) =>
      entry.patch_kind === "official" && entry.test_set === "abs"
        ? { ...entry, exit_code: 1, failed_tests: failed }
        : entry,
    );
  const absFailing = (failed: string[]) => ({ exit_code: 1, failed_tests: failed });

  test("a correct patch holds when its SWE-ABS failures are the official fix's own", () => {
    const runs = withOfficialAbs(caseRuns([absFailing(["y", "x"]), absFailing(["x", "y"])]), ["x", "y"]);
    const [verdict] = computeVerdicts(runs, [correct], 2);
    assert.equal(verdict.matches_label, true);
    assert.equal(verdict.control_ok, true);
    assert.equal(verdict.abs_pass, false);
    assert.deepEqual(verdict.abs_failing_tests, [["x", "y"], ["x", "y"]]);
    assert.deepEqual(verdict.official_abs_failing_tests, ["x", "y"]);
    const extra = withOfficialAbs(caseRuns([absFailing(["x"]), absFailing(["x", "z"])]), ["x"]);
    assert.equal(computeVerdicts(extra, [correct], 2)[0].matches_label, false);
  });

  test("a wrong patch needs a SWE-ABS failure the official fix passes", () => {
    const shared = withOfficialAbs(caseRuns([absFailing(["x"]), absFailing(["x"])]), ["x", "y"]);
    const [verdict] = computeVerdicts(shared, [PATCH], 2);
    assert.equal(verdict.matches_label, false);
    assert.equal(verdict.control_ok, true);
    const own = withOfficialAbs(caseRuns([absFailing(["x", "z"]), absFailing(["z"])]), ["x"]);
    assert.equal(computeVerdicts(own, [PATCH], 2)[0].matches_label, true);
    const oneRepeat = withOfficialAbs(caseRuns([absFailing(["x", "z"]), absFailing(["x"])]), ["x"]);
    assert.equal(computeVerdicts(oneRepeat, [PATCH], 2)[0].matches_label, false);
  });

  test("keys candidate runs by agent and shares the official runs", () => {
    const agentA = { ...PATCH, agent_id: "a" };
    const agentB = { ...PATCH, agent_id: "b" };
    const runs = [
      ...caseRuns([failing, failing]).map((entry) =>
        entry.patch_kind === "candidate" ? { ...entry, agent_id: "a" } : entry,
      ),
      ...caseRuns([{}, {}])
        .filter((entry) => entry.patch_kind === "candidate")
        .map((entry) => ({ ...entry, agent_id: "b" })),
    ];
    const verdicts = computeVerdicts(runs, [agentA, agentB], 2);
    assert.deepEqual(verdicts.map((verdict) => [verdict.agent_id, verdict.matches_label, verdict.control_ok]), [
      ["a", true, true],
      ["b", false, true],
    ]);
  });

  test("exclusions name each reason a patch fails", () => {
    const [flaky] = computeVerdicts(caseRuns([failing, { ...failing, failed_tests: ["u"] }]), [PATCH], 2);
    const [held] = computeVerdicts(caseRuns([failing, failing]), [PATCH], 2);
    assert.deepEqual(exclusionsOf([held, flaky]), [
      { instance_id: PATCH.instance_id, agent_id: "", reason: "repeats_disagree" },
    ]);
  });
});

function outcomeResponder(absFailures: Record<"candidate" | "official", string[]>) {
  const containers = new Map<string, { kind?: "candidate" | "official"; set?: "verified" | "abs" }>();
  return (args: string[], stdin?: string): ExecAnswer => {
    if (args[0] !== "exec") return {};
    const name = args[args.indexOf("/testbed") + 1];
    const state = containers.get(name) ?? {};
    containers.set(name, state);
    if (stdin === CANDIDATE_APPLIED) state.kind = "candidate";
    if (stdin === OFFICIAL_APPLIED) state.kind = "official";
    if (stdin === VERIFIED_PATCH) state.set = "verified";
    if (stdin === ABS_PATCH) state.set = "abs";
    if (!isTestRun(args)) return {};
    if (state.set === "verified") return { stderr: EXPECTED.map((testName) => `${testName} ... ok`).join("\n") };
    const failures = absFailures[state.kind ?? "candidate"];
    const lines = [
      "test_new_a (app.test_new.Case) ... ok",
      ...failures.map((testName) => `${testName} ... FAIL`),
      ...failures.map((testName) => `FAIL: ${testName}`),
    ];
    return { code: failures.length > 0 ? 1 : 0, stderr: lines.join("\n") };
  };
}

describe("label check on a patch list", () => {
  const OWN_FAILURE = "test_new_b (app.test_new.Case)";
  const agentA = { ...PATCH, agent_id: "agent-a" };
  const agentB = { ...PATCH, agent_id: "agent/b" };

  async function runAgents(jobs: number) {
    const { deps, calls } = makeDeps(outcomeResponder({ candidate: [OWN_FAILURE], official: [] }));
    const inner = deps.exec;
    let inFlight = 0;
    let peak = 0;
    deps.exec = async (command, args, options) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      try {
        return await inner(command, args, options);
      } finally {
        inFlight -= 1;
      }
    };
    const outDir = mkdtempSync(join(tmpdir(), "label-check-"));
    const exitCode = await runLabelCheck({ outDir, repeats: 2, patches: [agentA, agentB], inputs: INPUTS, jobs }, deps);
    const report = JSON.parse(readFileSync(join(outDir, REPORT_FILE), "utf8")) as { runs: RunRecord[]; verdicts: Verdict[] };
    const exclusions = JSON.parse(readFileSync(join(outDir, EXCLUSIONS_FILE), "utf8")) as Exclusion[];
    return { exitCode, outDir, report, exclusions, calls, peak };
  }

  test("two agents on one instance get two verdicts and one shared set of official runs", async () => {
    const { exitCode, outDir, report, exclusions, calls } = await runAgents(1);
    assert.equal(exitCode, 0);
    assert.deepEqual(
      report.runs.map((entry) => [entry.agent_id, entry.patch_kind, entry.test_set, entry.repeat]),
      [
        ["agent-a", "candidate", "verified", 1],
        ["agent-a", "candidate", "verified", 2],
        ["agent-a", "candidate", "abs", 1],
        ["agent-a", "candidate", "abs", 2],
        ["agent/b", "candidate", "verified", 1],
        ["agent/b", "candidate", "verified", 2],
        ["agent/b", "candidate", "abs", 1],
        ["agent/b", "candidate", "abs", 2],
        [null, "official", "verified", 1],
        [null, "official", "abs", 1],
      ],
    );
    assert.equal(calls.filter((call) => call.args[0] === "run").length, 10);
    assert.deepEqual(
      report.verdicts.map((verdict) => [verdict.agent_id, verdict.matches_label, verdict.control_ok, verdict.abs_failing_tests]),
      [
        ["agent-a", true, true, [[OWN_FAILURE], [OWN_FAILURE]]],
        ["agent/b", true, true, [[OWN_FAILURE], [OWN_FAILURE]]],
      ],
    );
    for (const name of [
      "django__django-1.agent-a.candidate.abs.2.log",
      "django__django-1.agent_b.candidate.abs.2.log",
      "django__django-1.official.abs.1.log",
    ]) {
      assert.ok(existsSync(join(outDir, "logs", name)), name);
    }
    assert.deepEqual(exclusions, []);
  });

  test("reverdict rebuilds the same report from the saved logs", async () => {
    const first = await runAgents(1);
    const outDir = mkdtempSync(join(tmpdir(), "label-check-"));
    const { deps } = makeDeps(() => ({}));
    await runReverdict(
      { reportPath: join(first.outDir, REPORT_FILE), logsDir: join(first.outDir, "logs"), outDir, repeats: 2, inputs: INPUTS },
      deps,
    );
    assert.deepEqual(JSON.parse(readFileSync(join(outDir, REPORT_FILE), "utf8")), first.report);
    assert.deepEqual(JSON.parse(readFileSync(join(outDir, EXCLUSIONS_FILE), "utf8")), first.exclusions);
  });

  test("--jobs runs containers at once and keeps the report order", async () => {
    const sequential = await runAgents(1);
    const parallel = await runAgents(3);
    assert.equal(sequential.peak, 1);
    assert.ok(parallel.peak > 1 && parallel.peak <= 3, `peak ${parallel.peak}`);
    assert.equal(parallel.exitCode, 0);
    assert.deepEqual(parallel.report, sequential.report);
  });

  test("a label mismatch and a failed control go to exclusions.json with exit 0", async () => {
    const { deps } = makeDeps(() => ({}));
    const outDir = mkdtempSync(join(tmpdir(), "label-check-"));
    const exitCode = await runLabelCheck({ outDir, repeats: 2, patches: [agentA], inputs: INPUTS }, deps);
    assert.equal(exitCode, 0);
    const exclusions = JSON.parse(readFileSync(join(outDir, EXCLUSIONS_FILE), "utf8")) as Exclusion[];
    assert.deepEqual(exclusions, [
      { instance_id: PATCH.instance_id, agent_id: "agent-a", reason: "label_mismatch,control_failed" },
    ]);
  });

  test("refuses a patch list that repeats an instance and agent", async () => {
    const { deps, calls } = makeDeps(() => ({}));
    await assert.rejects(
      runLabelCheck({ outDir: mkdtempSync(join(tmpdir(), "label-check-")), repeats: 1, patches: [agentA, agentA], inputs: INPUTS }, deps),
      /repeats django__django-1 agent-a/,
    );
    assert.equal(calls.length, 0);
  });
});

describe("parseCli", () => {
  const checks = join(import.meta.dirname, "..", "checks");
  const smokePatches = join(import.meta.dirname, "..", "smoke", "smoke-patches.json");

  test("defaults to the smoke patches, the committed inputs and one job", () => {
    assert.deepEqual(parseCli(["--out", "o"]), {
      command: "run",
      outDir: "o",
      repeats: 3,
      patchesPath: smokePatches,
      inputsPath: join(checks, "label-check-inputs.json"),
      jobs: 1,
    });
  });

  test("reads --patches, --inputs and --jobs", () => {
    assert.deepEqual(parseCli(["--out", "o", "--repeats", "2", "--patches", "p.json", "--inputs", "i.json", "--jobs", "4"]), {
      command: "run",
      outDir: "o",
      repeats: 2,
      patchesPath: "p.json",
      inputsPath: "i.json",
      jobs: 4,
    });
    assert.throws(() => parseCli(["--out", "o", "--jobs", "0"]), /usage/);
    assert.throws(() => parseCli(["--repeats", "2"]), /usage/);
  });

  test("parses pin", () => {
    assert.deepEqual(parseCli(["pin", "--patches", "p.json", "--out", "i.json"]), {
      command: "pin",
      patchesPath: "p.json",
      outPath: "i.json",
      fromPath: join(checks, "label-check-inputs.json"),
    });
    assert.equal((parseCli(["pin", "--patches", "p", "--out", "o", "--from", "f"]) as { fromPath: string }).fromPath, "f");
    assert.throws(() => parseCli(["pin", "--out", "o"]), /usage/);
    assert.throws(() => parseCli(["other", "--out", "o"]), /usage/);
  });

  test("parses reverdict", () => {
    assert.deepEqual(parseCli(["reverdict", "--report", "r.json", "--logs", "l", "--out", "o"]), {
      command: "reverdict",
      reportPath: "r.json",
      logsDir: "l",
      outDir: "o",
      repeats: 3,
      inputsPath: join(checks, "label-check-inputs.json"),
    });
    assert.throws(() => parseCli(["reverdict", "--logs", "l", "--out", "o"]), /usage/);
    assert.throws(() => parseCli(["reverdict", "--report", "r.json", "--out", "o"]), /usage/);
  });
});

describe("pin", () => {
  const SECOND = "django__django-2";
  const secondRow = {
    instance_id: SECOND,
    patch: "second official",
    test_patch: "second abs",
    original_test_patch: "second verified",
    FAIL_TO_PASS: "[\"f\"]",
    PASS_TO_PASS: "[\"p\"]",
  };
  const page = JSON.stringify({
    rows: [...(JSON.parse(rowsPage()) as { rows: unknown[] }).rows, { row: secondRow, truncated_cells: [] }],
  });
  const patches: SmokePatch[] = [
    { ...PATCH, agent_id: "a" },
    { ...PATCH, agent_id: "b" },
    { ...PATCH, instance_id: SECOND, agent_id: "a", gold_patch_sha256: sha256(secondRow.patch) },
  ];
  const kept = INPUTS.instances[PATCH.instance_id];

  function files(from: Inputs) {
    const dir = mkdtempSync(join(tmpdir(), "label-check-pin-"));
    const paths = { patchesPath: join(dir, "patches.json"), fromPath: join(dir, "from.json"), outPath: join(dir, "out.json") };
    writeFileSync(paths.patchesPath, JSON.stringify(patches));
    writeFileSync(paths.fromPath, JSON.stringify(from));
    return paths;
  }

  const fetcher = { fetch: async () => new Response(page), sleep: async () => {} };

  test("writes an entry for every instance in the patch list, merged with the existing ones", async () => {
    const paths = files({ source: INPUTS.source, instances: { "django__django-9": kept } });
    await runPin(paths, fetcher);
    const pinned = JSON.parse(readFileSync(paths.outPath, "utf8")) as Inputs;
    assert.deepEqual(pinned.source, INPUTS.source);
    assert.deepEqual(pinned.instances, {
      "django__django-9": kept,
      [PATCH.instance_id]: kept,
      [SECOND]: {
        abs_test_patch_sha256: sha256(secondRow.test_patch),
        verified_test_patch_sha256: sha256(secondRow.original_test_patch),
        fail_to_pass_sha256: sha256(secondRow.FAIL_TO_PASS),
        pass_to_pass_sha256: sha256(secondRow.PASS_TO_PASS),
      },
    });

    const again = files(pinned);
    await runPin(again, fetcher);
    assert.deepEqual(JSON.parse(readFileSync(again.outPath, "utf8")), pinned);
  });

  test("refuses when an existing entry's hash does not match", async () => {
    const paths = files({
      source: INPUTS.source,
      instances: { [SECOND]: { ...kept, abs_test_patch_sha256: sha256("other") } },
    });
    await assert.rejects(runPin(paths, fetcher), /django__django-2 abs test patch sha256 is/);
    assert.equal(existsSync(paths.outPath), false);
  });

  test("refuses when the official fix does not match the patch list", async () => {
    const paths = files({ source: INPUTS.source, instances: {} });
    const tampered = JSON.stringify({ rows: [{ row: { ...secondRow, patch: "tampered" }, truncated_cells: [] }, ...(JSON.parse(rowsPage()) as { rows: unknown[] }).rows] });
    await assert.rejects(runPin(paths, { ...fetcher, fetch: async () => new Response(tampered) }), /django__django-2 official fix sha256 is/);
    assert.equal(existsSync(paths.outPath), false);
  });
});
