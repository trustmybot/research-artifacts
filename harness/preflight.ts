import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ENVIRONMENT_DIR,
  ENVIRONMENT_PATH,
  FIELD_SEPARATOR,
  FIXED_AUTHOR_EMAIL,
  FIXED_AUTHOR_NAME,
  FIXED_EPOCH_SECONDS,
  FIXED_MESSAGE,
  REVIEWER_ENV,
  REVIEWER_PYTHON,
  type ContainerRunner,
  type ExecResult,
} from "./runners.ts";
import { sha256 } from "./sources.ts";

export const CLI_VERSION = "2.1.311";
export const EFFORT_ENV = "CLAUDE_CODE_EFFORT_LEVEL";

const DANGLING_ORIGIN_HEAD = "refs/remotes/origin/HEAD";
const UPSTREAM_REF = "refs/remotes/origin/main";
export const UPSTREAM_BASE_CHECK = "upstream_base";
const DJANGO_UNDER_TESTBED = "/testbed/django/__init__.py";
const ENVIRONMENTS_DIR = join(import.meta.dirname, "environments");
const REVIEWER_SHELL_FLAGS = ["-c", "-lc"];

const LEAK_NAME_PATTERNS = [
  "*swe*abs*",
  "*sweabs*",
  "*test_patch*",
  "*test.patch",
  "gold*.patch",
  "gold*.diff",
  "*gold_patch*",
  "eval.sh",
];

const PROBE_TIMEOUT_SECONDS = "15";
const PROBE_BLOCKED_URL = "https://github.com/";
const PROBE_METADATA_URL = "http://169.254.169.254/";
const PROBE_ALLOWED_URL = "https://api.anthropic.com/";
const CURL_UNREACHABLE_EXIT_CODES = [6, 7, 28];

export interface PreflightInput {
  baseCommit: string;
  patch: string;
  testPatch: string;
  goldPatch: string;
  hostEnv: NodeJS.ProcessEnv;
}

export interface PreflightCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface PreflightResult {
  passed: boolean;
  checks: PreflightCheck[];
}

export function splitDiffByFile(diff: string): string[] {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((section) => section.startsWith("diff --git "));
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

function headerPath(line: string): string | null {
  const path = line.slice(4).split("\t")[0];
  return path === "/dev/null" ? null : path.replace(/^[^/]*\//, "");
}

export function patchPaths(diff: string): string[] {
  const paths = new Set<string>();
  const lines = diff.split(/\r?\n/);
  let oldLeft = 0;
  let newLeft = 0;
  for (const [index, line] of lines.entries()) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("-")) oldLeft--;
      else if (line.startsWith("+")) newLeft--;
      else if (!line.startsWith("\\")) {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
      continue;
    }
    const gitHeader = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (gitHeader) paths.add(gitHeader[1]);
    else if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      const path = headerPath(lines[index + 1]) ?? headerPath(line);
      if (path) paths.add(path);
    }
  }
  return [...paths].sort();
}

function git(...args: string[]): string[] {
  return ["git", "-C", "/testbed", ...args];
}

export function withFinalNewline(diff: string): string {
  return diff.endsWith("\n") ? diff : `${diff}\n`;
}

function commitArgv(): string[] {
  return [
    "env",
    `GIT_AUTHOR_NAME=${FIXED_AUTHOR_NAME}`,
    `GIT_AUTHOR_EMAIL=${FIXED_AUTHOR_EMAIL}`,
    `GIT_AUTHOR_DATE=${FIXED_EPOCH_SECONDS} +0000`,
    `GIT_COMMITTER_NAME=${FIXED_AUTHOR_NAME}`,
    `GIT_COMMITTER_EMAIL=${FIXED_AUTHOR_EMAIL}`,
    `GIT_COMMITTER_DATE=${FIXED_EPOCH_SECONDS} +0000`,
    ...git("commit", "--no-verify", "--no-gpg-sign", "-m", FIXED_MESSAGE),
  ];
}

function leakScanArgv(): string[] {
  const names = LEAK_NAME_PATTERNS.flatMap((pattern, index) =>
    index === 0 ? ["-iname", pattern] : ["-o", "-iname", pattern],
  );
  return [
    "find",
    "/",
    "-xdev",
    "(",
    "-path",
    "/proc",
    "-o",
    "-path",
    "/sys",
    "-o",
    "-path",
    "/opt/miniconda3",
    ")",
    "-prune",
    "-o",
    "(",
    ...names,
    ")",
    "-print",
  ];
}

