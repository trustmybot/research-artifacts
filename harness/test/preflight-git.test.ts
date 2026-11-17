import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

import { applyAndPreflight, setUpstreamBase, UPSTREAM_BASE_CHECK, type PreflightResult } from "../preflight.ts";
import type { ContainerRunner, ExecResult } from "../runners.ts";

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Upstream",
  GIT_AUTHOR_EMAIL: "u@example.invalid",
  GIT_COMMITTER_NAME: "Upstream",
  GIT_COMMITTER_EMAIL: "u@example.invalid",
};
const PATCH =
  "diff --git a/pkg/mod.py b/pkg/mod.py\n--- a/pkg/mod.py\n+++ b/pkg/mod.py\n@@ -1 +1 @@\n-value = 1\n+value = 2\n";
const TEST_PATCH =
  "diff --git a/tests/test_mod.py b/tests/test_mod.py\n--- a/tests/test_mod.py\n+++ b/tests/test_mod.py\n@@ -1 +1 @@\n-old = 1\n+old = 2\n";
const GOLD_PATCH =
  "diff --git a/pkg/mod.py b/pkg/mod.py\n--- a/pkg/mod.py\n+++ b/pkg/mod.py\n@@ -1 +1 @@\n-value = 1\n+value = 3\n";
const LEAK_NAMED_PATCH =
  "diff --git a/test_patch.py b/test_patch.py\nnew file mode 100644\n--- /dev/null\n+++ b/test_patch.py\n@@ -0,0 +1 @@\n+x = 1\n";
const LEAK_CHECKS = ["no_test_patch_applied", "no_gold_patch_applied", "no_gold_or_swe_abs_files"];

