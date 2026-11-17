import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import {
  correctFrame,
  CORRECT_STRATUM,
  DrawRefusal,
  drawStratum,
  PINNED_VERDICTS_SHA256,
  WRONG_STRATUM,
  wrongFrame,
  type CapTier,
  type DrawEntry,
  type Frame,
  type VerdictRecord,
} from "../draw.ts";
import { fetchText, REPO_ROOT, sha256, type Downloader, type Instance } from "../sources.ts";

const USAGE = "usage: node harness/checks/draw-pilot.ts --verdicts <path> --seed <string> --out <path>";

export const PILOT_WRONG_ENTRIES = 14;
export const PILOT_CORRECT_ENTRIES = 6;
export const PILOT_WRONG_TIERS: readonly CapTier[] = [
  { through: PILOT_WRONG_ENTRIES, cap: 2, role: "pilot" },
  { through: Number.POSITIVE_INFINITY, cap: 2, role: "substitute" },
];
export const PILOT_CORRECT_TIERS: readonly CapTier[] = [
  { through: PILOT_CORRECT_ENTRIES, cap: 1, role: "pilot" },
  { through: Number.POSITIVE_INFINITY, cap: 1, role: "substitute" },
];

const SMOKE_PATCHES_PATH = join(REPO_ROOT, "harness", "smoke", "smoke-patches.json");
const DATASET_SERVER = "https://datasets-server.huggingface.co";
const ROWS_PAGE_LENGTH = 100;
const REGISTRY = "https://registry-1.docker.io";
const INDEX_ACCEPT = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json";
const DIGEST_SHAPE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_SHAPE = /^[0-9a-f]{40}$/;
const INSTANCE_SHAPE = /^django__django-(\d+)$/;

export interface PilotNet {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  sleep(ms: number): Promise<void>;
}

export interface PilotPin extends Instance {
  source_commits: Record<string, string>;
}

export interface PilotPatch extends PilotPin {
  label_stratum: "swe_abs_wrong" | "swe_abs_correct";
  image_amd64_manifest_digest: string;
  swe_abs_verdicts_sha256: string;
  draw_position: number;
}

export interface SkippedEntry {
  stratum: string;
  draw_position: number;
  instance_id: string;
  agent_id: string;
  reason: string;
}

export interface PilotDraw {
  seed: string;
  verdicts_sha256: string;
  drawn_at: string;
  frame_sizes: { wrong: number; correct: number };
  skipped: SkippedEntry[];
  patches: PilotPatch[];
}

export interface PilotParams {
  verdictsPath: string;
  seed: string;
  outPath: string;
  net?: PilotNet;
  now?: () => string;
  pinnedSha256?: string;
  pins?: readonly PilotPin[];
}

interface RowHashes {
  base_commit: string;
  problem_statement_sha256: string;
  test_patch_sha256: string;
  gold_patch_sha256: string;
}

export interface DatasetEntry {
  row?: Record<string, unknown>;
  truncated_cells?: unknown[];
}

export interface ImageDigests {
  image: string;
  image_digest: string;
  image_amd64_manifest_digest: string;
}

interface StratumRequest {
  frame: Frame;
  stratum: string;
  caps: readonly CapTier[];
  wanted: number;
  label: PilotPatch["label_stratum"];
}

interface StratumSelection {
  patches: PilotPatch[];
  skipped: SkippedEntry[];
  visited: string[];
}

export const REAL_NET: PilotNet = {
  fetch: (url, init) => fetch(url, init),
  sleep: async (ms) => {
    await delay(ms);
  },
};

function downloaderFor(net: PilotNet, init?: RequestInit): Downloader {
  return { fetch: (url) => net.fetch(url, init), sleep: net.sleep, cacheRoot: "" };
}

export async function fetchDatasetEntries(dataset: string, net: PilotNet): Promise<Map<string, DatasetEntry>> {
  const entries = new Map<string, DatasetEntry>();
  for (let offset = 0; ; ) {
    const query = new URLSearchParams({
      dataset,
      config: "default",
      split: "test",
      offset: String(offset),
      length: String(ROWS_PAGE_LENGTH),
    });
    let page: { rows?: DatasetEntry[]; num_rows_total?: number };
    try {
      page = JSON.parse(await fetchText(`${DATASET_SERVER}/rows?${query}`, downloaderFor(net)));
    } catch (error) {
      throw new DrawRefusal(`dataset page at offset ${offset}: ${(error as Error).message}`);
    }
    const { rows, num_rows_total: total } = page;
    if (!Array.isArray(rows) || typeof total !== "number") {
      throw new DrawRefusal(`dataset page at offset ${offset} has no rows or num_rows_total`);
    }
    for (const entry of rows) {
      if (typeof entry.row?.instance_id === "string") entries.set(entry.row.instance_id, entry);
    }
    offset += rows.length;
    if (offset >= total) return entries;
    if (rows.length === 0) throw new DrawRefusal(`dataset page at offset ${offset} is empty before total ${total}`);
  }
}

