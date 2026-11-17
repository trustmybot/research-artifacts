import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  PILOT_CORRECT_ENTRIES,
  PILOT_WRONG_ENTRIES,
  runPilotDraw,
  type PilotDraw,
  type PilotNet,
  type PilotPin,
} from "../checks/draw-pilot.ts";
import { correctFrame, DrawRefusal, patchUrl, PINNED_VERDICTS_SHA256, wrongFrame, type VerdictRecord } from "../draw.ts";
import { REPO_ROOT, sha256 } from "../sources.ts";

const CHECKS = join(REPO_ROOT, "harness", "checks");
const SEED = "pilot-fixture-seed";
const PATCH_TEXT = "diff --git a/x b/x\n";
const SMOKE_FIELDS = Object.keys(JSON.parse(readFileSync(join(REPO_ROOT, "harness", "smoke", "smoke-patches.json"), "utf8"))[0]);
const WRONG_INSTANCES = 40;
const CORRECT_INSTANCES = 30;
const AGENTS = 12;
const SOURCE_COMMITS = { "SWE-bench/SWE-bench_Verified": "a".repeat(40) };

function instanceId(index: number): string {
  return `django__django-${20000 + index}`;
}

function fixtureRecords(): VerdictRecord[] {
  const records: VerdictRecord[] = [];
  for (let i = 0; i < WRONG_INSTANCES; i += 1) {
    for (let a = 0; a < AGENTS; a += 1) {
      records.push({
        instance_id: instanceId(i),
        agent_id: `wrong-agent-${a}`,
        original_tests_passed: true,
        swe_abs_tests_passed: false,
      });
      if (i < CORRECT_INSTANCES) {
        records.push({
          instance_id: instanceId(i),
          agent_id: `correct-agent-${a}`,
          original_tests_passed: true,
          swe_abs_tests_passed: true,
        });
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

function indexBody(repository: string): string {
  return JSON.stringify({
    manifests: [
      { digest: `sha256:${sha256(`arm ${repository}`)}`, platform: { os: "linux", architecture: "arm64" } },
      { digest: `sha256:${sha256(`amd ${repository}`)}`, platform: { os: "linux", architecture: "amd64" } },
    ],
  });
}

interface FakeOptions {
  respond?: (url: string, init: RequestInit | undefined) => Response | undefined;
  entryFor?: (id: string) => unknown;
}

function fakeNet({ respond, entryFor = datasetEntry }: FakeOptions = {}): PilotNet & { urls: string[]; heads: RequestInit[] } {
  const ids = Array.from({ length: 250 }, (_, index) => instanceId(index));
  const urls: string[] = [];
  const heads: RequestInit[] = [];
  return {
    urls,
    heads,
    sleep: async () => {},
    fetch: async (url, init) => {
      urls.push(url);
      const override = respond?.(url, init);
      if (override) return override;
      const parsed = new URL(url);
      if (parsed.hostname === "swe-bench-submissions.s3.amazonaws.com") return new Response(PATCH_TEXT);
      if (parsed.hostname === "datasets-server.huggingface.co") {
        const offset = Number(parsed.searchParams.get("offset"));
        const length = Number(parsed.searchParams.get("length"));
        assert.equal(length, 100);
        assert.equal(parsed.searchParams.get("dataset"), "SWE-bench/SWE-bench_Verified");
        assert.equal(parsed.searchParams.get("config"), "default");
        assert.equal(parsed.searchParams.get("split"), "test");
        return Response.json({ rows: ids.slice(offset, offset + length).map(entryFor), num_rows_total: ids.length });
      }
      if (parsed.hostname === "auth.docker.io") return Response.json({ token: "fake-token" });
      if (parsed.hostname === "registry-1.docker.io") {
        const repository = parsed.pathname.split("/manifests/")[0].replace("/v2/", "");
        const body = indexBody(repository);
        if (init?.method === "HEAD") {
          heads.push(init);
          return new Response(null, { headers: { "docker-content-digest": `sha256:${sha256(body)}` } });
        }
        return new Response(body);
      }
      throw new Error(`unexpected url ${url}`);
    },
  };
}

function fixturePin(): PilotPin {
  const id = instanceId(200);
  const entry = datasetEntry(id);
  return {
    instance_id: id,
    agent_id: "pin-agent",
    patch_sha256: "0".repeat(64),
    patch_url: "https://example.invalid/patch.diff",
    image: `swebench/sweb.eval.x86_64.django_1776_django-${20200}`,
    image_digest: `sha256:${"0".repeat(64)}`,
    base_commit: entry.row.base_commit as string,
    problem_statement_sha256: sha256(entry.row.problem_statement as string),
    test_patch_sha256: sha256(entry.row.test_patch as string),
    gold_patch_sha256: sha256(entry.row.patch as string),
    dataset: "SWE-bench/SWE-bench_Verified",
    excluded_from_draw: true,
    source_commits: SOURCE_COMMITS,
  };
}

function setup(): { dir: string; verdictsPath: string; outPath: string; verdictsSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "draw-pilot-test-"));
  const verdictsPath = join(dir, "verdicts.json");
  const text = JSON.stringify({ records: fixtureRecords() });
  writeFileSync(verdictsPath, text);
  return { dir, verdictsPath, outPath: join(dir, "out", "pilot.json"), verdictsSha: sha256(text) };
}

async function draw(net: PilotNet = fakeNet(), now = () => "2026-11-01T00:00:00.000Z"): Promise<PilotDraw & { outPath: string }> {
  const { verdictsPath, outPath, verdictsSha } = setup();
  const result = await runPilotDraw({ verdictsPath, seed: SEED, outPath, net, now, pinnedSha256: verdictsSha, pins: [fixturePin()] });
  return { ...result, outPath };
}

function refuses(net: PilotNet, pattern: RegExp, pins: PilotPin[] = [fixturePin()]): Promise<void> {
  const { verdictsPath, outPath, verdictsSha } = setup();
  return assert
    .rejects(
      runPilotDraw({ verdictsPath, seed: SEED, outPath, net, pinnedSha256: verdictsSha, pins }),
      (error: Error) => error instanceof DrawRefusal && pattern.test(error.message),
    )
    .then(() => assert.equal(existsSync(outPath), false));
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

describe("SC1: pinned verdicts and stratified draw", () => {
  test("a verdict file off the pin refuses before any fetch and writes nothing", async () => {
    const { verdictsPath, outPath } = setup();
    const net = fakeNet();
    await assert.rejects(
      runPilotDraw({ verdictsPath, seed: SEED, outPath, net, pins: [fixturePin()] }),
      (error: Error) => error instanceof DrawRefusal && error.message.includes(PINNED_VERDICTS_SHA256),
    );
    assert.deepEqual(net.urls, []);
    assert.equal(existsSync(outPath), false);
  });

  test("draws 14 wrong and 6 correct, all distinct", async () => {
    const { patches } = await draw();
    assert.equal(PILOT_WRONG_ENTRIES + PILOT_CORRECT_ENTRIES, 20);
    assert.equal(patches.filter((patch) => patch.label_stratum === "swe_abs_wrong").length, 14);
    assert.equal(patches.filter((patch) => patch.label_stratum === "swe_abs_correct").length, 6);
    assert.deepEqual(patches.slice(0, 14).map((patch) => patch.label_stratum), Array(14).fill("swe_abs_wrong"));
    assert.equal(new Set(patches.map((patch) => patch.instance_id)).size, 20);
  });

  test("agents respect cap 2 in wrong and cap 1 in correct", async () => {
    const { patches } = await draw();
    const counts = (label: string): number[] => {
      const seen = new Map<string, number>();
      for (const patch of patches.filter((p) => p.label_stratum === label)) {
        seen.set(patch.agent_id, (seen.get(patch.agent_id) ?? 0) + 1);
      }
      return [...seen.values()];
    };
    assert.ok(Math.max(...counts("swe_abs_wrong")) <= 2);
    assert.ok(Math.max(...counts("swe_abs_correct")) <= 1);
  });

  test("a frame too small for the caps refuses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draw-pilot-test-"));
    const verdictsPath = join(dir, "verdicts.json");
    const records = fixtureRecords().filter((r) => !r.agent_id.startsWith("wrong-agent-") || r.agent_id === "wrong-agent-0");
    const text = JSON.stringify({ records });
    writeFileSync(verdictsPath, text);
    await assert.rejects(
      runPilotDraw({ verdictsPath, seed: SEED, outPath: join(dir, "o.json"), net: fakeNet(), pinnedSha256: sha256(text), pins: [fixturePin()] }),
      (error: Error) => error instanceof DrawRefusal && /wrong stratum yielded 2/.test(error.message),
    );
  });

  test("correct leaves out every drawn wrong issue, skipped ones included", async () => {
    const unavailable = Array.from({ length: 10 }, (_, index) => `/logs/${instanceId(index)}/`);
    const { patches, skipped } = await draw(
      fakeNet({
        respond: (url) =>
          url.includes("/wrong-agent-") && unavailable.some((part) => url.includes(part))
            ? new Response("", { status: 404 })
            : undefined,
      }),
    );
    assert.ok(skipped.length > 0);
    const correctIds = patches.filter((p) => p.label_stratum === "swe_abs_correct").map((p) => p.instance_id);
    const wrongIds = patches.filter((p) => p.label_stratum === "swe_abs_wrong").map((p) => p.instance_id);
    const correctFrameIds = correctFrame(fixtureRecords()).map((instance) => instance.instance_id);
    const wrongFrameIds = wrongFrame(fixtureRecords()).map((instance) => instance.instance_id);
    for (const id of correctIds) {
      assert.ok(correctFrameIds.includes(id));
      assert.ok(!wrongIds.includes(id));
      assert.ok(!skipped.some((entry) => entry.instance_id === id));
    }
    for (const id of wrongIds) assert.ok(wrongFrameIds.includes(id));
  });
});

