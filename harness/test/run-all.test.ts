import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import "./gcp-test-infra.ts";

import { runAll, type RunAllOptions } from "../checks/run-all.ts";
import { CONDITION_USAGE, INFRA, type Exec, type ExecOptions } from "../gcp/common.ts";
import { runLauncher } from "../gcp/launch.ts";
import { renderStartupScript } from "../gcp/startup-script.ts";
import { BATCH_BUDGET_USD, BudgetMeter, parseBatchCli } from "../smoke/run-batch.ts";

const SECRET = "sk-fake-key";
const RUN_ID = "20261101t120000z-abc1234";
const CHECKPOINT = "sync-command";
const CHECKS_ENTRY = "harness/checks/run-all.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "run-all-test-"));
}

interface Call {
  argv: string[];
  options?: ExecOptions;
}

function stepName(argv: string[]): string | null {
  if (argv[0] === "sh") return "checkpoint";
  if (argv.includes("harness/checks/recall.ts")) return "recall";
  if (argv.includes("harness/smoke/run-batch.ts")) return "pilot";
  if (argv.includes("harness/checks/label-check.ts")) return "label-check";
  return null;
}

function writeRecallSummary(outDir: string, spent: unknown): void {
  mkdirSync(join(outDir, "recall"), { recursive: true });
  writeFileSync(join(outDir, "recall", "summary.json"), JSON.stringify({ spent_usd: spent }));
}

