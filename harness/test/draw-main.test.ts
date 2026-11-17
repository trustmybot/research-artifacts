import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { main, runMainDraw, type Exclusion, type MainDrawResult, type MainPatch } from "../checks/draw-main.ts";
import type { PilotNet, PilotPin } from "../checks/draw-pilot.ts";
import { DrawRefusal, PINNED_FRAME_SIZES, PINNED_VERDICTS_SHA256, type VerdictRecord } from "../draw.ts";
import { REPO_ROOT, sha256 } from "../sources.ts";

const SCRIPT = join(REPO_ROOT, "harness", "checks", "draw-main.ts");
const SEED = "20261102";
const PATCH_TEXT = "diff --git a/x b/x\n";
const SMOKE_FIELDS = Object.keys(JSON.parse(readFileSync(join(REPO_ROOT, "harness", "smoke", "smoke-patches.json"), "utf8"))[0]);
const AGENTS = 12;
const WRONG_RESERVES = 8;
const CORRECT_RESERVES = 6;
const OUTPUT_FILES = ["main-draw.json", "main-patches.json", "check-patches.json", "extension-patches.json"];

function instanceId(index: number): string {
  return `django__django-${20000 + index}`;
}

function fixtureRecords(wrongInstances = PINNED_FRAME_SIZES.wrong, correctInstances = PINNED_FRAME_SIZES.correct): VerdictRecord[] {
  const records: VerdictRecord[] = [];
  for (let i = 0; i < wrongInstances; i += 1) {
    for (let a = 0; a < AGENTS; a += 1) {
      records.push({ instance_id: instanceId(i), agent_id: `wrong-agent-${a}`, original_tests_passed: true, swe_abs_tests_passed: false });
      if (i < correctInstances) {
        records.push({ instance_id: instanceId(i), agent_id: `correct-agent-${a}`, original_tests_passed: true, swe_abs_tests_passed: true });
      }
    }
  }
  return records;
}

function datasetEntry(id: string): { row: Record<string, unknown>; truncated_cells: unknown[] } {
  return {
    row: {
      instance_id: id,
      base_commit: sha256(id).slice(0, 40),
      problem_statement: `problem ${id}`,
      test_patch: `test ${id}`,
      patch: `gold ${id}`,
    },
    truncated_cells: [],
  };
}

function fakeNet(unavailable: (url: string) => boolean = () => false): PilotNet {
  const ids = Array.from({ length: 250 }, (_, index) => instanceId(index));
  return {
    sleep: async () => {},
    fetch: async (url, init) => {
      const parsed = new URL(url);
      if (parsed.hostname === "swe-bench-submissions.s3.amazonaws.com") {
        return unavailable(url) ? new Response("", { status: 404 }) : new Response(PATCH_TEXT);
      }
      if (parsed.hostname === "datasets-server.huggingface.co") {
        const offset = Number(parsed.searchParams.get("offset"));
        const length = Number(parsed.searchParams.get("length"));
        return Response.json({ rows: ids.slice(offset, offset + length).map(datasetEntry), num_rows_total: ids.length });
      }
      if (parsed.hostname === "auth.docker.io") return Response.json({ token: "fake-token" });
      if (parsed.hostname === "registry-1.docker.io") {
        const repository = parsed.pathname.split("/manifests/")[0].replace("/v2/", "");
        const body = JSON.stringify({
          manifests: [{ digest: `sha256:${sha256(`amd ${repository}`)}`, platform: { os: "linux", architecture: "amd64" } }],
        });
        if (init?.method === "HEAD") return new Response(null, { headers: { "docker-content-digest": `sha256:${sha256(body)}` } });
        return new Response(body);
      }
      throw new Error(`unexpected url ${url}`);
    },
  };
}

