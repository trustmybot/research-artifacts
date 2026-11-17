import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { COLUMNS, csvField, LIMIT_RERUN_SUFFIX, resultsCsv } from "../results-csv.ts";

const SCRIPT = join(import.meta.dirname, "..", "results-csv.ts");
const MARKER = "LEAK-MARKER";
const CRLF = "\r\n";

const FULL_RECORD = {
  mode: "real",
  budget_usd: 5,
  transcript_path: "transcript.jsonl",
  feedback: `feedback ${MARKER}`,
  findings: [{ location: `a.py ${MARKER}`, problem: MARKER }],
  command: ["claude", MARKER],
  preflight: { passed: true, checks: [{ id: MARKER, passed: true }] },
  instance_id: "django__django-1",
  agent_id: "agent-a",
  label_stratum: "wrong",
  effort: "medium",
  effective_effort: "medium",
  model: "claude-test",
  arm: "skill",
  cli_version: "2.1.311",
  verdict: "pass",
  stop_reason: "end_turn",
  skill_verdict: "fail",
  skill_invocations: 1,
  cost_usd: 1.25,
  wall_ms: 1000,
  turns: 3,
  tool_calls: 4,
  bash_commands: 5,
  bash_test_runs: 6,
  bash_inline_code_runs: 7,
  bash_test_files_written: 8,
  bash_failures: 9,
  test_files_written: 10,
  input_tokens: 11,
  output_tokens: 12,
  thinking_tokens: 13,
  thinking_blocks: 14,
  thinking_chars: 15,
  cache_read_tokens: 16,
  cache_write_tokens: 17,
  run_order: 18,
  repeat_number: 19,
  seed: 20,
  vm_type: "e2-standard-4",
  platform: "linux/amd64",
  patch_sha256: "patch-hash",
  prompt_sha256: "prompt-hash",
  environment_sha256: "environment-hash",
  image_digest: "sha256:image",
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "results-csv-"));
}

function writeRun(runsDir: string, relativeDir: string, content: unknown): void {
  const dir = join(runsDir, relativeDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), typeof content === "string" ? content : JSON.stringify(content));
}

function runCli(runsDir: string, outPath: string) {
  return spawnSync(process.execPath, [SCRIPT, "--runs", runsDir, "--out", outPath], { encoding: "utf8" });
}

function lines(csv: string): string[] {
  return csv.split(CRLF).slice(0, -1);
}

function assertRefused(runsDir: string, namedPath: string): void {
  const outPath = join(tempDir(), "results.csv");
  const result = runCli(runsDir, outPath);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(namedPath), result.stderr);
  assert.equal(existsSync(outPath), false);
}