function fixture(
  overrides: Partial<RunAllOptions> = {},
  behaviour: { exits?: Record<string, number>; recallSpent?: unknown } = {},
) {
  const outDir = overrides.outDir ?? tempDir();
  const calls: Call[] = [];
  const logs: string[] = [];
  const exec: Exec = (argv, options) => {
    calls.push({ argv, options });
    const name = stepName(argv);
    if (name === "recall" && behaviour.recallSpent !== undefined) writeRecallSummary(outDir, behaviour.recallSpent);
    return { code: behaviour.exits?.[name ?? ""] ?? 0, stdout: "", stderr: `boom ${SECRET}` };
  };
  let tick = 0;
  const deps = {
    exec,
    log: (line: string) => logs.push(line),
    now: () => new Date(Date.UTC(2026, 10, 1, 12, 0, tick++)),
    env: { ANTHROPIC_API_KEY: SECRET, PATH: "/bin" },
    codeDir: "/code",
    nodePath: "/node",
  };
  const options: RunAllOptions = {
    runId: RUN_ID,
    condition: "cr-tests-claude-opus-5.5",
    seed: "7",
    vmType: "e2-standard-4",
    outDir,
    checkpointCmd: CHECKPOINT,
    resumeFrom: null,
    patches: null,
    ...overrides,
  };
  const argvOf = (name: string) => calls.find(({ argv }) => stepName(argv) === name)?.argv as string[];
  const report = () => JSON.parse(readFileSync(join(outDir, "run-all.json"), "utf8"));
  return { outDir, calls, logs, deps, options, argvOf, report };
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

describe("run-all order and arguments", () => {
  test("runs recall, pilot, label check, with a checkpoint after each", () => {
    const run = fixture({}, { recallSpent: 1 });
    assert.equal(runAll(run.options, run.deps), 0);
    assert.deepEqual(
      run.calls.map(({ argv }) => stepName(argv)),
      ["recall", "checkpoint", "pilot", "checkpoint", "label-check", "checkpoint"],
    );
  });

  test("passes each step its arguments through this node binary", () => {
    const run = fixture({}, { recallSpent: 1 });
    runAll(run.options, run.deps);
    assert.deepEqual(run.argvOf("recall"), [
      "/node",
      "harness/checks/recall.ts",
      "--out",
      join(run.outDir, "recall"),
      "--patches",
      "harness/checks/pilot-patches.json",
    ]);
    const pilot = run.argvOf("pilot");
    assert.equal(pilot[0], "/node");
    assert.equal(flag(pilot, "--patches"), "harness/checks/pilot-patches.json");
    assert.equal(flag(pilot, "--review-reserve-usd"), "1");
    assert.equal(flag(pilot, "--out"), join(run.outDir, "pilot"));
    assert.equal(flag(pilot, "--run-id"), RUN_ID);
    assert.equal(flag(pilot, "--condition"), "cr-tests-claude-opus-5.5");
    assert.equal(pilot.indexOf("--condition"), pilot.indexOf("--run-id") + 2);
    assert.equal(flag(pilot, "--seed"), "7");
    assert.equal(flag(pilot, "--vm-type"), "e2-standard-4");
    assert.equal(flag(pilot, "--checkpoint-cmd"), CHECKPOINT);
    assert.equal(flag(pilot, "--resume-from"), undefined);
    assert.deepEqual(run.argvOf("label-check"), [
      "/node",
      "harness/checks/label-check.ts",
      "--out",
      join(run.outDir, "label-check"),
    ]);
  });

  test("steps get the key and run in the code dir; the checkpoint never gets the key", () => {
    const run = fixture({}, { recallSpent: 1, exits: { checkpoint: 1 } });
    assert.equal(runAll(run.options, run.deps), 0);
    for (const { argv, options } of run.calls) {
      if (stepName(argv) === "checkpoint") {
        assert.equal(options?.env?.ANTHROPIC_API_KEY, undefined);
      } else {
        assert.equal(options?.env?.ANTHROPIC_API_KEY, SECRET);
        assert.equal(options?.cwd, "/code");
      }
    }
  });

  test("a failing checkpoint is logged scrubbed and never prints the key", () => {
    const run = fixture({}, { recallSpent: 1, exits: { checkpoint: 1 } });
    runAll(run.options, run.deps);
    assert.ok(run.logs.some((line) => line.includes("checkpoint exited 1")));
    assert.ok(!run.logs.join("\n").includes(SECRET));
    assert.ok(!readFileSync(join(run.outDir, "run-all.json"), "utf8").includes(SECRET));
  });

  test("run-all.json is on disk before each checkpoint", () => {
    const outDir = tempDir();
    const seen: number[] = [];
    const run = fixture({ outDir }, { recallSpent: 1 });
    const exec: Exec = (argv, options) => {
      if (stepName(argv) === "checkpoint") seen.push(run.report().steps.length);
      return run.deps.exec(argv, options);
    };
    runAll(run.options, { ...run.deps, exec });
    assert.deepEqual(seen, [1, 2, 3]);
  });
});

describe("run-all with a patch list", () => {
  const PATCHES = "harness/checks/check-patches.json";

  test("runs recall and label check on the list, with no pilot step", () => {
    const run = fixture({ patches: PATCHES }, { recallSpent: 3 });
    assert.equal(runAll(run.options, run.deps), 0);
    assert.deepEqual(
      run.calls.map(({ argv }) => stepName(argv)),
      ["recall", "checkpoint", "label-check", "checkpoint"],
    );
    assert.deepEqual(run.argvOf("recall"), [
      "/node",
      "harness/checks/recall.ts",
      "--out",
      join(run.outDir, "recall"),
      "--patches",
      PATCHES,
    ]);
    assert.deepEqual(run.argvOf("label-check"), [
      "/node",
      "harness/checks/label-check.ts",
      "--out",
      join(run.outDir, "label-check"),
      "--patches",
      PATCHES,
      "--jobs",
      "4",
    ]);
    const report = run.report();
    assert.deepEqual(report.steps.map((step: { name: string }) => step.name), ["recall", "label-check"]);
    assert.equal(report.recall_spent_usd, 3);
    assert.equal(report.pilot_budget_usd, null);
  });

  test("a failing recall still runs the label check and exits non-zero", () => {
    const run = fixture({ patches: PATCHES }, { exits: { recall: 2 } });
    assert.equal(runAll(run.options, run.deps), 1);
    assert.ok(run.argvOf("label-check"));
    assert.equal(run.argvOf("pilot"), undefined);
  });

  for (const flag of [
    [],
    ["--condition", "c"],
    ["--condition", "cr-tests-claude-opus-5-5"],
    ["--condition", "cr-unknown"],
    ["--condition", ""],
  ]) {
    test(`the CLI refuses ${flag.length === 0 ? "a missing condition" : `condition ${JSON.stringify(flag[1])}`} with exit 2 and the valid study IDs`, () => {
      const outDir = tempDir();
      const child = spawnSync(
        process.execPath,
        [join(import.meta.dirname, "..", "checks", "run-all.ts"), "--run-id", RUN_ID, ...flag, "--seed", "1", "--vm-type", "v", "--out", outDir],
        { encoding: "utf8" },
      );
      assert.equal(child.status, 2);
      assert.ok(child.stderr.includes("usage: "), child.stderr);
      assert.ok(child.stderr.includes(CONDITION_USAGE), child.stderr);
      assert.ok(!existsSync(join(outDir, "run-all.json")));
    });
  }

  test("the CLI refuses an empty --patches with its usage line", () => {
    const outDir = tempDir();
    const child = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "..", "checks", "run-all.ts"),
        "--run-id",
        RUN_ID,
        "--condition",
        "c",
        "--seed",
        "1",
        "--vm-type",
        "v",
        "--out",
        outDir,
        "--patches",
        "",
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 2);
    assert.match(child.stderr, /\[--patches <path>\]/);
  });
});

