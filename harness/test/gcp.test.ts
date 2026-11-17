import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import "./gcp-test-infra.ts";

import {
  ACCOUNT,
  API_KEY_SECRET,
  BUCKET_NAME,
  canonicalArms,
  CONDITIONS,
  DEPLOY_KEY_SECRET,
  INFRA,
  INFRA_ENV,
  INFRA_PLACEHOLDERS,
  infraRefusal,
  LABEL,
  loadInfra,
  placeholderFields,
  PROJECT,
  realExec,
  resourceNames,
  RUN_ID_PATTERN,
  SERVICE_ACCOUNT,
  VAULT_REPO,
  type Exec,
  type ExecOptions,
  type ExecResult,
} from "../gcp/common.ts";
import { API_KEY_COMMAND, runLauncher, type LaunchDeps } from "../gcp/launch.ts";
import { NODE_LINUX_X64_SHA256, NODE_VERSION, renderStartupScript, STARTUP_LOG } from "../gcp/startup-script.ts";
import { DONE_FILE, runVm, STATS_FILE, sync, type RunParams, type VmDeps } from "../gcp/vm-run.ts";

const OK: ExecResult = { code: 0, stdout: "", stderr: "" };
const FAILED: ExecResult = { code: 1, stdout: "", stderr: "boom" };
const FIXED_NOW = new Date("2026-10-31T21:22:38.217Z");
const SHORT_SHA = "34c414f";
const RUN_ID = `20261031t212238z-${SHORT_SHA}`;
const FAKE_API_KEY = "fake-key-value-for-tests";
const FAKE_DEPLOY_KEY = "fake-deploy-key\n";
const BUCKET_URL = `gs://${BUCKET_NAME}`;
const VM_PREFIX = "c4-c-smoke-";

interface Call {
  argv: string[];
  options?: ExecOptions;
}

type Responder = (argv: string[], options?: ExecOptions) => ExecResult | undefined;

function recorder(respond: Responder = () => undefined): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    exec: (argv, options) => {
      calls.push({ argv, options });
      return respond(argv, options) ?? OK;
    },
  };
}

function has(argv: string[], ...words: string[]): boolean {
  return words.every((word) => argv.includes(word));
}

function launcherDeps(exec: Exec): LaunchDeps & { output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    exec,
    output,
    errors,
    out: (line) => output.push(line),
    err: (line) => errors.push(line),
    now: () => FIXED_NOW,
    repoRoot: "/repo",
    infra: INFRA,
  };
}

function assertGcloudFlags(calls: Call[]): void {
  for (const { argv } of calls.filter((call) => call.argv[0] === "gcloud")) {
    assert.ok(argv.includes(`--project=${PROJECT}`), argv.join(" "));
    assert.ok(argv.includes(`--account=${ACCOUNT}`), argv.join(" "));
    assert.notEqual(argv[1], "config", argv.join(" "));
  }
}

function setupResponder(existing: boolean): Responder {
  return (argv) => {
    if (argv[0] !== "gcloud") return undefined;
    if (has(argv, "describe")) return existing ? OK : FAILED;
    if (has(argv, "versions", "list")) return existing ? { ...OK, stdout: "1\n" } : OK;
    return undefined;
  };
}

describe("project constants", () => {
  test("the bucket and service account follow the project", () => {
    assert.equal(BUCKET_NAME, `${PROJECT}-c4-smoke`);
    assert.equal(SERVICE_ACCOUNT, `c4-smoke@${PROJECT}.iam.gserviceaccount.com`);
    assert.deepEqual(placeholderFields(INFRA), []);
  });

  test("the legacy effort study keeps the old VM prefix and shared infrastructure keeps its names", () => {
    assert.equal(resourceNames("cr-effort-claude-opus-5.5", RUN_ID).vm, `${VM_PREFIX}${RUN_ID}`);
    assert.equal(LABEL, "purpose=c4-smoke");
    assert.equal(API_KEY_SECRET, "c4-anthropic-api-key");
    assert.equal(DEPLOY_KEY_SECRET, "c4-vault-deploy-key");
  });
});

describe("infrastructure config", () => {
  const FILE_INFRA = { project: "file-gcp-project", account: "file@example.com", vaultRepo: "file-org/file-vault" };
  const ENV_INFRA = {
    [INFRA_ENV.project]: "env-gcp-project",
    [INFRA_ENV.account]: "env@example.com",
    [INFRA_ENV.vaultRepo]: "env-org/env-vault",
  };

  function infraFile(content: unknown): string {
    const path = join(mkdtempSync(join(tmpdir(), "cr-infra-")), "infra.local.json");
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
    return path;
  }

  const missingFile = () => join(mkdtempSync(join(tmpdir(), "cr-infra-")), "infra.local.json");

  test("with no file and no environment every field is its placeholder", () => {
    const infra = loadInfra({}, missingFile());
    assert.deepEqual(infra, INFRA_PLACEHOLDERS);
    assert.deepEqual(placeholderFields(infra), ["project", "account", "vaultRepo"]);
  });

  test("the environment fills the fields when there is no file, and an empty variable counts as unset", () => {
    assert.deepEqual(loadInfra(ENV_INFRA, missingFile()), {
      project: "env-gcp-project",
      account: "env@example.com",
      vaultRepo: "env-org/env-vault",
    });
    assert.equal(loadInfra({ [INFRA_ENV.project]: "" }, missingFile()).project, INFRA_PLACEHOLDERS.project);
  });

  test("the file wins over the environment, field by field", () => {
    assert.deepEqual(loadInfra(ENV_INFRA, infraFile(FILE_INFRA)), FILE_INFRA);
    assert.deepEqual(loadInfra(ENV_INFRA, infraFile({ project: "file-gcp-project" })), {
      project: "file-gcp-project",
      account: "env@example.com",
      vaultRepo: "env-org/env-vault",
    });
  });

  test("refuses a malformed file or value", () => {
    assert.throws(() => loadInfra({}, infraFile("[]")), /must hold a JSON object/);
    assert.throws(() => loadInfra({}, infraFile("{")), SyntaxError);
    assert.throws(() => loadInfra({}, infraFile({ project: "Bad Project" })), /project in .*infra\.local\.json is not a valid project/);
    assert.throws(() => loadInfra({}, infraFile({ account: 7 })), /not a valid account/);
    assert.throws(() => loadInfra({ [INFRA_ENV.vaultRepo]: "no-owner" }, missingFile()), /TMB_VAULT_REPO is not a valid vaultRepo/);
    assert.throws(() => loadInfra({ [INFRA_ENV.project]: "x;rm -rf /" }, missingFile()), /TMB_GCP_PROJECT/);
  });

  test("the refusal names each placeholder field and how to set it", () => {
    assert.equal(infraRefusal(FILE_INFRA), null);
    const refusal = infraRefusal({ ...FILE_INFRA, vaultRepo: INFRA_PLACEHOLDERS.vaultRepo });
    assert.match(refusal ?? "", /^vaultRepo still holds its placeholder; copy harness\/gcp\/infra\.example\.json/);
    assert.match(refusal ?? "", /or set TMB_VAULT_REPO$/);
  });

  test("the example file holds exactly the placeholders", () => {
    const example = JSON.parse(readFileSync(join(import.meta.dirname, "..", "gcp", "infra.example.json"), "utf8"));
    assert.deepEqual(example, INFRA_PLACEHOLDERS);
  });

  describe("with a placeholder in use", () => {
    function placeholderDeps(exec: Exec) {
      return { ...launcherDeps(exec), infra: { ...INFRA, project: INFRA_PLACEHOLDERS.project } };
    }

    for (const argv of [["setup", "--yes"], ["start", "--condition", "cr-effort-claude-opus-5.5", "--yes"], ["cleanup", "--yes"], ["status"]]) {
      test(`${argv.join(" ")} refuses with exit 2 before any call`, () => {
        const { exec, calls } = recorder();
        const deps = placeholderDeps(exec);
        assert.equal(runLauncher(argv, deps), 2);
        assert.deepEqual(calls, []);
        assert.match(deps.errors.join("\n"), /^refused: project still holds its placeholder/);
      });
    }

    test("the plans still print", () => {
      for (const command of ["setup", "cleanup"]) {
        const { exec, calls } = recorder();
        const deps = placeholderDeps(exec);
        assert.equal(runLauncher([command], deps), 0);
        assert.deepEqual(calls, []);
        assert.match(deps.output.join("\n"), /Plan only/);
      }
    });
  });
});

