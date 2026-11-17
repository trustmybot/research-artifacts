# cr smoke test on GCP

Runs the smoke batch once on one on-demand VM in your GCP project `<project>`, then copies the results to GCS and to a new branch of your private vault repo `<vault-repo>`, and stops the VM.

It needs Node 24 and the harness's one pinned npm dependency. Run `npm ci` once, then run the commands from the repo root. The VM's startup script runs its own `npm ci` after unpacking the code.

Without `--yes`, `setup`, `start` and `cleanup` print the commands they would run and call no external tool, apart from read-only `git`. `status` is read-only. Every `gcloud` call on your laptop passes `--project=<project> --account=<account>`, and nothing changes your gcloud config.

## Infrastructure config

The project, your gcloud account and the vault repo are not in the source. Copy `infra.example.json` to `infra.local.json` in this directory and fill in `project`, `account` and `vaultRepo`; git ignores `infra.local.json`. A field missing from that file comes from `TMB_GCP_PROJECT`, `TMB_GCP_ACCOUNT` or `TMB_VAULT_REPO`, and otherwise keeps the example's placeholder. While any field holds its placeholder, `setup --yes`, `start --yes`, `cleanup --yes` and `status` refuse with exit 2 before any call; the plans without `--yes` still print. The startup script hands the project and vault repo to the VM as `TMB_GCP_PROJECT` and `TMB_VAULT_REPO`, since the code archive leaves `infra.local.json` out.

## Costs

- GCP credits cover compute only. The Anthropic key bills separately, against the Anthropic account.
- A stopped VM keeps billing its disk until `cleanup` deletes it.

## Your steps, in order