const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

function isModeOnlyRawLine(line: string): boolean {
  const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) M\t/.exec(line);
  if (!match) return false;
  const [, oldMode, newMode, oldBlob, newBlob] = match;
  return REGULAR_FILE_MODES.has(oldMode) && REGULAR_FILE_MODES.has(newMode) && oldBlob === newBlob;
}

async function isContentIdenticalCommitOn(container: ContainerRunner, baseCommit: string): Promise<boolean> {
  const parents = await container.exec(git("log", "-1", "--format=%P", "HEAD"));
  if (parents.code !== 0 || parents.stdout.trim() !== baseCommit) return false;
  const diff = await container.exec(git("diff", "--raw", "--no-abbrev", "--no-renames", baseCommit, "HEAD"));
  return diff.code === 0 && diff.stdout.split("\n").filter(Boolean).every(isModeOnlyRawLine);
}

async function dropCommit(container: ContainerRunner, baseCommit: string): Promise<boolean> {
  for (const argv of [
    git("reset", "-q", "--hard", baseCommit),
    git("reflog", "expire", "--expire=now", "--all"),
    git("prune", "--expire=now"),
  ]) {
    if ((await container.exec(argv)).code !== 0) return false;
  }
  return true;
}

export async function checkReviewerImports(container: ContainerRunner): Promise<PreflightCheck> {
  const expected = `${REVIEWER_PYTHON} ${DJANGO_UNDER_TESTBED}`;
  const mismatches: string[] = [];
  for (const flag of REVIEWER_SHELL_FLAGS) {
    const resolved = await container.exec([
      "env",
      ...REVIEWER_ENV,
      "bash",
      flag,
      "cd /tmp && python -c 'import sys; import django; print(sys.executable, django.__file__)'",
    ]);
    const found = resolved.stdout.trim().split("\n").at(-1) ?? "";
    if (resolved.code !== 0 || found !== expected) {
      mismatches.push(`bash ${flag}: ${found || resolved.stderr.trim().slice(-120)}`);
    }
  }
  return {
    id: "reviewer_imports_testbed_django",
    passed: mismatches.length === 0,
    detail: (mismatches.join("; ") || expected).slice(0, 300),
  };
}

export async function applyAndPreflight(
  container: ContainerRunner,
  input: PreflightInput,
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const record = (id: string, passed: boolean, detail = ""): boolean => {
    checks.push({ id, passed, detail: detail.trim().slice(0, 300) });
    return passed;
  };
  const finish = (): PreflightResult => ({ passed: checks.every((c) => c.passed), checks });

  record("effort_env_unset_on_host", input.hostEnv[EFFORT_ENV] === undefined);
  const effort = await container.exec(["printenv", EFFORT_ENV]);
  record("effort_env_unset_in_container", effort.code !== 0, effort.stdout);

  const version = await container.exec(["claude", "--version"]);
  record("cli_version", version.code === 0 && version.stdout.startsWith(CLI_VERSION), version.stdout);

  const originHead = await container.exec(git("symbolic-ref", "-q", DANGLING_ORIGIN_HEAD));
  if (originHead.code === 0) await container.exec(git("symbolic-ref", "-d", DANGLING_ORIGIN_HEAD));

  const before = await container.exec(git("rev-parse", "HEAD"));
  const startsAtBase =
    before.stdout.trim() === input.baseCommit ||
    ((await isContentIdenticalCommitOn(container, input.baseCommit)) &&
      (await dropCommit(container, input.baseCommit)));
  if (!record("starts_at_base_commit", startsAtBase, before.stdout)) return finish();

  for (const [id, diff] of [
    ["no_test_patch_applied", input.testPatch],
    ["no_gold_patch_applied", input.goldPatch],
  ] as const) {
    const present: string[] = [];
    for (const section of splitDiffByFile(diff)) {
      const reverse = await container.exec(git("apply", "--check", "-R", "-"), {
        stdin: withFinalNewline(section),
      });
      if (reverse.code === 0) present.push(...patchPaths(section));
    }
    record(id, present.length === 0, present.join(" "));
  }

  const leaks = await container.exec(leakScanArgv());
  record(
    "no_gold_or_swe_abs_files",
    leaks.code === 0 && leaks.stdout.trim() === "",
    leaks.stdout || leaks.stderr,
  );

  const applied = await container.exec(git("apply", "--whitespace=nowarn", "-"), {
    stdin: withFinalNewline(input.patch),
  });
  if (!record("patch_applied", applied.code === 0, applied.stderr)) return finish();

  const staged = await container.exec(git("add", "-A"));
  const committed = await container.exec(commitArgv());
  const commitOk = staged.code === 0 && committed.code === 0;
  if (!record("patch_committed", commitOk, staged.stderr + committed.stderr)) return finish();

  const status = await container.exec(git("status", "--porcelain"));
  record("tree_clean", status.code === 0 && status.stdout.trim() === "", status.stdout);

  const changed = await container.exec(
    git("-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", input.baseCommit, "HEAD"),
  );
  const changedPaths = changed.stdout.split("\n").filter(Boolean).sort();
  record(
    "changed_paths_match_patch",
    changed.code === 0 && changedPaths.join("\n") === patchPaths(input.patch).join("\n"),
    changedPaths.join(" "),
  );

  const log = await container.exec(
    git("log", "-2", `--format=${["%H", "%P", "%an", "%ae", "%at", "%ct", "%s"].join("%x1f")}`),
  );
  const [head = [], base = []] = log.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(FIELD_SEPARATOR));
  const headMatches =
    head[1] === input.baseCommit &&
    head[2] === FIXED_AUTHOR_NAME &&
    head[3] === FIXED_AUTHOR_EMAIL &&
    head[4] === String(FIXED_EPOCH_SECONDS) &&
    head[5] === String(FIXED_EPOCH_SECONDS) &&
    head[6] === FIXED_MESSAGE;
  record("git_log_fixed_commit_on_base", log.code === 0 && headMatches && base[0] === input.baseCommit, log.stdout);

  const beyond = await container.exec(git("rev-list", "--all", "--reflog", "^HEAD"));
  record("no_commits_beyond_head", beyond.code === 0 && beyond.stdout.trim() === "", beyond.stdout);

  const unreachable = await container.exec(git("fsck", "--unreachable", "--no-reflogs", "--no-progress"));
  const lostCommits = unreachable.stdout.split("\n").filter((line) => line.includes(" commit "));
  record(
    "no_unreachable_commits",
    unreachable.code === 0 && lostCommits.length === 0,
    lostCommits.join("\n") || unreachable.stderr,
  );

  return finish();
}