export function rowHashes(instanceId: string, entries: ReadonlyMap<string, DatasetEntry>): RowHashes {
  const entry = entries.get(instanceId);
  if (!entry?.row) throw new DrawRefusal(`dataset has no row for ${instanceId}`);
  if (entry.truncated_cells?.length !== 0) throw new DrawRefusal(`dataset row for ${instanceId} is truncated`);
  const { base_commit, problem_statement, test_patch, patch } = entry.row;
  if (
    typeof base_commit !== "string" ||
    !COMMIT_SHAPE.test(base_commit) ||
    typeof problem_statement !== "string" ||
    typeof test_patch !== "string" ||
    typeof patch !== "string"
  ) {
    throw new DrawRefusal(`dataset row for ${instanceId} has the wrong shape`);
  }
  return {
    base_commit,
    problem_statement_sha256: sha256(problem_statement),
    test_patch_sha256: sha256(test_patch),
    gold_patch_sha256: sha256(patch),
  };
}

export function requirePinnedRows(pins: readonly PilotPin[], entries: ReadonlyMap<string, DatasetEntry>): void {
  for (const pin of pins) {
    const hashes = rowHashes(pin.instance_id, entries);
    for (const field of Object.keys(hashes) as Array<keyof RowHashes>) {
      if (hashes[field] !== pin[field]) {
        throw new DrawRefusal(`dataset row for ${pin.instance_id}: ${field} is ${hashes[field]}, pinned ${pin[field]}`);
      }
    }
  }
}

function imageRepository(instanceId: string): string {
  const match = INSTANCE_SHAPE.exec(instanceId);
  if (!match) throw new DrawRefusal(`instance id ${instanceId} has the wrong shape`);
  return `swebench/sweb.eval.x86_64.django_1776_django-${match[1]}`;
}

function requireDigest(label: string, value: unknown): string {
  if (typeof value !== "string" || !DIGEST_SHAPE.test(value)) {
    throw new DrawRefusal(`${label} is not a sha256 digest: ${String(value)}`);
  }
  return value;
}

async function fetchIndexDigest(url: string, headers: Record<string, string>, net: PilotNet): Promise<string> {
  let digest: string | null = null;
  const capturing: Downloader = {
    ...downloaderFor(net),
    fetch: async (target) => {
      const response = await net.fetch(target, { method: "HEAD", headers });
      digest = response.headers.get("docker-content-digest");
      return response;
    },
  };
  await fetchText(url, capturing);
  return requireDigest(`${url} digest`, digest);
}

function amd64Digest(repository: string, indexDigest: string, indexText: string): string {
  if (`sha256:${sha256(indexText)}` !== indexDigest) {
    throw new DrawRefusal(`${repository} index body does not hash to ${indexDigest}`);
  }
  let index: { manifests?: Array<{ digest?: unknown; platform?: { os?: string; architecture?: string } }> };
  try {
    index = JSON.parse(indexText);
  } catch (error) {
    throw new DrawRefusal(`${repository} index is not JSON: ${(error as Error).message}`);
  }
  const entry = index.manifests?.find(
    ({ platform }) => platform?.os === "linux" && platform.architecture === "amd64",
  );
  if (!entry) throw new Error(`${repository} index has no linux/amd64 entry`);
  return requireDigest(`${repository} linux/amd64 digest`, entry.digest);
}

async function fetchImageDigests(instanceId: string, net: PilotNet): Promise<ImageDigests> {
  const image = imageRepository(instanceId);
  const tokenQuery = new URLSearchParams({ service: "registry.docker.io", scope: `repository:${image}:pull` });
  const tokenBody = await fetchText(`https://auth.docker.io/token?${tokenQuery}`, downloaderFor(net));
  const { token } = JSON.parse(tokenBody) as { token?: string };
  if (!token) throw new Error(`auth.docker.io returned no token for ${image}`);
  const headers = { Accept: INDEX_ACCEPT, Authorization: `Bearer ${token}` };
  const image_digest = await fetchIndexDigest(`${REGISTRY}/v2/${image}/manifests/latest`, headers, net);
  const indexText = await fetchText(`${REGISTRY}/v2/${image}/manifests/${image_digest}`, downloaderFor(net, { headers }));
  return { image, image_digest, image_amd64_manifest_digest: amd64Digest(image, image_digest, indexText) };
}

async function fetchPatchHash(patchUrl: string, net: PilotNet): Promise<string> {
  const patch = await fetchText(patchUrl, downloaderFor(net));
  if (patch.length === 0) throw new Error(`${patchUrl} is empty`);
  return sha256(patch);
}

export async function checkAvailability(
  entry: DrawEntry,
  net: PilotNet,
): Promise<{ patch_sha256: string; digests: ImageDigests } | { reason: string }> {
  try {
    const patch_sha256 = await fetchPatchHash(entry.patch_url, net);
    return { patch_sha256, digests: await fetchImageDigests(entry.instance_id, net) };
  } catch (error) {
    if (error instanceof DrawRefusal) throw error;
    return { reason: (error as Error).message };
  }
}