function fixturePin(): PilotPin {
  const id = instanceId(200);
  const { row } = datasetEntry(id);
  return {
    instance_id: id,
    agent_id: "pin-agent",
    patch_sha256: "0".repeat(64),
    patch_url: "https://example.invalid/patch.diff",
    image: "swebench/sweb.eval.x86_64.django_1776_django-20200",
    image_digest: `sha256:${"0".repeat(64)}`,
    base_commit: row.base_commit as string,
    problem_statement_sha256: sha256(row.problem_statement as string),
    test_patch_sha256: sha256(row.test_patch as string),
    gold_patch_sha256: sha256(row.patch as string),
    dataset: "SWE-bench/SWE-bench_Verified",
    excluded_from_draw: true,
    source_commits: { "SWE-bench/SWE-bench_Verified": "a".repeat(40) },
  };
}

function setup(records: VerdictRecord[] = fixtureRecords()): { verdictsPath: string; outDir: string; verdictsSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "draw-main-test-"));
  const verdictsPath = join(dir, "verdicts.json");
  const text = JSON.stringify({ records });
  writeFileSync(verdictsPath, text);
  return { verdictsPath, outDir: join(dir, "out"), verdictsSha: sha256(text) };
}

async function draw(net: PilotNet = fakeNet(), exclude: Exclusion[] = []): Promise<MainDrawResult & { outDir: string }> {
  const { verdictsPath, outDir, verdictsSha } = setup();
  const result = await runMainDraw({ verdictsPath, seed: SEED, outDir, exclude, net, pinnedSha256: verdictsSha, pins: [fixturePin()] });
  return { ...result, outDir };
}