export function environmentFileFor(instanceId: string): string {
  const prefix = instanceId.split("__")[0];
  const file = `${prefix}.txt`;
  if (!readdirSync(ENVIRONMENTS_DIR).includes(file)) {
    throw new Error(`no environment file for instance prefix ${prefix}`);
  }
  return readFileSync(join(ENVIRONMENTS_DIR, file), "utf8");
}

export async function installEnvironment(
  container: ContainerRunner,
  content: string,
): Promise<{ written: boolean; commitSha: string | null; checks: PreflightCheck[] }> {
  const write = await container.exec(
    ["sh", "-c", `mkdir -p ${ENVIRONMENT_DIR} && cat > ${ENVIRONMENT_PATH}`],
    { stdin: content },
  );
  const written = {
    id: "environment_written",
    passed: write.code === 0,
    detail: write.stderr.trim().slice(0, 300),
  };
  if (!written.passed) return { written: false, commitSha: null, checks: [written] };

  const readBack = await container.exec(["cat", ENVIRONMENT_PATH]);
  const readBackSha = sha256(readBack.stdout);
  const status = await container.exec(git("status", "--porcelain"));
  const head = await container.exec(git("rev-parse", "HEAD"));
  const commitSha = head.stdout.trim();
  const headResolved = head.code === 0 && /^[0-9a-f]{40}$/.test(commitSha);
  return {
    written: true,
    commitSha: headResolved ? commitSha : null,
    checks: [
      written,
      {
        id: "environment_read_back",
        passed: readBack.code === 0 && readBackSha === sha256(content),
        detail: `exit ${readBack.code} sha256 ${readBackSha}`,
      },
      {
        id: "tree_clean_after_environment",
        passed: status.code === 0 && status.stdout.trim() === "",
        detail: status.stdout.trim().slice(0, 300),
      },
      { id: "head_resolved", passed: headResolved, detail: (commitSha || head.stderr).trim().slice(0, 300) },
    ],
  };
}

export function diffMatchesPatch(result: ExecResult, patch: string): PreflightCheck {
  const diffPaths = patchPaths(result.stdout);
  const expected = patchPaths(patch);
  const samePaths = diffPaths.length === expected.length && diffPaths.every((path, index) => path === expected[index]);
  return {
    id: "diff_matches_patch",
    passed: result.code === 0 && result.stdout.trim() !== "" && samePaths,
    detail: `exit ${result.code} paths ${diffPaths.join(",") || "none"} ${result.stderr}`.trim().slice(0, 300),
  };
}