describe("SC2: unavailable entries skip, row failures refuse", () => {
  test("an unavailable patch moves to the next position in the same stratum", async () => {
    const clean = await draw();
    const target = clean.patches[3];
    const result = await draw(
      fakeNet({ respond: (url) => (url === target.patch_url ? new Response("", { status: 404 }) : undefined) }),
    );
    assert.deepEqual(
      result.skipped.map(({ stratum, draw_position, instance_id, agent_id }) => ({ stratum, draw_position, instance_id, agent_id })),
      [{ stratum: "wrong", draw_position: 4, instance_id: target.instance_id, agent_id: target.agent_id }],
    );
    assert.match(result.skipped[0].reason, /returned 404/);
    assert.deepEqual(
      result.patches.slice(0, 14).map((patch) => patch.draw_position),
      [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    );
    assert.deepEqual(result.patches.slice(0, 3), clean.patches.slice(0, 3));
  });

  test("an empty patch, a missing image and an index without amd64 all skip", async () => {
    const clean = await draw();
    const emptyPatch = clean.patches[0];
    const missingImage = clean.patches[1];
    const noAmd64 = clean.patches[2];
    const net = fakeNet({
      respond: (url, init) => {
        if (url === emptyPatch.patch_url) return new Response("");
        if (url.includes(`${missingImage.image}/manifests/latest`)) return new Response(null, { status: 404 });
        if (url.includes(`/v2/${noAmd64.image}/manifests/`)) {
          const body = JSON.stringify({ manifests: [{ digest: `sha256:${"1".repeat(64)}`, platform: { os: "linux", architecture: "arm64" } }] });
          if (init?.method === "HEAD") {
            return new Response(null, { headers: { "docker-content-digest": `sha256:${sha256(body)}` } });
          }
          return new Response(body);
        }
        return undefined;
      },
    });
    const { skipped, patches } = await draw(net);
    assert.deepEqual(skipped.map((entry) => entry.draw_position), [1, 2, 3]);
    assert.match(skipped[0].reason, /is empty/);
    assert.match(skipped[1].reason, /returned 404/);
    assert.match(skipped[2].reason, /no linux\/amd64 entry/);
    assert.equal(patches.length, 20);
  });

  test("a server error retries, then skips", async () => {
    const clean = await draw();
    const target = clean.patches[0];
    const net = fakeNet({ respond: (url) => (url === target.patch_url ? new Response("", { status: 503 }) : undefined) });
    const { skipped } = await draw(net);
    assert.match(skipped[0].reason, /after 3 attempts/);
    assert.equal(net.urls.filter((url) => url === target.patch_url).length, 3);
  });

  test("the same availability gives the same substitution", async () => {
    const clean = await draw();
    const target = clean.patches[5];
    const netFor = () => fakeNet({ respond: (url) => (url === target.patch_url ? new Response("", { status: 404 }) : undefined) });
    const first = await draw(netFor());
    const second = await draw(netFor());
    assert.deepEqual(first.patches, second.patches);
    assert.deepEqual(first.skipped, second.skipped);
  });

  test("a truncated row refuses", async () => {
    await refuses(
      fakeNet({ entryFor: (id) => ({ ...datasetEntry(id), truncated_cells: ["patch"] }) }),
      /is truncated/,
    );
  });

  test("a row without its text fields refuses", async () => {
    await refuses(
      fakeNet({
        entryFor: (id) => {
          const entry = datasetEntry(id);
          return { ...entry, row: { ...entry.row, patch: null } };
        },
      }),
      /wrong shape/,
    );
  });

  test("a row hash off a pinned entry refuses", async () => {
    await refuses(fakeNet(), /problem_statement_sha256 is/, [
      { ...fixturePin(), problem_statement_sha256: "f".repeat(64) },
    ]);
  });

  test("a pinned instance missing from the dataset refuses", async () => {
    await refuses(fakeNet(), /has no row/, [{ ...fixturePin(), instance_id: "django__django-99999" }]);
  });

  test("a failed dataset fetch refuses instead of skipping", async () => {
    await refuses(
      fakeNet({
        respond: (url) => (url.includes("datasets-server") ? new Response("", { status: 404 }) : undefined),
      }),
      /dataset page at offset 0/,
    );
  });

  test("an index body off its digest refuses", async () => {
    await refuses(
      fakeNet({
        respond: (url, init) => (url.includes("/manifests/") && init?.method !== "HEAD" ? new Response("{}") : undefined),
      }),
      /does not hash to/,
    );
  });

  test("a malformed registry digest refuses", async () => {
    await refuses(
      fakeNet({
        respond: (url, init) =>
          init?.method === "HEAD" ? new Response(null, { headers: { "docker-content-digest": "md5:abc" } }) : undefined,
      }),
      /not a sha256 digest/,
    );
  });

  test("the same inputs give byte-identical output apart from drawn_at", async () => {
    const first = await draw(fakeNet(), () => "2026-11-01T00:00:00.000Z");
    const second = await draw(fakeNet(), () => "2027-01-01T00:00:00.000Z");
    const firstText = readFileSync(first.outPath, "utf8");
    const secondText = readFileSync(second.outPath, "utf8");
    assert.notEqual(firstText, secondText);
    assert.equal(
      firstText.replace("2026-11-01T00:00:00.000Z", "T"),
      secondText.replace("2027-01-01T00:00:00.000Z", "T"),
    );
  });
});

describe("SC3: output file", () => {
  test("writes the document shape with every field populated", async () => {
    const { outPath } = await draw();
    const written = JSON.parse(readFileSync(outPath, "utf8"));
    assert.deepEqual(Object.keys(written), ["seed", "verdicts_sha256", "drawn_at", "frame_sizes", "skipped", "patches"]);
    assert.equal(written.seed, SEED);
    assert.deepEqual(written.frame_sizes, { wrong: WRONG_INSTANCES, correct: CORRECT_INSTANCES });
    assert.deepEqual(written.skipped, []);
    for (const patch of written.patches) {
      assert.deepEqual(new Set(Object.keys(patch)), new Set([...SMOKE_FIELDS, "draw_position"]));
      for (const value of Object.values(patch)) assert.ok(value !== null && value !== undefined);
    }
  });

  test("entries pass the smoke-patch regexes and carry the pinned fields", async () => {
    const { patches, verdicts_sha256: verdictsSha } = await draw();
    for (const patch of patches) {
      assert.equal(patch.excluded_from_draw, true);
      assert.match(patch.image_digest, /^sha256:[0-9a-f]{64}$/);
      assert.match(patch.image_amd64_manifest_digest, /^sha256:[0-9a-f]{64}$/);
      assert.match(patch.base_commit, /^[0-9a-f]{40}$/);
      for (const hash of [patch.patch_sha256, patch.problem_statement_sha256, patch.test_patch_sha256, patch.gold_patch_sha256]) {
        assert.match(hash, /^[0-9a-f]{64}$/);
      }
      assert.ok(patch.patch_url.includes(`/${patch.agent_id}/logs/${patch.instance_id}/`));
      assert.equal(patch.patch_url, patchUrl(patch.agent_id, patch.instance_id));
      assert.ok(patch.image.endsWith(patch.instance_id.replace("django__", "")));
      assert.equal(patch.image, `swebench/sweb.eval.x86_64.django_1776_${patch.instance_id.replace("django__", "")}`);
      assert.equal(patch.patch_sha256, sha256(PATCH_TEXT));
      assert.equal(patch.dataset, "SWE-bench/SWE-bench_Verified");
      assert.deepEqual(patch.source_commits, SOURCE_COMMITS);
      assert.equal(patch.swe_abs_verdicts_sha256, verdictsSha);
      assert.equal(patch.image_amd64_manifest_digest, `sha256:${sha256(`amd ${patch.image}`)}`);
    }
  });

  test("the output holds no patch text", async () => {
    const { outPath } = await draw();
    assert.ok(!readFileSync(outPath, "utf8").includes("diff --git"));
  });

  test("the registry HEAD asks for an index with an anonymous token", async () => {
    const net = fakeNet();
    await draw(net);
    const headers = net.heads[0].headers as Record<string, string>;
    assert.match(headers.Accept, /application\/vnd\.oci\.image\.index\.v1\+json/);
    assert.match(headers.Accept, /application\/vnd\.docker\.distribution\.manifest\.list\.v2\+json/);
    assert.equal(headers.Authorization, "Bearer fake-token");
  });
});

describe("SC4: network", () => {
  test("every request goes through the injected fetch to a known host", async () => {
    const net = fakeNet();
    await draw(net);
    const hosts = new Set(net.urls.map((url) => new URL(url).hostname));
    assert.deepEqual(
      [...hosts].sort(),
      ["auth.docker.io", "datasets-server.huggingface.co", "registry-1.docker.io", "swe-bench-submissions.s3.amazonaws.com"],
    );
  });
});

function runCli(script: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [join(CHECKS, script), ...args], { encoding: "utf8" });
}

