import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";

import { ARMS } from "../conditions/arms.ts";
import { EFFORTS, MODELS } from "../models.ts";
import {
  armsRunIdSuffix,
  CONDITIONS,
  gcpId,
  isDnsLabel,
  modelsRunIdSuffix,
  parseCondition,
  repeatRunIdSuffix,
  resourceNames,
  RUN_ID_PATTERN,
  runIdOfVm,
  SHARDED_RUN_ID_PATTERN,
  shardRunIdSuffix,
} from "../gcp/common.ts";

const HARNESS = join(import.meta.dirname, "..");
const HARDCODED_CONDITION = /\bc4-c(?![a-z0-9])/i;
const NAMED_LEGACY_CONSTANT = /^\s*(?:export\s+)?const\s+LEGACY_[A-Z0-9_]+\s*=/;
const RUN_ID = "20261105t120000z-fa7afee";
const SIXTEEN_CHAR_RUN_ID = "20261105t120000z";
const GCE_NAME = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const GCE_LABEL_VALUE = /^[-a-z0-9]+$/;
const MAX_GCE_NAME_LENGTH = 63;
const DOCKER_TAG_MAX_LENGTH = 128;
const DOCKER_TAG = /^[a-z0-9_][a-z0-9_.-]*$/;
const LONGEST_DJANGO_INSTANCE_ID = "django__django-17087";
const DIGEST = "9f86d081884c";

interface Hit {
  path: string;
  line: number;
  text: string;
}

function offendingLines(path: string, source: string): Hit[] {
  return source.split("\n").flatMap((text, index) =>
    HARDCODED_CONDITION.test(text) && !NAMED_LEGACY_CONSTANT.test(text) ? [{ path, line: index + 1, text }] : [],
  );
}

function harnessSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" || entry.name === "node_modules" ? [] : harnessSources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("no hardcoded c4-c outside named legacy constants", () => {
  test("no non-test harness source names the legacy prefix by hand", () => {
    const sources = harnessSources(HARNESS);
    assert.ok(sources.some((path) => path.endsWith(join("gcp", "common.ts"))));
    const hits = sources.flatMap((path) => offendingLines(relative(HARNESS, path), readFileSync(path, "utf8")));
    assert.deepEqual(hits, []);
  });

  test("the checker flags an injected c4-c name and passes legacy constants and longer words", () => {
    const injected = [
      'const VM = "c4-c-smoke-";',
      "const name = `C4-C smoke results for ${id}`;",
      'const LEGACY_OWNER_LABEL = "c4-c.owner-pid";',
      'export const LEGACY_SMOKE_NAME = "c4-c-smoke";',
      'const dir = "c4-code-";',
      'const label = "c4-cc";',
      'const other = "c4-m-smoke-";',
      'const prefix = "xc4-c-smoke";',
    ].join("\n");
    assert.deepEqual(
      offendingLines("injected.ts", injected).map(({ line }) => line),
      [1, 2],
    );
  });
});

