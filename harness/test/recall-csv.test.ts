import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { COLUMNS, recallCsv } from "../checks/recall-csv.ts";

const SCRIPT = join(import.meta.dirname, "..", "checks", "recall-csv.ts");
const MARKER = "LEAK-MARKER";
const CRLF = "\r\n";

const SCORES = {
  parsed: true,
  files_official: 1,
  files_answer: 2,
  files_overlap: 1,
  lines_official: 10,
  lines_recovered: 7,
  lines_official_not_in_issue: 4,
  lines_recovered_not_in_issue: 3,
};

function result(instanceId: string, overrides: Record<string, unknown> = {}) {
  return {
    instance_id: instanceId,
    status: "completed",
    stop_reason: "end_turn",
    model: "claude-test",
    input_tokens: 300,
    output_tokens: 900,
    cost_usd: 0.0192,
    answer_text: `--- a/x.py ${MARKER}`,
    scores: SCORES,
    ...overrides,
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "recall-csv-"));
}

function writeRun(results: ReturnType<typeof result>[]): string {
  const runDir = tempDir();
  mkdirSync(join(runDir, "instances"));
  for (const entry of results) {
    writeFileSync(join(runDir, "instances", `${entry.instance_id}.json`), JSON.stringify(entry));
  }
  return runDir;
}

function writePatches(entries: [string, string][]): string {
  const path = join(tempDir(), "patches.json");
  writeFileSync(path, JSON.stringify(entries.map(([instance_id, label_stratum]) => ({ instance_id, label_stratum }))));
  return path;
}

function lines(csv: string): string[] {
  return csv.split(CRLF).slice(0, -1);
}

describe("columns", () => {
  test("the header holds the columns in order and a result fills each one", () => {
    const runDir = writeRun([result("django__django-1")]);
    const patches = writePatches([["django__django-1", "swe_abs_wrong"]]);

    const [header, row, ...rest] = lines(recallCsv(runDir, patches));

    assert.equal(
      header,
      "instance_id,wrong_patches,correct_patches,status,stop_reason,model,input_tokens,output_tokens,cost_usd," +
        "parsed,files_official,files_answer,files_overlap,lines_official,lines_recovered," +
        "lines_official_not_in_issue,lines_recovered_not_in_issue",
    );
    assert.deepEqual(rest, []);
    assert.equal(row, "django__django-1,1,0,completed,end_turn,claude-test,300,900,0.0192,true,1,2,1,10,7,4,3");
    assert.equal(row!.split(",").length, COLUMNS.length);
  });

  test("a result with no scores leaves the score cells empty", () => {
    const runDir = writeRun([result("django__django-1", { status: "refused", scores: null, answer_text: null })]);
    const patches = writePatches([["django__django-1", "swe_abs_wrong"]]);

    const row = lines(recallCsv(runDir, patches))[1]!;

    assert.ok(row.endsWith(",,,,,,,,"), row);
  });
});

describe("labels", () => {
  test("wrong and correct patches are counted per issue", () => {
    const runDir = writeRun([result("django__django-1"), result("django__django-2")]);
    const patches = writePatches([
      ["django__django-1", "swe_abs_wrong"],
      ["django__django-2", "swe_abs_wrong"],
      ["django__django-1", "swe_abs_correct"],
    ]);

    const counts = lines(recallCsv(runDir, patches))
      .slice(1)
      .map((row) => row.split(",").slice(0, 3).join(","));

    assert.deepEqual(counts, ["django__django-1,1,1", "django__django-2,1,0"]);
  });

  test("any other label_stratum throws", () => {
    const runDir = writeRun([result("django__django-1")]);
    const patches = writePatches([["django__django-1", "other"]]);

    assert.throws(() => recallCsv(runDir, patches), /label_stratum other/);
  });
});

describe("failures", () => {
  test("a patch-list issue with no result throws", () => {
    const runDir = writeRun([result("django__django-1")]);
    const patches = writePatches([
      ["django__django-1", "swe_abs_wrong"],
      ["django__django-2", "swe_abs_correct"],
    ]);

    assert.throws(() => recallCsv(runDir, patches), /no result .* for django__django-2/);
  });

  test("a result for an issue not in the patch list throws", () => {
    const runDir = writeRun([result("django__django-1"), result("django__django-9")]);
    const patches = writePatches([["django__django-1", "swe_abs_wrong"]]);

    assert.throws(() => recallCsv(runDir, patches), /django__django-9 has a result but is not in/);
  });

  test("a missing flag exits 2 and writes nothing", () => {
    const outPath = join(tempDir(), "recall.csv");
    const cli = spawnSync(process.execPath, [SCRIPT, "--out", outPath], { encoding: "utf8" });

    assert.equal(cli.status, 2);
    assert.ok(cli.stderr.includes("usage:"), cli.stderr);
    assert.equal(existsSync(outPath), false);
  });
});

describe("answer text", () => {
  test("answer text never reaches the file", () => {
    const runDir = writeRun([result("django__django-1")]);
    const patches = writePatches([["django__django-1", "swe_abs_wrong"]]);
    const outPath = join(tempDir(), "recall.csv");

    const cli = spawnSync(process.execPath, [SCRIPT, "--run", runDir, "--patches", patches, "--out", outPath], {
      encoding: "utf8",
    });

    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(readFileSync(outPath, "utf8").includes(MARKER), false);
  });
});