async function selectStratum(
  { frame, stratum, caps, wanted, label }: StratumRequest,
  seed: string,
  entries: ReadonlyMap<string, DatasetEntry>,
  shared: Pick<PilotPatch, "dataset" | "source_commits" | "swe_abs_verdicts_sha256">,
  net: PilotNet,
): Promise<StratumSelection> {
  const selection: StratumSelection = { patches: [], skipped: [], visited: [] };
  for (const entry of drawStratum(frame, { seed, stratum, caps }).entries) {
    if (selection.patches.length === wanted) break;
    selection.visited.push(entry.instance_id);
    const outcome = await checkAvailability(entry, net);
    if ("reason" in outcome) {
      selection.skipped.push({
        stratum,
        draw_position: entry.position,
        instance_id: entry.instance_id,
        agent_id: entry.agent_id,
        reason: outcome.reason,
      });
      continue;
    }
    selection.patches.push({
      instance_id: entry.instance_id,
      agent_id: entry.agent_id,
      label_stratum: label,
      patch_sha256: outcome.patch_sha256,
      patch_url: entry.patch_url,
      ...outcome.digests,
      ...rowHashes(entry.instance_id, entries),
      dataset: shared.dataset,
      source_commits: shared.source_commits,
      swe_abs_verdicts_sha256: shared.swe_abs_verdicts_sha256,
      excluded_from_draw: true,
      draw_position: entry.position,
    });
  }
  if (selection.patches.length < wanted) {
    throw new DrawRefusal(`${stratum} stratum yielded ${selection.patches.length} available entries, needs ${wanted}`);
  }
  return selection;
}

export function parseVerdictRecords(raw: string): VerdictRecord[] {
  let parsed: { records?: unknown } | null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DrawRefusal(`verdict file is not JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed?.records)) throw new DrawRefusal("verdict file has no records[] array");
  return parsed.records as VerdictRecord[];
}

export function readVerdictFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new DrawRefusal(`cannot read verdict file: ${(error as Error).message}`);
  }
}

export function loadPins(): PilotPin[] {
  return JSON.parse(readFileSync(SMOKE_PATCHES_PATH, "utf8")) as PilotPin[];
}

export async function runPilotDraw({
  verdictsPath,
  seed,
  outPath,
  net = REAL_NET,
  now = () => new Date().toISOString(),
  pinnedSha256 = PINNED_VERDICTS_SHA256,
  pins = loadPins(),
}: PilotParams): Promise<PilotDraw> {
  const raw = readVerdictFile(verdictsPath);
  const verdictsSha256 = sha256(raw);
  if (verdictsSha256 !== pinnedSha256) {
    throw new DrawRefusal(`verdict file sha256 ${verdictsSha256} differs from the pinned ${pinnedSha256}`);
  }
  const records = parseVerdictRecords(raw);

  const [{ dataset, source_commits }] = pins;
  const entries = await fetchDatasetEntries(dataset, net);
  requirePinnedRows(pins, entries);
  const shared = { dataset, source_commits, swe_abs_verdicts_sha256: verdictsSha256 };

  const wrong = wrongFrame(records);
  const correct = correctFrame(records);
  const wrongSelection = await selectStratum(
    { frame: wrong, stratum: WRONG_STRATUM, caps: PILOT_WRONG_TIERS, wanted: PILOT_WRONG_ENTRIES, label: "swe_abs_wrong" },
    seed,
    entries,
    shared,
    net,
  );
  const drawnWrong = new Set(wrongSelection.visited);
  const correctSelection = await selectStratum(
    {
      frame: correct.filter((instance) => !drawnWrong.has(instance.instance_id)),
      stratum: CORRECT_STRATUM,
      caps: PILOT_CORRECT_TIERS,
      wanted: PILOT_CORRECT_ENTRIES,
      label: "swe_abs_correct",
    },
    seed,
    entries,
    shared,
    net,
  );

  const draw: PilotDraw = {
    seed,
    verdicts_sha256: verdictsSha256,
    drawn_at: now(),
    frame_sizes: { wrong: wrong.length, correct: correct.length },
    skipped: [...wrongSelection.skipped, ...correctSelection.skipped],
    patches: [...wrongSelection.patches, ...correctSelection.patches],
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(draw, null, 2)}\n`);
  return draw;
}

function parseCli(args: string[]): PilotParams {
  const { values } = parseArgs({
    args,
    options: {
      verdicts: { type: "string" },
      seed: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.verdicts) throw new DrawRefusal("--verdicts is required");
  if (!values.seed) throw new DrawRefusal("--seed is required; the draw has no default seed");
  if (!values.out) throw new DrawRefusal("--out is required");
  return { verdictsPath: values.verdicts, seed: values.seed, outPath: values.out };
}

async function main(): Promise<number> {
  try {
    const params = parseCli(process.argv.slice(2));
    await runPilotDraw(params);
    console.log(params.outPath);
    return 0;
  } catch (error) {
    const isUsage = error instanceof DrawRefusal || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    if (!isUsage) throw error;
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