describe("CLI refusal", () => {
  test("draw-pilot without arguments prints usage and exits non-zero", () => {
    const result = runCli("draw-pilot.ts", []);
    assert.equal(result.status, 2);
    assert.match(result.stderr as string, /usage: node harness\/checks\/draw-pilot\.ts/);
  });

  test("draw-pilot refuses an unpinned verdict file and writes nothing", () => {
    const { verdictsPath, outPath } = setup();
    const result = runCli("draw-pilot.ts", ["--verdicts", verdictsPath, "--seed", SEED, "--out", outPath]);
    assert.equal(result.status, 2);
    assert.match(result.stderr as string, /differs from the pinned/);
    assert.equal(existsSync(outPath), false);
  });
});

describe("SC5: reasoning audit tools", () => {
  function runFixture(): { root: string; runName: string } {
    const root = mkdtempSync(join(tmpdir(), "reasoning-test-"));
    const runName = "01-django__django-20000-high";
    const dir = join(root, "runs", runName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), JSON.stringify({ instance_id: "django__django-20000", verdict: "PASS", thinking_blocks: 1 }));
    const transcript = [
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "I recall the upstream fix." }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "grep needle-one" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "needle-two seen" }] } },
      { type: "result", result: "done" },
    ];
    writeFileSync(join(dir, "transcript.jsonl"), transcript.map((event) => JSON.stringify(event)).join("\n"));
    return { root, runName };
  }

  for (const [script, args] of [
    ["reasoning-extract.ts", []],
    ["reasoning-extract.ts", ["only-run-dir"]],
    ["first-sight.ts", []],
    ["first-sight.ts", ["only-runs-dir"]],
  ] as Array<[string, string[]]>) {
    test(`${script} with ${args.length} args prints usage and exits non-zero`, () => {
      const result = runCli(script, args);
      assert.equal(result.status, 2);
      assert.match(result.stderr as string, new RegExp(`usage: node harness/checks/${script}`));
    });
  }

  test("reasoning-extract writes the transcript and reports memory terms", () => {
    const { root, runName } = runFixture();
    const outDir = join(root, "extract");
    const result = runCli("reasoning-extract.ts", [root, outDir]);
    assert.equal(result.status, 0, result.stderr as string);
    assert.match(result.stdout as string, /memory-term hits=1/);
    const text = readFileSync(join(outDir, `${runName}.txt`), "utf8");
    assert.match(text, /--- THINKING ---/);
    assert.match(text, /=== RESULT ===/);
  });

  test("first-sight reports each needle of the run's instance only", () => {
    const { root } = runFixture();
    const needlesPath = join(root, "needles.json");
    writeFileSync(
      needlesPath,
      JSON.stringify({ "django__django-20000": ["needle-one", "needle-two"], "django__django-29999": ["upstream"] }),
    );
    const result = runCli("first-sight.ts", [join(root, "runs"), needlesPath]);
    assert.equal(result.status, 0, result.stderr as string);
    assert.match(result.stdout as string, /needle-one -> 1:COMMAND/);
    assert.match(result.stdout as string, /needle-two -> 2:OUTPUT/);
    assert.ok(!(result.stdout as string).includes("upstream"));
  });
});