export async function commitDiff(
  container: ContainerRunner,
  patch: string,
): Promise<{ diff: string; check: PreflightCheck }> {
  const result = await container.exec(
    git("diff", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD~1", "HEAD"),
  );
  return { diff: result.stdout, check: diffMatchesPatch(result, patch) };
}

function upstreamBaseFailure(argv: string[], result: ExecResult): PreflightCheck {
  const detail = `${argv.slice(3).join(" ")}: exit ${result.code} ${result.stderr}`;
  return { id: UPSTREAM_BASE_CHECK, passed: false, detail: detail.trim().slice(0, 300) };
}

// The bundled code-review skill reviews `git diff @{upstream}...HEAD`, so the checked-out branch tracks the base commit.
export async function setUpstreamBase(container: ContainerRunner, patch: string): Promise<PreflightCheck> {
  const updateRef = git("update-ref", UPSTREAM_REF, "HEAD~1");
  const updated = await container.exec(updateRef);
  if (updated.code !== 0) return upstreamBaseFailure(updateRef, updated);
  const currentBranch = git("symbolic-ref", "--short", "-q", "HEAD");
  const branch = await container.exec(currentBranch);
  if (branch.code !== 0) return upstreamBaseFailure(currentBranch, branch);
  const name = branch.stdout.trim();
  // Remote `.` tracks a ref of this repository, so origin's fetch refspec, absent or narrow, never has to map it.
  for (const argv of [git("config", `branch.${name}.remote`, "."), git("config", `branch.${name}.merge`, UPSTREAM_REF)]) {
    const result = await container.exec(argv);
    if (result.code !== 0) return upstreamBaseFailure(argv, result);
  }
  const result = await container.exec(
    git("diff", "--no-color", "--no-ext-diff", "--no-textconv", "@{upstream}...HEAD"),
  );
  return { ...diffMatchesPatch(result, patch), id: UPSTREAM_BASE_CHECK };
}

export function specWithheldCheck(prompt: string, problemStatement: string): PreflightCheck {
  const statement = problemStatement.trim();
  const leakedText =
    statement !== "" && [statement, JSON.stringify(statement).slice(1, -1)].some((form) => prompt.includes(form));
  const specKey = /^spec:/m.test(prompt);
  return {
    id: "spec_withheld",
    passed: !leakedText && !specKey,
    detail: `problem statement ${leakedText ? "present" : "absent"}, spec key ${specKey ? "present" : "absent"}`,
  };
}

function curlProbe(url: string, routing: string[]): string[] {
  return [
    "curl",
    url,
    ...routing,
    "--silent",
    "--show-error",
    "--output",
    "/dev/null",
    "--max-time",
    PROBE_TIMEOUT_SECONDS,
    "--write-out",
    "%{http_connect}",
  ];
}

export function isNetworkBlocked(curlExitCode: number): boolean {
  return CURL_UNREACHABLE_EXIT_CODES.includes(curlExitCode);
}

export async function networkPreflight(
  container: ContainerRunner,
  proxyUrl: string,
): Promise<PreflightCheck[]> {
  const direct = ["--noproxy", "*"];
  const proxied = ["--proxy", proxyUrl];
  const github = await container.exec(curlProbe(PROBE_BLOCKED_URL, direct));
  const metadata = await container.exec(curlProbe(PROBE_METADATA_URL, direct));
  const refused = await container.exec(curlProbe(PROBE_BLOCKED_URL, proxied));
  const admitted = await container.exec(curlProbe(PROBE_ALLOWED_URL, proxied));
  const detail = ({ code, stdout, stderr }: ExecResult): string =>
    `exit ${code} connect ${stdout} ${stderr}`.trim().slice(0, 300);
  return [
    { id: "direct_github_blocked", passed: isNetworkBlocked(github.code), detail: detail(github) },
    { id: "direct_metadata_blocked", passed: isNetworkBlocked(metadata.code), detail: detail(metadata) },
    {
      id: "proxy_refuses_github",
      passed: refused.code !== 0 && refused.stdout.trim() === "403",
      detail: detail(refused),
    },
    {
      id: "proxy_admits_anthropic",
      passed: admitted.code === 0 && admitted.stdout.trim() === "200",
      detail: detail(admitted),
    },
  ];
}