describe("columns", () => {
  test("the header holds the columns in order and a full record fills each one", () => {
    const runsDir = tempDir();
    writeRun(runsDir, "runs/01-a-medium", FULL_RECORD);

    const [header, row, ...rest] = lines(resultsCsv(runsDir));

    assert.equal(
      header,
      "run,instance_id,agent_id,label_stratum,effort,effective_effort,model,arm,cli_version,verdict,stop_reason," +
        "skill_verdict,skill_invocations,cost_usd,wall_ms,turns,tool_calls,bash_commands,bash_test_runs,bash_inline_code_runs," +
        "bash_test_files_written,bash_failures,test_files_written,input_tokens,output_tokens,thinking_tokens," +
        "thinking_blocks,thinking_chars,cache_read_tokens,cache_write_tokens,run_order,repeat_number,seed," +
        "vm_type,platform,patch_sha256,prompt_sha256,environment_sha256,image_digest,limit_rerun_of",
    );
    assert.deepEqual(rest, []);
    const cells = row!.split(",");
    assert.equal(cells.length, COLUMNS.length + 1);
    COLUMNS.forEach((column, index) => {
      const expected = column === "run" ? "runs/01-a-medium" : String(FULL_RECORD[column]);
      assert.equal(cells[index], expected, column);
    });
    assert.equal(cells.at(-1), "");
  });

  test("the exported COLUMNS stays the run.json columns without limit_rerun_of", () => {
    assert.equal(COLUMNS.length, 39);
    assert.equal((COLUMNS as readonly string[]).includes("limit_rerun_of"), false);
  });

  test("arm follows model and copies run.json arm, blank when the run has none", () => {
    const runsDir = tempDir();
    writeRun(runsDir, "a-skill", { instance_id: "with-arm", model: "claude-opus-5-5", arm: "skill" });
    writeRun(runsDir, "b-old", { instance_id: "without-arm", model: "claude-opus-5-5" });

    const [header, withArm, withoutArm] = lines(resultsCsv(runsDir));

    const armIndex = header!.split(",").indexOf("arm");
    assert.equal(armIndex, header!.split(",").indexOf("model") + 1);
    assert.equal(withArm!.split(",")[armIndex], "skill");
    assert.equal(withoutArm!.split(",")[armIndex], "");
  });

  test("a limit-hit re-run names its main run in limit_rerun_of and a main run leaves it blank", () => {
    const runsDir = tempDir();
    writeRun(runsDir, "runs/x", { instance_id: "main" });
    writeRun(runsDir, `runs/x${LIMIT_RERUN_SUFFIX}`, { instance_id: "companion", limit_rerun_of: "x" });

    const [header, companion, main] = lines(resultsCsv(runsDir));

    assert.equal(header!.split(",").at(-1), "limit_rerun_of");
    assert.deepEqual(main!.split(",").slice(0, 2), ["runs/x", "main"]);
    assert.equal(main!.split(",").at(-1), "");
    assert.deepEqual(companion!.split(",").slice(0, 2), ["runs/x-limitrerun", "companion"]);
    assert.equal(companion!.split(",").at(-1), "runs/x");
  });

  test("a top-level limit-hit re-run names its main run without a directory", () => {
    const runsDir = tempDir();
    writeRun(runsDir, "x", { instance_id: "main" });
    writeRun(runsDir, `x${LIMIT_RERUN_SUFFIX}`, { instance_id: "companion", limit_rerun_of: "x" });

    const [, companion, main] = lines(resultsCsv(runsDir));

    assert.equal(main!.split(",").at(-1), "");
    assert.deepEqual(companion!.split(",").slice(0, 2), ["x-limitrerun", "companion"]);
    assert.equal(companion!.split(",").at(-1), "x");
  });

  test("rows sort by relative path across nested and flat directories", () => {
    const runsDir = tempDir();
    writeRun(runsDir, "batch/runs/02-b-low", { instance_id: "second" });
    writeRun(runsDir, "batch/runs/01-a-low", { instance_id: "first" });
    writeRun(runsDir, "mvp", { instance_id: "third" });

    const runs = lines(resultsCsv(runsDir))
      .slice(1)
      .map((row) => row.split(",").slice(0, 2).join(","));

    assert.deepEqual(runs, ["batch/runs/01-a-low,first", "batch/runs/02-b-low,second", "mvp,third"]);
  });

  test("a run.json directly in --runs has run set to a dot", () => {
    const runsDir = tempDir();
    writeRun(runsDir, ".", { instance_id: "only" });

    assert.ok(lines(resultsCsv(runsDir))[1]!.startsWith(".,only,"));
  });

  test("files with other names are ignored", () => {
    const runsDir = tempDir();
    writeRun(runsDir, "a", { instance_id: "kept" });
    writeFileSync(join(runsDir, "a", "summary.json"), "not json");

    assert.equal(lines(resultsCsv(runsDir)).length, 2);
  });
});

describe("free text", () => {
  test("no free-text or patch-bearing field reaches the file", () => {
    const runsDir = tempDir();
    const outPath = join(tempDir(), "results.csv");
    writeRun(runsDir, "a", FULL_RECORD);

    assert.equal(runCli(runsDir, outPath).status, 0);

    assert.equal(readFileSync(outPath, "utf8").includes(MARKER), false);
  });
});

