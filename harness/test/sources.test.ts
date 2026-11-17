import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  fetchText,
  loadMvpSources,
  loadSources,
  sha256,
  type Downloader,
  type Instance,
} from "../sources.ts";

const URL_A = "https://example.invalid/a";
const DATASET_BODY = JSON.stringify({
  rows: [{ row: { problem_statement: "p", test_patch: "t", patch: "g" }, truncated_cells: [] }],
});

const CANDIDATE = "candidate patch";
const INSTANCE: Instance = {
  instance_id: "example__example-1",
  agent_id: "agent",
  patch_sha256: sha256(CANDIDATE),
  patch_url: "https://example.invalid/patch.diff",
  image: "example/image",
  image_digest: `sha256:${"0".repeat(64)}`,
  base_commit: "0".repeat(40),
  problem_statement_sha256: sha256("p"),
  test_patch_sha256: sha256("t"),
  gold_patch_sha256: sha256("g"),
  dataset: "example/dataset",
  excluded_from_draw: true,
};

type Reply = number | Error | string | Response;

function toResponse(reply: Reply): Response {
  if (reply instanceof Error) throw reply;
  if (reply instanceof Response) return reply;
  return typeof reply === "number" ? new Response("", { status: reply }) : new Response(reply);
}

function scripted(replies: Reply[]) {
  const urls: string[] = [];
  const sleeps: number[] = [];
  const downloader: Downloader = {
    fetch: async (url) => {
      urls.push(url);
      return toResponse(replies[urls.length - 1]);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    cacheRoot: mkdtempSync(join(tmpdir(), "cr-sources-")),
  };
  return { downloader, urls, sleeps };
}

function networkError(): Error {
  return new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
}

function timeoutError(): Error {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

function failingBody(): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.error(timeoutError());
    },
  });
  return new Response(body);
}

describe("SC4: download retry", () => {
  const recovers: Array<[string, Reply]> = [
    ["a 500", 500],
    ["a 503", 503],
    ["a 429", 429],
    ["a network error", networkError()],
    ["a fetch timeout", timeoutError()],
    ["a body read that fails", failingBody()],
  ];

  for (const [name, first] of recovers) {
    test(`succeeds after ${name}`, async () => {
      const { downloader, urls, sleeps } = scripted([first, "body"]);
      assert.equal(await fetchText(URL_A, downloader), "body");
      assert.equal(urls.length, 2);
      assert.deepEqual(sleeps, [1000]);
    });
  }

  test("succeeds on the third attempt with a growing backoff", async () => {
    const { downloader, sleeps } = scripted([500, 500, "body"]);
    assert.equal(await fetchText(URL_A, downloader), "body");
    assert.deepEqual(sleeps, [1000, 2000]);
  });

  const exhausts: Array<[string, Reply, RegExp]> = [
    ["500s", 500, /returned 500 after 3 attempts/],
    ["429s", 429, /returned 429 after 3 attempts/],
    ["network errors", networkError(), /fetch failed: ECONNRESET after 3 attempts/],
  ];

  for (const [name, reply, expected] of exhausts) {
    test(`gives up after 3 attempts of ${name}`, async () => {
      const { downloader, urls, sleeps } = scripted([reply, reply, reply, "unreached"]);
      await assert.rejects(fetchText(URL_A, downloader), expected);
      assert.equal(urls.length, 3);
      assert.deepEqual(sleeps, [1000, 2000]);
    });
  }

  for (const status of [400, 403, 404]) {
    test(`does not retry a ${status}`, async () => {
      const { downloader, urls, sleeps } = scripted([status, "unreached"]);
      await assert.rejects(fetchText(URL_A, downloader), new RegExp(`returned ${status}$`));
      assert.equal(urls.length, 1);
      assert.deepEqual(sleeps, []);
    });
  }

  test("the patch and the dataset row both download through the retry", async () => {
    const { downloader, urls, sleeps } = scripted([500, CANDIDATE, 500, DATASET_BODY]);
    await loadSources(INSTANCE, downloader);
    assert.equal(urls[0], urls[1]);
    assert.equal(urls[2], urls[3]);
    assert.match(urls[2], /datasets-server\.huggingface\.co\/filter/);
    assert.deepEqual(sleeps, [1000, 1000]);
  });
});