describe("resourceNames", () => {
  test("cr-effort-claude-opus-5.5 keeps the legacy GCP names and dev's cr- local names byte for byte", () => {
    const names = resourceNames("cr-effort-claude-opus-5.5", RUN_ID);
    assert.equal(names.vm, `c4-c-smoke-${RUN_ID}`);
    assert.equal(names.batchNetwork, `cr-smoke-${RUN_ID}`);
    assert.equal(names.vaultBranch, `c4-c-smoke/${RUN_ID}`);
    assert.equal(names.vaultPath, `c4-effort/c4-c-smoke/${RUN_ID}`);
    assert.equal(names.vaultAuthor, "c4-c-smoke");
    assert.equal(names.vaultCommitMessage, `cr smoke results for ${RUN_ID}`);
    assert.equal(names.reviewContainer("0a1b2c3d"), "cr-mvp-0a1b2c3d");
    assert.equal(names.reviewNetwork("0a1b2c3d"), "cr-mvp-net-0a1b2c3d");
    assert.equal(
      names.reviewImage("django__django-10097", "9F86D081884C"),
      `cr-mvp-review:${RUN_ID}-django__django-10097-9f86d081884c`,
    );
    assert.equal(names.reviewOutDir("fake"), `runs/cr-mvp-fake-${RUN_ID}`);
  });

  test("two runs of one study tag the same instance and digest's review image apart", () => {
    const first = resourceNames("cr-skill-claude-opus-5.5", "cr-skill-smoke-1");
    const second = resourceNames("cr-skill-claude-opus-5.5", "cr-skill-isolation-probe");
    const tags = [first, second].map((names) => names.reviewImage("django__django-10097", "9f86d081884c"));
    assert.notEqual(tags[0], tags[1]);
    assert.equal(tags[0], "cr-skill-claude-opus-5-5-mvp-review:cr-skill-smoke-1-django__django-10097-9f86d081884c");
  });

  test("a mixed-case run ID gives a lower-cased review image tag", () => {
    assert.equal(
      resourceNames("cr-effort-claude-opus-5.5", "2026-11-11T09-35-45-777Z").reviewImage("Django__django-10097", "9F86"),
      "cr-mvp-review:2026-11-11t09-35-45-777z-django__django-10097-9f86",
    );
  });

  test("a run ID that fits the review image tag exactly at 128 characters is kept whole", () => {
    const fits = "r".repeat(DOCKER_TAG_MAX_LENGTH - `-${LONGEST_DJANGO_INSTANCE_ID}-${DIGEST}`.length);
    const tag = reviewImageTag(resourceNames("cr-effort-claude-opus-5.5", fits).reviewImage(LONGEST_DJANGO_INSTANCE_ID, DIGEST));
    assert.equal(tag, `${fits}-${LONGEST_DJANGO_INSTANCE_ID}-${DIGEST}`);
  });

  test("a 129-character run ID gets a stable, valid, hashed review image tag that tells run IDs apart past the cut", () => {
    const longRunId = "r".repeat(128) + "a";
    const otherLongRunId = "r".repeat(128) + "b";
    assert.equal(longRunId.length, 129);
    for (const condition of CONDITIONS) {
      const tagOf = (runId: string) =>
        reviewImageTag(resourceNames(condition, runId).reviewImage(LONGEST_DJANGO_INSTANCE_ID, DIGEST));
      const tag = tagOf(longRunId);
      assert.ok(tag.length <= DOCKER_TAG_MAX_LENGTH, `${condition}: ${tag} is ${tag.length} characters`);
      assert.match(tag, DOCKER_TAG);
      assert.match(tag, new RegExp(`^[0-9a-f]{6}-${LONGEST_DJANGO_INSTANCE_ID}-${DIGEST}$`));
      assert.equal(tagOf(longRunId), tag);
      assert.notEqual(tagOf(otherLongRunId), tag);
    }
  });

  test("the longest run IDs the CLI accepts get a valid review image tag that keeps the timestamp, commit and shard", () => {
    const head = `${SIXTEEN_CHAR_RUN_ID}-${"fa7afee".padEnd(40, "0")}`;
    const shortCommitIds = longestAcceptedRunIds();
    for (const runId of [...shortCommitIds, ...shortCommitIds.map((id) => id.replace(RUN_ID, head))]) {
      assert.match(runId, RUN_ID_PATTERN);
      const runIdHead = runId.startsWith(head) ? head : RUN_ID;
      const shard = SHARDED_RUN_ID_PATTERN.exec(runId)?.[0] ?? "";
      const images = new Set<string>();
      for (const condition of CONDITIONS) {
        const image = resourceNames(condition, runId).reviewImage(LONGEST_DJANGO_INSTANCE_ID, DIGEST);
        const tag = reviewImageTag(image);
        assert.ok(tag.length <= DOCKER_TAG_MAX_LENGTH, `${condition} ${runId}: ${tag} is ${tag.length} characters`);
        assert.match(tag, DOCKER_TAG);
        assert.ok(tag === `${runId}-${LONGEST_DJANGO_INSTANCE_ID}-${DIGEST}` || tag.startsWith(`${runIdHead}-`), tag);
        assert.ok(tag.endsWith(`${shard}-${LONGEST_DJANGO_INSTANCE_ID}-${DIGEST}`), tag);
        assert.equal(resourceNames(condition, runId).reviewImage(LONGEST_DJANGO_INSTANCE_ID, DIGEST), image);
        images.add(image);
      }
      assert.equal(images.size, CONDITIONS.length, runId);
    }
    const shard = shardRunIdSuffix({ index: 998, count: 999 });
    const [allArms, fewerArms] = [ARMS, ARMS.slice(1)].map((arms) => {
      const runId = `${head}${armsRunIdSuffix(arms.join(","))}${shard}`;
      assert.match(runId, RUN_ID_PATTERN);
      return reviewImageTag(resourceNames("cr-skill-claude-opus-5.5", runId).reviewImage(LONGEST_DJANGO_INSTANCE_ID, DIGEST));
    });
    for (const tag of [allArms, fewerArms]) {
      assert.match(tag, new RegExp(`^${head}-[0-9a-f]{6}${shard}-${LONGEST_DJANGO_INSTANCE_ID}-${DIGEST}$`));
    }
    assert.notEqual(allArms, fewerArms);
  });

  test("an instance ID too long for any review image tag is refused, naming the instance ID", () => {
    const instanceId = "i".repeat(DOCKER_TAG_MAX_LENGTH);
    assert.throws(
      () => resourceNames("cr-effort-claude-opus-5.5", RUN_ID).reviewImage(instanceId, DIGEST),
      (error: Error) => error.message.includes(`instance ID ${instanceId}`) && /over Docker's 128/.test(error.message),
    );
  });

  test("a run ID that would make the review image tag invalid is refused", () => {
    assert.throws(
      () => resourceNames("cr-effort-claude-opus-5.5", "bad/run").reviewImage("django__django-10097", "9f86d081884c"),
      /run ID bad\/run makes the review image tag .* an invalid Docker tag/,
    );
  });

  test("the legacy study VM carries its study label", () => {
    assert.equal(resourceNames("cr-effort-claude-opus-5.5", RUN_ID).studyLabel, "study=cr-effort-claude-opus-5-5");
  });

  for (const [condition, gcp, vmPrefix] of [
    ["cr-repo-claude-opus-5.5", "cr-repo-claude-opus-5-5", "cr-repo"],
    ["cr-tests-claude-opus-5.5", "cr-tests-claude-opus-5-5", "cr-tests"],
    ["cr-tests-claude-haiku-5.5", "cr-tests-claude-haiku-5-5", "cr-tests"],
    ["cr-tests-claude-sonnet-5.5", "cr-tests-claude-sonnet-5-5", "cr-tests"],
  ] as const) {
    test(`${condition} names its VM by topic, labels it by study ID and names every other resource by study ID`, () => {
      const names = resourceNames(condition, RUN_ID);
      assert.equal(gcpId(condition), gcp);
      assert.equal(names.vm, `${vmPrefix}-${RUN_ID}`);
      assert.equal(names.studyLabel, `study=${gcp}`);
      assert.equal(names.batchNetwork, `${gcp}-smoke-${RUN_ID}`);
      assert.equal(names.vaultBranch, `${condition}/smoke/${RUN_ID}`);
      assert.equal(names.vaultPath, `${condition}/smoke/${RUN_ID}`);
      assert.equal(names.vaultAuthor, `${gcp}-smoke`);
      assert.equal(names.vaultCommitMessage, `${condition} smoke results for ${RUN_ID}`);
      assert.equal(names.reviewContainer("0a1b2c3d"), `${gcp}-mvp-0a1b2c3d`);
      assert.equal(names.reviewNetwork("0a1b2c3d"), `${gcp}-mvp-net-0a1b2c3d`);
      assert.equal(
        names.reviewImage("django__django-10097", "9F86D081884C"),
        `${gcp}-mvp-review:${RUN_ID}-django__django-10097-9f86d081884c`,
      );
      assert.equal(names.reviewOutDir("container-only"), `runs/${gcp}-mvp-container-only-${RUN_ID}`);
      assert.ok(!Object.values(names).some((value) => typeof value === "string" && HARDCODED_CONDITION.test(value)));
    });
  }

  test("every study ID gives a valid GCE VM name and study label at the longest run IDs that fit every study", () => {
    assert.equal(RUN_ID.length, 24);
    const runIds = longestFittingRunIds();
    for (const condition of CONDITIONS) {
      const { studyLabel } = resourceNames(condition, RUN_ID);
      const [, labelValue] = studyLabel.split("=");
      assert.ok(labelValue.length <= MAX_GCE_NAME_LENGTH);
      assert.match(labelValue, GCE_LABEL_VALUE);
      for (const runId of [SIXTEEN_CHAR_RUN_ID, ...runIds]) {
        const { vm } = resourceNames(condition, runId);
        assert.ok(vm.length <= MAX_GCE_NAME_LENGTH, `${vm} is ${vm.length} characters`);
        assert.match(vm, GCE_NAME);
        assert.equal(runIdOfVm(vm), runId);
      }
    }
  });

  test("the longest run ID the CLI accepts gives every study a VM, batch network and proxy name within 63 characters", () => {
    for (const runId of longestAcceptedRunIds()) {
      for (const condition of CONDITIONS) {
        const names = resourceNames(condition, runId);
        for (const name of [names.vm, names.batchNetwork, names.batchNetwork + "-proxy"]) {
          assert.ok(name.length <= MAX_GCE_NAME_LENGTH, `${condition} ${runId}: ${name} is ${name.length} characters`);
          assert.match(name, GCE_NAME);
          assert.ok(isDnsLabel(name), name);
        }
        assert.equal(names.batchProxy, names.batchNetwork + "-proxy");
        assert.equal(SHARDED_RUN_ID_PATTERN.test(runIdOfVm(names.vm)), SHARDED_RUN_ID_PATTERN.test(runId), names.vm);
        assert.ok(names.vaultBranch.endsWith(`/${runId}`), names.vaultBranch);
        assert.ok(names.vaultPath.endsWith(`/${runId}`), names.vaultPath);
        assert.ok(names.vaultCommitMessage.endsWith(` ${runId}`), names.vaultCommitMessage);
      }
    }
  });

  test("the sharded one-arm, two-model run from research#134 fits for every study", () => {
    const runId = `20261108t060747z-60df929${armsRunIdSuffix("a")}${modelsRunIdSuffix("claude-opus-5-5:medium,claude-haiku-5-5:high")}${shardRunIdSuffix({ index: 0, count: 2 })}`;
    assert.equal(runId, "20261108t060747z-60df929-arms-a-models-opusm-haikuh-s0of2");
    for (const condition of CONDITIONS) {
      const names = resourceNames(condition, runId);
      for (const name of [names.vm, names.batchNetwork, names.batchProxy]) assert.ok(isDnsLabel(name), name);
      assert.match(runIdOfVm(names.vm), SHARDED_RUN_ID_PATTERN);
    }
  });

  test("a name that would pass 63 characters keeps the timestamp, commit and shard and hashes the rest", () => {
    const runId = `${RUN_ID}${armsRunIdSuffix("c,e1,e2b,e2g,a,b")}${modelsRunIdSuffix("claude-opus-5-5:high")}${shardRunIdSuffix({ index: 10, count: 12 })}`;
    const names = resourceNames("cr-effort-claude-opus-5.5", runId);
    assert.match(names.vm, new RegExp(`^c4-c-smoke-${RUN_ID}-[0-9a-f]{6}-s10of12$`));
    assert.equal(names.batchNetwork, names.vm);
    const otherArms = `${RUN_ID}${armsRunIdSuffix("c,e1,e2b,e2g,a")}${modelsRunIdSuffix("claude-opus-5-5:high")}${shardRunIdSuffix({ index: 10, count: 12 })}`;
    assert.notEqual(resourceNames("cr-effort-claude-opus-5.5", otherArms).vm, names.vm);
    assert.equal(resourceNames("cr-effort-claude-opus-5.5", runId).vm, names.vm);
  });

  test("studies sharing a VM prefix get distinct shortened VM, batch network and proxy names for one run ID", () => {
    const runId = longestAcceptedRunIds()[0];
    const sonnet = resourceNames("cr-effort-claude-sonnet-5.5", runId);
    const haiku = resourceNames("cr-effort-claude-haiku-5.5", runId);
    assert.match(sonnet.vm, new RegExp(`^cr-effort-${RUN_ID}-[0-9a-f]{6}$`));
    assert.match(haiku.vm, new RegExp(`^cr-effort-${RUN_ID}-[0-9a-f]{6}$`));
    assert.notEqual(sonnet.vm, haiku.vm);
    assert.notEqual(sonnet.batchNetwork, haiku.batchNetwork);
    assert.notEqual(sonnet.batchProxy, haiku.batchProxy);
    const conditionsByNetwork = new Map<string, string[]>();
    for (const condition of CONDITIONS) {
      const { batchNetwork } = resourceNames(condition, runId);
      conditionsByNetwork.set(batchNetwork, [...(conditionsByNetwork.get(batchNetwork) ?? []), condition]);
    }
    assert.equal(conditionsByNetwork.size, CONDITIONS.length, JSON.stringify([...conditionsByNetwork]));
  });

  test("a batch network whose proxy name alone would pass 63 characters is shortened while its VM name is kept", () => {
    const runId = `${RUN_ID}${modelsRunIdSuffix("claude-sonnet-5-5")}`;
    const names = resourceNames("cr-effort-claude-haiku-5.5-equiv", runId);
    assert.equal(names.vm, `cr-effort-${runId}`);
    assert.ok(`cr-effort-claude-haiku-5-5-equiv-smoke-${runId}-proxy`.length > MAX_GCE_NAME_LENGTH);
    assert.match(names.batchNetwork, new RegExp(`^cr-effort-${RUN_ID}-[0-9a-f]{6}$`));
    assert.ok(isDnsLabel(names.batchProxy));
  });

  test("studies sharing a topic share the VM prefix and differ by study label", () => {
    const byPrefix = new Map<string, string[]>();
    for (const condition of CONDITIONS) {
      const { vm, studyLabel } = resourceNames(condition, RUN_ID);
      byPrefix.set(vm, [...(byPrefix.get(vm) ?? []), studyLabel]);
    }
    assert.deepEqual(byPrefix.get(`cr-effort-${RUN_ID}`), [
      "study=cr-effort-claude-sonnet-5-5",
      "study=cr-effort-claude-haiku-5-5",
      "study=cr-effort-claude-haiku-5-5-equiv",
    ]);
    assert.deepEqual(byPrefix.get(`cr-tests-${RUN_ID}`), [
      "study=cr-tests-claude-opus-5-5",
      "study=cr-tests-claude-haiku-5-5",
      "study=cr-tests-claude-sonnet-5-5",
    ]);
    assert.deepEqual(byPrefix.get(`cr-vote-${RUN_ID}`),["study=cr-vote-claude-haiku-5-5", "study=cr-vote-claude-opus-5-5"]);
    const labels = CONDITIONS.map((condition) => resourceNames(condition, RUN_ID).studyLabel);
    assert.equal(new Set(labels).size, CONDITIONS.length);
  });
});