1. Fill in the [infrastructure config](#infrastructure-config). Log in to `gcloud` as `<account>` and to `gh` with admin access to `<vault-repo>`.

2. Read the plan, then apply it. Running it again is safe. If a binding fails because the new service account is not visible yet, run it again.

   ```sh
   node harness/gcp/launch.ts setup
   node harness/gcp/launch.ts setup --yes
   ```

   This enables the APIs and creates the bucket `gs://<project>-c4-smoke`, the service account `c4-smoke@<project>.iam.gserviceaccount.com` and the two secret containers. A secret that already exists counts as success. The service account gets roles on those two secrets and that one bucket, with nothing at project level. If `c4-vault-deploy-key` has no enabled version, it also generates a deploy key and registers it on the vault.

   On the bucket, the service account gets `roles/storage.objectAdmin` and `roles/storage.legacyBucketReader`. The second is there because `storage.objectAdmin` has no `storage.buckets.get`. Anyone who ran `setup` earlier must run `setup --yes` once more to pick up this role and the `iam.googleapis.com` API.

3. Add the API key, unless the secret already has the version you want. `setup` never reads or handles it. Copy the key, then run:

   ```sh
   pbpaste | gcloud secrets versions add c4-anthropic-api-key --data-file=- --project=<project> --account=<account>
   ```

4. Commit and push the code to run, so that the tree is clean and `HEAD` is on `origin`. `harness/smoke/run-batch.ts` must exist at `HEAD`.

5. Read the plan, then start the run. `--condition <study-id>` is required, one of the study IDs listed in [Condition](../README.md#condition), such as `cr-repo-claude-opus-5.5`. It names the VM and the vault branch, and reaches the VM as metadata `condition` and as `vm-run.ts run --condition <study-id>`, which passes it on to the entry. `setup`, `status` and `cleanup` take no condition. `--seed` defaults to 1.

   ```sh
   node harness/gcp/launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1
   node harness/gcp/launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --yes
   ```

   It refuses unless the checks above pass, both secrets have an enabled version and no `purpose=c4-smoke` VM exists; a sharded start has its own rule, see [Shard the batch across VMs](#shard-the-batch-across-vms). It prints the VM name, run ID, machine type, zone, boot disk, result locations and the next commands.

6. Check on the run. `--run-id` is optional while the VM exists.

   ```sh
   node harness/gcp/launch.ts status --run-id <run_id>
   ```

7. When `DONE.json` appears, read the results and delete the stopped VM. `cleanup` deletes only `purpose=c4-smoke` VMs and refuses a RUNNING one. VMs are named `cr-<topic>-<run_id>`, where `<topic>` is the second segment of the run's `--condition`, for example `cr-repo-<run_id>` for `cr-repo-claude-opus-5.5`, so the name fits GCE's 63 characters. The full study ID, with each `.` turned into `-`, goes in a second label, for example `study=cr-repo-claude-opus-5-5`. Studies that share a topic, such as `cr-effort-claude-sonnet-5.5` and `cr-effort-claude-haiku-5.5`, share the VM prefix and differ by that label. `cr-effort-claude-opus-5.5` keeps the legacy name `c4-c-smoke-<run_id>`, which every VM from before `--condition` also has, and older VMs are named `c4-smoke-<run_id>`. When `<prefix>-<run_id>` would pass 63 characters, the VM name keeps the run ID's timestamp, commit and any shard suffix and puts a 6-character hash of the study ID and the full run ID in place of its repeat, arms and models suffixes, for example `c4-c-smoke-20261108t060747z-60df929-1a2b3c-s0of2`. The full run ID stays in the `run-id` metadata, the GCS prefix and the vault branch. All of them carry the `purpose=c4-smoke` label, so `cleanup` finds them and `status` reads their run IDs, from the `run-id` metadata when it is there and from the name otherwise.

   ```sh
   node harness/gcp/launch.ts cleanup
   node harness/gcp/launch.ts cleanup --yes
   ```

## Choose what the VM runs

`start` takes `--entry <path>`, and `vm-run.ts run` receives it. Only two values are admitted, and anything else is refused with the usage line and exit 2:

| `--entry` | Runs | Boot disk |
|---|---|---|
| `harness/smoke/run-batch.ts` (default) | The smoke batch | 100 GB |
| `harness/checks/run-all.ts` | The pre-main checks, in order: recall, pilot, label check | 200 GB |

```sh
node harness/gcp/launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --entry harness/checks/run-all.ts
node harness/gcp/launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --entry harness/checks/run-all.ts --yes
```

`start` refuses unless the chosen entry exists at `HEAD`. The default leaves the VM command and the startup script as they were.

`run-all.ts` writes `recall/`, `pilot/`, `label-check/` and `run-all.json` under the results, and runs the checkpoint after each step. The pilot gets `--batch-budget-usd` of $10 minus the recall step's `spent_usd`, read from `recall/summary.json`. If that value is not readable, it assumes recall spent $5 and records 5 as `recall_spent_usd`. It also gets `--review-reserve-usd 1`, because a measured review costs about $0.06 and a $4 reserve would stop the pilot early. A failing step is recorded and the later steps still run. `run-all.json` holds `steps[{name,exit_code,started_at,finished_at}]`, `recall_spent_usd` and `pilot_budget_usd`. `run-all.ts` exits 1 if any step failed, and `batch_exit_code` in `DONE.json` is that exit code.

To resume, add `--resume-from <prior_run_id>`. With this entry, `start --yes` refuses unless `gs://<project>-c4-smoke/runs/<prior_run_id>/run-all.json` exists, so a run that stopped during its first step cannot be resumed. A step with exit 0 in the prior `run-all.json` is copied and skipped. A pilot that has to run again gets `--resume-from` on the prior `pilot/` directory, so its own carried cap and reuse rules apply.

To run the checks on another patch list, add `--patches <path>`. The path must match `harness/checks/<name>.json` (lowercase letters, digits and hyphens) and exist at `HEAD`; anything else is refused. It reaches the VM as metadata `patches` and as `vm-run.ts run --patches <path>`, and the entry gets `--patches <path>` inside the VM checkout. With it, `run-all.ts` skips the pilot: it runs recall on the list, then `label-check.ts --patches <path> --jobs 4`, and `pilot_budget_usd` stays null. The batch entry also accepts the flag.

```sh
node harness/gcp/launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --entry harness/checks/run-all.ts --patches harness/checks/check-patches.json --yes
```

`recall.ts` asks once per instance. A list that repeats an instance under another agent is accepted when both entries agree on `problem_statement_sha256`, `base_commit` and `gold_patch_sha256`, and refused otherwise.

## Resume a stopped run

A resume is always a new VM with a new run ID. Read the plan, then start it, from the same clean, pushed state as step 4 and with the same seed. Delete the stopped VM first, because `start` refuses while one exists.

```sh
node harness/gcp/launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --resume-from <prior_run_id>
node harness/gcp/launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --resume-from <prior_run_id> --yes
```

With `--yes`, it also refuses unless `gs://<project>-c4-smoke/runs/<prior_run_id>/preflight-report.json` exists. The ID reaches the VM as metadata `resume-from` and as `vm-run.ts run --resume-from <prior_run_id>`. The VM downloads the prior run to `/opt/c4/prior` and passes it to the batch, which takes the prior run's patches file and shard when `--patches` or `--shard` is omitted and refuses a different one; see [Resume](../README.md#resume). `start` still names the run and checks VMs by its own `--shard`, so pass the prior shard to keep its suffix. If the download fails, the batch does not start, nothing is spent, `DONE.json` has `batch_exit_code: null` and the VM shuts down as usual.

- **Reused:** a review that passes the capture check, has a parsed verdict and matches the current plan and pins. It makes no model call. Anything else is re-run. See [Resume](../README.md#resume) for the full list.
- **Carried cap:** the $20 cap spans the whole chain. Prior spend carries forward, failed reviews included. A prior run with no `summary.json` is also charged $4 for each run directory with no `run.json`, a review that may have been in flight. A seed that differs from the prior run's makes the batch refuse with exit 2 before any spend.
- **Pause and budget:** `start` also takes `--pause-after-patches <n>`, `--batch-budget-usd <n>`, `--review-reserve-usd <n>` (above 0, at most 4) and `--unusable-limit <n>` (a positive integer: the API or VM failures, never missing or malformed verdicts or reviews that hit their $4 or 60-minute limit, counted per cell on each shard's VM only) for the batch entry, passed as metadata and on to `run-batch.ts`. A reserve above the budget, counting the $4 and $20 defaults, is refused with exit 2 before any gcloud call; see [Budget](../README.md#budget). See [Pause after n patches](../README.md#pause-after-n-patches) and [Unusable limit](../README.md#unusable-limit).
- **Dataset lookup:** when HF `/filter` fails, the batch pages `/rows`, and the sha256 pins still decide what is accepted, so a `/filter` outage no longer stops a run at setup.

## Shard the batch across VMs

`start` takes `--shard <k>/<n>` with the batch entry: integers with `n >= 2` and `0 <= k < n`. The VM runs only the patches whose 0-based index in the patches file has `index % n === k`, with the run names, run orders and efforts of the full seeded plan, so the n shards together are the full plan with no overlap. The run ID gets the suffix `-s<k>of<n>`, for example `20261102t200000z-64badb4-s0of6`, and so do the VM name, the GCS prefix and the vault branch. The shard reaches the VM as metadata `shard` and as `vm-run.ts run --shard <k>/<n>`, and `preflight-report.json` and `summary.json` record it as `shard`. It is refused with `--entry harness/checks/run-all.ts`.

Every main run uses every VM the 12-vCPU free-trial quota allows, to keep wall-clock time minimal. Before `start`, list the running `purpose=c4-smoke` VMs and their vCPUs, then launch as many shards as the free vCPUs fit at the chosen machine type, for example six `e2-standard-2`, as the effort study ran, or three `e2-standard-4`. When another study's VM holds vCPUs, wait for it to finish instead of launching fewer shards. A filing never fixes a smaller shard count: it says one shard per available VM, set by the quota at launch, with the cost stop split evenly across the shards.

Each VM also takes:

| Flag | Default | Admits |
|---|---|---|
| `--zone <zone>` | `us-central1-a` | A GCP zone such as `us-east1-b` |
| `--machine-type <type>` | `e2-standard-4` | `e2-standard-<n>` |
| `--boot-disk-size <n>GB` | `100GB`, or `200GB` with the checks entry | 50 to 500 GB |

The machine type also goes to metadata `machine-type` and to the batch's `--vm-type`. Anything else is refused with the usage line and exit 2.

Run one `start` per shard, each with the same seed and `--resume-from` on the pilot run, from the same clean, pushed state as step 4. Each pilot review belongs to exactly one shard, so it is reused once. Read each plan first by dropping `--yes`.

```sh
node harness/gcp/launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --shard 0/6 --resume-from <prior_run_id> --machine-type e2-standard-2 --zone us-central1-a --yes
node harness/gcp/launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --shard 1/6 --resume-from <prior_run_id> --machine-type e2-standard-2 --zone us-central1-a --yes
node harness/gcp/launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --shard 2/6 --resume-from <prior_run_id> --machine-type e2-standard-2 --zone us-east1-b --yes
node harness/gcp/launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --shard 3/6 --resume-from <prior_run_id> --machine-type e2-standard-2 --zone us-east1-b --yes
node harness/gcp/launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --shard 4/6 --resume-from <prior_run_id> --machine-type e2-standard-2 --zone us-west1-b --yes
node harness/gcp/launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --shard 5/6 --resume-from <prior_run_id> --machine-type e2-standard-2 --zone us-west1-b --yes
```

A sharded `start` refuses while a VM with its own name exists or while any `purpose=c4-smoke` VM belongs to an unsharded run. It goes ahead alongside other sharded VMs. An unsharded `start` still refuses while any `purpose=c4-smoke` VM exists. `status` lists every VM with its zone, and `cleanup` deletes each stopped VM in its own zone.

Each shard's meter starts at the pilot's `spent_usd`, because each one resumes from it, so set `--batch-budget-usd` per shard to that plus the shard's own share.

Project quota decides how the shards spread:

- 12 vCPUs across all regions, so six `e2-standard-2` shards use all of it and no other VM can run.
- 250 GB of SSD per region, which `pd-balanced` boot disks count against: two 100 GB disks fit in one region, three need `--boot-disk-size 80GB` or less.
- 4 in-use external IP addresses per region, one per VM.

## Repeat the high arm

`start` takes `--repeat <n>` with the batch entry: an integer from 2 to 99. The VM reviews every patch of the patches file once at `high`, named `NN-<instance_id>-high-r<n>`, and records `repeat_number: n`; see [Repeat](../README.md#repeat). The run ID gets the suffix `-r<n>` before any shard suffix, for example `20261102t200000z-64badb4-r2` or `20261102t200000z-64badb4-r2-s0of2`, and so do the VM name, the GCS prefix and the vault branch, so a repeat run never shares a name with the main run. The repeat reaches the VM as metadata `repeat` and as `vm-run.ts run --repeat <n>`, and `preflight-report.json` and `summary.json` record it as `repeat`. It is refused with `--entry harness/checks/run-all.ts`.

The `cr-effort-claude-opus-5.5` noise check reviews the 20 patches of [`checks/repeat-patches.json`](../checks/repeat-patches.json) once more. Read the plan first by dropping `--yes`.

```sh
node harness/gcp/launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --repeat 2 --patches harness/checks/repeat-patches.json --yes
```

## Run the author's-note arms

`start` takes `--arms <list>` with the batch entry: a comma list of distinct arms from `c`, `e1`, `e2b`, `e2g`, the read-only arm `a`, the no-spec arm `b` and the `cr-skill-claude-opus-5.5` arms `skill` and `tmbcr` (see [Arms and profiles](../README.md#arms-and-profiles)). The VM reviews every patch of the patches file once per arm at `medium`, named `NN-<instance_id>-medium-<arm>`, and records `arm` and `authors_note`; see [Arms](../README.md#arms). The run ID gets the suffix `-arms-<arms>`, the arms in canonical order joined by `-`, before any shard suffix, for example `20261102t200000z-64badb4-arms-c-e1-e2b-e2g` or `20261102t200000z-64badb4-arms-c-e1-e2b-e2g-s0of2`, and so do the VM name, the GCS prefix and the vault branch. The arms reach the VM as metadata `arms` and as `vm-run.ts run --arms <list>`. Because the list holds commas, the metadata flag then uses gcloud's alternate delimiter, `--metadata=^;^run-id=...;arms=c,e1,e2b,e2g` (see `gcloud topic escaping`). It is refused with `--repeat` and with `--entry harness/checks/run-all.ts`. With `--models` it runs each arm on each model cell; see [Run model cells](#run-model-cells).

The `cr-authornote-claude-opus-5.5` pilot reviews the 10 patches of [`checks/e-pilot-patches.json`](../checks/e-pilot-patches.json) on arms `e1`, `e2b` and `e2g`, 30 reviews, capped at $5 by `--batch-budget-usd 5`. `--review-reserve-usd 1` lets the meter dispatch while $1 of the cap is left; with the default $4 reserve it stops after about $1 of spend, near 11 reviews. Read the plan first by dropping `--yes`.

```sh
node harness/gcp/launch.ts start --condition cr-authornote-claude-opus-5.5 --seed 1 --arms e1,e2b,e2g --batch-budget-usd 5 --review-reserve-usd 1 --patches harness/checks/e-pilot-patches.json --yes
```

## Run model cells

`start` takes `--models <list>` with the batch entry: a comma list of entries, each `<model>` or `<model>:<low|medium|high>`, no model twice, from `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`; see [Models](../README.md#models). Without `--arms`, the VM reviews every patch once per (model, effort) cell on arm `c`, a bare entry at every effort and an entry with an effort at that effort only, named `NN-<instance_id>-<effort>-<short>`. With `--arms`, each entry is one cell, at `medium` when it has no effort, and the VM reviews every patch once per arm x cell, named `NN-<instance_id>-<effort>-<arm>-<short>`.

The run ID gets the suffix `-models-<cells>` after any `-arms-<arms>` suffix and before any shard suffix. Each cell is its short name, `opus`, `sonnet` or `haiku`, followed by the first letter of its effort, `l`, `m` or `h`, when the entry has one, in canonical order joined by `-`: for example `20261102t200000z-64badb4-models-sonnet-haiku`, `20261102t200000z-64badb4-models-haikuh-s0of2` or `20261102t200000z-64badb4-arms-c-models-opusm-haikuh`. The VM name, the GCS prefix and the vault branch follow it. The arms and models reach the VM as metadata `arms` and `models` and as `vm-run.ts run --arms <list> --models <list>`; with two or more entries the metadata flag uses the alternate delimiter, as for the arms. It is refused with `--repeat` and with `--entry harness/checks/run-all.ts`. A run ID too long for a 63-character name gets the shortened VM and batch network names described in step 7 of [Your steps, in order](#your-steps-in-order), so every `--arms`, `--models`, `--repeat` and `--shard` combination `start` accepts fits. `start --yes` still refuses unless the VM name, the batch network name and its `<network>-proxy` container name are each a DNS label of at most 63 characters, which only an unusually long commit hash from `git rev-parse --short=7` can break. Read the plan first by dropping `--yes`.

```sh
node harness/gcp/launch.ts start --condition cr-effort-claude-sonnet-5.5 --seed 1 --models claude-sonnet-5-5 --yes
node harness/gcp/launch.ts start --condition cr-effort-claude-haiku-5.5 --seed 1 --models claude-haiku-5-5 --yes
node harness/gcp/launch.ts start --condition cr-effort-claude-opus-5.5 --seed 1 --models claude-sonnet-5-5,claude-haiku-5-5 --yes
node harness/gcp/launch.ts start --condition cr-authornote-claude-opus-5.5 --seed 1 --arms c --models claude-opus-5-5:medium,claude-haiku-5-5:high --yes
```

## Results

| Where | What |
|---|---|
| `gs://<project>-c4-smoke/runs/<run_id>/` | Results, `vm-stats.json`, `DONE.json`, `STARTED`, `c4-startup.log` |
| `<vault-repo>`, branch `<study-id>/smoke/<run_id>`, under `<study-id>/smoke/<run_id>/`; for `cr-effort-claude-opus-5.5`, branch `c4-c-smoke/<run_id>`, under `c4-effort/c4-c-smoke/<run_id>/` | Results, `vm-stats.json`, `DONE.json` |

`DONE.json` holds `run_id`, `batch_exit_code`, `finished_at`, `vault_push_ok`, `gcs_copy_ok` and `peak_disk_gb`. `batch_exit_code` is 0 when the batch finished, 1 when a gate or budget stopped it, 2 when it refused, and `null` when an error stopped the batch from finishing.

If `DONE.json` is missing, read `c4-startup.log`. Setup may have failed before the batch ran, or `sync` may have refused to publish. `sync` refuses when a result file contains the API key value or when it cannot run that check. A refused run's results stay on the VM's disk until `cleanup`.

## Guards

- **Time limit:** `--max-run-duration=10h` deletes the VM, disk included, at the limit. Anything not yet synced is lost. Nine reviews at the 60-minute cap can take 9h.
- **Second boot:** each run has its own VM and marker, and a resume does not restart a VM. Stopping a VM clears that limit, and a restart recalculates it. A `STARTED` marker in GCS makes any later boot stop the VM without spending, and `--no-restart-on-failure` prevents crash reboots.
- **Stopping:** the startup script's `EXIT` trap uploads its log and shuts the VM down, whatever happened before it.
- **Secrets:** the API key reaches only the batch's environment. The deploy key lives in a 0600 file under `/dev/shm`, and it can write only to the vault. Pushes never force and never touch `main`, and a failed push does not stop the GCS copy or the batch.

On the VM, `gcloud` runs as the service account, so those calls pass `--project=<project>` and no `--account`.
