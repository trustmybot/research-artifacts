import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { patchPaths } from "../preflight.ts";

const PLAIN =
  "--- a/django/db/models/query.py\n+++ b/django/db/models/query.py\n@@ -920,6 +920,8 @@\n     def none(self):\n         \"\"\"Return an empty QuerySet.\"\"\"\n         clone = self._chain()\n+        if clone.query.combinator:\n+            clone.query.combinator = None\n         clone.query.set_empty()\n         return clone\n \n";

describe("patchPaths", () => {
  test("a plain unified diff yields the +++ path", () => {
    assert.deepEqual(patchPaths(PLAIN), ["django/db/models/query.py"]);
  });

  test("a plain diff creating a file yields the +++ path", () => {
    assert.deepEqual(patchPaths("--- /dev/null\n+++ b/new.py\n@@ -0,0 +1 @@\n+x = 1\n"), ["new.py"]);
  });

  test("a plain diff deleting a file yields the --- path", () => {
    assert.deepEqual(patchPaths("--- a/old.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-x = 1\n"), ["old.py"]);
  });

  test("header timestamps after a tab are stripped", () => {
    const diff =
      "--- a/pkg/mod.py\t2025-06-11 10:00:00.000000000 +0000\n+++ b/pkg/mod.py\t2025-06-11 10:01:00.000000000 +0000\n@@ -1 +1 @@\n-value = 1\n+value = 2\n" +
      "--- /dev/null\t1970-01-01 00:00:00.000000000 +0000\n+++ b/pkg/new.py\t2025-06-11 10:01:00.000000000 +0000\n@@ -0,0 +1 @@\n+x = 1\n";
    assert.deepEqual(patchPaths(diff), ["pkg/mod.py", "pkg/new.py"]);
  });

  test("several plain file sections yield sorted paths", () => {
    const diff =
      "--- a/z.py\n+++ b/z.py\n@@ -1 +1 @@\n-a\n+b\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-a\n+b\n";
    assert.deepEqual(patchPaths(diff), ["a.py", "z.py"]);
  });

  test("hunk lines that look like file headers are not paths", () => {
    const diff = "--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,2 @@\n--- a/comment\n+++ b/comment\n select 1;\n";
    assert.deepEqual(patchPaths(diff), ["q.sql"]);
  });

  test("a git diff yields each path once", () => {
    const diff =
      "diff --git a/pkg/mod.py b/pkg/mod.py\nindex 1..2 100644\n--- a/pkg/mod.py\n+++ b/pkg/mod.py\n@@ -1 +1 @@\n-value = 1\n+value = 2\n" +
      "diff --git a/new.py b/new.py\nnew file mode 100644\n--- /dev/null\n+++ b/new.py\n@@ -0,0 +1 @@\n+x = 1\n" +
      "diff --git a/old.py b/old.py\ndeleted file mode 100644\n--- a/old.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-x = 1\n";
    assert.deepEqual(patchPaths(diff), ["new.py", "old.py", "pkg/mod.py"]);
  });

  test("a git diff with no content headers still yields its path", () => {
    assert.deepEqual(patchPaths("diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n"), ["run.sh"]);
  });
});