function run(cwd: string, argv: string[]): string {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    env: { ...GIT_ENV, ...GIT_IDENTITY },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function originFetch(repo: string): string | null {
  const result = spawnSync("git", ["config", "--get-all", "remote.origin.fetch"], { cwd: repo, encoding: "utf8", env: GIT_ENV });
  return result.status === 0 ? result.stdout.trim() : null;
}

function write(repo: string, path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

function makeRepo(): { repo: string; base: string } {
  const repo = mkdtempSync(join(tmpdir(), "cr-preflight-"));
  run(repo, ["git", "init", "-q"]);
  write(repo, "pkg/mod.py", "value = 1\n");
  write(repo, "tests/test_mod.py", "old = 1\n");
  run(repo, ["git", "add", "-A"]);
  run(repo, ["git", "commit", "-q", "-m", "Base"]);
  return { repo, base: run(repo, ["git", "rev-parse", "HEAD"]) };
}

function commitOnBase(repo: string, path: string, text: string): string {
  write(repo, path, text);
  run(repo, ["git", "add", "-A"]);
  run(repo, ["git", "commit", "-q", "-m", "Upstream"]);
  return run(repo, ["git", "rev-parse", "HEAD"]);
}

class LocalGitContainer implements ContainerRunner {
  private readonly repo: string;

  constructor(repo: string) {
    this.repo = repo;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async exec(argv: string[], options: { stdin?: string } = {}): Promise<ExecResult> {
    if (argv[0] === "claude") return { code: 0, stdout: "2.1.311 (Claude Code)\n", stderr: "" };
    const root = argv[0] === "find" ? "/" : "/testbed";
    const [command, ...args] = argv.map((arg) => (arg === root ? this.repo : arg));
    const result = spawnSync(command, args, {
      input: options.stdin ?? "",
      encoding: "utf8",
      env: GIT_ENV,
    });
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  }
}

function failedIds(result: PreflightResult): string[] {
  return result.checks.filter((check) => !check.passed).map((check) => check.id);
}

function preflight(repo: string, base: string, patch = PATCH): Promise<PreflightResult> {
  return applyAndPreflight(new LocalGitContainer(repo), {
    baseCommit: base,
    patch,
    testPatch: TEST_PATCH,
    goldPatch: GOLD_PATCH,
    hostEnv: {},
  });
}

describe("preflight against real git", () => {
  test("a clean repository passes and HEAD is the fixed commit", async () => {
    const { repo, base } = makeRepo();
    const result = await preflight(repo, base);
    assert.deepEqual(failedIds(result), []);
    const fields = run(repo, ["git", "log", "-1", "--format=%P|%an|%at|%s"]);
    assert.equal(fields, `${base}|Candidate Author|946684800|Apply candidate patch`);
  });

  test("the fixed commit is reproducible", async () => {
    const first = makeRepo();
    const second = makeRepo();
    await preflight(first.repo, first.base);
    await preflight(second.repo, second.base);
    assert.equal(
      run(first.repo, ["git", "rev-parse", "HEAD^{tree}"]),
      run(second.repo, ["git", "rev-parse", "HEAD^{tree}"]),
    );
  });

  test("a patch that does not apply aborts", async () => {
    const { repo, base } = makeRepo();
    const broken = PATCH.replace("-value = 1", "-value = 9");
    assert.deepEqual(failedIds(await preflight(repo, base, broken)), ["patch_applied"]);
  });

  test("a test patch already in the base fails no_test_patch_applied", async () => {
    const { repo } = makeRepo();
    const head = commitOnBase(repo, "tests/test_mod.py", "old = 2\n");
    assert.deepEqual(failedIds(await preflight(repo, head)), ["no_test_patch_applied"]);
  });

  test("an official fix already in the base fails no_gold_patch_applied", async () => {
    const { repo } = makeRepo();
    const head = commitOnBase(repo, "pkg/mod.py", "value = 3\n");
    assert.deepEqual(failedIds(await preflight(repo, head, TEST_PATCH)), ["no_gold_patch_applied"]);
  });

  test("a leak-named file already in the base fails no_gold_or_swe_abs_files", async () => {
    const { repo } = makeRepo();
    const head = commitOnBase(repo, "swe_abs_tests/test_x.py", "x = 1\n");
    const result = await preflight(repo, head);
    assert.deepEqual(failedIds(result), ["no_gold_or_swe_abs_files"]);
    assert.match(result.checks.find((check) => !check.passed)?.detail ?? "", /swe_abs_tests/);
  });

  test("a candidate patch equal to the official fix passes", async () => {
    const { repo, base } = makeRepo();
    assert.deepEqual(failedIds(await preflight(repo, base, GOLD_PATCH)), []);
    assert.equal(run(repo, ["git", "show", "HEAD:pkg/mod.py"]), "value = 3");
  });

  test("a candidate adding its own test_patch.py passes", async () => {
    const { repo, base } = makeRepo();
    assert.deepEqual(failedIds(await preflight(repo, base, LEAK_NAMED_PATCH)), []);
    assert.equal(run(repo, ["git", "show", "--name-only", "--format=", "HEAD"]), "test_patch.py");
  });

  test("a candidate containing the test patch's changes passes", async () => {
    const { repo, base } = makeRepo();
    assert.deepEqual(failedIds(await preflight(repo, base, PATCH + TEST_PATCH)), []);
    assert.equal(run(repo, ["git", "show", "HEAD:tests/test_mod.py"]), "old = 2");
  });

  test("the leak checks are recorded before the patch goes on", async () => {
    const { repo, base } = makeRepo();
    const ids = (await preflight(repo, base)).checks.map((check) => check.id);
    const patchApplied = ids.indexOf("patch_applied");
    for (const id of LEAK_CHECKS) {
      assert.equal(ids.filter((other) => other === id).length, 1, id);
      assert.ok(ids.indexOf(id) < patchApplied, id);
    }
  });

  test("a branch ahead of HEAD is detected", async () => {
    const { repo, base } = makeRepo();
    run(repo, ["git", "checkout", "-q", "-b", "future"]);
    write(repo, "future.txt", "fix\n");
    run(repo, ["git", "add", "-A"]);
    run(repo, ["git", "commit", "-q", "-m", "Future"]);
    run(repo, ["git", "checkout", "-q", "-"]);
    assert.deepEqual(failedIds(await preflight(repo, base)), ["no_commits_beyond_head"]);
  });

  test("an unreachable commit is detected", async () => {
    const { repo, base } = makeRepo();
    write(repo, "future.txt", "fix\n");
    run(repo, ["git", "add", "-A"]);
    run(repo, ["git", "commit", "-q", "-m", "Future"]);
    run(repo, ["git", "reset", "-q", "--hard", base]);
    run(repo, ["git", "reflog", "expire", "--expire=now", "--all"]);
    assert.deepEqual(failedIds(await preflight(repo, base)), ["no_unreachable_commits"]);
  });

  test("F298-1: the image's empty commit is dropped without a trace", async () => {
    const { repo, base } = makeRepo();
    run(repo, ["git", "commit", "-q", "--allow-empty", "-m", "SWE-bench"]);
    const imageCommit = run(repo, ["git", "rev-parse", "HEAD"]);
    assert.deepEqual(failedIds(await preflight(repo, base)), []);
    assert.equal(run(repo, ["git", "log", "-1", "--format=%P"]), base);
    assert.equal(run(repo, ["git", "log", "-g", "--format=%H"]).includes(imageCommit), false);
    const object = spawnSync("git", ["-C", repo, "cat-file", "-e", imageCommit], { env: GIT_ENV });
    assert.notEqual(object.status, 0);
  });

  test("the image's mode-only commit is dropped and the file mode reverts", async () => {
    const { repo, base } = makeRepo();
    chmodSync(join(repo, "tests/test_mod.py"), 0o755);
    run(repo, ["git", "commit", "-q", "-am", "SWE-bench"]);
    const imageCommit = run(repo, ["git", "rev-parse", "HEAD"]);
    assert.deepEqual(failedIds(await preflight(repo, base)), []);
    assert.equal(run(repo, ["git", "log", "-1", "--format=%P"]), base);
    assert.match(run(repo, ["git", "ls-files", "-s", "tests/test_mod.py"]), /^100644 /);
    assert.equal(statSync(join(repo, "tests/test_mod.py")).mode & 0o111, 0);
    assert.equal(run(repo, ["git", "status", "--porcelain"]), "");
    const object = spawnSync("git", ["-C", repo, "cat-file", "-e", imageCommit], { env: GIT_ENV });
    assert.notEqual(object.status, 0);
  });

  test("a base-parented commit changing content fails starts_at_base_commit", async () => {
    const { repo, base } = makeRepo();
    commitOnBase(repo, "tests/test_mod.py", "old = 3\n");
    assert.deepEqual(failedIds(await preflight(repo, base)), ["starts_at_base_commit"]);
  });

  test("a base-parented commit changing mode and content fails starts_at_base_commit", async () => {
    const { repo, base } = makeRepo();
    chmodSync(join(repo, "tests/test_mod.py"), 0o755);
    commitOnBase(repo, "tests/test_mod.py", "old = 3\n");
    assert.deepEqual(failedIds(await preflight(repo, base)), ["starts_at_base_commit"]);
  });

  test("F298-1: the image's dangling origin/HEAD does not fail the fsck check", async () => {
    const { repo, base } = makeRepo();
    run(repo, ["git", "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    assert.deepEqual(failedIds(await preflight(repo, base)), []);
  });

  test("F298-2: a patch with no final newline applies", async () => {
    const { repo, base } = makeRepo();
    assert.deepEqual(failedIds(await preflight(repo, base, PATCH.slice(0, -1))), []);
    assert.equal(run(repo, ["git", "show", "--name-only", "--format=", "HEAD"]), "pkg/mod.py");
  });

  test("an applied final test_patch section with no final newline is detected", async () => {
    const { repo } = makeRepo();
    write(repo, "tests/test_mod.py", "old = 2\n");
    run(repo, ["git", "add", "-A"]);
    run(repo, ["git", "commit", "-q", "-m", "Tests"]);
    const head = run(repo, ["git", "rev-parse", "HEAD"]);
    const result = await applyAndPreflight(new LocalGitContainer(repo), {
      baseCommit: head,
      patch: PATCH,
      testPatch: TEST_PATCH.slice(0, -1),
      goldPatch: GOLD_PATCH,
      hostEnv: {},
    });
    assert.deepEqual(failedIds(result), ["no_test_patch_applied"]);
  });

  test("F298-3: ignored build output stays out of the fixed commit", async () => {
    const { repo } = makeRepo();
    write(repo, ".gitignore", "*.egg-info\nbuild/\n");
    run(repo, ["git", "add", "-A"]);
    run(repo, ["git", "commit", "-q", "-m", "Ignore"]);
    write(repo, "Django.egg-info/PKG-INFO", "x\n");
    write(repo, "build/a.py", "x\n");
    const head = run(repo, ["git", "rev-parse", "HEAD"]);
    assert.deepEqual(failedIds(await preflight(repo, head)), []);
    assert.equal(run(repo, ["git", "show", "--name-only", "--format=", "HEAD"]), "pkg/mod.py");
  });

  test("a plain unified diff with no diff --git line passes changed_paths_match_patch", async () => {
    const { repo, base } = makeRepo();
    const plain = PATCH.slice(PATCH.indexOf("--- "));
    const result = await preflight(repo, base, plain);
    assert.deepEqual(failedIds(result), []);
    assert.ok(result.checks.some((check) => check.id === "changed_paths_match_patch" && check.passed));
    assert.equal(run(repo, ["git", "show", "HEAD:pkg/mod.py"]), "value = 2");
  });

  test("a stray untracked file is not swept in silently", async () => {
    const { repo, base } = makeRepo();
    write(repo, "stray.py", "x\n");
    assert.deepEqual(failedIds(await preflight(repo, base)), ["changed_paths_match_patch"]);
  });

  test("a git log with a commit between HEAD and base is detected", async () => {
    const { repo, base } = makeRepo();
    write(repo, "extra.txt", "x\n");
    run(repo, ["git", "add", "-A"]);
    run(repo, ["git", "commit", "-q", "-m", "Extra"]);
    assert.ok((await preflight(repo, base)).checks.some((c) => c.id === "starts_at_base_commit" && !c.passed));
  });
});

describe("the upstream base against real git", () => {
  test("after preflight, @{upstream}...HEAD is the candidate patch", async () => {
    const { repo, base } = makeRepo();
    const container = new LocalGitContainer(repo);
    assert.deepEqual(failedIds(await preflight(repo, base)), []);
    const check = await setUpstreamBase(container, PATCH);
    assert.deepEqual({ id: check.id, passed: check.passed }, { id: UPSTREAM_BASE_CHECK, passed: true }, check.detail);
    assert.equal(run(repo, ["git", "rev-parse", "@{upstream}"]), base);
    assert.equal(run(repo, ["git", "diff", "--name-only", "@{upstream}...HEAD"]), "pkg/mod.py");
    assert.equal(run(repo, ["git", "rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/main");
    assert.equal(originFetch(repo), null);
  });

  test("an image that keeps its origin remote keeps its fetch refspec", async () => {
    const { repo, base } = makeRepo();
    run(repo, ["git", "remote", "add", "origin", "https://example.invalid/repo.git"]);
    const refspecs = originFetch(repo);
    assert.deepEqual(failedIds(await preflight(repo, base)), []);
    const check = await setUpstreamBase(new LocalGitContainer(repo), PATCH);
    assert.equal(check.passed, true, check.detail);
    assert.equal(run(repo, ["git", "rev-parse", "@{upstream}"]), base);
    assert.equal(originFetch(repo), refspecs);
  });

  test("an origin whose fetch refspec does not map origin/main still tracks it", async () => {
    const { repo, base } = makeRepo();
    run(repo, ["git", "remote", "add", "origin", "https://example.invalid/repo.git"]);
    run(repo, ["git", "config", "remote.origin.fetch", "+refs/heads/stable:refs/remotes/origin/stable"]);
    assert.deepEqual(failedIds(await preflight(repo, base)), []);
    const check = await setUpstreamBase(new LocalGitContainer(repo), PATCH);
    assert.deepEqual({ id: check.id, passed: check.passed }, { id: UPSTREAM_BASE_CHECK, passed: true }, check.detail);
    assert.equal(run(repo, ["git", "rev-parse", "@{upstream}"]), base);
    assert.equal(run(repo, ["git", "rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/main");
    assert.equal(originFetch(repo), "+refs/heads/stable:refs/remotes/origin/stable");
  });

  test("a detached HEAD fails upstream_base", async () => {
    const { repo, base } = makeRepo();
    const container = new LocalGitContainer(repo);
    assert.deepEqual(failedIds(await preflight(repo, base)), []);
    run(repo, ["git", "checkout", "-q", "--detach"]);
    const check = await setUpstreamBase(container, PATCH);
    assert.deepEqual({ id: check.id, passed: check.passed }, { id: UPSTREAM_BASE_CHECK, passed: false });
  });
});