describe("run-all.json", () => {
  test("every field is populated on a fake run", () => {
    const run = fixture({}, { recallSpent: 2.5 });
    runAll(run.options, run.deps);
    const report = run.report();
    assert.equal(report.recall_spent_usd, 2.5);
    assert.equal(report.pilot_budget_usd, 7.5);
    assert.deepEqual(report.steps.map((step: { name: string }) => step.name), ["recall", "pilot", "label-check"]);
    for (const step of report.steps) {
      assert.equal(step.exit_code, 0);
      assert.ok(!Number.isNaN(Date.parse(step.started_at)));
      assert.ok(Date.parse(step.finished_at) > Date.parse(step.started_at));
    }
  });
});

describe("pilot budget arithmetic", () => {
  const budgetFor = (behaviour: { exits?: Record<string, number>; recallSpent?: unknown }) => {
    const run = fixture({}, behaviour);
    runAll(run.options, run.deps);
    return { flagged: flag(run.argvOf("pilot"), "--batch-budget-usd"), report: run.report() };
  };

  test("the pilot gets 10 minus what recall spent", () => {
    assert.equal(budgetFor({ recallSpent: 3.25 }).flagged, "6.75");
  });

  test("a failed recall with a readable spend still uses that spend", () => {
    const { flagged } = budgetFor({ recallSpent: 2, exits: { recall: 1 } });
    assert.equal(flagged, "8");
  });

  for (const [name, recallSpent] of [
    ["no summary", undefined],
    ["a non-numeric spend", "lots"],
    ["a negative spend", -1],
  ] as const) {
    test(`a failed recall with ${name} assumes $5`, () => {
      const { flagged, report } = budgetFor({ recallSpent, exits: { recall: 1 } });
      assert.equal(flagged, "5");
      assert.equal(report.recall_spent_usd, 5);
      assert.equal(report.pilot_budget_usd, 5);
    });
  }

  test("recall spending the whole ceiling gets a budget run-batch refuses", () => {
    const { flagged } = budgetFor({ recallSpent: 10 });
    assert.equal(flagged, "0");
    assert.throws(
      () => parseBatchCli(["--run-id", "r", "--condition", "cr-effort-claude-opus-5.5", "--seed", "1", "--vm-type", "v", "--out", tempDir(), "--batch-budget-usd", "0", "--fake"], {}),
      /positive number/,
    );
  });
});