function readOut(outDir: string, name: string): unknown {
  return JSON.parse(readFileSync(join(outDir, name), "utf8"));
}

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = () => {
    throw new Error("network reached outside the injected fetch");
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

describe("SC1: four output files", () => {
  test("writes main, check and extension patches with the expected counts and roles", async () => {
    const { outDir } = await draw();
    for (const name of OUTPUT_FILES) assert.ok(existsSync(join(outDir, name)), name);

    const mainPatches = readOut(outDir, "main-patches.json") as MainPatch[];
    assert.equal(mainPatches.length, 90);
    assert.deepEqual(mainPatches.slice(0, 60).map((p) => [p.label_stratum, p.role]), Array(60).fill(["swe_abs_wrong", "main"]));
    assert.deepEqual(mainPatches.slice(60).map((p) => [p.label_stratum, p.role]), Array(30).fill(["swe_abs_correct", "correct"]));

    const extension = readOut(outDir, "extension-patches.json") as MainPatch[];
    assert.equal(extension.length, 15);
    assert.ok(extension.every((p) => p.role === "extension" && p.label_stratum === "swe_abs_wrong"));

    const check = readOut(outDir, "check-patches.json") as MainPatch[];
    assert.equal(check.length, 90 + WRONG_RESERVES + 5);
    assert.deepEqual(check.slice(0, 90), mainPatches);
    assert.ok(check.slice(90).every((p) => p.role === "reserve"));
    assert.equal(check.slice(90).filter((p) => p.label_stratum === "swe_abs_wrong").length, WRONG_RESERVES);

    const mainDraw = readOut(outDir, "main-draw.json") as Record<string, unknown>;
    assert.deepEqual(Object.keys(mainDraw), ["seed", "verdicts_sha256", "frame_sizes", "entries", "skipped", "replacements"]);
    assert.deepEqual(mainDraw.frame_sizes, PINNED_FRAME_SIZES);
    const entries = mainDraw.entries as Array<{ stratum: string; role: string }>;
    assert.equal(entries.length, 83 + 30 + CORRECT_RESERVES);
    assert.ok(entries.every((entry) => typeof entry.role === "string"));
    assert.deepEqual(mainDraw.skipped, []);
    assert.deepEqual(mainDraw.replacements, []);
  });

  test("each patch carries every smoke field plus role and draw_position, not excluded", async () => {
    const { checkPatches, extensionPatches } = await draw();
    for (const patch of [...checkPatches, ...extensionPatches]) {
      assert.deepEqual(new Set(Object.keys(patch)), new Set([...SMOKE_FIELDS, "draw_position", "role"]));
      assert.equal(patch.excluded_from_draw, false);
      assert.equal(patch.patch_sha256, sha256(PATCH_TEXT));
      assert.match(patch.image_amd64_manifest_digest, /^sha256:[0-9a-f]{64}$/);
    }
  });

  test("the correct frame is not filtered by the drawn wrong instances", async () => {
    const { mainPatches } = await draw();
    const wrongIds = new Set(mainPatches.filter((p) => p.label_stratum === "swe_abs_wrong").map((p) => p.instance_id));
    assert.ok(mainPatches.some((p) => p.label_stratum === "swe_abs_correct" && wrongIds.has(p.instance_id)));
  });
});

describe("SC2: replacements from reserves", () => {
  test("an unavailable main entry takes the first accepted wrong reserve", async () => {
    const clean = await draw();
    const target = clean.mainPatches[4];
    const firstReserve = clean.draw.entries.find((e) => e.stratum === "wrong" && e.role === "reserve");
    assert.ok(firstReserve);
    const result = await draw(fakeNet((url) => url === target.patch_url || url === firstReserve.patch_url));
    assert.deepEqual(
      result.draw.skipped.map((s) => s.draw_position),
      [target.draw_position, firstReserve.position],
    );
    const secondReserve = clean.draw.entries.filter((e) => e.stratum === "wrong" && e.role === "reserve")[1];
    assert.deepEqual(result.draw.replacements, [
      {
        dropped: { instance_id: target.instance_id, agent_id: target.agent_id, role: "main", reason: result.draw.skipped[0].reason },
        replacement: { instance_id: secondReserve.instance_id, agent_id: secondReserve.agent_id, draw_position: secondReserve.position },
      },
    ]);
    assert.match(result.draw.replacements[0].dropped.reason, /returned 404/);
    const filled = result.mainPatches[4];
    assert.equal(filled.instance_id, secondReserve.instance_id);
    assert.equal(filled.role, "main");
    assert.equal(filled.draw_position, secondReserve.position);
    assert.equal(result.mainPatches.length, 90);
    const reserves = result.checkPatches.slice(90).filter((p) => p.label_stratum === "swe_abs_wrong");
    assert.equal(reserves.length, WRONG_RESERVES - 2);
    assert.ok(!reserves.some((p) => p.instance_id === secondReserve.instance_id));
  });

  test("an --exclude'd correct entry takes the first correct reserve and logs the reason", async () => {
    const clean = await draw();
    const target = clean.mainPatches[70];
    const firstReserve = clean.draw.entries.find((e) => e.stratum === "correct" && e.role === "reserve");
    assert.ok(firstReserve);
    const result = await draw(fakeNet(), [{ instance_id: target.instance_id, agent_id: target.agent_id, reason: "label conflict" }]);
    assert.deepEqual(result.draw.replacements, [
      {
        dropped: { instance_id: target.instance_id, agent_id: target.agent_id, role: "correct", reason: "excluded: label conflict" },
        replacement: { instance_id: firstReserve.instance_id, agent_id: firstReserve.agent_id, draw_position: firstReserve.position },
      },
    ]);
    assert.equal(result.mainPatches[70].instance_id, firstReserve.instance_id);
    assert.equal(result.mainPatches[70].role, "correct");
    assert.equal(result.checkPatches.length, 90 + WRONG_RESERVES + 5);
  });

  test("an unavailable extension entry is replaced too", async () => {
    const clean = await draw();
    const target = clean.extensionPatches[0];
    const result = await draw(fakeNet((url) => url === target.patch_url));
    assert.equal(result.draw.replacements[0].dropped.role, "extension");
    assert.equal(result.extensionPatches.length, 15);
    assert.equal(result.extensionPatches[0].role, "extension");
  });

  test("running out of reserves refuses and writes nothing", async () => {
    const clean = await draw();
    const dropped = new Set(clean.mainPatches.slice(0, WRONG_RESERVES + 1).map((p) => p.patch_url));
    const { verdictsPath, outDir, verdictsSha } = setup();
    await assert.rejects(
      runMainDraw({
        verdictsPath,
        seed: SEED,
        outDir,
        net: fakeNet((url) => dropped.has(url)),
        pinnedSha256: verdictsSha,
        pins: [fixturePin()],
      }),
      (error: Error) => error instanceof DrawRefusal && /wrong stratum ran out of reserves/.test(error.message),
    );
    assert.equal(existsSync(outDir), false);
  });

  test("the CLI exits 2 when reserves run out", async () => {
    const clean = await draw();
    const dropped = new Set(clean.mainPatches.slice(60, 60 + CORRECT_RESERVES + 1).map((p) => p.patch_url));
    const { verdictsPath, outDir, verdictsSha } = setup();
    const code = await main(["--verdicts", verdictsPath, "--seed", SEED, "--out", outDir], {
      net: fakeNet((url) => dropped.has(url)),
      pinnedSha256: verdictsSha,
      pins: [fixturePin()],
    });
    assert.equal(code, 2);
    assert.equal(existsSync(outDir), false);
  });
});

describe("SC3: determinism and refusals", () => {
  test("the same seed and inputs give byte-identical files", async () => {
    const first = await draw();
    const second = await draw();
    for (const name of OUTPUT_FILES) {
      assert.equal(readFileSync(join(first.outDir, name), "utf8"), readFileSync(join(second.outDir, name), "utf8"), name);
    }
  });

  test("a frame size other than the pinned one refuses", async () => {
    const { verdictsPath, outDir, verdictsSha } = setup(fixtureRecords(PINNED_FRAME_SIZES.wrong - 1));
    await assert.rejects(
      runMainDraw({ verdictsPath, seed: SEED, outDir, net: fakeNet(), pinnedSha256: verdictsSha, pins: [fixturePin()] }),
      (error: Error) => error instanceof DrawRefusal && /frame sizes wrong=82 correct=70/.test(error.message),
    );
    assert.equal(existsSync(outDir), false);
  });

  test("a verdict file off the pin refuses", async () => {
    const { verdictsPath, outDir } = setup();
    await assert.rejects(
      runMainDraw({ verdictsPath, seed: SEED, outDir, net: fakeNet(), pins: [fixturePin()] }),
      (error: Error) => error instanceof DrawRefusal && error.message.includes(PINNED_VERDICTS_SHA256),
    );
    assert.equal(existsSync(outDir), false);
  });
});

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

describe("CLI refusal", () => {
  test("no arguments prints usage and exits 2", () => {
    const result = runCli([]);
    assert.equal(result.status, 2);
    assert.match(result.stderr as string, /usage: node harness\/checks\/draw-main\.ts/);
  });

  test("a non-digit seed exits 2", () => {
    const { verdictsPath, outDir } = setup();
    const result = runCli(["--verdicts", verdictsPath, "--seed", "abc", "--out", outDir]);
    assert.equal(result.status, 2);
    assert.match(result.stderr as string, /digits only/);
  });

  test("an unpinned verdict file exits 2 and writes nothing", () => {
    const { verdictsPath, outDir } = setup();
    const result = runCli(["--verdicts", verdictsPath, "--seed", SEED, "--out", outDir]);
    assert.equal(result.status, 2);
    assert.match(result.stderr as string, /differs from the pinned/);
    assert.equal(existsSync(outDir), false);
  });

  test("a malformed exclude file exits 2", () => {
    const { verdictsPath, outDir } = setup();
    const excludePath = join(outDir, "..", "exclude.json");
    writeFileSync(excludePath, JSON.stringify([{ instance_id: "x" }]));
    const result = runCli(["--verdicts", verdictsPath, "--seed", SEED, "--out", outDir, "--exclude", excludePath]);
    assert.equal(result.status, 2);
    assert.match(result.stderr as string, /exclude file must be a JSON array/);
  });
});