describe("RFC 4180", () => {
  test("plain text is left bare", () => {
    assert.equal(csvField("plain"), "plain");
  });

  test("a comma is quoted", () => {
    assert.equal(csvField("a,b"), '"a,b"');
  });

  test("a quote is quoted and doubled", () => {
    assert.equal(csvField('a"b'), '"a""b"');
  });

  test("line breaks are quoted", () => {
    assert.equal(csvField("a\nb"), '"a\nb"');
    assert.equal(csvField("a\rb"), '"a\rb"');
    assert.equal(csvField("a\r\nb"), '"a\r\nb"');
  });

  test("null, missing and empty are blank while 0 stays 0", () => {
    assert.equal(csvField(null), "");
    assert.equal(csvField(undefined), "");
    assert.equal(csvField(""), "");
    assert.equal(csvField(0), "0");
  });

  test("every record ends in CRLF and quoting survives into the file", () => {
    const runsDir = tempDir();
    writeRun(runsDir, "a", { stop_reason: 'x,"y"\nz', turns: 0, model: null, effort: "" });

    const csv = resultsCsv(runsDir);

    assert.ok(csv.endsWith(CRLF));
    assert.equal(csv.split(CRLF).length, 3);
    const row = csv.split(CRLF)[1]!;
    assert.ok(row.includes('"x,""y""\nz"'));
    const cells = row.replace('"x,""y""\nz"', "QUOTED").split(",");
    assert.equal(cells[COLUMNS.indexOf("stop_reason")], "QUOTED");
    assert.equal(cells[COLUMNS.indexOf("turns")], "0");
    assert.equal(cells[COLUMNS.indexOf("model")], "");
    assert.equal(cells[COLUMNS.indexOf("effort")], "");
    assert.equal(cells[COLUMNS.indexOf("agent_id")], "");
  });
});

describe("failures", () => {
  test("a run.json that fails to parse refuses and names the path", () => {
    const runsDir = tempDir();
    writeRun(runsDir, "good", { instance_id: "good" });
    writeRun(runsDir, "bad", "{ not json");

    assertRefused(runsDir, join(runsDir, "bad", "run.json"));
  });

  test("a run.json that holds no object refuses and names the path", () => {
    const runsDir = tempDir();
    writeRun(runsDir, "bad", "null");

    assertRefused(runsDir, join(runsDir, "bad", "run.json"));
  });

  test("a column holding a structure refuses and names the path", () => {
    const runsDir = tempDir();
    writeRun(runsDir, "bad", { model: { name: MARKER } });

    assertRefused(runsDir, join(runsDir, "bad", "run.json"));
  });

  test("a limit-rerun folder without a limit_rerun_of marker refuses and names the path", () => {
    const runsDir = tempDir();
    writeRun(runsDir, "runs/x", { instance_id: "main" });
    writeRun(runsDir, `runs/x${LIMIT_RERUN_SUFFIX}`, { instance_id: "companion" });

    assertRefused(runsDir, join(runsDir, "runs", `x${LIMIT_RERUN_SUFFIX}`, "run.json"));
  });

  test("a limit_rerun_of marker on a folder without the suffix refuses and names the path", () => {
    const runsDir = tempDir();
    writeRun(runsDir, "runs/y", { instance_id: "stray", limit_rerun_of: "x" });

    assertRefused(runsDir, join(runsDir, "runs", "y", "run.json"));
  });

  test("a limit_rerun_of marker that differs from the folder's main run refuses and names the path", () => {
    const runsDir = tempDir();
    writeRun(runsDir, `runs/x${LIMIT_RERUN_SUFFIX}`, { instance_id: "companion", limit_rerun_of: "z" });

    assertRefused(runsDir, join(runsDir, "runs", `x${LIMIT_RERUN_SUFFIX}`, "run.json"));
  });

  for (const marker of ["", null, 7, ["x"], "runs/x"]) {
    test(`a limit_rerun_of marker of ${JSON.stringify(marker)} refuses and names the path`, () => {
      const runsDir = tempDir();
      writeRun(runsDir, `runs/x${LIMIT_RERUN_SUFFIX}`, { instance_id: "companion", limit_rerun_of: marker });

      assertRefused(runsDir, join(runsDir, "runs", `x${LIMIT_RERUN_SUFFIX}`, "run.json"));
    });
  }

  test("a directory with no run.json refuses and names the path", () => {
    const runsDir = tempDir();
    writeFileSync(join(runsDir, "summary.json"), "{}");

    assertRefused(runsDir, runsDir);
  });

  test("a missing directory refuses and names the path", () => {
    const runsDir = join(tempDir(), "absent");

    assertRefused(runsDir, runsDir);
  });

  test("a failed run with a null verdict is a normal row", () => {
    const runsDir = tempDir();
    const outPath = join(tempDir(), "nested", "results.csv");
    writeRun(runsDir, "failed", { verdict: null, stop_reason: "preflight_failed:patch_apply" });

    assert.equal(runCli(runsDir, outPath).status, 0);

    const cells = lines(readFileSync(outPath, "utf8"))[1]!.split(",");
    assert.equal(cells[COLUMNS.indexOf("verdict")], "");
    assert.equal(cells[COLUMNS.indexOf("stop_reason")], "preflight_failed:patch_apply");
  });
});