describe("failed-step continuation", () => {
  for (const failing of ["recall", "pilot", "label-check"]) {
    test(`a failing ${failing} is recorded, later steps run and run-all exits non-zero`, () => {
      const run = fixture({}, { recallSpent: 1, exits: { [failing]: 3 } });
      assert.equal(runAll(run.options, run.deps), 1);
      const report = run.report();
      assert.deepEqual(
        report.steps.map((step: { name: string; exit_code: number }) => [step.name, step.exit_code]),
        ["recall", "pilot", "label-check"].map((name) => [name, name === failing ? 3 : 0]),
      );
    });
  }
});

describe("resume", () => {
  function priorRun(exits: Record<string, number>, extra: object = {}): string {
    const dir = tempDir();
    const steps = ["recall", "pilot", "label-check"].map((name) => {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "marker.txt"), name);
      return {
        name,
        exit_code: exits[name] ?? 0,
        started_at: "2026-10-31T00:00:00.000Z",
        finished_at: "2026-10-31T00:01:00.000Z",
      };
    });
    writeRecallSummary(dir, 2);
    writeFileSync(join(dir, "run-all.json"), JSON.stringify({ steps, recall_spent_usd: 2, pilot_budget_usd: 8, ...extra }));
    return dir;
  }

  test("a step that passed is copied and skipped, keeping its record", () => {
    const prior = priorRun({ pilot: 1, "label-check": 1 });
    const run = fixture({ resumeFrom: prior });
    assert.equal(runAll(run.options, run.deps), 0);
    assert.equal(run.argvOf("recall"), undefined);
    assert.equal(readFileSync(join(run.outDir, "recall", "marker.txt"), "utf8"), "recall");
    const report = run.report();
    assert.equal(report.steps[0].started_at, "2026-10-31T00:00:00.000Z");
    assert.equal(report.recall_spent_usd, 2);
    assert.equal(flag(run.argvOf("pilot"), "--batch-budget-usd"), "8");
    assert.equal(run.calls.filter(({ argv }) => stepName(argv) === "checkpoint").length, 3);
  });

  test("a pilot that failed resumes from its prior directory", () => {
    const prior = priorRun({ pilot: 1 });
    const run = fixture({ resumeFrom: prior });
    runAll(run.options, run.deps);
    assert.equal(flag(run.argvOf("pilot"), "--resume-from"), join(prior, "pilot"));
    assert.ok(!existsSync(join(run.outDir, "pilot", "marker.txt")));
    assert.equal(run.argvOf("label-check"), undefined);
  });

  test("a pilot with no prior directory gets no --resume-from", () => {
    const dir = tempDir();
    const run = fixture({ resumeFrom: dir }, { recallSpent: 1 });
    runAll(run.options, run.deps);
    assert.ok(run.argvOf("recall"));
    assert.equal(flag(run.argvOf("pilot"), "--resume-from"), undefined);
  });

  test("a pilot that passed before keeps its prior budget and is not run", () => {
    const prior = priorRun({ recall: 1 });
    const run = fixture({ resumeFrom: prior }, { recallSpent: 4 });
    assert.equal(runAll(run.options, run.deps), 0);
    assert.equal(run.argvOf("pilot"), undefined);
    assert.equal(run.report().pilot_budget_usd, 8);
    assert.equal(run.report().recall_spent_usd, 4);
  });

  test("a prior pass whose directory is missing runs again", () => {
    const dir = tempDir();
    const steps = [{ name: "label-check", exit_code: 0, started_at: "a", finished_at: "b" }];
    writeFileSync(join(dir, "run-all.json"), JSON.stringify({ steps }));
    const run = fixture({ resumeFrom: dir }, { recallSpent: 1 });
    assert.equal(runAll(run.options, run.deps), 0);
    assert.ok(run.argvOf("label-check"));
  });

  test("an unreadable prior run-all.json counts as no prior", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "run-all.json"), "not json");
    const run = fixture({ resumeFrom: dir }, { recallSpent: 1 });
    assert.equal(runAll(run.options, run.deps), 0);
    assert.ok(run.argvOf("recall"));
  });
});

