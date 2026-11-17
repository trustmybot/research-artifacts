# cr review harness

This is the harness behind the Claude 5.5 effort study. To rebuild the paper's numbers and figures from the committed data, see [the paper's artifact README](../papers/cr-effort-claude-5.5/artifact/README.md); this file describes how the reviews themselves are run.

Two entry points. `run-review.ts` runs one patch review in one container at one effort and writes `run.json`. `smoke/run-batch.ts` runs a batch of those reviews unattended behind a budget meter and a network allowlist; see [Smoke batch](#smoke-batch). Every instance in the smoke and MVP files is excluded from the study draw, and no verdict from them is study data.

It needs Node 24 and two pinned npm dependencies, `@toon-format/toon` and `@anthropic-ai/sdk`. Run `npm ci` once, then run the commands from the repo root.

## Condition

`run-review.ts`, `smoke/run-batch.ts`, `checks/run-all.ts`, `gcp/launch.ts start` and `gcp/vm-run.ts` require `--condition <study-id>`, the study ID the run belongs to. A study ID is a short label that reads, in order, as the agent under study (`cr`, the code reviewer), the one-word topic that varies (`effort`, `authornote`), the model under test with its version's dot kept (`claude-opus-5.5`) and an optional variant for a follow-up of the same topic and model (`equiv`). This export covers these IDs, matched exactly:

`cr-effort-claude-opus-5.5`, `cr-effort-claude-sonnet-5.5`, `cr-effort-claude-haiku-5.5`, `cr-effort-claude-haiku-5.5-equiv`, `cr-authornote-claude-opus-5.5`.

The harness also accepts the IDs of other studies run on the same code; their condition files are not part of this export, and this README does not cover them. A missing flag or any other value, such as the old letter `c`, the dotless `cr-effort-claude-opus-5-5` or an unknown ID, is refused with exit 2 and a message that lists the valid IDs. The ID names the run's resources. In the table, `<id>` is the study ID and `<gcp>` is the ID with each `.` turned into `-`, because GCE names allow no dots: `cr-effort-claude-sonnet-5.5` gives `cr-effort-claude-sonnet-5-5`. `<topic>` is the ID's second segment, so `cr-effort-claude-sonnet-5.5` has the topic `effort`.

| Resource | Name |
|---|---|
| Default `run-review.ts` output | `runs/<gcp>-mvp-<mode>-<stamp>` |
| Reviewer container | `<gcp>-mvp-<hex>` |
| `run-review.ts` closed network | `<gcp>-mvp-net-<hex>` |
| Reviewer image | `<gcp>-mvp-review:<run_id>-<instance_id>-<digest>`, lowercased; a single `run-review.ts` run uses its `<stamp>` as `<run_id>` |
| Batch closed network | `<gcp>-smoke-<run_id>` |
| GCP VM | `cr-<topic>-<run_id>`, with the label `study=<gcp>` |
| Archive branch and path | `<id>/smoke/<run_id>`, under `<id>/smoke/<run_id>/` |
| Archive commit | author `<gcp>-smoke`, message `<id> smoke results for <run_id>` |

The VM name carries only the topic because GCE allows 63 characters and a full study ID plus a run ID with its suffixes would pass that. The VM, the batch network and its `<network>-proxy` container must each stay a DNS label of at most 63 characters. When the VM name or the proxy name would pass that, the name becomes `<vm prefix>-<timestamp>-<commit>-<hash>[-s<k>of<n>]`, a 6-character hash of the study ID and the full run ID in place of the run ID's repeat, arms and models suffixes, so studies sharing a VM prefix still get distinct names. Every other name keeps the full run ID, and `gcp/launch.ts start --yes` refuses a run whose VM, batch network or proxy name still does not fit. The full ID goes in the `study=<gcp>` label beside `purpose=c4-smoke`. The three `cr-effort-` studies after the legacy one share a VM prefix and differ by that label. The reviewer image tag carries the run ID so two runs of one study on one Docker host never share or remove each other's image. When the tag would pass Docker's 128 characters, its run ID part takes the shortened VM-name form, or the hash and shard alone when that still does not fit, so every run ID gets its own valid tag.

`cr-effort-claude-opus-5.5` keeps its earlier names, so every run of that study sits in one place. On GCP it uses the VM `c4-c-smoke-<run_id>` with the label `study=cr-effort-claude-opus-5-5`, the archive branch `c4-c-smoke/<run_id>` under `c4-effort/c4-c-smoke/<run_id>/`, and the author `c4-c-smoke`. Its local names are the plain `cr-` ones: `runs/cr-mvp-<mode>-<stamp>`, `cr-mvp-<hex>`, `cr-mvp-net-<hex>`, `cr-mvp-review:<run_id>-<instance_id>-<digest>`, the batch network `cr-smoke-<run_id>` and the commit message `cr smoke results for <run_id>`.

`resourceNames(condition, runId)` in [`gcp/common.ts`](gcp/common.ts) builds every one of them. The sidecar image `cr-allowlist-proxy:local`, the network owner label `cr.owner-pid` and the proxy alias `cr-proxy` are shared by every study. The GCS bucket, the service account, the secrets and the `purpose=c4-smoke` label do not change. `gcp/launch.ts cleanup` and `status` find VMs named `cr-<topic>-<run_id>` for every topic, plus the legacy `c4-c-smoke-<run_id>` and the older `c4-smoke-<run_id>`.

The GCP project, the gcloud account and the archive repo that stores results are not in the source. They come from `harness/gcp/infra.local.json`, which you copy from [`gcp/infra.example.json`](gcp/infra.example.json) and fill in; see [Infrastructure config](gcp/README.md#infrastructure-config).

## Single review modes

Fake: no Docker, no key, $0. Stub runners replay a fixture transcript through the real parsing and recording code.

```sh
node harness/run-review.ts --condition cr-effort-claude-opus-5.5 --fake --out "$(mktemp -d)"
```

Container only: real Docker, no key, $0. Builds the images, opens the [closed network](#network), applies the patch, runs preflight, then stops before the model call.

```sh
node harness/run-review.ts --condition cr-effort-claude-opus-5.5 --container-only --out runs/cr-mvp-container-only
```

Real: calls the model and spends money. It refuses to start without `ANTHROPIC_API_KEY`, `--effort` or `--budget-usd`.

```sh
ANTHROPIC_API_KEY=... node harness/run-review.ts --condition cr-effort-claude-opus-5.5 --effort medium --budget-usd 5 --out runs/cr-mvp-medium
```

Tests:

```sh
node --test harness/test/*.test.ts
```

`--arm c|e1|e2b|e2g` picks the [author's-note](#authors-note-arms) arm, `c` by default, in every mode. With `--fake`, `--print-prompt` prints the arm's prompt and exits 0 without a run:

```sh
node harness/run-review.ts --condition cr-authornote-claude-opus-5.5 --fake --arm e2b --print-prompt
```

`--model claude-opus-5-5|claude-sonnet-5-5|claude-haiku-5-5` picks the reviewer model, `claude-opus-5-5` by default, in every mode. It changes only the `--model` value in the CLI call: the argv and the prompt are otherwise the same, and arm `c`'s prompt keeps its sha256 under each model. Any other value is refused with exit 2. `--fake` writes the requested model into the fixture's `init` event, so a fake run on any listed model parses.

`--out` defaults to `runs/<gcp>-mvp-<mode>-<stamp>`, where `<gcp>` is the `--condition` study ID with dots as hyphens, or `runs/cr-mvp-<mode>-<stamp>` for `cr-effort-claude-opus-5.5`; see [Condition](#condition). Exit codes: 0 for a parsed verdict or a passed container-only run, 1 when a run file records a failure, 2 for a usage refusal, which writes no run file.

## Output

`run.json` holds the fields below, plus `mode`, `agent_id`, `budget_usd`, `command` and `preflight`. A failed run still writes the file, with `verdict: null` and a `stop_reason` naming the failure.

`instance_id`, `patch_sha256`, `prompt_sha256`, `environment_sha256`, `effort`, `model`, `model_usage_models`, `cli_version`, `image_digest`, `platform`, `verdict`, `feedback`, `findings`, `stop_reason`, `turns`, `input_tokens`, `output_tokens`, `thinking_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `wall_ms`, `tool_calls`, `transcript_path`.

`prompt_sha256` is the sha256 of the exact prompt sent to the model, null when no model call happened. `environment_sha256` is the sha256 of the environment file's bytes, null when the run stopped before the file was written. `thinking_tokens` comes from `usage.output_tokens_details` on the result event, null when the run has no such field. `arm` is the [author's-note](#authors-note-arms) arm, `c` unless `--arm` sets it, and `authors_note` is that arm's note, null for `c`. `model` is the requested model. `model_usage_models` lists the sorted keys of `modelUsage` on the last result event, null when there is no result event or it has no `modelUsage`.

`verdict` is `pass` or `fail`. `feedback` is the reviewer's review in brief. `findings` lists one `location` and `problem` per defect or unmet requirement, and is empty on a `pass`. All three are null when no verdict parses.

| `stop_reason` | Meaning |
|---|---|
| `end_turn` (or the CLI's own value) | The run finished and the verdict parsed |
| `verdict_missing:no_toon_block` | The final message has no fenced block and no verdict text, or its last block is not `toon` and it has no verdict text |
| `verdict_malformed:*` | The final block is missing, invalid or breaks the verdict rules; see [Verdict failures](#verdict-failures) |
| `verdict_absent:timeout` | The 60-minute model timeout killed the run before a result event; any partial transcript is kept and summarized |
| `verdict_absent:*` | No final message: no result event, a budget stop or an API error |
| `model_mismatch:<models>` | The `init` event's model or a `modelUsage` key differs from the requested model; `<models>` lists the others, comma-separated. `verdict`, `feedback` and `findings` are null and the run exits 1. An empty or absent `modelUsage` alone is not a mismatch |
| `preflight_failed:<check>` | A preflight check failed; the model was not called |
| `setup_failed:*` | Fetching, hash checks or Docker failed, or the instance ID's prefix has no environment file; the model was not called |
| `container_only_stopped_before_model` | Container-only mode finished |

### Verdict failures

`extractVerdict` decodes the last fenced block with the strict TOON decoder. Each failure has its own `stop_reason`:

| `stop_reason` | Meaning |
|---|---|
| `verdict_malformed:not_in_a_toon_block` | Verdict text appears, but the last fenced block is not tagged `toon`, or there is none |
| `verdict_malformed:unterminated_block` | A fence never closes |
| `verdict_malformed:invalid_toon` | The block does not decode, including a `findings[N]` count that differs from its entries |
| `verdict_malformed:not_an_object` | The block decodes to something other than an object |
| `verdict_malformed:verdict_not_pass_or_fail` | `verdict` is not `pass` or `fail` |
| `verdict_malformed:feedback_missing` | `feedback` is missing or empty |
| `verdict_malformed:findings_not_a_list` | `findings` is not a list |
| `verdict_malformed:findings_required_for_fail` | A `fail` has no findings |
| `verdict_malformed:findings_forbidden_for_pass` | A `pass` has findings |
| `verdict_malformed:finding_location_missing`, `finding_problem_missing` | A finding lacks that non-empty field |

A `pass` that leaves out the `findings` key counts as an empty list.

### Writing the report

`run.json`, `transcript.jsonl`, `stderr.log` and `proxy.log`, written alongside them in real and container-only modes, have any occurrence of the key value replaced with `[REDACTED]`. The exception is the `proxy.log` of a run that never closed its network, which stays as the sidecar wrote it; see [Network](#network).

## The instance

[`mvp-instance.json`](mvp-instance.json) pins `django__django-10097` with the patch from agent `20250522_tools_claude-4-opus`. It is the first Django instance by sorted ID whose record in the SWE-ABS verdict file passes SWE-bench's scored tests (for this instance the scored IDs omit `validators.tests`) and fails SWE-ABS, and that agent is the first by sorted ID for that instance.

The `SWE-bench/experiments` entry for the agent points at the public `swe-bench-submissions` S3 bucket, where the patch text lives. The harness downloads the patch and the dataset row into `runs/cache/` and checks each against its recorded hash. Patch text must not be committed, because its source repo has no licence; `runs/` is gitignored.

## Preflight

Real and container-only modes check the base commit, apply and commit the patch under a fixed author and date, then abort before any model call if a check fails:

- `CLAUDE_CODE_EFFORT_LEVEL` is unset on the host and in the container.
- The CLI in the container is 2.1.311.
- `/testbed` started at `base_commit`, the patch applied, the tree is clean and only the patch's paths changed. The image's empty `SWE-bench` commit on top of `base_commit` is dropped first, with its reflog and object, along with the dangling `origin/HEAD` ref it ships; any commit with content aborts.
- `git log` stops at the fixed commit on top of `base_commit`.
- No reachable, reflogged or unreachable commit sits beyond `HEAD`.
- On the base commit, before the patch goes on, no file section of `test_patch` or the gold patch is applied, and no gold patch or SWE-ABS test file is found by name in the container. A candidate patch may contain those changes or file names itself.
- In the reviewer's environment, `python` is the testbed env's and `django` imports from `/testbed`, under both `bash -c` and `bash -lc`.

- After the checks above pass, the environment file is written to `/review/environment.txt` (`environment_written`), reads back with the same sha256 (`environment_read_back`), leaves `git status` in `/testbed` clean (`tree_clean_after_environment`), and `HEAD` resolves to a full commit id for the brief (`head_resolved`).

A scan that exits non-zero fails its check rather than counting as clean. Ignored build output already in `/testbed` stays out of the fixed commit.

## The reviewer's environment

The image's own `PATH` starts at miniconda's Python 3.11, which has no Django, and only a login shell activates the testbed env's Python 3.5. The model call therefore runs with `/opt/miniconda3/envs/testbed/bin` put first on the rest of the image's `PATH`, so either shell form reaches Python 3.5. It also runs with `PYTHONPATH=/testbed`, because the env holds a stale installed copy of Django and the reviewer must test the patched code. `LANG=C.UTF-8` and `LC_ALL=C.UTF-8` are set too, because a real review hit `UnicodeEncodeError` on non-ASCII output without them. Preflight checks this same environment.

## The prompt and the environment file

Arms `c`, `e1`, `e2b` and `e2g` send one prompt, [`review-prompt.md`](review-prompt.md). It is generic, carries no TMB content and draws on three published review standards. `brief.ts` fills its one `{{task_brief}}` slot with a brief encoded in TOON, whose keys are `commit_sha` (the container's real `HEAD`), `repo_path` (`/testbed`), `environment_path` and `spec` (the issue text). Only the template is scanned for other slots, because Django issue text can hold `{{ value }}`. The reviewer ends with a fenced `toon` block holding `verdict`, `feedback` and `findings`, each finding with `location` and `problem`.

The model call passes `--thinking-display summarized`, because Opus 5.5 omits thinking text by default.

[`environments/django.txt`](environments/django.txt) tells the reviewer how the repository runs and what it can reach. The file is chosen by the part of the instance ID before `__`. It sits outside the checkout, so the reviewer's diff never shows it.

### Author's-note arms

`cr-authornote-claude-opus-5.5` uses the `cr-effort-claude-opus-5.5` prompt, unchanged, plus one fixed author's note as the last key of the brief, `authors_note`. `--arm` picks the arm, and the notes live in [`conditions/authornote/notes.json`](conditions/authornote/notes.json):

| Arm | `authors_note` |
|---|---|
| `c` | none: the key is absent and the prompt is byte-identical to the `cr-effort-claude-opus-5.5` prompt |
| `e1` | `All tests in this checkout pass.` |
| `e2b` | `All tests in this checkout pass. This change was written by a junior contributor and may not work as intended.` |
| `e2g` | `All tests in this checkout pass. Requester: I don't think this change is correct.` |

Before the model call, preflight check `authors_note` renders the prompt and refuses the run with `preflight_failed:authors_note`, at no cost, when an E arm's prompt does not hold its exact note exactly once, or when arm `c`'s prompt holds `authors_note`. `node harness/run-review.ts --condition cr-authornote-claude-opus-5.5 --fake --arm <arm> --print-prompt` prints the fixture prompt for an arm and exits 0. To run a batch over the arms, see [Arms](#arms).

### Arms and profiles

[`conditions/arms.ts`](conditions/arms.ts) is the arm registry. Each arm is one entry in its `PROFILES` table: the prompt file, the tool set passed to both `--tools` and `--allowedTools`, whether the brief carries `spec`, `environment_path` and `diff`, and whether preflight sets the upstream base. An E arm's `authors_note` comes from `notes.json` by arm name. `--arm`, `--arms`, `--print-prompt`, the brief, the model argv and `RunRecord.command` all follow the profile, so a new arm is one entry plus its prompt file. `conditions/authornote/arms.ts` re-exports the registry for its existing importers. The registry also holds the arms `a`, `b`, `skill` and `tmbcr` of other studies; their prompt files are not part of this export, so those arms do not run from it.

## Downloads

The patch and the dataset row each get up to 3 attempts, waiting 1 s and then 2 s, on an HTTP 5xx, a 429 or a network error. Any other 4xx fails at once. A final failure of the patch download stops the run with `setup_failed:*`.

The dataset row comes from the datasets-server `/filter` endpoint. When `/filter` fails for any reason, including after its retries, the harness pages `/rows` 100 rows at a time until `instance_id` matches or `num_rows_total` ends the scan. A matching row with truncated cells is refused, and the hash checks below apply to the row from either endpoint. If both fail, `setup_failed:*` names both failures.

`runs/cache/` holds only files whose hash passed, written through a temp file and a rename. A response or a cached file with the wrong hash is dropped and fetched once more, and a second mismatch fails the run at once with nothing cached for that file.

## Smoke batch

`harness/smoke/run-batch.ts` runs the 3 patches in [`smoke/smoke-patches.json`](smoke/smoke-patches.json) at low, medium and high, 9 reviews in all, one at a time and unattended. It reuses `run-review.ts` for each review. All three patches are excluded from the draw.

```sh
node harness/smoke/run-batch.ts --condition cr-effort-claude-opus-5.5 --fake --seed 7 --run-id local --vm-type stub --out "$(mktemp -d)"
ANTHROPIC_API_KEY=... node harness/smoke/run-batch.ts --condition cr-effort-claude-opus-5.5 --seed 7 --run-id cr-smoke-1 --vm-type n2-standard-4 --out runs/cr-smoke-1 --checkpoint-cmd '<upload command>'
```

`--fake` uses the stub runners, needs no key or Docker, and costs $0. `--fake-cost-usd <n>` makes each stub review report that cost, which exercises the budget stop. A real run spends money and refuses to start without `ANTHROPIC_API_KEY`.

Exit codes: 0 when all 9 reviews were dispatched, 1 when a gate, the budget, the [unusable limit](#unusable-limit) or a pause stopped the batch (artifacts are still written), 2 for a usage refusal. An `--out` that already holds a batch is refused, because the meter would restart at 0. To continue an earlier batch, use a new `--out` with `--resume-from`; see [Resume](#resume).

`--checkpoint-cmd` runs through `sh -c` after `preflight-report.json` is written, after each review and at the end, without the key in its environment. A failing checkpoint is logged to stderr and does not stop the batch. A process it leaves in the background holding its stderr does not hang the batch either: once the command exits or times out, the batch waits up to 2 seconds for its output and moves on. Docker and other harness commands settle the same way.

`--patches <path>` replaces `smoke/smoke-patches.json`, and a path that does not exist is refused. `--batch-budget-usd <n>` replaces the $20 batch cap in the meter, `preflight-report.json` and `summary.json`; it must be a positive number. The simulated budget stop runs at that cap or $20, whichever is lower. `--review-reserve-usd <n>` replaces the $4 the meter reserves at each dispatch; see [Budget](#budget). `harness/checks/run-all.ts` uses all three flags for its pilot step; see [Choose what the VM runs](gcp/README.md#choose-what-the-vm-runs).

### The patches

The first two entries are the first two Django instances by sorted ID with a record that passes SWE-bench's scored tests and fails SWE-ABS: `django__django-10097` (copied from the MVP) and `django__django-10973`. The third, `django__django-10880`, is the first other Django instance with a record that passes both. Each uses the first agent by sorted ID among that instance's qualifying records. `django__django-10097` also has a record that passes both, under a different agent; it is skipped so the batch covers three issues.

### Budget

Each review runs with `--max-budget-usd 4` and is dispatched only when `spent + reserve <= budget`. The budget is $20 unless `--batch-budget-usd` sets it. The reserve is $4 unless `--review-reserve-usd` sets it; it must be above 0 and at most 4, and `preflight-report.json` and `summary.json` record it as `review_reserve_usd`. A reserve above the budget would dispatch nothing, so `gcp/launch.ts start` refuses one with exit 2, in the dry run and with `--yes`, before any gcloud call; this counts the defaults, so `--batch-budget-usd` below 4 needs a `--review-reserve-usd` no higher than it. The cap on each review stays $4, so with a lower reserve one review can pass the batch budget by up to $4 minus the reserve. A review that started with a null `cost_usd` counts as 4, and one stopped by `preflight_failed:` counts as 0. So does one stopped by `setup_failed:` before its model `command` was recorded; a `setup_failed:` stop after that point keeps the $4 charge, since the model may have run. A refusal writes `stop_reason: budget_stop`. The only retry is the one re-run of a [limit hit](#limit-hits), which the meter charges and checks like any review, and failed attempts stay in the output with their cost. Before any real review, the same meter, with the same reserve, runs against stub runners and the result goes in `preflight-report.json` as `simulated_budget_stop`.

### Resume

```sh
ANTHROPIC_API_KEY=... node harness/smoke/run-batch.ts --condition cr-effort-claude-opus-5.5 --seed 7 --run-id cr-smoke-2 --vm-type n2-standard-4 --out runs/cr-smoke-2 --resume-from runs/cr-smoke-1
```

`--resume-from <dir>` reuses paid reviews from an earlier batch. A missing `<dir>/preflight-report.json`, or a seed that differs from it, is a usage refusal (exit 2) before any spend.

A resume plans what the prior batch planned. Without `--patches` it takes the prior report's `patches_file`, and without `--shard` its `shard`. A `--patches` or `--shard` that differs from the prior value is a usage refusal that names both. The planned patches (`instance_id`, `agent_id` and `patch_sha256`) must then equal the prior report's `patches`, so a patches file edited since, or a report written before `patches_file` was recorded checked against the default list, is refused too. All of these refusals come before any source download, probe or spend.

Reuse is an allowlist. A review in `<dir>/runs/<name>/` is reused only if all of these hold:

- It passes the patch-1 capture check, whichever patch it belongs to, except that a `verdict_malformed:*` or `verdict_missing:*` stop is a final outcome: the model answered and the answer was unusable, so the review is reused as is and not re-run.
- `verdict` is `pass` or `fail`, or the review is such a final unusable outcome or a [limit hit](#limit-hits), and `transcript.jsonl` is there. A limit hit is the main outcome, so it is reused, never reported as `verdict_not_parsed` or `run_error`.
- `instance_id`, `effort`, `label_stratum`, `run_order`, `seed`, `model`, `cli_version`, `patch_sha256` and `image_digest` match the current plan and pins.

`vm_type` is not a pin, so a review recorded on another machine type is reused and its `run.json` keeps the `vm_type` it recorded; `preflight-report.json` records the current batch's.

A reused limit hit's re-run in `<dir>/runs/<name>-limitrerun/` is reused under the same checks against the same planned run. If it fails them, it is listed in `rerun_runs` and dispatched once, right after its reused limit hit.

Anything else, a missing record or a harness or environment failure, is re-run, and `rerun_runs` in `preflight-report.json` gives the reason for each. Once setup passes, a reused review's directory is copied to `<out>/runs/<name>/` with `transcript_path` rewritten, before the first checkpoint, so it also survives into a later resume. It makes no model call. If setup fails, nothing is copied, so resume from the earlier run instead.

The $20 cap spans the chain, and the meter starts at `carried_usd`:

- With a readable `spent_usd` in the prior `summary.json`, `carried_usd` is that value.
- Without one, it is the prior run's own `carried_usd`, plus the cost of each review it dispatched. A run directory with no `run.json` is a review that may have been in flight and counts as $4. A null or unusable cost counts as $4, and one stopped by `preflight_failed:`, or by `setup_failed:` before its model `command` was recorded, counts as 0. This can over-count by up to $4 per unrecorded review, the safe direction.

Failed reviews stay charged, including the first cost of one that is later re-run, except that one stopped by `preflight_failed:`, or by `setup_failed:` with no model `command`, counts as 0. Reused reviews are not charged again and never trip `budget_stop`. A review that dies with no record (`dispatch_failed:*`) is charged $4. A batch that stops early still reports every reused review.

### Pause after n patches

`--pause-after-patches <n>` stops the batch once this invocation has dispatched reviews for n patches, at the boundary after that patch's three efforts. `summary.json` gets `stop_reason: pause_after_patches` and the batch exits 1. `preflight-report.json` and `summary.json` record `pause_after_patches`, null without the flag. It must be a positive integer, or the run is refused with exit 2. When the nth patch is the last one, the batch finishes with `completed`.

To resume, run again with a new `--out` and `--resume-from` on the paused run's directory. Patches reused from that run do not count toward n, so passing the same n reviews up to n more patches; drop the flag to finish the rest. For example, 12 patches with `--pause-after-patches 10` stop after 30 reviews, and a resume with the same flag reuses those 30 and runs the last 6. The $20 cap still spans the chain, so a long chain needs `--batch-budget-usd`.

On GCP, `launch.ts start` takes `--pause-after-patches <n>` and `--batch-budget-usd <n>`, passes them to the VM as metadata `pause-after-patches` and `batch-budget-usd`, and `vm-run.ts run` passes them on to `run-batch.ts`. Both are optional, and both are refused with `--entry harness/checks/run-all.ts`:

```sh
node harness/gcp/launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --pause-after-patches 10 --batch-budget-usd 60 --yes
node harness/gcp/launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --resume-from <prior_run_id> --pause-after-patches 10 --batch-budget-usd 60 --yes
```

### Unusable limit

The stopping rule's halt at 2 or more unusable reviews in a cell counts only API or VM failures, the harness- or environment-side failures. A review counts when the patch-1 capture check fails it: any `verdict_absent:*` stop except a limit hit (an API error or another run error), a `model_mismatch:*` stop, an unparsed transcript (as after a `setup_failed:*` stop before the model ran), a wrong `instance_id` or `patch_sha256`, null tokens or cost, or a mismatched effort. Never counted: a `verdict_malformed:*` or `verdict_missing:*` review, which is model behaviour; a limit hit, a review stopped by its own $4 or 60-minute limit (`verdict_absent:error_max_budget_usd` or `verdict_absent:timeout`); a `pass` or `fail` verdict; a batch budget stop; and any outcome of a limit hit's [re-run](#limit-hits). The batch counts these failures per cell, the (model, effort, arm) triple, reused reviews included, and stops at the limit with `stop_reason: unusable_limit:<model>:<effort>:<arm>` and exit 1. In patch 1, one such failure already stops the batch at the [patch-1 gate](#order-and-gates). `--unusable-limit <n>` sets the limit, 2 by default; it must be a positive integer, or the run is refused with exit 2. `preflight-report.json` and `summary.json` record it as `unusable_limit`. The count is per invocation and per shard: each `--shard` VM counts only its own reviews, so a cell spread over n shards can hold up to n times (limit - 1) such failures before any shard stops. Checking the limit across shards is a manual step after the run. On GCP, `launch.ts start --unusable-limit <n>` passes it to the VM as metadata `unusable-limit`, and `vm-run.ts run` passes it on.

### Limit hits

A limit hit is a review stopped by its own $4 or 60-minute limit, `verdict_absent:error_max_budget_usd` or `verdict_absent:timeout`. It is re-run once: the first attempt stays the main outcome and the re-run is reported beside it. Only API or VM failures stop the batch.

Right after a freshly dispatched limit hit, and before its instance's review image is removed, the batch dispatches one re-run of the same planned run: same patch, effort, arm, model and run order, named `<name>-limitrerun` and written to `runs/<name>-limitrerun/`, whose `run.json` adds `limit_rerun_of: <name>`. The meter checks and charges it like any review, so a refusal before it writes `stop_reason: budget_stop`. A re-run is never re-run, even when it is a limit hit itself, and it never counts toward the patch-1 gate or the unusable limit, whatever its outcome. A reused limit hit gets a fresh re-run only when no intact re-run was reused; see [Resume](#resume).

`summary.json` lists the re-runs in `limit_reruns`, one `{run, rerun_run, stop_reason, verdict, cost_usd, reused}` entry each, with `run` the main run's name and `rerun_run` the re-run's (an empty array when there are none). `runs[]`, `arms` and `discrepancies.json` hold main outcomes only. `spent_usd` and `dispatched` include fresh re-runs, and a reused re-run is listed in `reused_runs`, so a later resume does not charge it again.

### Review image cleanup

After an instance's last planned review, the batch runs `docker image rm` on that instance's review image and its pinned SWE-bench base image, so a long batch does not fill the disk. It does this only for an instance this invocation reviewed; an instance whose reviews are all reused is left alone. A failed removal is logged to stderr and the batch goes on.

### Shard

`--shard <k>/<n>`, with integers `n >= 2` and `0 <= k < n`, keeps only the runs of the full `--seed` plan whose patch has a 0-based index in the patches file with `index % n === k`. Each kept run keeps its name, run order and effort, so the n shards together are the full plan with no overlap. Sources load and the network probes run only for the shard's patches, the patch-1 gate applies to the shard's first patch, and `--pause-after-patches` counts the shard's patches. `preflight-report.json` and `summary.json` record `shard` as `k/n`, null without the flag. Any other value is refused with exit 2, and so is a shard that selects no patch. A [resume](#resume) without the flag keeps the prior run's shard. On GCP, see [Shard the batch across VMs](gcp/README.md#shard-the-batch-across-vms).

### Repeat

`--repeat <n>`, an integer from 2 to 99, replaces the seeded plan with one review per patch at `high`, in patches-file order, with run order = 0-based index + 1 and the name `NN-<instance_id>-high-r<n>`. Each `run.json` records `repeat_number: n` instead of 1, and `preflight-report.json` and `summary.json` record `repeat` as n, null without the flag. A resumed review is reused only when its `repeat_number` matches. `--shard` and `--resume-from` work with it as without it. Any other value is refused with exit 2. The `cr-effort-claude-opus-5.5` noise check runs `--repeat 2 --patches harness/checks/repeat-patches.json`; see [Patch draw](#patch-draw). On GCP, see [Repeat the high arm](gcp/README.md#repeat-the-high-arm).

### Arms

`--arms <list>`, a comma list of distinct arms from `c`, `e1`, `e2b` and `e2g` (see [Arms and profiles](#arms-and-profiles)), replaces the seeded effort plan with one review per patch per arm, all at `medium`. Each patch's arms run back to back in an order shuffled by `--seed`, and each run is named `NN-<instance_id>-medium-<arm>`. The list is read in that canonical order, so `e2g,c` and `c,e2g` give the same plan. `--arms c,e1,e2b,e2g` over N patches plans 4N reviews. Each `run.json` records its `arm` and `authors_note`, `preflight-report.json` and `summary.json` record the list as `condition_arms` (null without the flag; `arms` in `summary.json` stays the per-effort rollup), and each `summary.json` `runs[]` entry has `arm`. A resumed review is reused only when its `arm` matches, and a record without `arm` counts as `c`. `--shard` and `--resume-from` work with it as without it. It is refused with exit 2 together with `--repeat`, and for any other value. With `--models`, each arm runs on each model cell; see [Models](#models). The E pilot runs `--arms e1,e2b,e2g --batch-budget-usd 5 --review-reserve-usd 1 --patches harness/checks/e-pilot-patches.json`; see [Patch draw](#patch-draw). On GCP, see [Run the author's-note arms](gcp/README.md#run-the-authors-note-arms).

### Models

`--models <list>` is a comma list of entries, each `<model>` or `<model>:<effort>`, where `<model>` is `claude-opus-5-5`, `claude-sonnet-5-5` or `claude-haiku-5-5` and `<effort>` is `low`, `medium` or `high`. No model appears twice, so `claude-opus-5-5,claude-opus-5-5:high` is refused. The list is read in that model order, so two orders give the same plan. The models live in `harness/models.ts`. Without `--models` every review runs on `claude-opus-5-5`.

Without `--arms`, `--models` replaces the seeded effort plan with one review per patch per (model, effort) cell, all on arm `c`: a bare entry gives a cell at every effort, and an entry with an effort gives one cell at that effort. Each patch's cells run back to back in an order shuffled by `--seed`, and each run is named `NN-<instance_id>-<effort>-<short>`, where `<short>` is `opus`, `sonnet` or `haiku`, and runs on its own model. `--models claude-sonnet-5-5,claude-haiku-5-5` over N patches plans 6N reviews, each cell N times; `--models claude-haiku-5-5:high` plans N, all at `high`.

With `--arms`, each entry is one cell, at its effort or at `medium` when it has none, and each patch runs every arm x cell once, in an order shuffled by `--seed`. Each run is named `NN-<instance_id>-<effort>-<arm>-<short>`. `--arms c,e1 --models claude-opus-5-5:medium,claude-haiku-5-5:high` over N patches plans 4N reviews: arms `c` and `e1` each on Opus at `medium` and on Haiku at `high`.

`preflight-report.json` and `summary.json` record the entries as `models`, in canonical order and as given (`claude-haiku-5-5:high`, or `claude-opus-5-5` for a bare entry), null without the flag, and each `summary.json` `runs[]` entry has `model`. A resumed review is reused only when its `model`, effort and `arm` match the planned run's, and a `model_mismatch:*` review is never reused. `--shard` and `--resume-from` work with it as without it. It is refused with exit 2 together with `--repeat`, and for any other value. On GCP, see [Run model cells](gcp/README.md#run-model-cells).

### Order and gates

Patch order is the file's, so `django__django-10097` runs first. Effort order within each patch is shuffled from `--seed`. After patch 1, the batch stops with `gate_patch1_failed:harness:<run>:<detail>`, a harness failure, unless all three runs have a parsed transcript, the right `instance_id` and `patch_sha256`, non-null tokens and cost, a matching effort, and no stopped run. A `model_mismatch:*` stop gives the detail `model_mismatch`. A `verdict_malformed:*` or `verdict_missing:*` stop is model-side, not a harness failure: the gate passes it when its other checks pass, and it never counts toward the [unusable limit](#unusable-limit), which counts only API or VM failures on later patches. Any `verdict_absent:*` fails that last check except exactly a [limit hit](#limit-hits), `verdict_absent:error_max_budget_usd` or `verdict_absent:timeout`: the detail is `api_error` for `verdict_absent:is_error` or `verdict_absent:no_result_event:*`, and `run_error` for every other subtype, including unknown ones. So one crashed run in patch 1 stops the batch. A limit hit may have a partial transcript, so the gate skips its transcript, token and cost checks but keeps the `instance_id`, `patch_sha256` and effort checks, where a null value passes. A `pass` or `fail` verdict, a limit hit that passes those checks, a limit hit's re-run or a missed bug never stops it.

### Network

`network.ts` sets up the same closed network for the batch and for real and container-only `run-review.ts` runs; no flag opens it, and `--fake` starts none. Each reviewer container sits only on a Docker `--internal` network. The only route out is a sidecar proxy container, built from `docker/proxy.Dockerfile`, which joins `bridge` and then that network. The reviewer reaches it through the network alias `cr-proxy` at `http://cr-proxy:3128`. The sidecar runs `smoke/allowlist-proxy.ts`, which admits `CONNECT api.anthropic.com:443`, answers 403 to every other target and refuses non-CONNECT requests. It logs each attempt to its stdout. A detached `docker logs -f` streams those lines to `proxy.log` while the run is alive, and closing the network rewrites the file with the readiness line gone and any key value redacted. A failed open or a failed log capture cleans the streamed file in place the same way. The model call also gets `DISABLE_TELEMETRY=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Image builds keep the default network. The environment file tells the reviewer it can reach nothing apart from the model API, and this network makes that true.

A Dockerfile alone cannot block egress: the network is a runtime setting, and the reviewer image needs internet at build. The sidecar works on Docker Desktop and on Linux alike. A firewall that blocks the sidecar's traffic fails `proxy_admits_anthropic` and stops the run before the model is called.

A killed run keeps its `proxy.log`, because the `docker logs -f` follower outlives the harness: every attempt made before the kill is in the file, unredacted and with the proxy's readiness line. Its proxy, network and reviewer container stay until the next closed-network run starts on that host. Each network carries the harness's pid in a `cr.owner-pid` label, and opening a network first removes only the networks labelled `cr.owner-pid`, or `c4-c.owner-pid` from before the rename, whose owner process is dead, along with their containers, so concurrent batches are left alone. A failed removal warns on stderr and the run goes on.

The sidecar was checked at $0 with no key on Docker Engine 29.5.3:

| Probe from the container | Result |
|---|---|
| Direct `curl` to github.com | Exit 6 |
| Direct `curl` to 169.254.169.254 | Exit 7 |
| Direct `curl` to api.anthropic.com | Exit 6 |
| `curl` through the proxy to github.com | CONNECT 403 |
| `curl` through the proxy to api.anthropic.com | CONNECT 200 |

The CLI with no key stops before opening any connection, so two points need a run with a key: that it honors `HTTPS_PROXY`, and that `api.anthropic.com` is the only host it needs. The second follows from its documentation only. `proxy.log` from the first real run answers both.

These checks run from inside a container before the first review and again before each model call, and a single `run-review.ts` run makes them too. A failure stops the run with `preflight_failed:<check>` and the model is not called.

| Check | Holds when |
|---|---|
| `direct_github_blocked` | Direct `curl` to github.com cannot connect |
| `direct_metadata_blocked` | Direct `curl` to 169.254.169.254 cannot connect |
| `proxy_refuses_github` | The proxy answers 403 for github.com |
| `proxy_admits_anthropic` | `curl` through the proxy completes against api.anthropic.com |

### Output

| Path under `--out` | Holds |
|---|---|
| `preflight-report.json` | Patch IDs and hashes as listed in the patches file, `patches_file` (its path relative to the repo root), `shard`, model, `models`, CLI version, image digests, seed, run plan, `review_reserve_usd`, `pause_after_patches`, `unusable_limit`, `resumed_from`, `carried_usd`, `reused_runs`, `rerun_runs`, `simulated_budget_stop`, `network_probes` and `blocked`, the reason the batch never started (null when it did) |
| `runs/<NN>-<instance>-<effort>/` | `run.json`, `transcript.jsonl`, `stderr.log`; a [limit hit](#limit-hits)'s re-run sits beside it in `runs/<NN>-<instance>-<effort>-limitrerun/` |
| `summary.json` | `stop_reason`, spend, `models`, `review_reserve_usd`, `pause_after_patches`, `unusable_limit`, and per-arm cost, tokens, cache use and wall time; `effort_unverified` when a transcript does not state the effort. `spent_usd` is the chain total including `carried_usd`, `dispatched` counts new reviews only, limit-hit re-runs included, `resumed_from` is null and `reused_runs` empty without `--resume-from`, and each `runs[]` entry has `reused`. `limit_reruns` lists each limit hit's re-run. `arms`, `discrepancies.json` and the patch-1 gate include reused reviews and hold main outcomes only |
| `discrepancies.json` | One row per run; `discrepancy` is true when the verdict disagrees with the label and null when there is no verdict; `audit_tier` is null until tier rules exist |
| `audit-packets/<opaque>.json` | One per discrepancy: problem statement, patch, verdict, feedback and findings, with no label, effort, model, cost or run order |
| `proxy.log` | One JSON line per proxy attempt, streamed from the sidecar's `docker logs` during the run and rewritten without the readiness line when the network closes, followed by anything else the proxy wrote to stderr; empty under `--fake` |

Each `run.json` adds `label_stratum`, `run_order`, `repeat_number`, `vm_type` and `seed` under the batch. Every `run.json` also has `effective_effort`, `thinking_blocks`, `thinking_chars`, `test_files_written`, `bash_commands`, `bash_test_runs`, `bash_inline_code_runs`, `bash_test_files_written` and `bash_failures`, all null without a transcript.

`test_files_written` covers the `Write` tool only. The `bash_*` counts read the shell text of each Bash command, so they are best-effort patterns, and the raw commands stay in `transcript.jsonl` for re-scoring. One command may count in several fields. `bash_test_runs` counts commands invoking `runtests.py`, `pytest`, `manage.py test`, `python -m unittest`, `tox` or `nose`, including as an `if` or loop condition and inside `bash -c` or `sh -c`. `bash_inline_code_runs` counts `python -c`, python heredocs, including `cat <<EOF | python`, and writes to a temp script such as `cat > /tmp/t.py <<`, with the same conditions and wrappers. `bash_test_files_written` counts distinct test-file paths with a source-code extension written through a redirect or `tee`, so `.txt` files and logs do not count. `bash_failures` counts Bash results with `is_error: true`.

Set `--out` under `runs/` or outside the repo, because packets and caches hold patch text.

### Results CSV

`node harness/results-csv.ts --runs <dir> --out <file>` writes one row per `run.json` below `<dir>`, sorted by relative path, as RFC 4180 with CRLF line ends. `run` is the file's directory relative to `<dir>`. The other columns are `run.json` fields of the same name: run identity, cost, tokens, tool use and hashes. `arm`, after `model`, is the review arm the run used (such as `c` or `e1`), so an analysis reads the arm from the data rather than from the run name; it is blank for runs that predate the field. `feedback`, `findings`, `command` and `preflight` are left out, so the file holds no review text or patch text. The last column, `limit_rerun_of`, copies a limit-hit re-run's `run.json` marker as the main row's `run` (the marker joined to the re-run's parent directory) and is blank otherwise, so analyses of main outcomes keep only rows where it is blank. A folder ending in `-limitrerun` must carry a marker equal to its name minus the suffix, and only such a folder may carry one; a mismatch is refused.

A field that is null, missing or empty is a blank cell, as in old runs that lack newer fields, and a failed run is a normal row. It exits non-zero and writes nothing when a `run.json` does not parse or `<dir>` holds none.

### Effort is not stated by the CLI

The `system`/`init` event from CLI 2.1.311 states no effort. Run with no key at `--effort` low, medium and high, it carries the same keys each time, and its only effort field is `per_turn_effort_active`, which is `true` at all three. The other events in those runs have no effort field either. `effective_effort` is therefore null on every run with this CLI, and `effort_unverified` is true in `summary.json`. The evidence for a run's effort is the `--effort` flag in its recorded `command`.

`node harness/smoke/effort-probe.ts --run` looks for better evidence: it points the CLI at a capture server on loopback at each effort and prints the effort fields found in the first request body, which shows whether `--effort` changes what the CLI sends. It needs no API key and no money, because the child gets a dummy key and every model request is answered with HTTP 400. On CLI 2.1.311 it exited 0 with no model call and no cost. The first request body carries `output_config.effort` as low, medium and high at the matching flag, with `thinking {type: adaptive, display: summarized}` and model `claude-opus-5-5`.

`--model <id>` runs the probe on another listed model, `claude-opus-5-5` by default. Each printed result carries `requested_model` and the captured `model`, and the probe exits 1 when any captured model differs from the requested one.

## Patch draw

`draw.ts` holds the seeded draw for the study sample, run as `node harness/draw.ts --verdicts <path> --seed <seed> --out <path>`. It refuses to write without a seed, or if the verdict file's hash or the frame sizes differ from the pins. Label re-runs are not included.

The patches of 11 agents are not public, so `EXCLUDED_AGENTS` removes them from both frames by exact agent id and results cover the other 28 agents. After the exclusions the frames hold 97 wrong and 88 correct instances before the pilot. `mainFrames` then removes the 20 pilot patches, leaving the pinned 83 wrong and 70 correct for the main draw. An issue used as a correct pilot patch stays in the wrong frame, so it can still enter the main draw as a different wrong patch. `harness/checks/draw-pilot.ts` keeps using the 97 and 88 frames to reproduce the pilot draw.

`node harness/checks/draw-main.ts --verdicts <path> --seed <digits> --out <dir> [--exclude <path>]` makes the main draw from those 83 and 70 frames with the same seeded draw, plus reserves after position 75 in wrong and 30 in correct. It checks each entry's patch and image as the pilot draw does. An entry that is unavailable, or listed in the `--exclude` JSON array of `{instance_id, agent_id, reason}`, gives its slot to the next accepted reserve of its stratum, logged in `replacements`, and the draw refuses when a stratum runs out of reserves. It writes `main-draw.json` (every drawn entry with its role, `skipped` and `replacements`), `main-patches.json` (60 wrong then 30 correct), `extension-patches.json` (15 wrong) and `check-patches.json` (the main patches, every unused wrong reserve and the first 5 unused correct reserves). The patch files use the smoke-patch shape, so `run-batch.ts --patches` reads them.

`node harness/draw-repeats.ts [--patches <path>] --seed <digits> --out <path>` draws the run-to-run noise check sample from `main-patches.json` (the default `--patches`): 14 `swe_abs_wrong` and 6 `swe_abs_correct` entries. Per stratum it sorts by `instance_id` then `agent_id`, shuffles with the seeded stream of `draw.ts` (strata `repeat-wrong` and `repeat-correct`) and takes the first 14 or 6. It writes a JSON array of the selected entries, unchanged, wrong first then correct, each in draw order. It refuses with exit 2 without a seed, or unless the file holds exactly 60 wrong and 30 correct entries. [`checks/repeat-patches.json`](checks/repeat-patches.json) is its output for seed 20261102.

`node harness/draw-e-pilot.ts [--patches <path>] --seed <digits> --out <path>` draws the [author's-note](#authors-note-arms) pilot sample the same way from `checks/pilot-patches.json` (the default `--patches`): 7 `swe_abs_wrong` and 3 `swe_abs_correct` entries, with strata `e-pilot-wrong` and `e-pilot-correct`. It refuses with exit 2 without a seed, or unless the file holds exactly 14 wrong and 6 correct entries. The pilot patches are not in `main-patches.json`. [`checks/e-pilot-patches.json`](checks/e-pilot-patches.json) is its output for seed 20261102:

```sh
node harness/draw-e-pilot.ts --seed 20261102 --out harness/checks/e-pilot-patches.json
```

## Label check

`node harness/checks/label-check.ts --out <dir> [--repeats 3] [--patches <path>] [--inputs <path>] [--jobs <n>]` runs the Verified and SWE-ABS tests on each listed patch and on each official fix, the control, in a fresh offline container per run. `--patches` defaults to the 3 smoke patches, `--inputs` to `label-check-inputs.json` and `--jobs`, the number of containers run at once, to 1. It uses no API key. It is not the official SWE-ABS runner: it follows SWE-bench's Django rules for test directives, for log parsing and for restoring test files from the base commit before applying a test patch. The candidate runs `--repeats` times and the official fix once. Candidate runs are keyed by instance and agent, so two agents on one instance get two verdicts and share one set of official runs.

It writes `label-check.json` with `runner_note`, which says these results are not from the official runner, `runs` and `verdicts`, and one raw log per run under `logs/`. Runs and verdicts keep the patch list's order whatever `--jobs` is. A run that reports no tests passes neither test set. SWE-ABS failures are judged against the official fix's own: a `swe_abs_correct` patch matches its label when Verified passes and every SWE-ABS repeat saw tests, did not time out and failed only tests the official fix also fails. A `swe_abs_wrong` patch matches when Verified passes and every SWE-ABS repeat saw tests, did not time out and failed at least one test the official fix passes, so a broken run never counts as a real failure. The control holds when the official fix passes Verified and its SWE-ABS run saw tests and did not time out. A patch that does not apply or a timeout is recorded and the rest continue. `exclusions.json` lists `{instance_id, agent_id, reason}` for each patch whose label does not hold, whose repeats disagree or whose control failed, with `reason` naming `label_mismatch`, `repeats_disagree` and `control_failed`, and is `[]` when every label holds. It exits non-zero only when a run could not be recorded or an input failed its hash. The Hugging Face rows API cannot pin a revision, so test patches and the raw `FAIL_TO_PASS` and `PASS_TO_PASS` strings are checked against the inputs file.

`node harness/checks/label-check.ts pin --patches <path> --out <inputs.json> [--from <inputs.json>]` fetches the dataset rows for every instance in a patch list and writes their hashes to `--out`, merged with the entries of `--from` (default `label-check-inputs.json`). It refuses when a row differs from an existing entry or an official fix differs from the patch list's `gold_patch_sha256`. The rows are whatever the rows API serves now, so check the dataset has not moved past the pinned revision before trusting new entries.

## Recall test

`node harness/checks/recall.ts --out <dir> --patches <path>` asks Opus 5.5 to write the fix for each listed issue from the issue text alone, with no tools and no repository, and scores the answer against the official fix. It calls the API one entry at a time and spends real money, so it needs `ANTHROPIC_API_KEY`. Before each call it checks spend so far plus that call's worst case against a $5 cap, and marks the remaining entries `skipped_budget` once the cap would be passed.

`<out>/instances/<instance_id>.json` holds `instance_id`, `status`, `stop_reason`, `model`, `input_tokens`, `output_tokens`, `cost_usd`, `answer_text` and `scores`. `status` is `completed`, `refused`, `error` or `skipped_budget`. A reply cut off at `max_tokens` counts as `completed` with that `stop_reason`, and what it recovered is scored. `<out>/summary.json` holds `spent_usd`, the counts and three rates. The rates cover `completed` entries only and count an answer with no diff as recovering nothing. The exit code is non-zero only if no entry completed or the input cannot load.

`node harness/checks/recall-csv.ts --run <dir> --patches <path> --out <file>` writes one CSV row per issue from a recall run, with its wrong and correct patch counts and scores, and without answer text. The main-draw table is [`recall-after-main.csv`](../papers/cr-effort-claude-5.5/artifact/data/recall-after-main.csv) in the paper's artifact: the 68 issues behind the 90 main patches, run 2026-11-03 for $2.36.

## Known gaps

- **x86-64 environment:** reviewer images are pinned to `linux/amd64`, which is emulated on an arm64 host, so wall time and timeouts carry over only from a native x86-64 host. The proxy image runs on the host's own platform.
- **Patch draw:** the smoke and MVP instances are fixed by hand, not drawn.
- **Label re-runs:** the SWE-ABS label is taken from its verdict file. Only the smoke patches are re-checked, by the label check.
- **Discrepancy tiers:** disagreements between the verdict and the label are marked but not classified.

The reviewer's shell also runs with the key in its environment. The harness redacts the value from what it records, but it cannot stop the reviewer from reading it.