describe("launch.ts mutation guard", () => {
  for (const command of ["setup", "cleanup"]) {
    test(`${command} without --yes calls nothing and prints its plan`, () => {
      const { exec, calls } = recorder();
      const deps = launcherDeps(exec);
      assert.equal(runLauncher([command], deps), 0);
      assert.deepEqual(calls, []);
      assert.match(deps.output.join("\n"), /Plan only/);
    });
  }

  test("start without --yes runs only read-only git", () => {
    const { exec, calls } = recorder(() => ({ ...OK, stdout: `${SHORT_SHA}\n` }));
    const deps = launcherDeps(exec);
    assert.equal(runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5"], deps), 0);
    assert.deepEqual(calls.map((call) => call.argv), [["git", "-C", "/repo", "rev-parse", "--short=7", "HEAD"]]);
    assert.match(deps.output.join("\n"), new RegExp(`c4-c-smoke-${RUN_ID}`));
  });

  test("status runs only gcloud reads", () => {
    const { exec, calls } = recorder((argv) => (has(argv, "list") ? { ...OK, stdout: "[]" } : undefined));
    assert.equal(runLauncher(["status"], launcherDeps(exec)), 0);
    assert.ok(calls.every(({ argv }) => has(argv, "list") || has(argv, "ls")));
    assertGcloudFlags(calls);
  });

  test("unknown commands and bad flags exit 2 and call nothing", () => {
    for (const argv of [["nonsense"], [], ["setup", "extra"], ["setup", "--force"], ["start", "--condition", "cr-effort-claude-opus-5.5", "--seed", "x"]]) {
      const { exec, calls } = recorder();
      assert.equal(runLauncher(argv, launcherDeps(exec)), 2, argv.join(" "));
      assert.deepEqual(calls, []);
    }
  });
});

describe("launch.ts setup --yes", () => {
  function fresh(respond: Responder = setupResponder(false)) {
    const keyDirs: string[] = [];
    const { exec, calls } = recorder((argv, options) => {
      if (argv[0] === "ssh-keygen") {
        const keyPath = argv[argv.indexOf("-f") + 1];
        writeFileSync(keyPath, "private");
        writeFileSync(`${keyPath}.pub`, "public");
        keyDirs.push(join(keyPath, ".."));
      }
      return respond(argv, options);
    });
    return { exec, calls, keyDirs, deps: launcherDeps(exec) };
  }

  test("creates everything with resource-level roles only", () => {
    const { calls, deps } = fresh();
    assert.equal(runLauncher(["setup", "--yes"], deps), 0);
    assertGcloudFlags(calls);
    const argvs = calls.map((call) => call.argv);
    const find = (...words: string[]) => argvs.find((argv) => has(argv, ...words));

    assert.ok(find("services", "enable", "compute.googleapis.com", "iam.googleapis.com", "secretmanager.googleapis.com", "storage.googleapis.com"));
    assert.ok(find("buckets", "create", BUCKET_URL, "--uniform-bucket-level-access", "--labels=purpose=c4-smoke"));
    assert.ok(find("service-accounts", "create", "c4-smoke"));
    assert.ok(find("secrets", "create", "c4-anthropic-api-key"));
    assert.ok(find("secrets", "create", "c4-vault-deploy-key"));
    const member = `--member=serviceAccount:${SERVICE_ACCOUNT}`;
    for (const secret of ["c4-anthropic-api-key", "c4-vault-deploy-key"]) {
      assert.ok(find("secrets", "add-iam-policy-binding", secret, member, "--role=roles/secretmanager.secretAccessor"));
    }
    assert.ok(find("buckets", "add-iam-policy-binding", BUCKET_URL, member, "--role=roles/storage.objectAdmin"));
    assert.equal(argvs.filter((argv) => has(argv, "projects")).length, 0);
    assert.equal(argvs.filter((argv) => argv.join(" ").includes("add-iam-policy-binding")).length, 4);
  });

  test("binds the bucket read role on the bucket only", () => {
    const { calls, deps } = fresh();
    assert.equal(runLauncher(["setup", "--yes"], deps), 0);
    const bindings = calls
      .map((call) => call.argv)
      .filter((argv) => has(argv, "--role=roles/storage.legacyBucketReader"));
    assert.deepEqual(bindings, [
      [
        "gcloud",
        "storage",
        "buckets",
        "add-iam-policy-binding",
        BUCKET_URL,
        `--member=serviceAccount:${SERVICE_ACCOUNT}`,
        "--role=roles/storage.legacyBucketReader",
        `--project=${PROJECT}`,
        `--account=${ACCOUNT}`,
      ],
    ]);
  });

  test("registers a deploy key, stores it and removes the temp dir", () => {
    const { calls, deps, keyDirs } = fresh();
    assert.equal(runLauncher(["setup", "--yes"], deps), 0);
    const argvs = calls.map((call) => call.argv);
    assert.ok(argvs.some((argv) => argv[0] === "ssh-keygen" && has(argv, "ed25519")));
    assert.ok(
      argvs.some(
        (argv) =>
          argv[0] === "gh" &&
          has(argv, "repo", "deploy-key", "add", "--allow-write", "--title", "c4-smoke", "--repo", VAULT_REPO),
      ),
    );
    assert.ok(argvs.some((argv) => has(argv, "versions", "add", "c4-vault-deploy-key")));
    assert.equal(keyDirs.length, 1);
    assert.equal(existsSync(keyDirs[0]), false);
  });

  for (const failing of ["gh", "gcloud"]) {
    test(`removes the temp dir when ${failing} fails on the deploy key`, () => {
      const base = setupResponder(false);
      const { deps, keyDirs } = fresh((argv, options) => {
        const isKeyStep = failing === "gh" ? argv[0] === "gh" : has(argv, "versions", "add");
        return isKeyStep ? FAILED : base(argv, options);
      });
      assert.equal(runLauncher(["setup", "--yes"], deps), 1);
      assert.equal(keyDirs.length, 1);
      assert.equal(existsSync(keyDirs[0]), false);
    });
  }

  test("a second run creates nothing and keeps the deploy key", () => {
    const { calls, deps } = fresh(setupResponder(true));
    assert.equal(runLauncher(["setup", "--yes"], deps), 0);
    const argvs = calls.map((call) => call.argv);
    assert.equal(argvs.filter((argv) => has(argv, "create")).length, 0);
    assert.equal(argvs.filter((argv) => argv[0] === "ssh-keygen" || argv[0] === "gh").length, 0);
  });

  test("a second run reapplies the bucket read role and the IAM API", () => {
    const { calls, deps } = fresh(setupResponder(true));
    assert.equal(runLauncher(["setup", "--yes"], deps), 0);
    const argvs = calls.map((call) => call.argv);
    assert.ok(argvs.some((argv) => has(argv, "services", "enable", "iam.googleapis.com")));
    assert.ok(
      argvs.some((argv) => has(argv, "buckets", "add-iam-policy-binding", BUCKET_URL, "--role=roles/storage.legacyBucketReader")),
    );
  });

  test("an existing secret counts as success, also when it cannot be described", () => {
    const base = setupResponder(false);
    const { calls, deps } = fresh((argv, options) => {
      const isApiKeyCreate = has(argv, "secrets", "create", "c4-anthropic-api-key");
      if (isApiKeyCreate) return { code: 1, stdout: "", stderr: "ALREADY_EXISTS: Secret [x] already exists." };
      return base(argv, options);
    });
    assert.equal(runLauncher(["setup", "--yes"], deps), 0);
    assert.ok(
      calls.some(({ argv }) => has(argv, "add-iam-policy-binding", "c4-anthropic-api-key")),
      "still grants access on the existing secret",
    );
  });

  test("another create failure stops setup", () => {
    const base = setupResponder(false);
    const { deps } = fresh((argv, options) =>
      has(argv, "secrets", "create", "c4-anthropic-api-key") ? FAILED : base(argv, options),
    );
    assert.equal(runLauncher(["setup", "--yes"], deps), 1);
  });

  test("never touches the API key and prints the Human's command", () => {
    const { calls, deps } = fresh();
    assert.equal(runLauncher(["setup", "--yes"], deps), 0);
    const argvs = calls.map((call) => call.argv);
    assert.equal(argvs.filter((argv) => has(argv, "access")).length, 0);
    assert.equal(argvs.filter((argv) => has(argv, "versions", "add", "c4-anthropic-api-key")).length, 0);
    assert.equal(
      API_KEY_COMMAND,
      `pbpaste | gcloud secrets versions add c4-anthropic-api-key --data-file=- --project=${PROJECT} --account=${ACCOUNT}`,
    );
    assert.ok(deps.output.join("\n").includes(API_KEY_COMMAND));
  });
});

describe("launch.ts start --yes", () => {
  function passing(overrides: Responder = () => undefined): Responder {
    return (argv, options) => {
      const override = overrides(argv, options);
      if (override) return override;
      if (has(argv, "rev-parse")) return { ...OK, stdout: `${SHORT_SHA}\n` };
      if (has(argv, "for-each-ref")) return { ...OK, stdout: "refs/remotes/origin/dev\n" };
      if (has(argv, "versions", "list")) return { ...OK, stdout: "1\n" };
      if (has(argv, "instances", "list")) return { ...OK, stdout: "[]" };
      return undefined;
    };
  }

  test("uploads the archive and creates the guarded VM", () => {
    let script = "";
    const { exec, calls } = recorder(
      passing((argv) => {
        if (has(argv, "instances", "create")) {
          const flag = argv.find((arg) => arg.startsWith("--metadata-from-file="));
          script = readFileSync(String(flag).split("startup-script=")[1], "utf8");
        }
        return undefined;
      }),
    );
    const deps = launcherDeps(exec);
    assert.equal(runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--yes", "--seed", "7"], deps), 0);
    assertGcloudFlags(calls);
    const argvs = calls.map((call) => call.argv);
    const archive = argvs.findIndex((argv) => has(argv, "archive", "HEAD"));
    const upload = argvs.findIndex((argv) => has(argv, "storage", "cp", `${BUCKET_URL}/code/${RUN_ID}.tar.gz`));
    const create = argvs.findIndex((argv) => has(argv, "instances", "create"));
    assert.ok(archive >= 0 && archive < upload && upload < create);
    const flags = argvs[create];
    for (const flag of [
      `c4-c-smoke-${RUN_ID}`,
      "--zone=us-central1-a",
      "--machine-type=e2-standard-4",
      "--provisioning-model=STANDARD",
      "--max-run-duration=10h",
      "--instance-termination-action=DELETE",
      "--no-restart-on-failure",
      `--service-account=${SERVICE_ACCOUNT}`,
      "--scopes=cloud-platform",
      "--image-family=debian-12",
      "--boot-disk-size=100GB",
      "--boot-disk-type=pd-balanced",
      "--labels=purpose=c4-smoke,study=cr-effort-claude-opus-5-5",
      `--metadata=run-id=${RUN_ID},condition=cr-effort-claude-opus-5.5,seed=7,bucket=${BUCKET_NAME},machine-type=e2-standard-4`,
    ]) {
      assert.ok(flags.includes(flag), flag);
    }
    assert.ok(script.startsWith("#!/bin/bash\ntrap "));
    assert.ok(script.includes("--seed 7"));
    const printed = deps.output.join("\n");
    for (const expected of [
      `c4-c-smoke-${RUN_ID}`,
      RUN_ID,
      "e2-standard-4",
      `${BUCKET_URL}/runs/${RUN_ID}/`,
      `branch c4-c-smoke/${RUN_ID}, under c4-effort/c4-c-smoke/${RUN_ID}/`,
      "launch.ts status",
      "launch.ts cleanup --yes",
    ]) {
      assert.ok(printed.includes(expected), expected);
    }
  });

  const refusals: Array<[string, Responder, RegExp]> = [
    ["a dirty tree", (argv) => (has(argv, "status") ? { ...OK, stdout: " M x\n" } : undefined), /not clean/],
    ["HEAD not on origin", (argv) => (has(argv, "for-each-ref") ? OK : undefined), /origin/],
    ["no batch at HEAD", (argv) => (has(argv, "cat-file") ? FAILED : undefined), /run-batch/],
    [
      "a secret with no enabled version",
      (argv) => (has(argv, "versions", "list", "c4-anthropic-api-key") ? OK : undefined),
      /c4-anthropic-api-key/,
    ],
    [
      "a stopped VM",
      (argv) =>
        has(argv, "instances", "list")
          ? { ...OK, stdout: JSON.stringify([{ name: "c4-c-smoke-x", status: "TERMINATED", zone: "z" }]) }
          : undefined,
      /already exists/,
    ],
    [
      "a running VM",
      (argv) =>
        has(argv, "instances", "list")
          ? { ...OK, stdout: JSON.stringify([{ name: "c4-c-smoke-x", status: "RUNNING", zone: "z" }]) }
          : undefined,
      /already exists/,
    ],
  ];

  for (const [name, respond, pattern] of refusals) {
    test(`refuses ${name} and uploads nothing`, () => {
      const { exec, calls } = recorder(passing(respond));
      const deps = launcherDeps(exec);
      assert.equal(runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--yes"], deps), 1);
      assert.match(deps.errors.join("\n"), pattern);
      assert.equal(calls.filter(({ argv }) => has(argv, "archive") || has(argv, "cp") || has(argv, "create")).length, 0);
    });
  }
});

describe("launch.ts cleanup --yes and status", () => {
  const LABELS = { purpose: "c4-smoke" };
  const ZONE_URL = "https://www.googleapis.com/compute/v1/projects/p/zones/us-central1-a";

  function withVms(vms: object[]) {
    return recorder((argv) => (has(argv, "instances", "list") ? { ...OK, stdout: JSON.stringify(vms) } : undefined));
  }

  test("filters on the label and deletes a stopped VM", () => {
    const { exec, calls } = withVms([{ name: "c4-c-smoke-a", status: "TERMINATED", zone: ZONE_URL, labels: LABELS }]);
    assert.equal(runLauncher(["cleanup", "--yes"], launcherDeps(exec)), 0);
    assertGcloudFlags(calls);
    assert.ok(calls[0].argv.includes("--filter=labels.purpose=c4-smoke"));
    assert.ok(has(calls[1].argv, "instances", "delete", "c4-c-smoke-a", "--zone=us-central1-a"));
  });

  test("the label finds and deletes a stopped VM with the old name", () => {
    const { exec, calls } = withVms([{ name: "c4-smoke-a", status: "TERMINATED", zone: ZONE_URL, labels: LABELS }]);
    assert.equal(runLauncher(["cleanup", "--yes"], launcherDeps(exec)), 0);
    assert.ok(calls[0].argv.includes("--filter=labels.purpose=c4-smoke"));
    assert.ok(has(calls[1].argv, "instances", "delete", "c4-smoke-a", "--zone=us-central1-a"));
  });

  test("status reads the run ID of a VM with the old name", () => {
    const { exec, calls } = withVms([{ name: `c4-smoke-${RUN_ID}`, status: "TERMINATED", zone: ZONE_URL, labels: LABELS }]);
    assert.equal(runLauncher(["status"], launcherDeps(exec)), 0);
    assert.ok(calls.some(({ argv }) => has(argv, "storage", "ls", "--recursive", `${BUCKET_URL}/runs/${RUN_ID}/`)));
  });

  for (const name of [
    `cr-repo-${RUN_ID}`,
    `cr-effort-${RUN_ID}`,
    `cr-testresults-${RUN_ID}`,
    `cr-skill-${RUN_ID}`,
    `c4-c-smoke-${RUN_ID}`,
    `c4-smoke-${RUN_ID}`,
  ]) {
    test(`cleanup deletes and status reads the run ID of ${name.replace(RUN_ID, "<id>")}`, () => {
      const cleaned = withVms([{ name, status: "TERMINATED", zone: ZONE_URL, labels: LABELS }]);
      assert.equal(runLauncher(["cleanup", "--yes"], launcherDeps(cleaned.exec)), 0);
      assert.ok(has(cleaned.calls[1].argv, "instances", "delete", name, "--zone=us-central1-a"));
      const status = withVms([{ name, status: "TERMINATED", zone: ZONE_URL, labels: LABELS }]);
      assert.equal(runLauncher(["status"], launcherDeps(status.exec)), 0);
      assert.ok(status.calls.some(({ argv }) => has(argv, "storage", "ls", "--recursive", `${BUCKET_URL}/runs/${RUN_ID}/`)));
    });
  }

  test("status reads the full run ID from the metadata of a VM whose name is shortened", () => {
    const runId = `${RUN_ID}-arms-a-models-opusm-haikuh-s0of2`;
    const vm = {
      name: resourceNames("cr-effort-claude-opus-5.5", runId).vm,
      status: "RUNNING",
      zone: ZONE_URL,
      labels: LABELS,
      metadata: { items: [{ key: "startup-script", value: "#!/bin/bash" }, { key: "run-id", value: runId }] },
    };
    assert.notEqual(vm.name, `c4-c-smoke-${runId}`);
    const { exec, calls } = withVms([vm]);
    assert.equal(runLauncher(["status"], launcherDeps(exec)), 0);
    assert.ok(calls.some(({ argv }) => has(argv, "storage", "ls", "--recursive", `${BUCKET_URL}/runs/${runId}/`)));
  });

  test("refuses a RUNNING VM", () => {
    const { exec, calls } = withVms([{ name: "c4-c-smoke-a", status: "RUNNING", zone: ZONE_URL, labels: LABELS }]);
    const deps = launcherDeps(exec);
    assert.equal(runLauncher(["cleanup", "--yes"], deps), 1);
    assert.match(deps.errors.join("\n"), /RUNNING/);
    assert.equal(calls.filter(({ argv }) => has(argv, "delete")).length, 0);
  });

  test("refuses a VM without the label", () => {
    const { exec, calls } = withVms([{ name: "other", status: "TERMINATED", zone: ZONE_URL, labels: {} }]);
    assert.equal(runLauncher(["cleanup", "--yes"], launcherDeps(exec)), 1);
    assert.equal(calls.filter(({ argv }) => has(argv, "delete")).length, 0);
  });

  test("status shows the VM state and the run's objects", () => {
    const { exec } = recorder((argv) => {
      if (has(argv, "instances", "list")) {
        return {
          ...OK,
          stdout: JSON.stringify([{ name: `c4-c-smoke-${RUN_ID}`, status: "RUNNING", zone: ZONE_URL, labels: LABELS }]),
        };
      }
      return has(argv, "storage", "ls", "--recursive", `${BUCKET_URL}/runs/${RUN_ID}/`)
        ? { ...OK, stdout: `${BUCKET_URL}/runs/${RUN_ID}/STARTED\n` }
        : FAILED;
    });
    const deps = launcherDeps(exec);
    assert.equal(runLauncher(["status"], deps), 0);
    const printed = deps.output.join("\n");
    assert.match(printed, /RUNNING/);
    assert.ok(printed.includes(`${RUN_ID}/STARTED`));
  });
});

describe("startup script", () => {
  const params = { runId: RUN_ID, condition: "cr-effort-claude-opus-5.5" as const, seed: "7", bucket: BUCKET_NAME, machineType: "e2-standard-4" };
  const script = renderStartupScript(params);
  const lines = script.split("\n");

  test("the trap comes before every other command", () => {
    assert.equal(lines[0], "#!/bin/bash");
    assert.match(lines[1], /^trap '.*' EXIT$/);
    assert.ok(lines[1].includes(`gcloud storage cp ${STARTUP_LOG} ${BUCKET_URL}/runs/${RUN_ID}/`));
    assert.ok(lines[1].includes("shutdown -h now"));
  });

  test("the marker check comes before the marker write and the installs", () => {
    const check = script.indexOf(`gcloud storage ls ${BUCKET_URL}/runs/${RUN_ID}/STARTED`);
    const write = script.indexOf(`gcloud storage cp --if-generation-match=0 - ${BUCKET_URL}/runs/${RUN_ID}/STARTED`);
    const install = script.indexOf("apt-get");
    assert.ok(check > 0 && check < write && write < install);
    assert.ok(script.includes("apt-get install -y docker.io git"));
  });

  test("pins Node and checks its hash before unpacking", () => {
    assert.match(NODE_VERSION, /^v24\./);
    assert.match(NODE_LINUX_X64_SHA256, /^[0-9a-f]{64}$/);
    const download = script.indexOf(`https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.gz`);
    const check = script.indexOf(`${NODE_LINUX_X64_SHA256}  `);
    const unpack = script.indexOf("--strip-components=1");
    assert.ok(download > 0 && download < check && check < unpack);
  });

  test("never traces and never reads a secret", () => {
    assert.doesNotMatch(script, /set -[a-z]*x|xtrace/);
    assert.doesNotMatch(script, /secrets|c4-anthropic|c4-vault/);
  });

  test("hands the project and vault repo to vm-run.ts through the environment, without the Human's account", () => {
    const exported = script.indexOf(`export ${INFRA_ENV.project}=${PROJECT} ${INFRA_ENV.vaultRepo}=${VAULT_REPO}`);
    assert.ok(exported > 0 && exported < script.indexOf("harness/gcp/vm-run.ts run"));
    assert.ok(!script.includes(INFRA_ENV.account));
    assert.ok(!script.includes(ACCOUNT));
  });

  test("unpacks the code and runs vm-run.ts last", () => {
    const unpack = script.indexOf(`gs://${BUCKET_NAME}/code/${RUN_ID}.tar.gz`);
    const run = script.indexOf("harness/gcp/vm-run.ts run");
    assert.ok(unpack > 0 && unpack < run);
    assert.ok(script.includes(`--run-id ${RUN_ID} --condition cr-effort-claude-opus-5.5 --seed 7 --bucket ${BUCKET_NAME} --vm-type e2-standard-4`));
  });

  test("installs the locked dependencies with the unpacked node, in the code dir, before the run", () => {
    const enterCode = script.indexOf("cd /opt/c4/code");
    const install = script.indexOf('PATH=/opt/c4/node/bin:"$PATH" /opt/c4/node/bin/npm ci');
    const run = script.indexOf("harness/gcp/vm-run.ts run");
    assert.ok(script.indexOf("--strip-components=1") < enterCode);
    assert.ok(enterCode > 0 && enterCode < install && install < run);
  });

  test("refuses unsafe values", () => {
    assert.throws(() => renderStartupScript({ ...params, runId: "x; rm -rf /" }));
    assert.throws(() => renderStartupScript({ ...params, bucket: "a b" }));
    assert.throws(() => renderStartupScript({ ...params, seed: "$(id)" }));
  });

  test("is valid bash", () => {
    const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });

  function runWithStubs(gcloudBody: string): { calls: string } {
    const dir = mkdtempSync(join(tmpdir(), "cr-startup-"));
    const callsPath = join(dir, "calls");
    const logPath = join(dir, "startup.log");
    const stub = (name: string, body: string) => {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "${callsPath}"\n${body}\n`);
      chmodSync(path, 0o755);
    };
    stub("gcloud", gcloudBody);
    for (const name of ["shutdown", "apt-get", "curl"]) stub(name, "exit 0");
    const scriptPath = join(dir, "startup.sh");
    writeFileSync(scriptPath, script.replaceAll(STARTUP_LOG, logPath));
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: { PATH: `${dir}:${process.env.PATH}` },
    });
    assert.equal(result.signal, null);
    return { calls: readFileSync(callsPath, "utf8") };
  }

  test("a second boot stops without installing or overwriting the marker", () => {
    const { calls } = runWithStubs("exit 0");
    assert.doesNotMatch(calls, /apt-get|curl|--if-generation-match/);
    assert.match(calls, /gcloud storage cp \S*startup\.log /);
    assert.match(calls, /shutdown -h now\n$/);
  });

  test("a marker write that fails stops the VM without installing", () => {
    const { calls } = runWithStubs('case "$*" in *"--if-generation-match"*|*"storage ls"*) exit 1;; esac; exit 0');
    assert.match(calls, /--if-generation-match/);
    assert.doesNotMatch(calls, /apt-get|curl/);
    assert.match(calls, /shutdown -h now\n$/);
  });

  test("the shutdown still runs when the log upload fails", () => {
    const { calls } = runWithStubs("exit 1");
    assert.match(calls, /shutdown -h now\n$/);
  });
});

function vmFixture(respond: Responder = () => undefined) {
  const work = mkdtempSync(join(tmpdir(), "cr-vm-"));
  const shmDir = mkdtempSync(join(tmpdir(), "cr-shm-"));
  const codeDir = mkdtempSync(join(tmpdir(), "cr-code-"));
  const logs: string[] = [];
  const { exec, calls } = recorder((argv, options) => {
    const override = respond(argv, options);
    if (override) return override;
    if (has(argv, "access", "--secret=c4-anthropic-api-key")) return { ...OK, stdout: FAKE_API_KEY };
    if (has(argv, "access", "--secret=c4-vault-deploy-key")) return { ...OK, stdout: FAKE_DEPLOY_KEY };
    if (argv[0] === "df") return { ...OK, stdout: "Used\n12500000000\n" };
    return undefined;
  });
  const deps: VmDeps = {
    exec,
    log: (line) => logs.push(line),
    now: () => FIXED_NOW,
    shmDir,
    codeDir,
    nodePath: "/node",
    scriptPath: "/code/harness/gcp/vm-run.ts",
  };
  const params: RunParams = { runId: RUN_ID, condition: "cr-effort-claude-opus-5.5", bucket: BUCKET_NAME, work, seed: "7", vmType: "e2-standard-4" };
  const results = join(work, "results");
  const keyFile = join(shmDir, `cr-vault-key-${RUN_ID}`);
  return { deps, params, calls, logs, results, keyFile };
}

function isBatch(argv: string[]): boolean {
  return argv.includes("harness/smoke/run-batch.ts");
}

function isGcsCopy(argv: string[]): boolean {
  return has(argv, "storage", "rsync");
}

function isPush(argv: string[]): boolean {
  return argv[0] === "git" && has(argv, "push");
}

describe("vm-run.ts sync", () => {
  test("copies to GCS, then pushes to a new vault branch", () => {
    const fixture = vmFixture((argv) => (has(argv, "rev-parse") ? FAILED : undefined));
    mkdirSync(fixture.results, { recursive: true });
    writeFileSync(join(fixture.results, "run.json"), "{}");
    const outcome = sync(fixture.params, fixture.deps);
    assert.equal(outcome.gcsCopyOk, true);
    assert.equal(outcome.vaultPushOk, true);
    const argvs = fixture.calls.map((call) => call.argv);
    const copy = argvs.findIndex(isGcsCopy);
    const push = argvs.findIndex(isPush);
    assert.ok(copy >= 0 && copy < push);
    assert.ok(argvs[copy].includes(`${BUCKET_URL}/runs/${RUN_ID}`));
    assert.ok(argvs.some((argv) => has(argv, "remote", "add", "origin", `git@github.com:${VAULT_REPO}.git`)));
    assert.ok(argvs.some((argv) => has(argv, "add", "-f", join("c4-effort", "c4-c-smoke", RUN_ID))));
    assert.ok(argvs.some((argv) => has(argv, "checkout", "-b", `c4-c-smoke/${RUN_ID}`)));
    assert.ok(argvs[push].includes(`HEAD:refs/heads/c4-c-smoke/${RUN_ID}`));
    const copied = join(fixture.params.work, "vault", "c4-effort", "c4-c-smoke", RUN_ID, "run.json");
    assert.equal(readFileSync(copied, "utf8"), "{}");
  });

  test("never force-pushes and never pushes main", () => {
    const fixture = vmFixture((argv) => (has(argv, "rev-parse") ? FAILED : undefined));
    sync(fixture.params, fixture.deps);
    const pushes = fixture.calls.map((call) => call.argv).filter(isPush);
    assert.equal(pushes.length, 1);
    for (const push of pushes) {
      for (const arg of push) {
        assert.doesNotMatch(arg, /^(--force.*|-f|\+.*)$/);
        assert.doesNotMatch(arg, /:refs\/heads\/main$|^main$/);
      }
    }
  });

  test("uses the pinned host key and strict checking", () => {
    const fixture = vmFixture();
    sync(fixture.params, fixture.deps);
    const push = fixture.calls.find((call) => isPush(call.argv));
    const sshCommand = String(push?.options?.env?.GIT_SSH_COMMAND);
    assert.match(sshCommand, /StrictHostKeyChecking=yes/);
    const knownHosts = /UserKnownHostsFile=(\S+)/.exec(sshCommand)?.[1];
    assert.equal(
      readFileSync(String(knownHosts), "utf8"),
      "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n",
    );
    assert.ok(sshCommand.includes(fixture.keyFile));
  });

  test("keeps the deploy key in a 0600 file", () => {
    const fixture = vmFixture();
    sync(fixture.params, fixture.deps);
    assert.equal(statSync(fixture.keyFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(fixture.keyFile, "utf8"), FAKE_DEPLOY_KEY);
  });

  test("refuses to publish when a result file holds the API key", () => {
    const fixture = vmFixture();
    mkdirSync(join(fixture.results, "nested"), { recursive: true });
    writeFileSync(join(fixture.results, "nested", "transcript.jsonl"), `prefix ${FAKE_API_KEY} suffix`);
    const outcome = sync(fixture.params, fixture.deps);
    assert.equal(outcome.refused, true);
    assert.equal(fixture.calls.filter(({ argv }) => isGcsCopy(argv) || isPush(argv)).length, 0);
    const logged = fixture.logs.join("\n");
    assert.match(logged, /publish refused/);
    assert.ok(!logged.includes(FAKE_API_KEY));
  });

  test("refuses to publish when the key cannot be read for the check", () => {
    const fixture = vmFixture((argv) => (has(argv, "access", "--secret=c4-anthropic-api-key") ? FAILED : undefined));
    const outcome = sync(fixture.params, fixture.deps);
    assert.equal(outcome.refused, true);
    assert.equal(fixture.calls.filter(({ argv }) => isGcsCopy(argv) || isPush(argv)).length, 0);
  });

  test("a failed push is logged and leaves the GCS copy standing", () => {
    const fixture = vmFixture((argv) => (isPush(argv) ? FAILED : undefined));
    const outcome = sync(fixture.params, fixture.deps);
    assert.deepEqual(
      { gcs: outcome.gcsCopyOk, vault: outcome.vaultPushOk, refused: outcome.refused },
      { gcs: true, vault: false, refused: false },
    );
    assert.match(fixture.logs.join("\n"), /vault push failed/);
  });

  test("a failed GCS copy still attempts the push", () => {
    const fixture = vmFixture((argv) => (isGcsCopy(argv) ? FAILED : undefined));
    const outcome = sync(fixture.params, fixture.deps);
    assert.equal(outcome.gcsCopyOk, false);
    assert.equal(outcome.vaultPushOk, true);
  });

  test("writes peak disk from df to vm-stats.json and keeps the peak", () => {
    let used = "12500000000";
    const fixture = vmFixture((argv) => (argv[0] === "df" ? { ...OK, stdout: `Used\n${used}\n` } : undefined));
    sync(fixture.params, fixture.deps);
    used = "2000000000";
    const outcome = sync(fixture.params, fixture.deps);
    const stats = JSON.parse(readFileSync(join(fixture.results, STATS_FILE), "utf8"));
    assert.deepEqual(stats, {
      run_id: RUN_ID,
      peak_disk_gb: 12.5,
      last_disk_gb: 2,
      sampled_at: FIXED_NOW.toISOString(),
    });
    assert.equal(outcome.peakDiskGb, 12.5);
  });

  test("a df failure keeps the sync going", () => {
    const fixture = vmFixture((argv) => (argv[0] === "df" ? FAILED : undefined));
    const outcome = sync(fixture.params, fixture.deps);
    assert.equal(outcome.peakDiskGb, null);
    assert.equal(outcome.gcsCopyOk, true);
  });
});

describe("vm-run.ts sync against a real git remote", () => {
  test("makes a new branch from main, adds a commit per sync and leaves main alone", () => {
    const root = mkdtempSync(join(tmpdir(), "cr-vault-"));
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    const vmEnv = {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const gitEnv = {
      ...vmEnv,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    };
    const git = (cwd: string, ...args: string[]): string => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    mkdirSync(remote);
    git(remote, "init", "-q", "--bare", "-b", "main");
    mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    writeFileSync(join(seed, "README.md"), "vault\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "--no-gpg-sign", "-m", "init");
    git(seed, "push", "-q", remote, "main");
    const mainBefore = git(remote, "rev-parse", "main");

    const fixture = vmFixture();
    const stubbed = fixture.deps.exec;
    const deps: VmDeps = {
      ...fixture.deps,
      exec: (argv, options) => {
        if (argv[0] !== "git") return stubbed(argv, options);
        const rewritten = argv.map((arg) => (arg.startsWith("git@github.com:") ? remote : arg));
        const env = { ...vmEnv, GIT_SSH_COMMAND: options?.env?.GIT_SSH_COMMAND };
        return realExec(rewritten, { ...options, env });
      },
    };
    mkdirSync(fixture.results, { recursive: true });
    writeFileSync(join(fixture.results, "one.json"), "1");
    assert.equal(sync(fixture.params, deps).vaultPushOk, true, fixture.logs.join("\n"));
    writeFileSync(join(fixture.results, "two.json"), "2");
    assert.equal(sync(fixture.params, deps).vaultPushOk, true, fixture.logs.join("\n"));

    const branch = `c4-c-smoke/${RUN_ID}`;
    assert.equal(git(remote, "rev-parse", "main"), mainBefore);
    assert.equal(git(remote, "merge-base", "main", branch), mainBefore);
    const files = git(remote, "ls-tree", "-r", "--name-only", branch).split("\n");
    for (const name of ["one.json", "two.json", STATS_FILE]) {
      assert.ok(files.includes(`c4-effort/c4-c-smoke/${RUN_ID}/${name}`), name);
    }
    assert.ok(files.includes("README.md"));
    assert.ok(Number(git(remote, "rev-list", "--count", `main..${branch}`)) >= 2);
    assert.equal(git(remote, "log", "-1", "--format=%an|%s", branch), `c4-c-smoke|cr smoke results for ${RUN_ID}`);
  });
});

describe("vm-run.ts run", () => {
  function done(results: string) {
    return JSON.parse(readFileSync(join(results, DONE_FILE), "utf8"));
  }

  for (const exitCode of [0, 1]) {
    test(`writes DONE.json and syncs it for batch exit ${exitCode}`, () => {
      const fixture = vmFixture((argv) => (isBatch(argv) ? { ...OK, code: exitCode } : undefined));
      assert.equal(runVm(fixture.params, fixture.deps), exitCode);
      assert.deepEqual(done(fixture.results), {
        run_id: RUN_ID,
        batch_exit_code: exitCode,
        finished_at: FIXED_NOW.toISOString(),
        vault_push_ok: true,
        gcs_copy_ok: true,
        peak_disk_gb: 12.5,
      });
      const argvs = fixture.calls.map((call) => call.argv);
      assert.ok(argvs.findLastIndex(isGcsCopy) > argvs.findIndex(isBatch));
      assert.ok(argvs.filter(isGcsCopy).length >= 2, "the sync after DONE.json publishes it");
    });
  }

  test("writes DONE.json when the batch throws", () => {
    const fixture = vmFixture((argv) => {
      if (isBatch(argv)) throw new Error("spawn failed");
      return undefined;
    });
    assert.equal(runVm(fixture.params, fixture.deps), 1);
    const record = done(fixture.results);
    assert.equal(record.batch_exit_code, null);
    assert.equal(record.gcs_copy_ok, true);
    assert.equal(record.vault_push_ok, true);
    assert.equal(record.peak_disk_gb, 12.5);
    assert.match(fixture.logs.join("\n"), /spawn failed/);
  });

  test("writes DONE.json when a secret cannot be read", () => {
    const fixture = vmFixture((argv) => (has(argv, "access", "--secret=c4-anthropic-api-key") ? FAILED : undefined));
    assert.equal(runVm(fixture.params, fixture.deps), 1);
    const record = done(fixture.results);
    assert.equal(record.batch_exit_code, null);
    assert.equal(record.gcs_copy_ok, false);
    assert.equal(fixture.calls.filter(({ argv }) => isBatch(argv)).length, 0);
  });

  test("DONE.json reports the last sync when a later one changes the outcome", () => {
    let copies = 0;
    const fixture = vmFixture((argv) => {
      if (isGcsCopy(argv)) copies += 1;
      return isGcsCopy(argv) && copies === 1 ? FAILED : undefined;
    });
    runVm(fixture.params, fixture.deps);
    assert.equal(done(fixture.results).gcs_copy_ok, true);
    assert.equal(copies, 3);
  });

  test("passes the API key only in the batch's env and argv never holds it", () => {
    const fixture = vmFixture();
    runVm(fixture.params, fixture.deps);
    assert.equal(process.env.ANTHROPIC_API_KEY === FAKE_API_KEY, false);
    for (const { argv, options } of fixture.calls) {
      assert.ok(!argv.join(" ").includes(FAKE_API_KEY), argv.join(" "));
      assert.equal(options?.env?.ANTHROPIC_API_KEY === FAKE_API_KEY, isBatch(argv), argv.join(" "));
    }
    assert.ok(!fixture.logs.join("\n").includes(FAKE_API_KEY));
    assert.ok(fixture.calls.some(({ argv }) => has(argv, "versions", "access", "latest", "--secret=c4-anthropic-api-key")));
    assert.ok(fixture.calls.some(({ argv }) => has(argv, "versions", "access", "latest", "--secret=c4-vault-deploy-key")));
  });

  test("runs the batch contract with a checkpoint that re-invokes sync", () => {
    const fixture = vmFixture();
    runVm(fixture.params, fixture.deps);
    const batch = fixture.calls.find(({ argv }) => isBatch(argv));
    assert.ok(batch);
    assert.equal(batch.options?.cwd, fixture.deps.codeDir);
    const value = (flag: string) => batch.argv[batch.argv.indexOf(flag) + 1];
    assert.equal(value("--run-id"), RUN_ID);
    assert.equal(value("--seed"), "7");
    assert.equal(value("--vm-type"), "e2-standard-4");
    assert.equal(value("--out"), fixture.results);
    assert.equal(
      value("--checkpoint-cmd"),
      `/node /code/harness/gcp/vm-run.ts sync --run-id ${RUN_ID} --condition cr-effort-claude-opus-5.5 --bucket ${BUCKET_NAME} --work ${fixture.params.work}`,
    );
  });

  test("removes the deploy key when it finishes", () => {
    const fixture = vmFixture();
    runVm(fixture.params, fixture.deps);
    assert.equal(existsSync(fixture.keyFile), false);
    assert.equal(existsSync(`${fixture.keyFile}.known_hosts`), false);
  });

  test("gcloud on the VM never uses the Human's account", () => {
    const fixture = vmFixture();
    runVm(fixture.params, fixture.deps);
    for (const { argv } of fixture.calls.filter((call) => call.argv[0] === "gcloud")) {
      assert.ok(argv.includes(`--project=${PROJECT}`));
      assert.ok(!argv.some((arg) => arg.startsWith("--account")));
    }
  });
});

describe("vm-run.ts source cache seed", () => {
  function isCacheSeed(argv: string[]): boolean {
    return isGcsCopy(argv) && argv.includes(`${BUCKET_URL}/cache`);
  }

  test("copies the GCS cache into the code dir before the batch", () => {
    const fixture = vmFixture();
    assert.equal(runVm(fixture.params, fixture.deps), 0);
    const argvs = fixture.calls.map((call) => call.argv);
    const seed = argvs.findIndex(isCacheSeed);
    const batch = argvs.findIndex(isBatch);
    assert.ok(seed >= 0 && seed < batch);
    assert.ok(argvs.findIndex((argv) => has(argv, "access", "--secret=c4-vault-deploy-key")) < seed);
    const cacheDir = join(fixture.deps.codeDir, "runs", "cache");
    assert.deepEqual(argvs[seed], [
      "gcloud",
      "storage",
      "rsync",
      `${BUCKET_URL}/cache`,
      cacheDir,
      "--recursive",
      `--project=${PROJECT}`,
    ]);
    assert.equal(argvs.filter(isCacheSeed).length, 1);
    assert.ok(existsSync(cacheDir));
    assert.ok(!fixture.calls[seed].options?.env?.ANTHROPIC_API_KEY);
  });

  test("a failed seed is logged and the batch still runs", () => {
    const fixture = vmFixture((argv) => (isCacheSeed(argv) ? FAILED : undefined));
    assert.equal(runVm(fixture.params, fixture.deps), 0);
    const argvs = fixture.calls.map((call) => call.argv);
    assert.ok(argvs.findIndex(isCacheSeed) < argvs.findIndex(isBatch));
    assert.match(fixture.logs.join("\n"), /source cache seed failed \(exit 1\): boom/);
    assert.equal(JSON.parse(readFileSync(join(fixture.results, DONE_FILE), "utf8")).batch_exit_code, 0);
  });
});

describe("README", () => {
  const readme = readFileSync(join(import.meta.dirname, "..", "gcp", "README.md"), "utf8");

  test("states the billing facts", () => {
    assert.match(readme, /credits cover compute only/i);
    assert.match(readme, /Anthropic key bills separately/);
    assert.match(readme, /stopped VM keeps billing its disk until `cleanup`/);
  });

  test("explains the bucket read role and the rerun", () => {
    assert.match(readme, /`roles\/storage\.legacyBucketReader`/);
    assert.match(readme, /`storage\.objectAdmin` has no `storage\.buckets\.get`/);
    assert.match(readme, /ran `setup` earlier must run `setup --yes` once more/);
  });

  test("shows the API key command with placeholders and names no configured infrastructure value", () => {
    const placeholderCommand = API_KEY_COMMAND.replace(`--project=${PROJECT}`, "--project=<project>").replace(
      `--account=${ACCOUNT}`,
      "--account=<account>",
    );
    assert.ok(readme.includes(placeholderCommand));
    for (const value of [PROJECT, ACCOUNT, VAULT_REPO]) assert.ok(!readme.includes(value), value);
  });
});

describe("resume from an earlier run", () => {
  const PRIOR = "20261101t021819z-2666a4e";
  const PRIOR_REPORT = `${BUCKET_URL}/runs/${PRIOR}/preflight-report.json`;

  function passing(overrides: Responder = () => undefined): Responder {
    return (argv, options) => {
      const override = overrides(argv, options);
      if (override) return override;
      if (has(argv, "rev-parse")) return { ...OK, stdout: `${SHORT_SHA}\n` };
      if (has(argv, "for-each-ref")) return { ...OK, stdout: "refs/remotes/origin/dev\n" };
      if (has(argv, "versions", "list")) return { ...OK, stdout: "1\n" };
      if (has(argv, "instances", "list")) return { ...OK, stdout: "[]" };
      return undefined;
    };
  }

  function isPriorDownload(argv: string[]): boolean {
    return isGcsCopy(argv) && argv.includes(`${BUCKET_URL}/runs/${PRIOR}`);
  }

  describe("launch.ts", () => {
    test("the dry run prints the flag and calls only read-only git", () => {
      const { exec, calls } = recorder(() => ({ ...OK, stdout: `${SHORT_SHA}\n` }));
      const deps = launcherDeps(exec);
      assert.equal(runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--resume-from", PRIOR], deps), 0);
      assert.deepEqual(calls.map((call) => call.argv), [["git", "-C", "/repo", "rev-parse", "--short=7", "HEAD"]]);
      const printed = deps.output.join("\n");
      assert.ok(printed.includes(`--resume-from ${PRIOR}`));
      assert.ok(printed.includes(`,resume-from=${PRIOR}`));
      assert.ok(printed.includes(PRIOR_REPORT));
    });

    for (const bad of ["../other", "x", "20261101t021819z-ZZZ", "", `${PRIOR};reboot`]) {
      test(`refuses the id ${JSON.stringify(bad)} and calls nothing`, () => {
        const { exec, calls } = recorder();
        const deps = launcherDeps(exec);
        assert.equal(runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", `--resume-from=${bad}`], deps), 2);
        assert.deepEqual(calls, []);
        assert.match(deps.errors.join("\n"), /usage:/);
      });
    }

    for (const command of ["setup", "status", "cleanup"]) {
      test(`${command} does not take the flag`, () => {
        const { exec, calls } = recorder();
        assert.equal(runLauncher([command, "--resume-from", PRIOR], launcherDeps(exec)), 2);
        assert.deepEqual(calls, []);
      });
    }

    test("--yes refuses and uploads nothing when the prior report is absent", () => {
      const { exec, calls } = recorder(
        passing((argv) => (has(argv, "storage", "ls", PRIOR_REPORT) ? FAILED : undefined)),
      );
      const deps = launcherDeps(exec);
      assert.equal(runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--yes", "--resume-from", PRIOR], deps), 1);
      assert.ok(deps.errors.join("\n").includes(`${PRIOR_REPORT} does not exist`));
      assert.equal(calls.filter(({ argv }) => has(argv, "archive") || has(argv, "cp") || has(argv, "create")).length, 0);
    });

    test("--yes carries the id through metadata and the startup script", () => {
      let script = "";
      const { exec, calls } = recorder(
        passing((argv) => {
          if (has(argv, "instances", "create")) {
            const flag = argv.find((arg) => arg.startsWith("--metadata-from-file="));
            script = readFileSync(String(flag).split("startup-script=")[1], "utf8");
          }
          return undefined;
        }),
      );
      const deps = launcherDeps(exec);
      assert.equal(runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--yes", "--seed", "7", "--resume-from", PRIOR], deps), 0);
      assertGcloudFlags(calls);
      const create = calls.map((call) => call.argv).find((argv) => has(argv, "instances", "create")) as string[];
      assert.ok(
        create.includes(
          `--metadata=run-id=${RUN_ID},condition=cr-effort-claude-opus-5.5,seed=7,bucket=${BUCKET_NAME},machine-type=e2-standard-4,resume-from=${PRIOR}`,
        ),
      );
      assert.ok(create.includes(`c4-c-smoke-${RUN_ID}`), "a resume is a new VM with a new run id");
      assert.ok(script.includes(`--work /opt/c4 --resume-from ${PRIOR}\n`));
      assert.ok(script.includes(`--run-id ${RUN_ID} `));
    });

    test("without the flag no prior report is checked", () => {
      const { exec, calls } = recorder(passing());
      assert.equal(runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--yes"], launcherDeps(exec)), 0);
      assert.equal(calls.filter(({ argv }) => has(argv, "storage", "ls")).length, 0);
      const create = calls.map((call) => call.argv).find((argv) => has(argv, "instances", "create")) as string[];
      assert.ok(!create.join(" ").includes("resume-from"));
    });
  });

  describe("startup script", () => {
    const base = { runId: RUN_ID, condition: "cr-effort-claude-opus-5.5" as const, seed: "7", bucket: BUCKET_NAME, machineType: "e2-standard-4" };

    test("is byte-identical without the flag", () => {
      assert.equal(renderStartupScript({ ...base, resumeFrom: null }), renderStartupScript(base));
      assert.ok(!renderStartupScript(base).includes("resume-from"));
    });

    test("keeps the second-boot guard for the new run id", () => {
      const script = renderStartupScript({ ...base, resumeFrom: PRIOR });
      assert.ok(script.includes(`gcloud storage ls ${BUCKET_URL}/runs/${RUN_ID}/STARTED`));
      assert.ok(!script.includes(`${PRIOR}/STARTED`));
    });

    test("refuses an unsafe id", () => {
      assert.throws(() => renderStartupScript({ ...base, resumeFrom: "x; reboot" }), /invalid resume run id/);
    });
  });

  describe("vm-run.ts", () => {
    test("downloads the prior run, then passes it to the batch", () => {
      const fixture = vmFixture();
      const params = { ...fixture.params, resumeFrom: PRIOR };
      assert.equal(runVm(params, fixture.deps), 0);
      const argvs = fixture.calls.map((call) => call.argv);
      const download = argvs.findIndex(isPriorDownload);
      const batch = argvs.findIndex(isBatch);
      assert.ok(download >= 0 && download < batch);
      const priorDir = join(params.work, "prior");
      assert.deepEqual(argvs[download], [
        "gcloud",
        "storage",
        "rsync",
        `${BUCKET_URL}/runs/${PRIOR}`,
        priorDir,
        "--recursive",
        `--project=${PROJECT}`,
      ]);
      assert.deepEqual(argvs[batch].slice(-2), ["--resume-from", priorDir]);
      assert.equal(argvs.filter(isPriorDownload).length, 1);
      assert.ok(existsSync(priorDir));
      assert.ok(!fixture.calls[download].options?.env?.ANTHROPIC_API_KEY);
    });

    test("a failed download starts no batch and still writes DONE.json and syncs", () => {
      const fixture = vmFixture((argv) => (isPriorDownload(argv) ? FAILED : undefined));
      assert.equal(runVm({ ...fixture.params, resumeFrom: PRIOR }, fixture.deps), 1);
      const argvs = fixture.calls.map((call) => call.argv);
      assert.equal(argvs.filter(isBatch).length, 0);
      const done = JSON.parse(readFileSync(join(fixture.results, DONE_FILE), "utf8"));
      assert.equal(done.batch_exit_code, null);
      assert.equal(done.gcs_copy_ok, true);
      assert.equal(done.vault_push_ok, true);
      assert.ok(argvs.some((argv) => isGcsCopy(argv) && argv.includes(`${BUCKET_URL}/runs/${RUN_ID}`)));
      assert.match(fixture.logs.join("\n"), new RegExp(`cannot download prior run ${PRIOR}`));
      assert.ok(!existsSync(fixture.keyFile), "the deploy key is removed");
    });

    test("without the flag the batch command is unchanged", () => {
      const fixture = vmFixture();
      runVm(fixture.params, fixture.deps);
      const argvs = fixture.calls.map((call) => call.argv);
      assert.ok(!argvs.find(isBatch)?.includes("--resume-from"));
      assert.equal(argvs.filter((argv) => isGcsCopy(argv) && argv[3].startsWith(`${BUCKET_URL}/runs/`)).length, 0);
    });

    const VM_RUN = join(import.meta.dirname, "..", "gcp", "vm-run.ts");
    const REQUIRED = ["--run-id", RUN_ID, "--condition", "cr-effort-claude-opus-5.5", "--bucket", "b", "--work", "w"];
    const usageRefusals: Array<[string, string[]]> = [
      ["a bad id on run", ["run", ...REQUIRED, "--seed", "1", "--vm-type", "v", "--resume-from", "../x"]],
      ["the flag on sync", ["sync", ...REQUIRED, "--resume-from", PRIOR]],
    ];

    for (const [name, args] of usageRefusals) {
      test(`the CLI refuses ${name}`, () => {
        const child = spawnSync(process.execPath, [VM_RUN, ...args], { encoding: "utf8" });
        assert.equal(child.status, 2);
        assert.match(child.stderr, /usage:/);
      });
    }
  });

  test("the READMEs document the command, the reuse rule, the cap and the fallback", () => {
    const gcp = readFileSync(join(import.meta.dirname, "..", "gcp", "README.md"), "utf8");
    const harness = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
    assert.ok(gcp.includes("launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --resume-from <prior_run_id>"));
    assert.ok(harness.includes("--resume-from runs/cr-smoke-1"));
    for (const readme of [gcp, harness]) {
      assert.match(readme, /\/rows/);
      assert.match(readme, /Reused|reused/);
      assert.match(readme, /\$20 cap spans/);
    }
  });
});

describe("--pause-after-patches and --batch-budget-usd", () => {
  const LIMITS = ["--pause-after-patches", "10", "--batch-budget-usd", "60"];

  function passing(): Responder {
    return (argv) => {
      if (has(argv, "rev-parse")) return { ...OK, stdout: `${SHORT_SHA}\n` };
      if (has(argv, "for-each-ref")) return { ...OK, stdout: "refs/remotes/origin/dev\n" };
      if (has(argv, "versions", "list")) return { ...OK, stdout: "1\n" };
      if (has(argv, "instances", "list")) return { ...OK, stdout: "[]" };
      return undefined;
    };
  }

  function startWith(args: string[]) {
    let script = "";
    const { exec, calls } = recorder((argv, options) => {
      if (has(argv, "instances", "create")) {
        const flag = argv.find((arg) => arg.startsWith("--metadata-from-file="));
        script = readFileSync(String(flag).split("startup-script=")[1], "utf8");
      }
      return passing()(argv, options);
    });
    const deps = launcherDeps(exec);
    const code = runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--yes", "--seed", "7", ...args], deps);
    const create = calls.map((call) => call.argv).find((argv) => has(argv, "instances", "create")) ?? [];
    return { code, create, script, deps };
  }

  describe("launch.ts", () => {
    test("the usage line names both flags", () => {
      const { exec } = recorder();
      const deps = launcherDeps(exec);
      runLauncher(["nonsense"], deps);
      assert.match(deps.errors.join("\n"), /\[--pause-after-patches <n>\] \[--batch-budget-usd <n>\]/);
    });

    test("--yes passes both as metadata and through the startup script", () => {
      const { code, create, script } = startWith(LIMITS);
      assert.equal(code, 0);
      assert.ok(
        create.includes(
          `--metadata=run-id=${RUN_ID},condition=cr-effort-claude-opus-5.5,seed=7,bucket=${BUCKET_NAME},machine-type=e2-standard-4,pause-after-patches=10,batch-budget-usd=60`,
        ),
      );
      assert.ok(script.includes(`--work /opt/c4 --pause-after-patches 10 --batch-budget-usd 60\n`));
    });

    test("the dry run prints the metadata", () => {
      const { exec } = recorder(() => ({ ...OK, stdout: `${SHORT_SHA}\n` }));
      const deps = launcherDeps(exec);
      assert.equal(runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", ...LIMITS], deps), 0);
      assert.ok(deps.output.join("\n").includes(",pause-after-patches=10,batch-budget-usd=60"));
    });

    test("without the flags neither metadata nor script carries them", () => {
      const { code, create, script } = startWith([]);
      assert.equal(code, 0);
      assert.ok(!create.join(" ").includes("pause-after-patches"));
      assert.ok(!create.join(" ").includes("batch-budget-usd"));
      assert.ok(!script.includes("--pause-after-patches"));
      assert.ok(!script.includes("--batch-budget-usd"));
    });

    const refusals: Array<[string, string[]]> = [
      ["a zero pause", ["start", "--condition", "cr-effort-claude-opus-5.5", "--pause-after-patches=0"]],
      ["a fractional pause", ["start", "--condition", "cr-effort-claude-opus-5.5", "--pause-after-patches=1.5"]],
      ["a negative pause", ["start", "--condition", "cr-effort-claude-opus-5.5", "--pause-after-patches=-1"]],
      ["a non-numeric pause", ["start", "--condition", "cr-effort-claude-opus-5.5", "--pause-after-patches=x;reboot"]],
      ["a zero budget", ["start", "--condition", "cr-effort-claude-opus-5.5", "--batch-budget-usd=0"]],
      ["a negative budget", ["start", "--condition", "cr-effort-claude-opus-5.5", "--batch-budget-usd=-5"]],
      ["a non-numeric budget", ["start", "--condition", "cr-effort-claude-opus-5.5", "--batch-budget-usd=abc"]],
      ["the pause on setup", ["setup", "--pause-after-patches", "10"]],
      ["the budget on status", ["status", "--batch-budget-usd", "60"]],
      ["the pause with the checks entry", ["start", "--condition", "cr-effort-claude-opus-5.5", "--entry", "harness/checks/run-all.ts", "--pause-after-patches", "10"]],
      ["the budget with the checks entry", ["start", "--condition", "cr-effort-claude-opus-5.5", "--entry", "harness/checks/run-all.ts", "--batch-budget-usd", "60"]],
    ];

    for (const [name, argv] of refusals) {
      test(`refuses ${name} and calls nothing`, () => {
        const { exec, calls } = recorder();
        const deps = launcherDeps(exec);
        assert.equal(runLauncher(argv, deps), 2);
        assert.deepEqual(calls, []);
        assert.match(deps.errors.join("\n"), /usage:/);
      });
    }
  });

  describe("startup script", () => {
    const base = { runId: RUN_ID, condition: "cr-effort-claude-opus-5.5" as const, seed: "7", bucket: BUCKET_NAME, machineType: "e2-standard-4" };

    test("is byte-identical without the flags", () => {
      assert.equal(renderStartupScript({ ...base, pauseAfterPatches: null, batchBudgetUsd: null }), renderStartupScript(base));
    });

    test("refuses unsafe values", () => {
      assert.throws(() => renderStartupScript({ ...base, pauseAfterPatches: "1; reboot" }), /invalid pause after patches/);
      assert.throws(() => renderStartupScript({ ...base, batchBudgetUsd: "1; reboot" }), /invalid batch budget/);
    });
  });

  describe("vm-run.ts", () => {
    test("passes both flags to the batch", () => {
      const fixture = vmFixture();
      assert.equal(runVm({ ...fixture.params, pauseAfterPatches: "10", batchBudgetUsd: "60" }, fixture.deps), 0);
      const batch = fixture.calls.map((call) => call.argv).find(isBatch) as string[];
      assert.deepEqual(batch.slice(-4), LIMITS);
    });

    test("without the flags the batch command carries neither", () => {
      const fixture = vmFixture();
      runVm(fixture.params, fixture.deps);
      const batch = fixture.calls.map((call) => call.argv).find(isBatch) as string[];
      assert.ok(!batch.includes("--pause-after-patches"));
      assert.ok(!batch.includes("--batch-budget-usd"));
    });

    const VM_RUN = join(import.meta.dirname, "..", "gcp", "vm-run.ts");
    const REQUIRED = ["--run-id", RUN_ID, "--condition", "cr-effort-claude-opus-5.5", "--bucket", "b", "--work", "w"];
    const usageRefusals: Array<[string, string[]]> = [
      ["a zero pause", ["run", ...REQUIRED, "--seed", "1", "--vm-type", "v", "--pause-after-patches=0"]],
      ["a bad budget", ["run", ...REQUIRED, "--seed", "1", "--vm-type", "v", "--batch-budget-usd=abc"]],
      ["the pause on sync", ["sync", ...REQUIRED, "--pause-after-patches", "10"]],
      ["the budget with the checks entry", ["run", ...REQUIRED, "--seed", "1", "--vm-type", "v", "--entry", "harness/checks/run-all.ts", "--batch-budget-usd", "60"]],
    ];

    for (const [name, args] of usageRefusals) {
      test(`the CLI refuses ${name}`, () => {
        const child = spawnSync(process.execPath, [VM_RUN, ...args], { encoding: "utf8" });
        assert.equal(child.status, 2);
        assert.match(child.stderr, /usage:/);
      });
    }
  });

  test("the harness README documents the pause, the resume and both launch flags", () => {
    const harness = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
    assert.match(harness, /### Pause after n patches/);
    assert.match(harness, /stop_reason: pause_after_patches/);
    assert.match(harness, /reused from that run do not count toward n/);
    assert.ok(harness.includes("launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --pause-after-patches 10 --batch-budget-usd 60 --yes"));
    assert.ok(harness.includes("--resume-from <prior_run_id> --pause-after-patches 10 --batch-budget-usd 60"));
  });
});

describe("--patches", () => {
  const PATCHES = "harness/checks/check-patches.json";
  const CHECKS = "harness/checks/run-all.ts";

  function startWith(args: string[], respond: Responder = () => undefined) {
    let script = "";
    const { exec, calls } = recorder((argv, options) => {
      const override = respond(argv, options);
      if (override) return override;
      if (has(argv, "instances", "create")) {
        const flag = argv.find((arg) => arg.startsWith("--metadata-from-file="));
        script = readFileSync(String(flag).split("startup-script=")[1], "utf8");
      }
      if (has(argv, "rev-parse")) return { ...OK, stdout: `${SHORT_SHA}\n` };
      if (has(argv, "for-each-ref")) return { ...OK, stdout: "refs/remotes/origin/dev\n" };
      if (has(argv, "versions", "list")) return { ...OK, stdout: "1\n" };
      if (has(argv, "instances", "list")) return { ...OK, stdout: "[]" };
      return undefined;
    });
    const deps = launcherDeps(exec);
    const code = runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--yes", "--seed", "7", ...args], deps);
    const argvs = calls.map((call) => call.argv);
    const create = argvs.find((argv) => has(argv, "instances", "create")) ?? [];
    return { code, argvs, create, script, deps };
  }

  describe("launch.ts", () => {
    for (const entry of [CHECKS, "harness/smoke/run-batch.ts"]) {
      test(`--yes with ${entry} checks the list at HEAD and passes it as metadata and through the startup script`, () => {
        const { code, argvs, create, script, deps } = startWith(["--entry", entry, "--patches", PATCHES]);
        assert.equal(code, 0);
        assert.ok(argvs.some((argv) => has(argv, "cat-file", "-e", `HEAD:${PATCHES}`)));
        const metadata = create.find((arg) => arg.startsWith("--metadata=")) ?? "";
        assert.ok(metadata.endsWith(`,patches=${PATCHES}`), metadata);
        assert.ok(script.includes(` --patches ${PATCHES}\n`));
        assert.ok(deps.output.includes(`Patches: ${PATCHES}`));
      });
    }

    test("the dry run prints the metadata and the HEAD check", () => {
      const { exec } = recorder(() => ({ ...OK, stdout: `${SHORT_SHA}\n` }));
      const deps = launcherDeps(exec);
      assert.equal(runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--entry", CHECKS, "--patches", PATCHES], deps), 0);
      const printed = deps.output.join("\n");
      assert.ok(printed.includes(`,entry=${CHECKS},patches=${PATCHES}`));
      assert.ok(printed.includes(`# --patches ${PATCHES} also refuses unless it exists at HEAD`));
      assert.ok(printed.includes(`Patches: ${PATCHES}`));
    });

    test("refuses a list missing at HEAD and uploads nothing", () => {
      const { code, argvs, deps } = startWith(["--entry", CHECKS, "--patches", PATCHES], (argv) =>
        has(argv, "cat-file", `HEAD:${PATCHES}`) ? FAILED : undefined,
      );
      assert.equal(code, 1);
      assert.match(deps.errors.join("\n"), /harness\/checks\/check-patches\.json does not exist at HEAD/);
      assert.equal(argvs.filter((argv) => has(argv, "archive") || has(argv, "cp") || has(argv, "create")).length, 0);
    });

    test("without the flag neither metadata nor script carries it", () => {
      const { code, create, script, argvs } = startWith(["--entry", CHECKS]);
      assert.equal(code, 0);
      assert.ok(!create.join(" ").includes("patches="));
      assert.ok(!script.includes("--patches"));
      assert.equal(argvs.filter((argv) => has(argv, "cat-file")).length, 1);
    });

    const refused: Array<[string, string[]]> = [
      ["a parent path", ["start", "--condition", "cr-effort-claude-opus-5.5", "--patches", "../x.json"]],
      ["a path that climbs out of checks", ["start", "--condition", "cr-effort-claude-opus-5.5", "--patches", "harness/checks/../x.json"]],
      ["an absolute path", ["start", "--condition", "cr-effort-claude-opus-5.5", "--patches", "/repo/harness/checks/check-patches.json"]],
      ["a path outside harness/checks", ["start", "--condition", "cr-effort-claude-opus-5.5", "--patches", "harness/smoke/smoke-patches.json"]],
      ["a nested path", ["start", "--condition", "cr-effort-claude-opus-5.5", "--patches", "harness/checks/sub/x.json"]],
      ["a non-JSON file", ["start", "--condition", "cr-effort-claude-opus-5.5", "--patches", "harness/checks/run-all.ts"]],
      ["a shell metacharacter", ["start", "--condition", "cr-effort-claude-opus-5.5", "--patches", "harness/checks/x;reboot.json"]],
      ["an empty path", ["start", "--condition", "cr-effort-claude-opus-5.5", "--patches", ""]],
      ["the flag on status", ["status", "--patches", PATCHES]],
      ["the flag on setup", ["setup", "--patches", PATCHES]],
    ];

    for (const [name, argv] of refused) {
      test(`refuses ${name} and calls nothing`, () => {
        const { exec, calls } = recorder();
        const deps = launcherDeps(exec);
        assert.equal(runLauncher(argv, deps), 2);
        assert.deepEqual(calls, []);
        assert.match(deps.errors.join("\n"), /\[--patches <harness\/checks\/name\.json>\]/);
      });
    }
  });

  describe("startup script", () => {
    const base = { runId: RUN_ID, condition: "cr-effort-claude-opus-5.5" as const, seed: "7", bucket: BUCKET_NAME, machineType: "e2-standard-4" };

    test("is byte-identical without the flag", () => {
      assert.equal(renderStartupScript({ ...base, patches: null }), renderStartupScript(base));
    });

    test("refuses an unsafe path", () => {
      for (const patches of ["../x.json", "/abs/x.json", "harness/checks/x.json; reboot"]) {
        assert.throws(() => renderStartupScript({ ...base, patches }), /invalid patches/);
      }
    });
  });

  describe("vm-run.ts", () => {
    test("passes the list to the entry", () => {
      const fixture = vmFixture();
      assert.equal(runVm({ ...fixture.params, entry: CHECKS, patches: PATCHES }, fixture.deps), 0);
      const run = fixture.calls.map((call) => call.argv).find((argv) => argv.includes(CHECKS)) as string[];
      assert.deepEqual(run.slice(-2), ["--patches", PATCHES]);
    });

    test("without the flag the entry command does not carry it", () => {
      const fixture = vmFixture();
      runVm(fixture.params, fixture.deps);
      const batch = fixture.calls.map((call) => call.argv).find(isBatch) as string[];
      assert.ok(!batch.includes("--patches"));
    });

    const VM_RUN = join(import.meta.dirname, "..", "gcp", "vm-run.ts");
    const REQUIRED = ["--run-id", RUN_ID, "--condition", "cr-effort-claude-opus-5.5", "--bucket", "b", "--work", "w", "--seed", "1", "--vm-type", "v"];
    for (const [name, args] of [
      ["a parent path", ["run", ...REQUIRED, "--patches", "../x.json"]],
      ["an absolute path", ["run", ...REQUIRED, "--patches", "/x/harness/checks/x.json"]],
      ["the flag on sync", ["sync", "--run-id", RUN_ID, "--condition", "cr-effort-claude-opus-5.5", "--bucket", "b", "--work", "w", "--patches", PATCHES]],
    ] as const) {
      test(`the CLI refuses ${name}`, () => {
        const child = spawnSync(process.execPath, [VM_RUN, ...args], { encoding: "utf8" });
        assert.equal(child.status, 2);
        assert.match(child.stderr, /usage:/);
      });
    }
  });
});

describe("sharded launch with per-VM zone, machine type and boot disk", () => {
  const SHARD_RUN_ID = `${RUN_ID}-s2of6`;
  const CHECKS = "harness/checks/run-all.ts";
  const SHARD_ARGS = ["--shard", "2/6", "--zone", "us-east1-b", "--machine-type", "e2-standard-2", "--boot-disk-size", "60GB"];

  function vmList(names: string[]): Responder {
    const vms = names.map((name) => ({ name, status: "RUNNING", zone: "zones/us-east1-b", labels: { purpose: "c4-smoke" } }));
    return (argv) => (has(argv, "instances", "list") ? { ...OK, stdout: JSON.stringify(vms) } : undefined);
  }

  function startWith(args: string[], respond: Responder = () => undefined) {
    let script = "";
    const { exec, calls } = recorder((argv, options) => {
      const override = respond(argv, options);
      if (override) return override;
      if (has(argv, "instances", "create")) {
        const flag = argv.find((arg) => arg.startsWith("--metadata-from-file="));
        script = readFileSync(String(flag).split("startup-script=")[1], "utf8");
      }
      if (has(argv, "rev-parse")) return { ...OK, stdout: `${SHORT_SHA}\n` };
      if (has(argv, "for-each-ref")) return { ...OK, stdout: "refs/remotes/origin/dev\n" };
      if (has(argv, "versions", "list")) return { ...OK, stdout: "1\n" };
      if (has(argv, "instances", "list")) return { ...OK, stdout: "[]" };
      return undefined;
    });
    const deps = launcherDeps(exec);
    const code = runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--yes", "--seed", "7", ...args], deps);
    const argvs = calls.map((call) => call.argv);
    const create = argvs.find((argv) => has(argv, "instances", "create")) ?? [];
    return { code, argvs, create, script, deps };
  }

  describe("launch.ts", () => {
    test("the run id carries the shard suffix and the common pattern accepts it", () => {
      assert.ok(RUN_ID_PATTERN.test(SHARD_RUN_ID));
      assert.ok(RUN_ID_PATTERN.test(RUN_ID));
      for (const bad of [`${RUN_ID}-s2of`, `${RUN_ID}-sxof6`, `${RUN_ID}-s2of6-s1of2`, `${RUN_ID}-s2of6;reboot`]) {
        assert.ok(!RUN_ID_PATTERN.test(bad), bad);
      }
    });

    test("--yes puts every value on the VM, the metadata and the startup script", () => {
      const { code, argvs, create, script, deps } = startWith(SHARD_ARGS);
      assert.equal(code, 0, deps.errors.join("\n"));
      assert.ok(argvs.some((argv) => has(argv, "storage", "cp", `${BUCKET_URL}/code/${SHARD_RUN_ID}.tar.gz`)));
      for (const flag of [
        `${VM_PREFIX}${SHARD_RUN_ID}`,
        "--zone=us-east1-b",
        "--machine-type=e2-standard-2",
        "--boot-disk-size=60GB",
        `--metadata=run-id=${SHARD_RUN_ID},condition=cr-effort-claude-opus-5.5,seed=7,bucket=${BUCKET_NAME},machine-type=e2-standard-2,shard=2/6`,
      ]) {
        assert.ok(create.includes(flag), flag);
      }
      assert.ok(script.includes(`--run-id ${SHARD_RUN_ID} `));
      assert.ok(script.includes(" --vm-type e2-standard-2 "));
      assert.ok(script.endsWith(" --shard 2/6\n"));
      const printed = deps.output.join("\n");
      for (const expected of ["Machine type: e2-standard-2", "Zone: us-east1-b", "Boot disk: 60GB", "Shard: 2/6", `Run ID: ${SHARD_RUN_ID}`]) {
        assert.ok(printed.includes(expected), expected);
      }
    });

    test("the defaults stay us-central1-a, e2-standard-4 and 100GB, or 200GB for the checks entry", () => {
      const batch = startWith([]);
      for (const flag of ["--zone=us-central1-a", "--machine-type=e2-standard-4", "--boot-disk-size=100GB"]) {
        assert.ok(batch.create.includes(flag), flag);
      }
      assert.ok(batch.create.includes(`${VM_PREFIX}${RUN_ID}`));
      assert.ok(!batch.create.join(" ").includes("shard="));
      assert.ok(!batch.script.includes("--shard"));
      assert.ok(batch.script.includes(" --vm-type e2-standard-4 "));
      assert.ok(startWith(["--entry", CHECKS]).create.includes("--boot-disk-size=200GB"));
      assert.ok(startWith(["--entry", CHECKS, "--boot-disk-size", "300GB"]).create.includes("--boot-disk-size=300GB"));
    });

    test("the dry run prints the suffixed VM, the values and the sharded refusal rule", () => {
      const { exec } = recorder(() => ({ ...OK, stdout: `${SHORT_SHA}\n` }));
      const deps = launcherDeps(exec);
      assert.equal(runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", ...SHARD_ARGS], deps), 0);
      const printed = deps.output.join("\n");
      assert.ok(printed.includes(`${VM_PREFIX}${SHARD_RUN_ID} --zone=us-east1-b --machine-type=e2-standard-2`));
      assert.ok(printed.includes(",machine-type=e2-standard-2,shard=2/6"));
      assert.ok(printed.includes("belongs to a sharded run"));
    });

    const refused: Array<[string, string[]]> = [
      ["k equal to n", ["start", "--condition", "cr-effort-claude-opus-5.5", "--shard", "6/6"]],
      ["n of 1", ["start", "--condition", "cr-effort-claude-opus-5.5", "--shard", "0/1"]],
      ["a negative k", ["start", "--condition", "cr-effort-claude-opus-5.5", "--shard=-1/6"]],
      ["a malformed shard", ["start", "--condition", "cr-effort-claude-opus-5.5", "--shard", "2of6"]],
      ["a shell metacharacter in the shard", ["start", "--condition", "cr-effort-claude-opus-5.5", "--shard", "2/6;reboot"]],
      ["the shard with the checks entry", ["start", "--condition", "cr-effort-claude-opus-5.5", "--entry", CHECKS, "--shard", "0/2"]],
      ["the shard on status", ["status", "--shard", "0/2"]],
      ["a region instead of a zone", ["start", "--condition", "cr-effort-claude-opus-5.5", "--zone", "us-east1"]],
      ["a zone with a shell metacharacter", ["start", "--condition", "cr-effort-claude-opus-5.5", "--zone", "us-east1-b;reboot"]],
      ["an upper-case zone", ["start", "--condition", "cr-effort-claude-opus-5.5", "--zone", "US-EAST1-B"]],
      ["the zone on cleanup", ["cleanup", "--zone", "us-east1-b"]],
      ["an n2 machine type", ["start", "--condition", "cr-effort-claude-opus-5.5", "--machine-type", "n2-standard-4"]],
      ["an e2 machine type without a size", ["start", "--condition", "cr-effort-claude-opus-5.5", "--machine-type", "e2-standard-"]],
      ["a machine type with a shell metacharacter", ["start", "--condition", "cr-effort-claude-opus-5.5", "--machine-type", "e2-standard-2;reboot"]],
      ["the machine type on setup", ["setup", "--machine-type", "e2-standard-2"]],
      ["a boot disk below 50GB", ["start", "--condition", "cr-effort-claude-opus-5.5", "--boot-disk-size", "49GB"]],
      ["a boot disk above 500GB", ["start", "--condition", "cr-effort-claude-opus-5.5", "--boot-disk-size", "501GB"]],
      ["a boot disk without a unit", ["start", "--condition", "cr-effort-claude-opus-5.5", "--boot-disk-size", "100"]],
      ["a boot disk in TB", ["start", "--condition", "cr-effort-claude-opus-5.5", "--boot-disk-size", "1TB"]],
      ["the boot disk on status", ["status", "--boot-disk-size", "100GB"]],
    ];

    for (const [name, argv] of refused) {
      test(`refuses ${name} with the usage error and calls nothing`, () => {
        const { exec, calls } = recorder();
        const deps = launcherDeps(exec);
        assert.equal(runLauncher(argv, deps), 2);
        assert.deepEqual(calls, []);
        assert.match(deps.errors.join("\n"), /\[--shard <k>\/<n>\] \[--zone <zone>\] \[--machine-type <e2-standard-n>\] \[--boot-disk-size <nGB>\]/);
      });
    }

    test("accepts the edges of the boot disk range", () => {
      assert.ok(startWith(["--boot-disk-size", "50GB"]).create.includes("--boot-disk-size=50GB"));
      assert.ok(startWith(["--boot-disk-size", "500GB"]).create.includes("--boot-disk-size=500GB"));
    });
  });

  describe("concurrency refusal", () => {
    const allowed: Array<[string, string[]]> = [
      ["no VM", []],
      ["other sharded VMs", [`${VM_PREFIX}${RUN_ID}-s0of6`, `${VM_PREFIX}20261031t200000z-${SHORT_SHA}-s1of6`]],
      ["a sharded VM with the old prefix", [`c4-smoke-${RUN_ID}-s3of6`]],
    ];

    for (const [name, vms] of allowed) {
      test(`a sharded start goes ahead alongside ${name}`, () => {
        const { code, create, deps } = startWith(SHARD_ARGS, vmList(vms));
        assert.equal(code, 0, deps.errors.join("\n"));
        assert.ok(create.includes(`${VM_PREFIX}${SHARD_RUN_ID}`));
      });
    }

    const blocked: Array<[string, string[]]> = [
      ["a VM with its own name", [`${VM_PREFIX}${SHARD_RUN_ID}`]],
      ["an unsharded VM", [`${VM_PREFIX}${RUN_ID}`]],
      ["an unsharded VM with the old prefix", [`c4-smoke-${RUN_ID}`]],
      ["an unsharded VM among sharded ones", [`${VM_PREFIX}${RUN_ID}-s0of6`, `${VM_PREFIX}20261031t200000z-${SHORT_SHA}`]],
    ];

    for (const [name, vms] of blocked) {
      test(`a sharded start refuses ${name} and uploads nothing`, () => {
        const { code, argvs, deps } = startWith(SHARD_ARGS, vmList(vms));
        assert.equal(code, 1);
        assert.match(deps.errors.join("\n"), /already exists/);
        assert.equal(argvs.filter((argv) => has(argv, "archive") || has(argv, "cp") || has(argv, "create")).length, 0);
      });
    }

    for (const vms of [[`${VM_PREFIX}${RUN_ID}-s0of6`], [`${VM_PREFIX}${RUN_ID}`]]) {
      test(`an unsharded start still refuses ${vms[0]}`, () => {
        const { code, argvs, deps } = startWith([], vmList(vms));
        assert.equal(code, 1);
        assert.match(deps.errors.join("\n"), /already exists/);
        assert.equal(argvs.filter((argv) => has(argv, "archive") || has(argv, "cp") || has(argv, "create")).length, 0);
      });
    }
  });

  describe("startup script", () => {
    const base = { runId: SHARD_RUN_ID, condition: "cr-effort-claude-opus-5.5" as const, seed: "7", bucket: BUCKET_NAME, machineType: "e2-standard-2" };

    test("passes the shard to vm-run.ts and is byte-identical without it", () => {
      assert.ok(renderStartupScript({ ...base, shard: "2/6" }).endsWith(" --shard 2/6\n"));
      assert.equal(renderStartupScript({ ...base, shard: null }), renderStartupScript(base));
    });

    test("refuses an unsafe shard", () => {
      for (const shard of ["6/6", "2/6; reboot", "x"]) {
        assert.throws(() => renderStartupScript({ ...base, shard }), /invalid shard/);
      }
    });
  });

  describe("vm-run.ts", () => {
    test("passes the shard to run-batch", () => {
      const fixture = vmFixture();
      assert.equal(runVm({ ...fixture.params, runId: SHARD_RUN_ID, vmType: "e2-standard-2", shard: "2/6" }, fixture.deps), 0);
      const batch = fixture.calls.map((call) => call.argv).find(isBatch) as string[];
      assert.deepEqual(batch.slice(-2), ["--shard", "2/6"]);
      assert.ok(has(batch, "--run-id", SHARD_RUN_ID, "--vm-type", "e2-standard-2"));
    });

    test("without the shard the batch command does not carry it", () => {
      const fixture = vmFixture();
      runVm(fixture.params, fixture.deps);
      const batch = fixture.calls.map((call) => call.argv).find(isBatch) as string[];
      assert.ok(!batch.includes("--shard"));
    });

    const VM_RUN = join(import.meta.dirname, "..", "gcp", "vm-run.ts");
    const REQUIRED = ["--run-id", SHARD_RUN_ID, "--condition", "cr-effort-claude-opus-5.5", "--bucket", "b", "--work", "w", "--seed", "1", "--vm-type", "v"];
    for (const [name, args] of [
      ["a malformed shard", ["run", ...REQUIRED, "--shard", "6/6"]],
      ["the shard with the checks entry", ["run", ...REQUIRED, "--entry", CHECKS, "--shard", "0/2"]],
      ["the shard on sync", ["sync", "--run-id", SHARD_RUN_ID, "--condition", "cr-effort-claude-opus-5.5", "--bucket", "b", "--work", "w", "--shard", "0/2"]],
    ] as const) {
      test(`the CLI refuses ${name}`, () => {
        const child = spawnSync(process.execPath, [VM_RUN, ...args], { encoding: "utf8" });
        assert.equal(child.status, 2);
        assert.match(child.stderr, /usage:/);
      });
    }
  });

  test("the README documents a sharded launch and the quota", () => {
    const readme = readFileSync(join(import.meta.dirname, "..", "gcp", "README.md"), "utf8");
    assert.match(readme, /## Shard the batch across VMs/);
    assert.ok(readme.includes("--shard 0/6 --resume-from <prior_run_id>"));
    assert.ok(readme.includes("--shard 5/6 --resume-from <prior_run_id>"));
    assert.match(readme, /12 vCPUs across all regions/);
    assert.match(readme, /250 GB of SSD/);
    assert.match(readme, /4 in-use external IP addresses/);
  });
});

describe("repeat launch", () => {
  const REPEAT_RUN_ID = `${RUN_ID}-r2`;
  const CHECKS = "harness/checks/run-all.ts";
  const VM_RUN = join(import.meta.dirname, "..", "gcp", "vm-run.ts");

  function dryRun(args: string[]) {
    const { exec, calls } = recorder(() => ({ ...OK, stdout: `${SHORT_SHA}\n` }));
    const deps = launcherDeps(exec);
    const code = runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--seed", "7", ...args], deps);
    return { code, calls, deps, printed: deps.output.join("\n") };
  }

  test("the common pattern accepts the repeat suffix before any shard suffix", () => {
    for (const good of [REPEAT_RUN_ID, `${RUN_ID}-r99`, `${RUN_ID}-r2-s1of3`]) {
      assert.ok(RUN_ID_PATTERN.test(good), good);
    }
    for (const bad of [`${RUN_ID}-r1`, `${RUN_ID}-r0`, `${RUN_ID}-r100`, `${RUN_ID}-r02`, `${RUN_ID}-s1of3-r2`, `${RUN_ID}-r2;reboot`]) {
      assert.ok(!RUN_ID_PATTERN.test(bad), bad);
    }
  });

  test("the dry run prints the repeat metadata and a run ID ending -r2", () => {
    const { code, printed } = dryRun(["--repeat", "2"]);
    assert.equal(code, 0);
    assert.ok(printed.includes(`--metadata=run-id=${REPEAT_RUN_ID},condition=cr-effort-claude-opus-5.5,seed=7,bucket=${BUCKET_NAME},machine-type=e2-standard-4,repeat=2`));
    assert.ok(printed.includes(`Run ID: ${REPEAT_RUN_ID}\n`));
    assert.ok(printed.includes(`VM: ${VM_PREFIX}${REPEAT_RUN_ID}\n`));
    assert.ok(printed.includes(`${BUCKET_URL}/runs/${REPEAT_RUN_ID}/`));
    assert.ok(printed.includes(`branch c4-c-smoke/${REPEAT_RUN_ID},`));
    assert.ok(printed.includes("Repeat: 2"));
  });

  test("with a shard the run ID ends -r2-s<k>of<n> and the metadata carries both", () => {
    const { code, printed } = dryRun(["--repeat", "2", "--shard", "1/3"]);
    assert.equal(code, 0);
    assert.ok(printed.includes(`Run ID: ${RUN_ID}-r2-s1of3`));
    assert.ok(printed.includes(",repeat=2,shard=1/3"));
  });

  test("without --repeat nothing changes", () => {
    const { printed } = dryRun([]);
    assert.ok(printed.includes(`Run ID: ${RUN_ID}\n`));
    assert.ok(!printed.includes("repeat"));
    assert.ok(!printed.includes("Repeat"));
  });

  test("--yes puts the repeat on the metadata and the startup script", () => {
    let script = "";
    const { exec, calls } = recorder((argv) => {
      if (has(argv, "instances", "create")) {
        const flag = argv.find((arg) => arg.startsWith("--metadata-from-file="));
        script = readFileSync(String(flag).split("startup-script=")[1], "utf8");
      }
      if (has(argv, "rev-parse")) return { ...OK, stdout: `${SHORT_SHA}\n` };
      if (has(argv, "for-each-ref")) return { ...OK, stdout: "refs/remotes/origin/dev\n" };
      if (has(argv, "versions", "list")) return { ...OK, stdout: "1\n" };
      if (has(argv, "instances", "list")) return { ...OK, stdout: "[]" };
      return undefined;
    });
    const deps = launcherDeps(exec);
    assert.equal(runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--yes", "--seed", "7", "--repeat", "2"], deps), 0, deps.errors.join("\n"));
    const create = calls.map((call) => call.argv).find((argv) => has(argv, "instances", "create")) as string[];
    assert.ok(create.includes(`${VM_PREFIX}${REPEAT_RUN_ID}`));
    assert.ok(create.some((arg) => arg.startsWith("--metadata=") && arg.endsWith(",repeat=2")));
    assert.ok(script.includes(`--run-id ${REPEAT_RUN_ID} `));
    assert.ok(script.endsWith(" --repeat 2\n"));
  });

  const refused: Array<[string, string[]]> = [
    ["a repeat of 1", ["start", "--condition", "cr-effort-claude-opus-5.5", "--repeat", "1"]],
    ["a repeat of 0", ["start", "--condition", "cr-effort-claude-opus-5.5", "--repeat", "0"]],
    ["a repeat of 100", ["start", "--condition", "cr-effort-claude-opus-5.5", "--repeat", "100"]],
    ["a non-numeric repeat", ["start", "--condition", "cr-effort-claude-opus-5.5", "--repeat", "x"]],
    ["a shell metacharacter in the repeat", ["start", "--condition", "cr-effort-claude-opus-5.5", "--repeat", "2;reboot"]],
    ["the repeat with the checks entry", ["start", "--condition", "cr-effort-claude-opus-5.5", "--entry", CHECKS, "--repeat", "2"]],
    ["the repeat on status", ["status", "--repeat", "2"]],
  ];
  for (const [name, argv] of refused) {
    test(`launch.ts refuses ${name} with the usage error and calls nothing`, () => {
      const { exec, calls } = recorder();
      const deps = launcherDeps(exec);
      assert.equal(runLauncher(argv, deps), 2);
      assert.deepEqual(calls, []);
      assert.match(deps.errors.join("\n"), /\[--repeat <n>\] \[--shard <k>\/<n>\]/);
    });
  }

  test("the startup script forwards the repeat before the shard and is byte-identical without it", () => {
    const base = { runId: REPEAT_RUN_ID, condition: "cr-effort-claude-opus-5.5" as const, seed: "7", bucket: BUCKET_NAME, machineType: "e2-standard-4" };
    assert.ok(renderStartupScript({ ...base, repeat: "2" }).endsWith(" --repeat 2\n"));
    assert.ok(renderStartupScript({ ...base, runId: `${REPEAT_RUN_ID}-s0of2`, repeat: "2", shard: "0/2" }).endsWith(" --repeat 2 --shard 0/2\n"));
    assert.equal(renderStartupScript({ ...base, repeat: null }), renderStartupScript(base));
    for (const repeat of ["1", "100", "x", "2; reboot"]) {
      assert.throws(() => renderStartupScript({ ...base, repeat }), /invalid repeat/);
    }
  });

  test("vm-run.ts forwards the repeat to run-batch", () => {
    const fixture = vmFixture();
    assert.equal(runVm({ ...fixture.params, runId: REPEAT_RUN_ID, repeat: "2" }, fixture.deps), 0);
    const batch = fixture.calls.map((call) => call.argv).find(isBatch) as string[];
    assert.deepEqual(batch.slice(-2), ["--repeat", "2"]);
    assert.ok(has(batch, "--run-id", REPEAT_RUN_ID));
  });

  test("vm-run.ts without the repeat does not carry it", () => {
    const fixture = vmFixture();
    runVm(fixture.params, fixture.deps);
    const batch = fixture.calls.map((call) => call.argv).find(isBatch) as string[];
    assert.ok(!batch.includes("--repeat"));
  });

  const REQUIRED = ["--run-id", REPEAT_RUN_ID, "--condition", "cr-effort-claude-opus-5.5", "--bucket", "b", "--work", "w", "--seed", "1", "--vm-type", "v"];
  for (const [name, args] of [
    ["a repeat of 1", ["run", ...REQUIRED, "--repeat", "1"]],
    ["a non-numeric repeat", ["run", ...REQUIRED, "--repeat", "x"]],
    ["the repeat with the checks entry", ["run", ...REQUIRED, "--entry", CHECKS, "--repeat", "2"]],
    ["the repeat on sync", ["sync", "--run-id", REPEAT_RUN_ID, "--condition", "cr-effort-claude-opus-5.5", "--bucket", "b", "--work", "w", "--repeat", "2"]],
  ] as const) {
    test(`the vm-run.ts CLI refuses ${name}`, () => {
      const child = spawnSync(process.execPath, [VM_RUN, ...args], { encoding: "utf8" });
      assert.equal(child.status, 2);
      assert.match(child.stderr, /usage:.*\[--repeat <n>\]/);
    });
  }
});

describe("arms launch", () => {
  const ARMS = "c,e1,e2b,e2g";
  const ARMS_RUN_ID = `${RUN_ID}-arms-c-e1-e2b-e2g`;
  const CHECKS = "harness/checks/run-all.ts";
  const VM_RUN = join(import.meta.dirname, "..", "gcp", "vm-run.ts");

  function dryRun(args: string[]) {
    const { exec, calls } = recorder(() => ({ ...OK, stdout: `${SHORT_SHA}\n` }));
    const deps = launcherDeps(exec);
    const code = runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--seed", "7", ...args], deps);
    return { code, calls, deps, printed: deps.output.join("\n") };
  }

  test("the common pattern accepts the arms suffix before any shard suffix", () => {
    for (const good of [ARMS_RUN_ID, `${RUN_ID}-arms-e1`, `${RUN_ID}-arms-c-e2g-s1of3`]) {
      assert.ok(RUN_ID_PATTERN.test(good), good);
    }
    for (const bad of [`${RUN_ID}-arms`, `${RUN_ID}-arms-e3`, `${RUN_ID}-r2-arms-c`, `${RUN_ID}-s1of3-arms-c`, `${RUN_ID}-arms-c;reboot`]) {
      assert.ok(!RUN_ID_PATTERN.test(bad), bad);
    }
  });

  test("the dry run prints the arms metadata with gcloud's alternate delimiter and a run ID ending in the arms", () => {
    const { code, printed } = dryRun(["--arms", ARMS]);
    assert.equal(code, 0);
    assert.ok(printed.includes(`'--metadata=^;^run-id=${ARMS_RUN_ID};condition=cr-effort-claude-opus-5.5;seed=7;bucket=${BUCKET_NAME};machine-type=e2-standard-4;arms=${ARMS}'`), printed);
    assert.ok(printed.includes(`Run ID: ${ARMS_RUN_ID}\n`));
    assert.ok(printed.includes(`VM: ${VM_PREFIX}${ARMS_RUN_ID}\n`));
    assert.ok(printed.includes(`Arms: ${ARMS}\n`));
    assert.ok(`${VM_PREFIX}${ARMS_RUN_ID}-s99of99`.length <= 63);
  });

  test("the common pattern accepts arms a and b, alone and with model cells, before any shard suffix", () => {
    for (const good of [
      `${RUN_ID}-arms-a`,
      `${RUN_ID}-arms-b`,
      `${RUN_ID}-arms-c-e1-e2b-e2g-a-b`,
      `${RUN_ID}-arms-b-models-opusm`,
      `${RUN_ID}-arms-b-models-haikuh`,
      `${RUN_ID}-arms-b-models-opusm-s0of2`,
      `${RUN_ID}-arms-b-models-haikuh-s1of2`,
    ]) {
      assert.ok(RUN_ID_PATTERN.test(good), good);
    }
    for (const bad of [`${RUN_ID}-arms-d`, `${RUN_ID}-arms-b-models-haikux`, `${RUN_ID}-s1of2-arms-b`, `${RUN_ID}-arms-b;reboot`]) {
      assert.ok(!RUN_ID_PATTERN.test(bad), bad);
    }
  });

  test("the launcher's arm parsing accepts the read-only arm a", () => {
    assert.equal(canonicalArms("a"), "a");
    assert.equal(canonicalArms("a,c"), "c,a");
    assert.equal(canonicalArms("a,a"), null);
  });

  test("the common pattern accepts the read-only arm a in the arms suffix", () => {
    const allArms = `${RUN_ID}-arms-c-e1-e2b-e2g-a`;
    for (const good of [`${RUN_ID}-arms-a`, `${RUN_ID}-arms-c-a`, `${RUN_ID}-arms-a-s0of3`, allArms]) {
      assert.ok(RUN_ID_PATTERN.test(good), good);
    }
    assert.ok(!RUN_ID_PATTERN.test(`${allArms}-b-a`));
    assert.ok(`${VM_PREFIX}${allArms}-s99of99`.length <= 63);
  });

  test("the arm list is canonicalized, and one arm keeps the comma delimiter", () => {
    assert.ok(dryRun(["--arms", "e2g,c,e1,e2b"]).printed.includes(`Run ID: ${ARMS_RUN_ID}\n`));
    const single = dryRun(["--arms", "e1"]).printed;
    assert.ok(single.includes(`--metadata=run-id=${RUN_ID}-arms-e1,condition=cr-effort-claude-opus-5.5,seed=7,bucket=${BUCKET_NAME},machine-type=e2-standard-4,arms=e1`));
  });

  test("with a shard the run ID ends -arms-...-s<k>of<n> and the metadata carries both", () => {
    const { code, printed } = dryRun(["--arms", ARMS, "--shard", "1/3"]);
    assert.equal(code, 0);
    assert.ok(printed.includes(`Run ID: ${ARMS_RUN_ID}-s1of3`));
    assert.ok(printed.includes(`;arms=${ARMS};shard=1/3`));
  });

  test("without --arms nothing changes", () => {
    const { printed } = dryRun([]);
    assert.ok(!printed.includes("arms"));
    assert.ok(!printed.includes("Arms"));
    assert.ok(!printed.includes("^;^"));
  });

  test("--yes puts the arms on the metadata and the startup script", () => {
    let script = "";
    const { exec, calls } = recorder((argv) => {
      if (has(argv, "instances", "create")) {
        const flag = argv.find((arg) => arg.startsWith("--metadata-from-file="));
        script = readFileSync(String(flag).split("startup-script=")[1], "utf8");
      }
      if (has(argv, "rev-parse")) return { ...OK, stdout: `${SHORT_SHA}\n` };
      if (has(argv, "for-each-ref")) return { ...OK, stdout: "refs/remotes/origin/dev\n" };
      if (has(argv, "versions", "list")) return { ...OK, stdout: "1\n" };
      if (has(argv, "instances", "list")) return { ...OK, stdout: "[]" };
      return undefined;
    });
    const deps = launcherDeps(exec);
    assert.equal(runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--yes", "--seed", "7", "--arms", ARMS], deps), 0, deps.errors.join("\n"));
    const create = calls.map((call) => call.argv).find((argv) => has(argv, "instances", "create")) as string[];
    assert.ok(create.includes(`${VM_PREFIX}${ARMS_RUN_ID}`));
    assert.ok(create.includes(`--metadata=^;^run-id=${ARMS_RUN_ID};condition=cr-effort-claude-opus-5.5;seed=7;bucket=${BUCKET_NAME};machine-type=e2-standard-4;arms=${ARMS}`));
    assert.ok(script.includes(`--run-id ${ARMS_RUN_ID} `));
    assert.ok(script.endsWith(` --arms ${ARMS}\n`));
  });

  const refused: Array<[string, string[]]> = [
    ["a duplicated arm", ["start", "--condition", "cr-effort-claude-opus-5.5", "--arms", "c,c"]],
    ["an unknown arm", ["start", "--condition", "cr-effort-claude-opus-5.5", "--arms", "c,e3"]],
    ["an empty arm list", ["start", "--condition", "cr-effort-claude-opus-5.5", "--arms", ""]],
    ["a shell metacharacter in the arms", ["start", "--condition", "cr-effort-claude-opus-5.5", "--arms", "c;reboot"]],
    ["the arms with --repeat", ["start", "--condition", "cr-effort-claude-opus-5.5", "--arms", ARMS, "--repeat", "2"]],
    ["the arms with the checks entry", ["start", "--condition", "cr-effort-claude-opus-5.5", "--entry", CHECKS, "--arms", ARMS]],
    ["the arms on status", ["status", "--arms", ARMS]],
  ];
  for (const [name, argv] of refused) {
    test(`launch.ts refuses ${name} with the usage error and calls nothing`, () => {
      const { exec, calls } = recorder();
      const deps = launcherDeps(exec);
      assert.equal(runLauncher(argv, deps), 2);
      assert.deepEqual(calls, []);
      assert.match(deps.errors.join("\n"), /\[--arms <c,e1,e2b,e2g,a,b,skill,tmbcr>\] \[--repeat <n>\]/);
    });
  }

  test("the startup script forwards the arms before the shard and is byte-identical without them", () => {
    const base = { runId: ARMS_RUN_ID, condition: "cr-effort-claude-opus-5.5" as const, seed: "7", bucket: BUCKET_NAME, machineType: "e2-standard-4" };
    assert.ok(renderStartupScript({ ...base, arms: ARMS }).endsWith(` --arms ${ARMS}\n`));
    assert.ok(
      renderStartupScript({ ...base, runId: `${ARMS_RUN_ID}-s0of2`, arms: ARMS, shard: "0/2" }).endsWith(` --arms ${ARMS} --shard 0/2\n`),
    );
    assert.equal(renderStartupScript({ ...base, arms: null }), renderStartupScript(base));
    for (const arms of ["c,c", "e3", "c; reboot", "c,e1 --repeat 2"]) {
      assert.throws(() => renderStartupScript({ ...base, arms }), /invalid arms/);
    }
    assert.throws(() => renderStartupScript({ ...base, arms: ARMS, repeat: "2" }), /invalid arms/);
  });

  test("vm-run.ts forwards the arms to run-batch", () => {
    const fixture = vmFixture();
    assert.equal(runVm({ ...fixture.params, runId: ARMS_RUN_ID, arms: ARMS }, fixture.deps), 0);
    const batch = fixture.calls.map((call) => call.argv).find(isBatch) as string[];
    assert.deepEqual(batch.slice(-2), ["--arms", ARMS]);
    assert.ok(has(batch, "--run-id", ARMS_RUN_ID));
  });

  test("vm-run.ts without the arms does not carry them", () => {
    const fixture = vmFixture();
    runVm(fixture.params, fixture.deps);
    const batch = fixture.calls.map((call) => call.argv).find(isBatch) as string[];
    assert.ok(!batch.includes("--arms"));
  });

  const REQUIRED = ["--run-id", ARMS_RUN_ID, "--condition", "cr-effort-claude-opus-5.5", "--bucket", "b", "--work", "w", "--seed", "1", "--vm-type", "v"];
  for (const [name, args] of [
    ["a duplicated arm", ["run", ...REQUIRED, "--arms", "c,c"]],
    ["an unknown arm", ["run", ...REQUIRED, "--arms", "e3"]],
    ["the arms with --repeat", ["run", ...REQUIRED, "--arms", ARMS, "--repeat", "2"]],
    ["the arms with the checks entry", ["run", ...REQUIRED, "--entry", CHECKS, "--arms", ARMS]],
    ["the arms on sync", ["sync", "--run-id", ARMS_RUN_ID, "--condition", "cr-effort-claude-opus-5.5", "--bucket", "b", "--work", "w", "--arms", ARMS]],
  ] as const) {
    test(`the vm-run.ts CLI refuses ${name}`, () => {
      const child = spawnSync(process.execPath, [VM_RUN, ...args], { encoding: "utf8" });
      assert.equal(child.status, 2);
      assert.match(child.stderr, /usage:.*\[--arms <c,e1,e2b,e2g,a,b,skill,tmbcr>\]/);
    });
  }
});

describe("models launch", () => {
  const MODELS = "claude-sonnet-5-5,claude-haiku-5-5";
  const MODELS_RUN_ID = `${RUN_ID}-models-sonnet-haiku`;
  const ALL_MODELS = "claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5";
  const CHECKS = "harness/checks/run-all.ts";
  const VM_RUN = join(import.meta.dirname, "..", "gcp", "vm-run.ts");

  function dryRun(args: string[]) {
    const { exec, calls } = recorder(() => ({ ...OK, stdout: `${SHORT_SHA}\n` }));
    const deps = launcherDeps(exec);
    const code = runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--seed", "7", ...args], deps);
    return { code, calls, deps, printed: deps.output.join("\n") };
  }

  function startYes(args: string[], sha = SHORT_SHA) {
    let script = "";
    const { exec, calls } = recorder((argv) => {
      if (has(argv, "instances", "create")) {
        const flag = argv.find((arg) => arg.startsWith("--metadata-from-file="));
        script = readFileSync(String(flag).split("startup-script=")[1], "utf8");
      }
      if (has(argv, "rev-parse")) return { ...OK, stdout: `${sha}\n` };
      if (has(argv, "for-each-ref")) return { ...OK, stdout: "refs/remotes/origin/dev\n" };
      if (has(argv, "versions", "list")) return { ...OK, stdout: "1\n" };
      if (has(argv, "instances", "list")) return { ...OK, stdout: "[]" };
      return undefined;
    });
    const deps = launcherDeps(exec);
    const code = runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--yes", "--seed", "7", ...args], deps);
    return { code, calls, deps, script: () => script };
  }

  test("the common pattern accepts the models suffix with and without a shard suffix", () => {
    for (const good of [
      MODELS_RUN_ID,
      `${MODELS_RUN_ID}-s1of3`,
      `${RUN_ID}-models-opus`,
      `${RUN_ID}-models-opus-sonnet-haiku`,
      `${RUN_ID}-models-haiku-s0of2`,
      `${RUN_ID}-models-opusm-haikuh`,
      `${RUN_ID}-models-sonnetl-s1of2`,
      `${RUN_ID}-arms-c-models-opus`,
      `${RUN_ID}-arms-c-e1-models-opusm-haikuh-s0of2`,
    ]) {
      assert.ok(RUN_ID_PATTERN.test(good), good);
    }
    for (const bad of [
      `${RUN_ID}-models`,
      `${RUN_ID}-models-gpt`,
      `${RUN_ID}-models-claude-opus-5-5`,
      `${RUN_ID}-models-opus-sonnet-haiku-opus`,
      `${RUN_ID}-models-opus:high`,
      `${RUN_ID}-models-opusx`,
      `${RUN_ID}-models-opus-m`,
      `${RUN_ID}-models-opus-arms-c`,
      `${RUN_ID}-r2-arms-c-models-opus`,
      `${RUN_ID}-r2-models-opus`,
      `${RUN_ID}-s1of3-models-opus`,
      `${RUN_ID}-models-opus;reboot`,
    ]) {
      assert.ok(!RUN_ID_PATTERN.test(bad), bad);
    }
  });

  test("the common pattern still accepts every shape it accepted before", () => {
    for (const good of [RUN_ID, `${RUN_ID}-r2`, `${RUN_ID}-r10-s1of3`, `${RUN_ID}-arms-c-e1-e2b-e2g`, `${RUN_ID}-arms-e1-s0of2`, `${RUN_ID}-s2of3`]) {
      assert.ok(RUN_ID_PATTERN.test(good), good);
    }
  });

  test("the dry run prints the models metadata with gcloud's alternate delimiter and a run ID ending in the short models", () => {
    const { code, printed } = dryRun(["--models", MODELS]);
    assert.equal(code, 0);
    assert.ok(printed.includes(`'--metadata=^;^run-id=${MODELS_RUN_ID};condition=cr-effort-claude-opus-5.5;seed=7;bucket=${BUCKET_NAME};machine-type=e2-standard-4;models=${MODELS}'`), printed);
    assert.ok(printed.includes(`Run ID: ${MODELS_RUN_ID}\n`));
    assert.ok(printed.includes(`VM: ${VM_PREFIX}${MODELS_RUN_ID}\n`));
    assert.ok(printed.includes(`Models: ${MODELS}\n`));
    assert.ok(`${VM_PREFIX}${MODELS_RUN_ID}-s99of99`.length <= 63);
  });

  test("the model list is canonicalized, and one model keeps the comma delimiter", () => {
    assert.ok(dryRun(["--models", "claude-haiku-5-5,claude-sonnet-5-5"]).printed.includes(`Run ID: ${MODELS_RUN_ID}\n`));
    assert.ok(dryRun(["--models", "claude-haiku-5-5,claude-sonnet-5-5"]).printed.includes(`;models=${MODELS}'`));
    const single = dryRun(["--models", "claude-haiku-5-5"]).printed;
    assert.ok(single.includes(`--metadata=run-id=${RUN_ID}-models-haiku,condition=cr-effort-claude-opus-5.5,seed=7,bucket=${BUCKET_NAME},machine-type=e2-standard-4,models=claude-haiku-5-5`));
  });

  test("with a shard the run ID ends -models-...-s<k>of<n> and the metadata carries both", () => {
    const { code, printed } = dryRun(["--models", MODELS, "--shard", "1/3"]);
    assert.equal(code, 0);
    assert.ok(printed.includes(`Run ID: ${MODELS_RUN_ID}-s1of3`));
    assert.ok(printed.includes(`;models=${MODELS};shard=1/3`));
  });

  test("without --models nothing changes", () => {
    const { printed } = dryRun([]);
    assert.ok(!printed.includes("models"));
    assert.ok(!printed.includes("Models"));
    assert.ok(!printed.includes("^;^"));
  });

  test("--yes puts the models on the metadata and the startup script", () => {
    const { code, calls, deps, script } = startYes(["--models", MODELS]);
    assert.equal(code, 0, deps.errors.join("\n"));
    const create = calls.map((call) => call.argv).find((argv) => has(argv, "instances", "create")) as string[];
    assert.ok(create.includes(`${VM_PREFIX}${MODELS_RUN_ID}`));
    assert.ok(create.includes(`--metadata=^;^run-id=${MODELS_RUN_ID};condition=cr-effort-claude-opus-5.5;seed=7;bucket=${BUCKET_NAME};machine-type=e2-standard-4;models=${MODELS}`));
    assert.ok(script().includes(`--run-id ${MODELS_RUN_ID} `));
    assert.ok(script().endsWith(` --models ${MODELS}\n`));
  });

  test("--yes starts a run whose full VM name would pass 63 characters under a shortened name with the full run ID in metadata", () => {
    const runId = `${RUN_ID}-models-opus-sonnet-haiku-s1of3`;
    const { code, calls, deps, script } = startYes(["--models", ALL_MODELS, "--shard", "1/3"]);
    assert.equal(code, 0, deps.errors.join("\n"));
    const create = calls.map((call) => call.argv).find((argv) => has(argv, "instances", "create")) as string[];
    const vm = create[create.indexOf("create") + 1];
    assert.match(vm, new RegExp(`^${VM_PREFIX}${RUN_ID}-[0-9a-f]{6}-s1of3$`));
    assert.ok(vm.length <= 63);
    assert.ok(create.some((arg) => arg.startsWith(`--metadata=^;^run-id=${runId};`)));
    assert.ok(calls.some((call) => has(call.argv, "storage", "cp", `${BUCKET_URL}/code/${runId}.tar.gz`)));
    assert.ok(script().includes(`--run-id ${runId} `));
    const printed = deps.output.join("\n");
    assert.ok(printed.includes(`VM: ${vm}\n`));
    assert.ok(printed.includes(`Results in GCS: ${BUCKET_URL}/runs/${runId}/`));
    assert.ok(printed.includes(`branch c4-c-smoke/${runId}, under c4-effort/c4-c-smoke/${runId}/`));
  });

  test("--yes refuses a run ID whose proxy name would pass 63 characters, naming the proxy and the limit, and creates nothing", () => {
    const longSha = "34c414f0123456789abcdef0123456789abcdef0";
    const { code, calls, deps } = startYes([], longSha);
    assert.equal(code, 1);
    const errors = deps.errors.join("\n");
    assert.match(errors, new RegExp(`refused: proxy name c4-c-smoke-20261031t212238z-${longSha}-[0-9a-f]{6}-proxy is not a DNS label of at most 63 characters`));
    assert.match(errors, /refused: VM name .* is not a DNS label of at most 63 characters/);
    assert.match(errors, /refused: batch network name .* is not a DNS label of at most 63 characters/);
    assert.ok(!calls.some((call) => has(call.argv, "instances", "create") || has(call.argv, "storage", "cp")));
  });

  test("--yes accepts the sharded one-arm, two-model run from research#134 and its names fit", () => {
    const runId = `${RUN_ID}-arms-a-models-opusm-haikuh-s0of2`;
    const { code, calls, deps } = startYes(["--arms", "a", "--models", "claude-opus-5-5:medium,claude-haiku-5-5:high", "--shard", "0/2"]);
    assert.equal(code, 0, deps.errors.join("\n"));
    const create = calls.map((call) => call.argv).find((argv) => has(argv, "instances", "create")) as string[];
    const vm = create[create.indexOf("create") + 1];
    assert.ok(vm.length <= 63, vm);
    assert.ok(create.some((arg) => arg.startsWith(`--metadata=^;^run-id=${runId};`)));
    const names = resourceNames("cr-effort-claude-opus-5.5", runId);
    assert.equal(names.vm, vm);
    for (const name of [names.vm, names.batchNetwork, names.batchProxy]) assert.ok(name.length <= 63, name);
  });

  const refused: Array<[string, string[]]> = [
    ["a duplicated model", ["start", "--condition", "cr-effort-claude-opus-5.5", "--models", "claude-opus-5-5,claude-opus-5-5"]],
    ["an unlisted model", ["start", "--condition", "cr-effort-claude-opus-5.5", "--models", "claude-sonnet-4-5"]],
    ["a short model name", ["start", "--condition", "cr-effort-claude-opus-5.5", "--models", "sonnet"]],
    ["an empty model list", ["start", "--condition", "cr-effort-claude-opus-5.5", "--models", ""]],
    ["a shell metacharacter in the models", ["start", "--condition", "cr-effort-claude-opus-5.5", "--models", "claude-opus-5-5;reboot"]],
    ["a model listed twice with different efforts", ["start", "--condition", "cr-effort-claude-opus-5.5", "--models", "claude-opus-5-5,claude-opus-5-5:high"]],
    ["an unknown effort", ["start", "--condition", "cr-effort-claude-opus-5.5", "--models", "claude-opus-5-5:max"]],
    ["two efforts on one entry", ["start", "--condition", "cr-effort-claude-opus-5.5", "--models", "claude-opus-5-5:high:low"]],
    ["the models with --repeat", ["start", "--condition", "cr-effort-claude-opus-5.5", "--models", MODELS, "--repeat", "2"]],
    ["the models with --arms and --repeat", ["start", "--condition", "cr-effort-claude-opus-5.5", "--models", MODELS, "--arms", "c", "--repeat", "2"]],
    ["the models with the checks entry", ["start", "--condition", "cr-effort-claude-opus-5.5", "--entry", CHECKS, "--models", MODELS]],
    ["the models on status", ["status", "--models", MODELS]],
  ];
  for (const [name, argv] of refused) {
    test(`launch.ts refuses ${name} with the usage error and calls nothing`, () => {
      const { exec, calls } = recorder();
      const deps = launcherDeps(exec);
      assert.equal(runLauncher(argv, deps), 2);
      assert.deepEqual(calls, []);
      assert.match(deps.errors.join("\n"), /\[--models <model\[:effort\],\.\.\.>\] \[--arms /);
    });
  }

  describe("with --arms", () => {
    const CELLS = "claude-opus-5-5:medium,claude-haiku-5-5:high";
    const CELLS_RUN_ID = `${RUN_ID}-arms-c-e1-models-opusm-haikuh`;
    const ONE_ARM_RUN_ID = `${RUN_ID}-arms-c-models-opusm-haikuh`;

    test("the dry run carries the arms and the cells and a run ID the pattern accepts", () => {
      const { code, printed } = dryRun(["--arms", "c,e1", "--models", "claude-haiku-5-5:high,claude-opus-5-5:medium"]);
      assert.equal(code, 0, printed);
      assert.ok(RUN_ID_PATTERN.test(CELLS_RUN_ID));
      assert.ok(printed.includes(`Run ID: ${CELLS_RUN_ID}\n`), printed);
      assert.ok(printed.includes(`;arms=c,e1;models=${CELLS}'`), printed);
    });

    test("arm a with the cells builds a run ID the pattern accepts and a VM name within 63 characters", () => {
      const runId = `${RUN_ID}-arms-a-models-opusm-haikuh`;
      const { code, printed } = dryRun(["--arms", "a", "--models", CELLS]);
      assert.equal(code, 0, printed);
      assert.ok(printed.includes(`Run ID: ${runId}\n`), printed);
      assert.ok(RUN_ID_PATTERN.test(runId));
      assert.ok(`${VM_PREFIX}${runId}`.length <= 63);
      const { code: yes, calls, deps } = startYes(["--arms", "a", "--models", CELLS]);
      assert.equal(yes, 0, deps.errors.join("\n"));
      const create = calls.map((call) => call.argv).find((argv) => has(argv, "instances", "create")) as string[];
      assert.ok(create.includes(`${VM_PREFIX}${runId}`));
    });

    test("a bare entry keeps no effort letter in the run ID", () => {
      const { printed } = dryRun(["--arms", "c", "--models", "claude-opus-5-5,claude-haiku-5-5:high"]);
      assert.ok(printed.includes(`Run ID: ${RUN_ID}-arms-c-models-opus-haikuh\n`), printed);
      assert.ok(printed.includes(`;models=claude-opus-5-5,claude-haiku-5-5:high'`), printed);
    });

    test("--yes passes --arms and --models to the VM's batch command", () => {
      const { code, calls, deps, script } = startYes(["--arms", "c", "--models", CELLS]);
      assert.equal(code, 0, deps.errors.join("\n"));
      const create = calls.map((call) => call.argv).find((argv) => has(argv, "instances", "create")) as string[];
      assert.ok(create.includes(`${VM_PREFIX}${ONE_ARM_RUN_ID}`));
      assert.ok(script().includes(`--run-id ${ONE_ARM_RUN_ID} `));
      assert.ok(script().endsWith(` --arms c --models ${CELLS}\n`), script());
      const fixture = vmFixture();
      assert.equal(runVm({ ...fixture.params, runId: CELLS_RUN_ID, arms: "c,e1", models: CELLS }, fixture.deps), 0);
      const batch = fixture.calls.map((call) => call.argv).find(isBatch) as string[];
      assert.deepEqual(batch.slice(-4), ["--arms", "c,e1", "--models", CELLS]);
    });
  });

  test("the startup script forwards the models before the shard and is byte-identical without them", () => {
    const base = { runId: MODELS_RUN_ID, condition: "cr-effort-claude-opus-5.5" as const, seed: "7", bucket: BUCKET_NAME, machineType: "e2-standard-4" };
    assert.ok(renderStartupScript({ ...base, models: MODELS }).endsWith(` --models ${MODELS}\n`));
    assert.ok(
      renderStartupScript({ ...base, runId: `${MODELS_RUN_ID}-s0of2`, models: MODELS, shard: "0/2" }).endsWith(` --models ${MODELS} --shard 0/2\n`),
    );
    assert.equal(renderStartupScript({ ...base, models: null }), renderStartupScript(base));
    for (const models of ["claude-opus-5-5,claude-opus-5-5", "claude-sonnet-4-5", "claude-opus-5-5; reboot", "claude-opus-5-5 --repeat 2"]) {
      assert.throws(() => renderStartupScript({ ...base, models }), /invalid models/);
    }
    assert.throws(() => renderStartupScript({ ...base, models: MODELS, repeat: "2" }), /invalid models/);
    assert.ok(renderStartupScript({ ...base, models: MODELS, arms: "c" }).endsWith(` --arms c --models ${MODELS}\n`));
    assert.throws(() => renderStartupScript({ ...base, models: "claude-opus-5-5:max" }), /invalid models/);
  });

  test("vm-run.ts forwards the models to run-batch", () => {
    const fixture = vmFixture();
    assert.equal(runVm({ ...fixture.params, runId: MODELS_RUN_ID, models: MODELS }, fixture.deps), 0);
    const batch = fixture.calls.map((call) => call.argv).find(isBatch) as string[];
    assert.deepEqual(batch.slice(-2), ["--models", MODELS]);
    assert.ok(has(batch, "--run-id", MODELS_RUN_ID));
  });

  test("vm-run.ts without the models does not carry them", () => {
    const fixture = vmFixture();
    runVm(fixture.params, fixture.deps);
    const batch = fixture.calls.map((call) => call.argv).find(isBatch) as string[];
    assert.ok(!batch.includes("--models"));
  });

  const REQUIRED = ["--run-id", MODELS_RUN_ID, "--condition", "cr-effort-claude-opus-5.5", "--bucket", "b", "--work", "w", "--seed", "1", "--vm-type", "v"];
  for (const [name, args] of [
    ["a duplicated model", ["run", ...REQUIRED, "--models", "claude-opus-5-5,claude-opus-5-5"]],
    ["an unlisted model", ["run", ...REQUIRED, "--models", "claude-sonnet-4-5"]],
    ["the models with --repeat", ["run", ...REQUIRED, "--models", MODELS, "--repeat", "2"]],
    ["an unknown effort", ["run", ...REQUIRED, "--models", "claude-opus-5-5:max"]],
    ["the models with the checks entry", ["run", ...REQUIRED, "--entry", CHECKS, "--models", MODELS]],
    ["the models on sync", ["sync", "--run-id", MODELS_RUN_ID, "--condition", "cr-effort-claude-opus-5.5", "--bucket", "b", "--work", "w", "--models", MODELS]],
  ] as const) {
    test(`the vm-run.ts CLI refuses ${name}`, () => {
      const child = spawnSync(process.execPath, [VM_RUN, ...args], { encoding: "utf8" });
      assert.equal(child.status, 2);
      assert.match(child.stderr, /usage:.*\[--models <model\[:effort\],\.\.\.>\]/);
    });
  }
});

describe("--review-reserve-usd", () => {
  const REPO_ROOT = join(import.meta.dirname, "..", "..");

  function startWith(args: string[]) {
    let script = "";
    const { exec, calls } = recorder((argv) => {
      if (has(argv, "rev-parse")) return { ...OK, stdout: `${SHORT_SHA}\n` };
      if (has(argv, "for-each-ref")) return { ...OK, stdout: "refs/remotes/origin/dev\n" };
      if (has(argv, "versions", "list")) return { ...OK, stdout: "1\n" };
      if (has(argv, "instances", "list")) return { ...OK, stdout: "[]" };
      if (has(argv, "instances", "create")) {
        const flag = argv.find((arg) => arg.startsWith("--metadata-from-file="));
        script = readFileSync(String(flag).split("startup-script=")[1], "utf8");
      }
      return undefined;
    });
    const deps = launcherDeps(exec);
    const code = runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5", "--yes", "--seed", "7", ...args], deps);
    const create = calls.map((call) => call.argv).find((argv) => has(argv, "instances", "create")) ?? [];
    return { code, create, script, deps };
  }

  test("launch.ts names the flag in its usage line", () => {
    const { exec } = recorder();
    const deps = launcherDeps(exec);
    runLauncher(["nonsense"], deps);
    assert.match(deps.errors.join("\n"), /\[--batch-budget-usd <n>\] \[--review-reserve-usd <n>\]/);
  });

  test("launch.ts passes it as metadata and through the startup script", () => {
    const { code, create, script } = startWith(["--batch-budget-usd", "5", "--review-reserve-usd", "1"]);
    assert.equal(code, 0);
    assert.ok(
      create.includes(
        `--metadata=run-id=${RUN_ID},condition=cr-effort-claude-opus-5.5,seed=7,bucket=${BUCKET_NAME},machine-type=e2-standard-4,batch-budget-usd=5,review-reserve-usd=1`,
      ),
    );
    assert.ok(script.includes(`--work /opt/c4 --batch-budget-usd 5 --review-reserve-usd 1\n`));
  });

  test("without the flag neither metadata nor script carries it", () => {
    const { code, create, script } = startWith([]);
    assert.equal(code, 0);
    assert.ok(!create.join(" ").includes("review-reserve-usd"));
    assert.ok(!script.includes("--review-reserve-usd"));
  });

  const refusals: Array<[string, string[]]> = [
    ["a zero reserve", ["start", "--condition", "cr-effort-claude-opus-5.5", "--review-reserve-usd=0"]],
    ["a reserve above 4", ["start", "--condition", "cr-effort-claude-opus-5.5", "--review-reserve-usd=4.5"]],
    ["a non-numeric reserve", ["start", "--condition", "cr-effort-claude-opus-5.5", "--review-reserve-usd=1;reboot"]],
    ["the reserve on status", ["status", "--review-reserve-usd", "1"]],
    ["the reserve with the checks entry", ["start", "--condition", "cr-effort-claude-opus-5.5", "--entry", "harness/checks/run-all.ts", "--review-reserve-usd", "1"]],
  ];

  for (const [name, argv] of refusals) {
    test(`launch.ts refuses ${name} and calls nothing`, () => {
      const { exec, calls } = recorder();
      const deps = launcherDeps(exec);
      assert.equal(runLauncher(argv, deps), 2);
      assert.deepEqual(calls, []);
      assert.match(deps.errors.join("\n"), /usage:/);
    });
  }

  const reserveAboveBudget: Array<[string, string[], RegExp]> = [
    ["the default reserve above a budget of 1.6", ["--batch-budget-usd", "1.6"], /--review-reserve-usd 4 \(the default\) is above --batch-budget-usd 1\.6/],
    ["a reserve of 3 above a budget of 2", ["--batch-budget-usd", "2", "--review-reserve-usd", "3"], /--review-reserve-usd 3 is above --batch-budget-usd 2\b/],
  ];

  for (const [name, args, message] of reserveAboveBudget) {
    for (const yes of [false, true]) {
      test(`launch.ts refuses ${name}${yes ? " with --yes" : " in the dry run"} and calls nothing`, () => {
        const { exec, calls } = recorder();
        const deps = launcherDeps(exec);
        const argv = ["start", "--condition", "cr-effort-claude-opus-5.5", ...args, ...(yes ? ["--yes"] : [])];
        assert.equal(runLauncher(argv, deps), 2);
        assert.deepEqual(calls, []);
        assert.match(deps.errors.join("\n"), message);
        assert.deepEqual(deps.output, []);
      });
    }
  }

  for (const [name, args] of [
    ["a reserve below the budget", ["--batch-budget-usd", "1.6", "--review-reserve-usd", "0.25"]],
    ["a reserve equal to the budget", ["--batch-budget-usd", "1", "--review-reserve-usd", "1"]],
  ] as Array<[string, string[]]>) {
    test(`launch.ts admits ${name}`, () => {
      const { code, create, deps } = startWith(args);
      assert.equal(code, 0, deps.errors.join("\n"));
      assert.ok(create.length > 0);
      assert.deepEqual(deps.errors, []);
    });
  }

  test("the startup script refuses an unsafe reserve", () => {
    const base = { runId: RUN_ID, condition: "cr-effort-claude-opus-5.5" as const, seed: "7", bucket: BUCKET_NAME, machineType: "e2-standard-4" };
    assert.throws(() => renderStartupScript({ ...base, reviewReserveUsd: "1; reboot" }), /invalid review reserve/);
    assert.throws(() => renderStartupScript({ ...base, reviewReserveUsd: "5" }), /invalid review reserve/);
    assert.equal(renderStartupScript({ ...base, reviewReserveUsd: null }), renderStartupScript(base));
  });

  test("vm-run.ts passes it to the batch", () => {
    const fixture = vmFixture();
    assert.equal(runVm({ ...fixture.params, batchBudgetUsd: "5", reviewReserveUsd: "1" }, fixture.deps), 0);
    const batch = fixture.calls.map((call) => call.argv).find(isBatch) as string[];
    assert.deepEqual(batch.slice(-4), ["--batch-budget-usd", "5", "--review-reserve-usd", "1"]);
  });

  const VM_RUN = join(import.meta.dirname, "..", "gcp", "vm-run.ts");
  const REQUIRED = ["--run-id", RUN_ID, "--condition", "cr-effort-claude-opus-5.5", "--bucket", "b", "--work", "w"];
  for (const [name, args] of [
    ["a reserve above 4", ["run", ...REQUIRED, "--seed", "1", "--vm-type", "v", "--review-reserve-usd=5"]],
    ["the reserve on sync", ["sync", ...REQUIRED, "--review-reserve-usd", "1"]],
    ["the reserve with the checks entry", ["run", ...REQUIRED, "--seed", "1", "--vm-type", "v", "--entry", "harness/checks/run-all.ts", "--review-reserve-usd", "1"]],
  ] as Array<[string, string[]]>) {
    test(`the vm-run.ts CLI refuses ${name}`, () => {
      const child = spawnSync(process.execPath, [VM_RUN, ...args], { encoding: "utf8" });
      assert.equal(child.status, 2);
      assert.match(child.stderr, /usage:.*\[--review-reserve-usd <n>\]/);
    });
  }

  test("launch.ts passes --unusable-limit as metadata and through the startup script, and names it per shard", () => {
    const { code, create, script } = startWith(["--review-reserve-usd", "1", "--unusable-limit", "3"]);
    assert.equal(code, 0);
    assert.ok(
      create.includes(
        `--metadata=run-id=${RUN_ID},condition=cr-effort-claude-opus-5.5,seed=7,bucket=${BUCKET_NAME},machine-type=e2-standard-4,review-reserve-usd=1,unusable-limit=3`,
      ),
    );
    assert.ok(script.includes(`--work /opt/c4 --review-reserve-usd 1 --unusable-limit 3\n`));
    const { exec } = recorder();
    const deps = launcherDeps(exec);
    runLauncher(["nonsense"], deps);
    assert.match(deps.errors.join("\n"), /\[--unusable-limit <n API or VM failures per cell, per shard>\]/);
  });

  test("without --unusable-limit neither metadata nor script carries it", () => {
    const { code, create, script } = startWith([]);
    assert.equal(code, 0);
    assert.ok(!create.join(" ").includes("unusable-limit"));
    assert.ok(!script.includes("--unusable-limit"));
  });

  for (const [name, argv] of [
    ["a zero unusable limit", ["start", "--condition", "cr-effort-claude-opus-5.5", "--unusable-limit=0"]],
    ["a fractional unusable limit", ["start", "--condition", "cr-effort-claude-opus-5.5", "--unusable-limit=1.5"]],
    ["an unsafe unusable limit", ["start", "--condition", "cr-effort-claude-opus-5.5", "--unusable-limit=2;reboot"]],
    ["the unusable limit on status", ["status", "--unusable-limit", "2"]],
    ["the unusable limit with the checks entry", ["start", "--condition", "cr-effort-claude-opus-5.5", "--entry", "harness/checks/run-all.ts", "--unusable-limit", "2"]],
  ] as Array<[string, string[]]>) {
    test(`launch.ts refuses ${name} and calls nothing`, () => {
      const { exec, calls } = recorder();
      const deps = launcherDeps(exec);
      assert.equal(runLauncher(argv, deps), 2);
      assert.deepEqual(calls, []);
      assert.match(deps.errors.join("\n"), /usage:/);
    });
  }

  test("the startup script refuses an unsafe unusable limit", () => {
    const base = { runId: RUN_ID, condition: "cr-effort-claude-opus-5.5" as const, seed: "7", bucket: BUCKET_NAME, machineType: "e2-standard-4" };
    assert.throws(() => renderStartupScript({ ...base, unusableLimit: "2; reboot" }), /invalid unusable limit/);
    assert.throws(() => renderStartupScript({ ...base, unusableLimit: "0" }), /invalid unusable limit/);
    assert.equal(renderStartupScript({ ...base, unusableLimit: null }), renderStartupScript(base));
  });

  test("vm-run.ts passes --unusable-limit to the batch", () => {
    const fixture = vmFixture();
    assert.equal(runVm({ ...fixture.params, reviewReserveUsd: "1", unusableLimit: "3" }, fixture.deps), 0);
    const batch = fixture.calls.map((call) => call.argv).find(isBatch) as string[];
    assert.deepEqual(batch.slice(-4), ["--review-reserve-usd", "1", "--unusable-limit", "3"]);
  });

  for (const [name, args] of [
    ["a zero unusable limit", ["run", ...REQUIRED, "--seed", "1", "--vm-type", "v", "--unusable-limit=0"]],
    ["the unusable limit on sync", ["sync", ...REQUIRED, "--unusable-limit", "2"]],
    ["the unusable limit with the checks entry", ["run", ...REQUIRED, "--seed", "1", "--vm-type", "v", "--entry", "harness/checks/run-all.ts", "--unusable-limit", "2"]],
  ] as Array<[string, string[]]>) {
    test(`the vm-run.ts CLI refuses ${name}`, () => {
      const child = spawnSync(process.execPath, [VM_RUN, ...args], { encoding: "utf8" });
      assert.equal(child.status, 2);
      assert.match(child.stderr, /usage:.*\[--unusable-limit <n API or VM failures per cell, per shard>\]/);
    });
  }

  test("the documented E pilot command runs all 30 reviews at $0.10 each under its $5 cap", () => {
    const gcpReadme = readFileSync(join(import.meta.dirname, "..", "gcp", "README.md"), "utf8");
    const harnessReadme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
    const command = gcpReadme.match(/node harness\/gcp\/launch\.ts start .*--arms e1,e2b,e2g.*/)?.[0];
    assert.ok(command);
    assert.match(command, / --condition cr-authornote-claude-opus-5\.5 /);
    const flags = command
      .replace("node harness/gcp/launch.ts start", "")
      .replace("--yes", "")
      .replace("--condition cr-authornote-claude-opus-5.5", "")
      .replace(/--seed \d+/, "")
      .trim();
    assert.ok(harnessReadme.includes(`The E pilot runs \`${flags}\``));
    const { exec } = recorder();
    const deps = launcherDeps(exec);
    runLauncher(["nonsense"], deps);
    for (const flag of flags.match(/--[a-z-]+/g) ?? []) assert.ok(deps.errors.join("\n").includes(`[${flag}`), flag);
    const out = join(mkdtempSync(join(tmpdir(), "cr-e-pilot-")), "b");
    const child = spawnSync(
      process.execPath,
      [
        "harness/smoke/run-batch.ts",
        "--run-id",
        "probe",
        "--condition",
        "cr-authornote-claude-opus-5.5",
        "--seed",
        "1",
        "--vm-type",
        "probe",
        "--fake",
        "--fake-cost-usd",
        "0.1",
        ...flags.split(/\s+/),
        "--out",
        out,
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8")) as { stop_reason: string };
    assert.equal(summary.stop_reason, "completed");
    assert.equal(readdirSync(join(out, "runs")).length, 30);
  });
});

describe("--condition", () => {
  const STUDY_IDS = new RegExp(`--condition <${CONDITIONS.map((id) => id.replaceAll(".", "\\.")).join("\\|")}>`);
  const VM_RUN = join(import.meta.dirname, "..", "gcp", "vm-run.ts");
  const INVALID = [["c"], ["m"], ["cr-repo-claude-opus-5-5"], ["cr-unknown"], ["cr-patchonly"], ["CR-REPO-CLAUDE-OPUS-5.5"], [""]];
  const STUDY = "cr-repo-claude-opus-5.5";
  const GCP = "cr-repo-claude-opus-5-5";

  function launching(): Responder {
    return (argv) => {
      if (has(argv, "rev-parse")) return { ...OK, stdout: `${SHORT_SHA}\n` };
      if (has(argv, "for-each-ref")) return { ...OK, stdout: "refs/remotes/origin/dev\n" };
      if (has(argv, "versions", "list")) return { ...OK, stdout: "1\n" };
      if (has(argv, "instances", "list")) return { ...OK, stdout: "[]" };
      return undefined;
    };
  }

  for (const [name, flag] of [["a missing condition", []], ...INVALID.map((value) => [`condition ${JSON.stringify(value[0])}`, ["--condition", ...value]])] as Array<[string, string[]]>) {
    test(`launch.ts start refuses ${name} with exit 2, names the study IDs and calls nothing`, () => {
      for (const yes of [[], ["--yes"]]) {
        const { exec, calls } = recorder(launching());
        const deps = launcherDeps(exec);
        assert.equal(runLauncher(["start", ...flag, ...yes], deps), 2);
        assert.deepEqual(calls, []);
        assert.match(deps.errors.join("\n"), STUDY_IDS);
      }
    });

    test(`the vm-run.ts CLI refuses ${name} on run and on sync`, () => {
      const base = ["--run-id", RUN_ID, ...flag, "--bucket", "b", "--work", "w"];
      for (const args of [["run", ...base, "--seed", "1", "--vm-type", "v"], ["sync", ...base]]) {
        const child = spawnSync(process.execPath, [VM_RUN, ...args], { encoding: "utf8" });
        assert.equal(child.status, 2, args.join(" "));
        assert.match(child.stderr, STUDY_IDS);
      }
    });
  }

  test("setup, status and cleanup need no condition and refuse one", () => {
    for (const command of ["setup", "status", "cleanup"]) {
      const { exec } = recorder((argv) => (has(argv, "list") ? { ...OK, stdout: "[]" } : undefined));
      assert.equal(runLauncher([command], launcherDeps(exec)), 0, command);
      const refused = recorder();
      assert.equal(runLauncher([command, "--condition", "cr-effort-claude-opus-5.5"], launcherDeps(refused.exec)), 2, command);
      assert.deepEqual(refused.calls, []);
    }
  });

  test("the dry run names the VM and the vault branch by the condition and prints it", () => {
    const { exec } = recorder(launching());
    const deps = launcherDeps(exec);
    assert.equal(runLauncher(["start", "--condition", STUDY], deps), 0);
    const printed = deps.output.join("\n");
    assert.ok(printed.includes(`Condition: ${STUDY}`), printed);
    assert.ok(printed.includes(`VM: cr-repo-${RUN_ID}`), printed);
    assert.ok(printed.includes(`run-id=${RUN_ID},condition=${STUDY},seed=1,`), printed);
    assert.ok(printed.includes(`branch ${STUDY}/smoke/${RUN_ID}, under ${STUDY}/smoke/${RUN_ID}/`), printed);
    assert.ok(!printed.includes("c4-c-smoke"), printed);
  });

  test("the legacy study keeps the c4-c VM, vault branch and path", () => {
    const { exec } = recorder(launching());
    const deps = launcherDeps(exec);
    assert.equal(runLauncher(["start", "--condition", "cr-effort-claude-opus-5.5"], deps), 0);
    const printed = deps.output.join("\n");
    assert.ok(printed.includes(`VM: ${VM_PREFIX}${RUN_ID}`), printed);
    assert.ok(printed.includes(`branch c4-c-smoke/${RUN_ID}, under c4-effort/c4-c-smoke/${RUN_ID}/`), printed);
  });

  test("studies sharing a topic share the VM prefix and differ by the study label", () => {
    for (const condition of ["cr-effort-claude-sonnet-5.5", "cr-effort-claude-haiku-5.5", "cr-effort-claude-haiku-5.5-equiv"]) {
      const { exec, calls } = recorder(launching());
      assert.equal(runLauncher(["start", "--condition", condition, "--yes"], launcherDeps(exec)), 0);
      const create = calls.map((call) => call.argv).find((argv) => has(argv, "instances", "create"));
      assert.ok(create);
      assert.equal(create[create.indexOf("create") + 1], `cr-effort-${RUN_ID}`);
      assert.ok(create.includes(`--labels=purpose=c4-smoke,study=${condition.replaceAll(".", "-")}`));
    }
  });

  test("the authornote pilot and the single-model effort runs fit GCE's VM name limit", () => {
    for (const args of [
      ["--condition", "cr-authornote-claude-opus-5.5", "--arms", "e1,e2b,e2g", "--patches", "harness/checks/e-pilot-patches.json"],
      ["--condition", "cr-effort-claude-sonnet-5.5", "--models", "claude-sonnet-5-5"],
      ["--condition", "cr-effort-claude-haiku-5.5", "--models", "claude-haiku-5-5"],
    ]) {
      const { exec, calls } = recorder(launching());
      const deps = launcherDeps(exec);
      assert.equal(runLauncher(["start", ...args, "--yes"], deps), 0, deps.errors.join("\n"));
      assert.ok(calls.some(({ argv }) => has(argv, "instances", "create")));
    }
  });

  test("--yes passes the study to the VM name, the study label, the metadata and vm-run.ts in the startup script", () => {
    let script = "";
    const { exec, calls } = recorder((argv, options) => {
      if (has(argv, "instances", "create")) {
        const flag = argv.find((arg) => arg.startsWith("--metadata-from-file="));
        script = readFileSync(String(flag).split("startup-script=")[1], "utf8");
      }
      return launching()(argv, options);
    });
    assert.equal(runLauncher(["start", "--condition", STUDY, "--yes"], launcherDeps(exec)), 0);
    const create = calls.map((call) => call.argv).find((argv) => has(argv, "instances", "create"));
    assert.ok(create);
    assert.equal(create[create.indexOf("create") + 1], `cr-repo-${RUN_ID}`);
    assert.deepEqual(
      create.filter((arg) => arg.startsWith("--labels=")),
      [`--labels=purpose=c4-smoke,study=${GCP}`],
    );
    assert.ok(create.includes(`--metadata=run-id=${RUN_ID},condition=${STUDY},seed=1,bucket=${BUCKET_NAME},machine-type=e2-standard-4`));
    assert.ok(script.includes(`vm-run.ts run --run-id ${RUN_ID} --condition ${STUDY} --seed 1 `), script);
  });

  test("a running VM of another condition still blocks an unsharded start", () => {
    const { exec, calls } = recorder((argv, options) =>
      has(argv, "instances", "list")
        ? { ...OK, stdout: JSON.stringify([{ name: `c4-c-smoke-${RUN_ID}`, status: "RUNNING", zone: "z" }]) }
        : launching()(argv, options),
    );
    const deps = launcherDeps(exec);
    assert.equal(runLauncher(["start", "--condition", STUDY, "--yes"], deps), 1);
    assert.match(deps.errors.join("\n"), /already exists/);
    assert.equal(calls.filter(({ argv }) => has(argv, "create")).length, 0);
  });

  test("the startup script refuses an invalid condition", () => {
    const params = { runId: RUN_ID, condition: STUDY, seed: "7", bucket: BUCKET_NAME, machineType: "e2-standard-4" } as const;
    assert.ok(renderStartupScript(params).includes(`--run-id ${RUN_ID} --condition ${STUDY} --seed 7 `));
    for (const condition of ["c", "m", GCP, "cr-unknown", "", "cr-skill; reboot"]) {
      assert.throws(() => renderStartupScript({ ...params, condition: condition as typeof STUDY }), /invalid condition/);
    }
  });

  test("vm-run.ts run passes the study ID to the entry and to the checkpoint", () => {
    const fixture = vmFixture();
    runVm({ ...fixture.params, condition: STUDY }, fixture.deps);
    const batch = fixture.calls.find(({ argv }) => isBatch(argv));
    assert.ok(batch);
    const value = (flag: string) => batch.argv[batch.argv.indexOf(flag) + 1];
    assert.equal(value("--condition"), STUDY);
    assert.equal(batch.argv.indexOf("--condition"), batch.argv.indexOf("--run-id") + 2);
    assert.ok(value("--checkpoint-cmd").includes(`sync --run-id ${RUN_ID} --condition ${STUDY} --bucket`));
  });

  test("vm-run.ts sync pushes a study to its own vault branch and path", () => {
    const fixture = vmFixture((argv) => (has(argv, "rev-parse") || has(argv, "diff", "--cached") ? FAILED : undefined));
    mkdirSync(fixture.results, { recursive: true });
    writeFileSync(join(fixture.results, "run.json"), "{}");
    assert.equal(sync({ ...fixture.params, condition: STUDY }, fixture.deps).vaultPushOk, true);
    const argvs = fixture.calls.map((call) => call.argv);
    assert.ok(argvs.some((argv) => has(argv, "add", "-f", join(STUDY, "smoke", RUN_ID))));
    assert.ok(argvs.some((argv) => has(argv, "checkout", "-b", `${STUDY}/smoke/${RUN_ID}`)));
    assert.ok(argvs.find(isPush)?.includes(`HEAD:refs/heads/${STUDY}/smoke/${RUN_ID}`));
    assert.ok(argvs.some((argv) => argv.includes(`user.name=${GCP}-smoke`)));
    assert.ok(argvs.some((argv) => argv.includes(`${STUDY} smoke results for ${RUN_ID}`)));
    assert.ok(!argvs.some((argv) => argv.some((arg) => arg.includes("c4-c-smoke"))));
  });
});