describe("entry allowlist", () => {
  const REFUSED = [
    "harness/run-review.ts",
    "../run-all.ts",
    "harness/checks/run-all.ts ",
    "harness/checks/run-all.ts;reboot",
    "./harness/smoke/run-batch.ts",
    "",
  ];

  for (const entry of REFUSED) {
    test(`refuses ${JSON.stringify(entry)} everywhere`, () => {
      const errors: string[] = [];
      const code = runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--entry", entry], {
        exec: () => assert.fail("a refused entry must run nothing"),
        out: () => {},
        err: (line) => errors.push(line),
        now: () => new Date(),
        repoRoot: "/repo",
        infra: INFRA,
      });
      assert.equal(code, 2);
      assert.match(errors.join("\n"), /usage/);

      assert.throws(
        () => renderStartupScript({ runId: RUN_ID, condition: "cr-effort-claude-opus-5.5" as const, seed: "7", bucket: "b", machineType: "m", entry }),
        /invalid entry/,
      );

      const vmRun = spawnSync(
        process.execPath,
        [
          join(import.meta.dirname, "..", "gcp", "vm-run.ts"),
          "run",
          "--run-id",
          RUN_ID,
          "--condition",
          "c",
          "--seed",
          "7",
          "--vm-type",
          "m",
          "--bucket",
          "b",
          "--work",
          tempDir(),
          "--entry",
          entry,
        ],
        { encoding: "utf8" },
      );
      assert.equal(vmRun.status, 2);
    });
  }

  test("the startup script carries the checks entry and omits the default", () => {
    const base = { runId: RUN_ID, condition: "cr-effort-claude-opus-5.5" as const, seed: "7", bucket: "b", machineType: "m" };
    assert.ok(renderStartupScript({ ...base, entry: CHECKS_ENTRY }).includes(` --entry ${CHECKS_ENTRY}\n`));
    assert.equal(renderStartupScript({ ...base, entry: "harness/smoke/run-batch.ts" }), renderStartupScript(base));
  });
});

describe("launch.ts with an entry", () => {
  const OK = { code: 0, stdout: "", stderr: "" };

  function launch(args: string[], respond: (argv: string[]) => { code: number; stdout: string; stderr: string } | undefined = () => undefined) {
    const calls: string[][] = [];
    const errors: string[] = [];
    const exec: Exec = (argv) => {
      calls.push(argv);
      const override = respond(argv);
      if (override) return override;
      if (argv.includes("rev-parse")) return { ...OK, stdout: "abc1234\n" };
      if (argv.includes("for-each-ref")) return { ...OK, stdout: "refs/remotes/origin/dev\n" };
      if (argv.includes("versions")) return { ...OK, stdout: "1\n" };
      if (argv.includes("instances") && argv.includes("list")) return { ...OK, stdout: "[]" };
      return OK;
    };
    const code = runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--yes", ...args], {
      exec,
      out: () => {},
      err: (line) => errors.push(line),
      now: () => new Date(Date.UTC(2026, 10, 1)),
      repoRoot: "/repo",
      infra: INFRA,
    });
    return { code, calls, errors, create: calls.find((argv) => argv.includes("create")) };
  }

  test("the checks entry gets a 200 GB disk and its metadata", () => {
    const { code, create, calls } = launch(["--entry", CHECKS_ENTRY]);
    assert.equal(code, 0);
    assert.ok(create?.includes("--boot-disk-size=200GB"));
    assert.ok(create?.some((arg) => arg.startsWith("--metadata=") && arg.endsWith(`,entry=${CHECKS_ENTRY}`)));
    assert.ok(calls.some((argv) => argv.includes(`HEAD:${CHECKS_ENTRY}`)));
  });

  for (const args of [[], ["--entry", "harness/smoke/run-batch.ts"]]) {
    test(`the batch entry keeps the 100 GB disk with args ${JSON.stringify(args)}`, () => {
      const { create } = launch(args);
      assert.ok(create?.includes("--boot-disk-size=100GB"));
      assert.ok(!create?.join(" ").includes("entry="));
    });
  }

  test("refuses when the chosen entry is not at HEAD", () => {
    const { code, errors, create } = launch(["--entry", CHECKS_ENTRY], (argv) =>
      argv.includes(`HEAD:${CHECKS_ENTRY}`) ? { ...OK, code: 1 } : undefined,
    );
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /harness\/checks\/run-all\.ts does not exist at HEAD/);
    assert.equal(create, undefined);
  });

  test("a checks resume looks for the prior run-all.json, not a preflight report", () => {
    const { code, calls } = launch(["--entry", CHECKS_ENTRY, "--resume-from", RUN_ID]);
    assert.equal(code, 0);
    const listed = calls.filter((argv) => argv.includes("ls")).flat().join(" ");
    assert.ok(listed.includes(`runs/${RUN_ID}/run-all.json`));
    assert.ok(!listed.includes("preflight-report.json"));
  });

  test("--entry belongs to start only", () => {
    const code = runLauncher(["status", "--entry", CHECKS_ENTRY], {
      exec: () => assert.fail("nothing runs"),
      out: () => {},
      err: () => {},
      now: () => new Date(),
      repoRoot: "/repo",
      infra: INFRA,
    });
    assert.equal(code, 2);
  });
});

