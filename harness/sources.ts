import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface Instance {
  instance_id: string;
  agent_id: string;
  patch_sha256: string;
  patch_url: string;
  image: string;
  image_digest: string;
  base_commit: string;
  problem_statement_sha256: string;
  test_patch_sha256: string;
  gold_patch_sha256: string;
  dataset: string;
  excluded_from_draw: boolean;
}

export interface Sources {
  instance: Instance;
  patch: string;
  problemStatement: string;
  testPatch: string;
  goldPatch: string;
}

interface DatasetRow {
  problem_statement: string;
  test_patch: string;
  patch: string;
}

interface DatasetEntry {
  row: DatasetRow & { instance_id?: string };
  truncated_cells?: string[];
}

export const REPO_ROOT = dirname(import.meta.dirname);
export const MVP_INSTANCE_PATH = join(import.meta.dirname, "mvp-instance.json");
const FAKE_SOURCES_PATH = join(import.meta.dirname, "fixtures", "fake-sources.json");
const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 60_000;
const BACKOFF_BASE_MS = 1000;
const MISMATCHES_BEFORE_FAILING = 2;
const DATASET_SERVER = "https://datasets-server.huggingface.co";
const ROWS_PAGE_LENGTH = 100;

export interface Downloader {
  fetch(url: string): Promise<Response>;
  sleep(ms: number): Promise<void>;
  cacheRoot: string;
}

const REAL_DOWNLOADER: Downloader = {
  fetch: (url) => fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
  sleep: async (ms) => {
    await delay(ms);
  },
  cacheRoot: join(REPO_ROOT, "runs", "cache"),
};

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function requireHash(label: string, text: string, expected: string): void {
  const actual = sha256(text);
  if (actual !== expected) {
    throw new Error(`${label} sha256 is ${actual}, expected ${expected}`);
  }
}

export function loadFakeSources(): Sources {
  return JSON.parse(readFileSync(FAKE_SOURCES_PATH, "utf8")) as Sources;
}

type FetchAttempt = { text: string } | { failure: string; retriable: boolean };

function isRetriableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function attemptFetch(url: string, downloader: Downloader): Promise<FetchAttempt> {
  try {
    const response = await downloader.fetch(url);
    if (response.ok) return { text: await response.text() };
    return {
      failure: `GET ${url} returned ${response.status}`,
      retriable: isRetriableStatus(response.status),
    };
  } catch (error) {
    const { message, cause } = error as Error;
    const reason = cause instanceof Error ? `${message}: ${cause.message}` : message;
    return { failure: `GET ${url} failed: ${reason}`, retriable: true };
  }
}

export async function fetchText(url: string, downloader: Downloader): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await attemptFetch(url, downloader);
    if ("text" in outcome) return outcome.text;
    if (!outcome.retriable) throw new Error(outcome.failure);
    if (attempt === FETCH_ATTEMPTS) {
      throw new Error(`${outcome.failure} after ${FETCH_ATTEMPTS} attempts`);
    }
    await downloader.sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
  }
}

function storeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

async function cached(
  path: string,
  fetcher: () => Promise<string>,
  verify: (text: string) => void,
): Promise<string> {
  let mismatches = 0;
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    try {
      verify(text);
      return text;
    } catch {
      rmSync(path);
      mismatches = 1;
    }
  }
  for (;;) {
    const text = await fetcher();
    try {
      verify(text);
      storeAtomically(path, text);
      return text;
    } catch (error) {
      mismatches += 1;
      if (mismatches === MISMATCHES_BEFORE_FAILING) throw error;
    }
  }
}

function completeRow(instance: Instance, entry: DatasetEntry | undefined): string {
  if (!entry || entry.truncated_cells?.length !== 0) {
    throw new Error(`dataset row for ${instance.instance_id} is missing or truncated`);
  }
  const { problem_statement, test_patch, patch } = entry.row;
  return JSON.stringify({ problem_statement, test_patch, patch });
}

function datasetQuery(instance: Instance, extra: Record<string, string>): URLSearchParams {
  return new URLSearchParams({
    dataset: instance.dataset,
    config: "default",
    split: "test",
    ...extra,
  });
}

async function filterDatasetRow(instance: Instance, downloader: Downloader): Promise<string> {
  const query = datasetQuery(instance, { where: `"instance_id"='${instance.instance_id}'` });
  const body = JSON.parse(await fetchText(`${DATASET_SERVER}/filter?${query}`, downloader)) as {
    rows?: DatasetEntry[];
  };
  return completeRow(instance, body.rows?.[0]);
}

async function scanDatasetRows(instance: Instance, downloader: Downloader): Promise<string> {
  for (let offset = 0; ; ) {
    const query = datasetQuery(instance, {
      offset: String(offset),
      length: String(ROWS_PAGE_LENGTH),
    });
    const page = JSON.parse(await fetchText(`${DATASET_SERVER}/rows?${query}`, downloader)) as {
      rows?: DatasetEntry[];
      num_rows_total?: number;
    };
    const { rows, num_rows_total: total } = page;
    if (!Array.isArray(rows) || typeof total !== "number") {
      throw new Error(`/rows page at offset ${offset} has no rows or num_rows_total`);
    }
    const match = rows.find((entry) => entry.row?.instance_id === instance.instance_id);
    if (match) return completeRow(instance, match);
    offset += rows.length;
    if (offset >= total) {
      throw new Error(`${instance.instance_id} not found in ${total} rows`);
    }
    if (rows.length === 0) {
      throw new Error(`/rows page at offset ${offset} is empty before num_rows_total ${total}`);
    }
  }
}

async function fetchDatasetRow(instance: Instance, downloader: Downloader): Promise<string> {
  let filterFailure: string;
  try {
    return await filterDatasetRow(instance, downloader);
  } catch (error) {
    filterFailure = (error as Error).message;
  }
  try {
    return await scanDatasetRows(instance, downloader);
  } catch (error) {
    throw new Error(
      `dataset lookup for ${instance.instance_id} failed: /filter: ${filterFailure}; /rows: ${(error as Error).message}`,
    );
  }
}

function verifyDatasetRow(instance: Instance, text: string): void {
  const row = JSON.parse(text) as DatasetRow;
  requireHash("problem_statement", row.problem_statement, instance.problem_statement_sha256);
  requireHash("test_patch", row.test_patch, instance.test_patch_sha256);
  requireHash("gold patch", row.patch, instance.gold_patch_sha256);
}

export function loadMvpSources(downloader: Downloader = REAL_DOWNLOADER): Promise<Sources> {
  return loadSources(JSON.parse(readFileSync(MVP_INSTANCE_PATH, "utf8")) as Instance, downloader);
}

export async function loadSources(
  instance: Instance,
  downloader: Downloader = REAL_DOWNLOADER,
): Promise<Sources> {
  const cacheDir = join(downloader.cacheRoot, instance.instance_id);
  const patch = await cached(
    join(cacheDir, `${instance.agent_id}.diff`),
    () => fetchText(instance.patch_url, downloader),
    (text) => requireHash("patch", text, instance.patch_sha256),
  );
  const row = JSON.parse(
    await cached(
      join(cacheDir, "dataset-row.json"),
      () => fetchDatasetRow(instance, downloader),
      (text) => verifyDatasetRow(instance, text),
    ),
  ) as DatasetRow;
  return {
    instance,
    patch,
    problemStatement: row.problem_statement,
    testPatch: row.test_patch,
    goldPatch: row.patch,
  };
}