function reviewImageTag(image: string): string {
  return image.slice(image.indexOf(":") + 1);
}

function longestAcceptedRunIds(): string[] {
  const allArms = armsRunIdSuffix(ARMS.join(","));
  const allModelsWithEfforts = modelsRunIdSuffix(MODELS.map((model) => `${model}:${EFFORTS.at(-1)}`).join(","));
  const shards = [
    shardRunIdSuffix({ index: 10, count: 12 }),
    shardRunIdSuffix({ index: 98, count: 99 }),
    shardRunIdSuffix({ index: 998, count: 999 }),
  ];
  const bases = [`${RUN_ID}${allArms}${allModelsWithEfforts}`, `${RUN_ID}${repeatRunIdSuffix("99")}`];
  return [...bases, ...bases.flatMap((base) => shards.map((shard) => `${base}${shard}`))].map((runId) => {
    assert.match(runId, RUN_ID_PATTERN);
    return runId;
  });
}

function longestFittingRunIds(): string[] {
  const largestShards = [
    shardRunIdSuffix({ index: 8, count: 9 }),
    shardRunIdSuffix({ index: 98, count: 99 }),
    shardRunIdSuffix({ index: 998, count: 999 }),
  ];
  const longestArms = armsRunIdSuffix("c,e1,e2b,e2g");
  const singleModels = MODELS.map((model) => modelsRunIdSuffix(model));
  const effortCells = MODELS.flatMap((model) => EFFORTS.map((effort) => `${model}:${effort}`));
  const singleEffortCells = effortCells.map((cell) => modelsRunIdSuffix(cell));
  const twoModels = MODELS.flatMap((first, index) =>
    MODELS.slice(index + 1).map((second) => modelsRunIdSuffix(`${first},${second}`)),
  );
  const twoEffortCells = effortCells.flatMap((first) =>
    effortCells
      .filter((second) => second.split(":")[0] !== first.split(":")[0])
      .map((second) => modelsRunIdSuffix(`${first},${second}`)),
  );
  const oneArmOneCell = ["c", "e1", "e2b", "e2g"].flatMap((arm) =>
    [...singleModels, ...singleEffortCells].map((cell) => `${armsRunIdSuffix(arm)}${cell}`),
  );
  return [
    RUN_ID,
    `${RUN_ID}${repeatRunIdSuffix("99")}`,
    `${RUN_ID}${longestArms}`,
    `${RUN_ID}${longestArms}${shardRunIdSuffix({ index: 8, count: 9 })}`,
    ...[...twoModels, ...twoEffortCells, ...oneArmOneCell].map((suffix) => `${RUN_ID}${suffix}`),
    ...[RUN_ID, `${RUN_ID}${repeatRunIdSuffix("99")}`, ...singleModels.map((suffix) => `${RUN_ID}${suffix}`)].flatMap(
      (base) => largestShards.map((shard) => `${base}${shard}`),
    ),
    ...singleEffortCells.map((suffix) => `${RUN_ID}${suffix}${shardRunIdSuffix({ index: 98, count: 99 })}`),
  ].map((runId) => {
    assert.match(runId, RUN_ID_PATTERN);
    return runId;
  });
}