describe("run-batch flags", () => {
  const base = ["--run-id", "r", "--condition", "cr-effort-claude-opus-5.5", "--seed", "1", "--vm-type", "v", "--fake"];

  test("defaults stay on the smoke route", () => {
    const parsed = parseBatchCli([...base, "--out", tempDir()], {});
    assert.equal(parsed.batchBudgetUsd, BATCH_BUDGET_USD);
    assert.match(parsed.patchesPath, /smoke-patches\.json$/);
  });

  for (const budget of ["0", "abc", "-1", "1e3", "Infinity", ""]) {
    test(`refuses --batch-budget-usd ${JSON.stringify(budget)}`, () => {
      assert.throws(() => parseBatchCli([...base, "--out", tempDir(), `--batch-budget-usd=${budget}`], {}), /positive number/);
    });
  }

  test("refuses a patches file that does not exist", () => {
    assert.throws(() => parseBatchCli([...base, "--out", tempDir(), "--patches", "/no/such.json"], {}), /does not exist/);
  });

  test("a fake batch uses the given patches and budget in its meter and reports", () => {
    const out = tempDir();
    const patchesPath = join(tempDir(), "two.json");
    const smoke = JSON.parse(readFileSync(join(import.meta.dirname, "..", "smoke", "smoke-patches.json"), "utf8"));
    writeFileSync(patchesPath, JSON.stringify(smoke.slice(0, 2)));
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "..", "smoke", "run-batch.ts"),
        ...base,
        "--out",
        out,
        "--patches",
        patchesPath,
        "--batch-budget-usd",
        "6",
        "--fake-cost-usd",
        "4",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    const preflight = JSON.parse(readFileSync(join(out, "preflight-report.json"), "utf8"));
    assert.equal(summary.stop_reason, "budget_stop");
    assert.equal(summary.batch_budget_usd, 6);
    assert.equal(summary.dispatched, 1);
    assert.equal(summary.planned, 6);
    assert.equal(preflight.batch_budget_usd, 6);
    assert.equal(preflight.patches.length, 2);
    assert.equal(preflight.simulated_budget_stop.stop_reason, "budget_stop");
  });

  test("a budget over the plan cost does not block the batch at the simulation", () => {
    const out = tempDir();
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "..", "smoke", "run-batch.ts"), ...base, "--out", out, "--batch-budget-usd", "100"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(out, "summary.json"), "utf8")).stop_reason, "completed");
  });

  test("the meter stops at the given budget", () => {
    const meter = new BudgetMeter(0, 6);
    assert.ok(meter.canDispatch());
    meter.charge(4);
    assert.ok(!meter.canDispatch());
  });
});