describe("the cache only holds verified files", () => {
  function cacheFiles(downloader: Downloader): string[] {
    const dir = join(downloader.cacheRoot, INSTANCE.instance_id);
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }

  function seedCache(downloader: Downloader, name: string, text: string): string {
    const dir = join(downloader.cacheRoot, INSTANCE.instance_id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  }

  test("a corrupt first response followed by a good one succeeds and stores the good one", async () => {
    const { downloader, urls, sleeps } = scripted(["corrupt", CANDIDATE, DATASET_BODY]);
    const sources = await loadSources(INSTANCE, downloader);
    assert.equal(sources.patch, CANDIDATE);
    assert.equal(urls.length, 3);
    assert.equal(urls[0], urls[1]);
    assert.deepEqual(sleeps, []);
    assert.deepEqual(cacheFiles(downloader), ["agent.diff", "dataset-row.json"]);
    const patchFile = join(downloader.cacheRoot, INSTANCE.instance_id, "agent.diff");
    assert.equal(readFileSync(patchFile, "utf8"), CANDIDATE);
  });

  test("two corrupt responses fail at once with nothing left in the cache", async () => {
    const { downloader, urls } = scripted(["corrupt", "corrupt again", "unreached"]);
    await assert.rejects(loadSources(INSTANCE, downloader), /patch sha256 is /);
    assert.equal(urls.length, 2);
    assert.deepEqual(cacheFiles(downloader), []);
  });

  test("a corrupt dataset row is refetched once and two fail with only the patch cached", async () => {
    const wrongRow = JSON.stringify({
      rows: [{ row: { problem_statement: "x", test_patch: "t", patch: "g" }, truncated_cells: [] }],
    });
    const recovered = scripted([CANDIDATE, wrongRow, DATASET_BODY]);
    assert.equal((await loadSources(INSTANCE, recovered.downloader)).problemStatement, "p");

    const failing = scripted([CANDIDATE, wrongRow, wrongRow, "unreached"]);
    await assert.rejects(loadSources(INSTANCE, failing.downloader), /problem_statement sha256 is /);
    assert.equal(failing.urls.length, 3);
    assert.deepEqual(cacheFiles(failing.downloader), ["agent.diff"]);
  });

  test("a mismatched cached file is refetched once and replaced", async () => {
    const { downloader, urls } = scripted([CANDIDATE, DATASET_BODY]);
    const poisoned = seedCache(downloader, "agent.diff", "corrupt");
    assert.equal((await loadSources(INSTANCE, downloader)).patch, CANDIDATE);
    assert.equal(urls.length, 2);
    assert.equal(readFileSync(poisoned, "utf8"), CANDIDATE);
  });

  test("a mismatched cached file with a corrupt refetch fails at once and is gone", async () => {
    const { downloader, urls } = scripted(["still corrupt", "unreached"]);
    seedCache(downloader, "agent.diff", "corrupt");
    await assert.rejects(loadSources(INSTANCE, downloader), /patch sha256 is /);
    assert.equal(urls.length, 1);
    assert.deepEqual(cacheFiles(downloader), []);
  });

  test("a cached row that is not JSON counts as a mismatch", async () => {
    const { downloader } = scripted([DATASET_BODY]);
    seedCache(downloader, "agent.diff", CANDIDATE);
    seedCache(downloader, "dataset-row.json", '{"problem_st');
    assert.equal((await loadSources(INSTANCE, downloader)).testPatch, "t");
  });

  test("a verified cached file is read without a fetch", async () => {
    const { downloader, urls } = scripted([]);
    seedCache(downloader, "agent.diff", CANDIDATE);
    seedCache(
      downloader,
      "dataset-row.json",
      JSON.stringify({ problem_statement: "p", test_patch: "t", patch: "g" }),
    );
    assert.equal((await loadSources(INSTANCE, downloader)).patch, CANDIDATE);
    assert.equal(urls.length, 0);
  });

  test("the rename leaves no temp file behind", async () => {
    const { downloader } = scripted([CANDIDATE, DATASET_BODY]);
    await loadSources(INSTANCE, downloader);
    assert.ok(!cacheFiles(downloader).some((name) => name.endsWith(".tmp")));
  });

  test("the MVP instance still rejects a wrong patch after one refetch", async () => {
    const { downloader, urls } = scripted(["wrong patch text", "wrong patch text", "unreached"]);
    await assert.rejects(loadMvpSources(downloader), /patch sha256 is /);
    assert.equal(urls.length, 2);
  });
});

describe("the /rows fallback", () => {
  const FULL_ROW = { problem_statement: "p", test_patch: "t", patch: "g" };

  function entry(id: string, overrides: object = {}) {
    return { row: { instance_id: id, ...FULL_ROW }, truncated_cells: [], ...overrides };
  }

  function page(rows: object[], total: number): string {
    return JSON.stringify({ rows, num_rows_total: total });
  }

  function others(count: number): object[] {
    return Array.from({ length: count }, (_, index) => entry(`other-${index}`));
  }

  function filterFailsThen(pages: Reply[]) {
    return scripted([CANDIDATE, 500, 500, 500, ...pages]);
  }

  function rowsUrls(urls: string[]): URL[] {
    return urls.filter((url) => url.includes("/rows?")).map((url) => new URL(url));
  }

  test("a /filter 500 after its retries pages /rows and caches the verified row", async () => {
    const { downloader, urls } = filterFailsThen([page(others(100), 150), page([entry(INSTANCE.instance_id)], 150)]);
    const sources = await loadSources(INSTANCE, downloader);
    assert.equal(sources.problemStatement, "p");
    assert.equal(urls.filter((url) => url.includes("/filter?")).length, 3);
    const pages = rowsUrls(urls);
    assert.deepEqual(pages.map((url) => url.searchParams.get("offset")), ["0", "100"]);
    assert.ok(pages.every((url) => url.searchParams.get("length") === "100"));
    assert.equal(pages[0].searchParams.get("dataset"), INSTANCE.dataset);
    const cachedRow = JSON.parse(readFileSync(join(downloader.cacheRoot, INSTANCE.instance_id, "dataset-row.json"), "utf8"));
    assert.deepEqual(cachedRow, FULL_ROW);
  });

  const filterFailures: Array<[string, Reply]> = [
    ["a 404", 404],
    ["a body that is not JSON", "not json"],
    ["no matching row", JSON.stringify({ rows: [] })],
    ["a truncated row", JSON.stringify({ rows: [entry(INSTANCE.instance_id, { truncated_cells: ["patch"] })] })],
  ];

  for (const [name, reply] of filterFailures) {
    test(`/filter failing with ${name} falls back at once`, async () => {
      const { downloader, urls } = scripted([CANDIDATE, reply, page([entry(INSTANCE.instance_id)], 1)]);
      assert.equal((await loadSources(INSTANCE, downloader)).testPatch, "t");
      assert.equal(rowsUrls(urls).length, 1);
    });
  }

  test("a short page advances by what it returned, so no row is skipped", async () => {
    const { downloader, urls } = filterFailsThen([page(others(40), 41), page([entry(INSTANCE.instance_id)], 41)]);
    await loadSources(INSTANCE, downloader);
    assert.deepEqual(rowsUrls(urls).map((url) => url.searchParams.get("offset")), ["0", "40"]);
  });

  test("a row from /rows still has to pass the sha256 check", async () => {
    const wrong = { row: { instance_id: INSTANCE.instance_id, ...FULL_ROW, patch: "x" }, truncated_cells: [] };
    const { downloader } = scripted([CANDIDATE, 404, page([wrong], 1), 404, page([wrong], 1)]);
    await assert.rejects(loadSources(INSTANCE, downloader), /gold patch sha256 is /);
  });

  test("not found ends at num_rows_total and names both failures", async () => {
    const { downloader, urls } = filterFailsThen([page(others(100), 150), page(others(50), 150), "unreached"]);
    await assert.rejects(
      loadSources(INSTANCE, downloader),
      /\/filter: .*returned 500 after 3 attempts; \/rows: example__example-1 not found in 150 rows/,
    );
    assert.equal(rowsUrls(urls).length, 2);
    assert.ok(!existsSync(join(downloader.cacheRoot, INSTANCE.instance_id, "dataset-row.json")));
  });

  test("both endpoints failing names both failures", async () => {
    const { downloader } = filterFailsThen([503, 503, 503]);
    await assert.rejects(
      loadSources(INSTANCE, downloader),
      /\/filter: GET .*\/filter\?.*returned 500 after 3 attempts; \/rows: GET .*\/rows\?.*returned 503 after 3 attempts/,
    );
  });

  test("a truncated match on /rows is refused, not skipped", async () => {
    const truncated = entry(INSTANCE.instance_id, { truncated_cells: ["problem_statement"] });
    const { downloader, urls } = filterFailsThen([page([truncated, ...others(1)], 200), "unreached"]);
    await assert.rejects(loadSources(INSTANCE, downloader), /\/rows: dataset row for example__example-1 is missing or truncated/);
    assert.equal(rowsUrls(urls).length, 1);
  });

  const malformedPages: Array<[string, string, RegExp]> = [
    ["no num_rows_total", JSON.stringify({ rows: [] }), /no rows or num_rows_total/],
    ["no rows", JSON.stringify({ num_rows_total: 5 }), /no rows or num_rows_total/],
    ["an empty page before the total", page([], 5), /is empty before num_rows_total/],
  ];

  for (const [name, body, pattern] of malformedPages) {
    test(`a /rows page with ${name} fails instead of looping`, async () => {
      const { downloader, urls } = filterFailsThen([body, "unreached"]);
      await assert.rejects(loadSources(INSTANCE, downloader), pattern);
      assert.equal(rowsUrls(urls).length, 1);
    });
  }
});