describe("parseCondition", () => {
  test("takes exactly one of the NAMING.md study IDs and refuses anything else", () => {
    assert.deepEqual(
      [...CONDITIONS],
      [
        "cr-repo-claude-opus-5.5",
        "cr-tests-claude-opus-5.5",
        "cr-tests-claude-haiku-5.5",
        "cr-tests-claude-sonnet-5.5",
        "cr-effort-claude-opus-5.5",
        "cr-effort-claude-sonnet-5.5",
        "cr-effort-claude-haiku-5.5",
        "cr-effort-claude-haiku-5.5-equiv",
        "cr-codegraph",
        "cr-authornote-claude-opus-5.5",
        "cr-skilltmb",
        "cr-spec",
        "cr-testresults",
        "cr-vote-claude-haiku-5.5",
        "cr-vote-claude-opus-5.5",
        "cr-escalate",
        "cr-skill",
        "cr-skill-claude-opus-5.5",
      ],
    );
    for (const condition of CONDITIONS) assert.equal(parseCondition(condition), condition);
    assert.equal(parseCondition("cr-tests-claude-haiku-5.5"), "cr-tests-claude-haiku-5.5");
    for (const bad of [
      undefined,
      "",
      "c",
      "m",
      "cr-repo-claude-opus-5-5",
      "CR-REPO-CLAUDE-OPUS-5.5",
      " cr-skill",
      "cr-skill ",
      "cr-notests",
      "cr-patchonly",
      "cr-unknown",
    ]) {
      assert.equal(parseCondition(bad), null, JSON.stringify(bad));
    }
  });
});

describe("runIdOfVm", () => {
  test("reads the run ID from study, legacy and pre-condition VM names", () => {
    assert.equal(runIdOfVm(`cr-repo-${RUN_ID}`), RUN_ID);
    assert.equal(runIdOfVm(`cr-effort-${RUN_ID}-models-sonnet-s1of3`), `${RUN_ID}-models-sonnet-s1of3`);
    assert.equal(runIdOfVm(`cr-testresults-${RUN_ID}`), RUN_ID);
    assert.equal(runIdOfVm(`cr-skill-${RUN_ID}`), RUN_ID);
    assert.equal(runIdOfVm(`cr-skilltmb-${RUN_ID}`), RUN_ID);
    assert.equal(runIdOfVm(`c4-c-smoke-${RUN_ID}`), RUN_ID);
    assert.equal(runIdOfVm(`c4-smoke-${RUN_ID}`), RUN_ID);
    assert.equal(runIdOfVm("other"), "other");
  });
});
