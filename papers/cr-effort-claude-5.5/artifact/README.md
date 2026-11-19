# cr-effort-claude-opus-5.5 Analysis Artifact

This directory holds the data, analysis code and figures behind every number in `papers/cr-effort-claude-5.5/paper.md`. The study plan is preregistered on the Open Science Framework at [osf.io/r8q2m](https://osf.io/r8q2m/). The run record rests on `data/attempts.csv` and `data/spend-ledger.csv`.

The scripts need Node.js 24 or later, which runs TypeScript directly. They have no package dependencies.

## Reproduce the Paper's Numbers From the Committed Data

Run from this directory:

```sh
node analysis/analyze.ts --data data --out outputs
node analysis/figures.ts --results outputs/results.json --data data --out figures
```

`analyze.ts` reads only the CSV files in `data/` and writes `outputs/results.json`. Every statistic in the paper is a field of that file.

The metrics take a wrong patch as the positive class and a rejection as a flag: a true positive is a wrong patch rejected, a false negative a wrong patch accepted, a false positive a correct patch rejected and a true negative a correct patch accepted. For each effort, `rates` holds `miss_rate` (wrong patches accepted, the preregistration's "false success") and `false_alarm_rate` (correct patches rejected), each with its count and 95% Wilson interval, and `balanced_accuracy`, the mean of one minus each rate. It also holds the exploratory `confusion` counts (`tp`, `fn`, `fp`, `tn`), `precision`, `recall`, `accuracy`, and `f1` and `mcc` (Matthews correlation coefficient), each with a 95% percentile-bootstrap interval over patches. These scores count a malformed verdict as a rejection, the primary rule.

The patch labels come from `data/labels.csv`, not from the `label` column of `results.csv`, which keeps the SWE-ABS label each patch was drawn with. `labels.csv` holds one row per main patch, plus the three sensitivity originals, with the original label, the rule that decided it and the corrected label; the rules are in the repository's `LABELS.md`. `analyze.ts` and `models.ts` score on the corrected `label`, stop if a patch has no `main` row or if its `original_label` differs from the raw `label`, and rerun the rates and hypotheses on the original labels under `original_labels`. `label_changes` counts the changed labels by direction and rule. The preregistered blinded look stays on the original labels, as it was run during the study. The bootstrap uses the seed 20261102 and 10,000 resamples with a mulberry32 generator, so reruns give identical output. `figures.ts` writes the Opus-only recall-split figure `figures/fig4-recall-split.svg`; Sonnet and Haiku had no recall test.

The cross-model comparison also runs from this directory:

```sh
node analysis/models.ts --reviews ../haiku-vs-opus/artifact/data/reviews.csv --requires data/issue-requires-coding.csv --labels data/labels.csv --out outputs/models.json
node analysis/models-figure.ts --models outputs/models.json --reviews ../haiku-vs-opus/artifact/data/reviews.csv --out figures
node analysis/thinking-figure.ts --reviews ../haiku-vs-opus/artifact/data/reviews.csv --out figures
```

`models.ts` compares Opus, Sonnet and Haiku at low, medium and high effort and writes `outputs/models.json`. For each model, `by_model` holds the rates and scores described above, the hypothesis tests and the cost, plus `incremental` (the extra cost per review, wrong patches caught, false alarms and dollars per extra catch for each step up in effort: `low_medium`, `medium_high` and `low_high`), `negative_predictive_value` (the share of accepted patches that are correct when 16.7% or 50% of incoming patches are wrong), `label_error_sensitivity` (the miss rate corrected for 0%, 5%, 10% or 20% of wrong labels being correct patches) and the exploratory `author_split` (the miss and false-alarm rates with Wilson intervals for each effort, split by the model family of the agent that wrote the patch). The family comes from the patch's `agent_id`: `claude_named` when it contains "claude" in any case, `other_named` when it names another model family (gpt, gemini, kimi, doubao, qwen, deepseek, llama or glm, in any case), and `unnamed` otherwise. The top-level `author_split_groups` gives each family's count of wrong and correct patches. `original_labels.by_model` repeats every block on the original labels. The label-check swap (supplement S4.8) reruns that comparison with the three wrongly excluded patches put back in place of their replacements:

```sh
node analysis/swap-sensitivity.ts --reviews ../haiku-vs-opus/artifact/data/reviews.csv --sensitivity data/label-check-sensitivity-reviews.csv --labels data/labels.csv --requires data/issue-requires-coding.csv --draw ../../../harness/checks/main-draw.json --out outputs/models-swap.json
```

`swap-sensitivity.ts` takes the replacements from the seeded draw `harness/checks/main-draw.json`, keeps those whose excluded patch has reviews in `data/label-check-sensitivity-reviews.csv`, and swaps those reviews in for the replacement's reviews in every model and effort. The excluded patches take their `sensitivity` rows of `data/labels.csv`. It writes `outputs/models-swap.json` in the shape of `models.json`, with `swap` naming each exchanged pair; `by_model` holds every block on the corrected labels and `original_labels.by_model` every block on the original labels, which is the computation S4.8 reports. The swapped-in patches have no issue-requirement code, so `label_question` is left out. `models-figure.ts` writes the error-rate figure `figures/fig1-error-rates.svg`, the cost strip `figures/fig2-models-cost.svg` (the cost of each review in `reviews.csv` by model and effort, with the geometric means and medium/high cost ratios of `models.json`) and the cost-agreement figure `figures/fig5-models-cost-agreement.svg`. Every figure that shows several models marks Opus as preregistered and Sonnet and Haiku as exploratory. `thinking-figure.ts` plots the thinking tokens of every review by model and effort in `figures/fig6-thinking-tokens.svg`.

The count of shallow passes (supplement S8) also runs from this directory:

```sh
node analysis/shallow-pass.ts --reviews ../haiku-vs-opus/artifact/data/reviews.csv --results data/results.csv --labels data/labels.csv --out outputs/shallow-pass.json
node analysis/flowchart.ts --shallow outputs/shallow-pass.json --models outputs/models.json --out figures
```

`shallow-pass.ts` counts, for each model and effort, the passes with no thinking tokens, with at most one tool call and with no shell test run, and writes `outputs/shallow-pass.json`. `by_model` splits the passes by the corrected label of `data/labels.csv`, and `original_labels.by_model` gives the same counts split by the original label. It first checks that the Opus rows of `reviews.csv` match the main-run rows of `data/results.csv`. `flowchart.ts` writes the reviewer flowchart `figures/fig0-reviewer-flowchart.svg` with those counts and the malformed verdicts from `outputs/models.json`.

## Rebuild the Data From the Run Records

The run directories hold full transcripts, which contain patch text with no licence for redistribution, so they are private. They are kept in a private archive held by the authors and are available from the authors on request. With read access, download the batch directories named in `data/spend-ledger.csv` into one directory and run:

```sh
node analysis/build-results.ts --runs <runs dir> --out data
node analysis/check-provenance.ts data
node analysis/derive-data.ts --audit <memory coding dir> --checks <runs dir>/20261102t124549z-5e7b1da --cache <instance cache> --patches ../../../harness/checks/main-patches.json --out data
```

- `build-results.ts` follows each final shard's `resumed_from` chain back to the batch that ran each review. It writes `results.csv`, `attempts.csv` and `spend-ledger.csv`.
- `check-provenance.ts` prints the harness commit, VM type, model, CLI version, prompt hash and environment hash behind each review.
- `derive-data.ts` writes the memory coding, recall scores, label-check summary, patch similarity and issue-text properties. The memory coding directory holds the coders' JSON output and the key that maps blind codes to runs. The instance cache holds each instance's SWE-bench dataset row and candidate diff.
- `requires-packets.ts <checks dir> <instance cache> <main-patches.json>` prints the blind packets used to code `issue-requires-coding.csv`. Its output contains issue text and test output, so it is not committed.

The archive holds every batch of this study, the main run included. Local mirrors live in the git-ignored `runs/` directory at the repository root:

| Directory | Contents | In `data/spend-ledger.csv` |
|---|---|---|
| `runs/gcs/<batch_run_id>/` | Mirror of the archive, one folder per batch | Every `batch_run_id` in the ledger has a folder. The mirror also holds the `20261101t021819z-2666a4e` smoke batch, two batches outside the ledger (`20261102t171734z-537a4e7` and `20261102t175326z-f17eb78`) and four superseded shards (`20261102t230508z-a83c3e6-s0of6`, `20261102t230637z-a83c3e6-s3of6`, `20261102t231406z-a83c3e6-s3of6` and `20261102t231513z-a83c3e6-s4of6`); none of these are in the ledger |
| `runs/smoke-audit/<batch_run_id>/` | Audit copies of the smoke-test batches | Yes, by `batch_run_id` |
| `runs/c4-recall-main/` | Recall run after the main run (68 instances), merged from `runs/c4-recall-main-20261102/` (14) and `runs/c4-recall-main-20261102-b/` (54); it ran outside the cloud batches | No |
| `runs/cache/` | Instance cache | No |
| `runs/c4-c-mvp-*` | Pre-study runs | No |

## Files

| File | One row per | Source |
|---|---|---|
| `data/results.csv` | Review: 270 main reviews and 20 repeats | `harness/results-csv.ts` columns plus `study_part`, `label`, `batch_run_id`, `origin_run_id`, `harness_commit` and `origin_vm_type` |
| `data/labels.csv` | Main patch (90) and sensitivity original (3) | Corrected labels under the rules in `LABELS.md`, copied unchanged from the repository root |
| `data/attempts.csv` | Model-call attempt in the main lineage and the repeat batch, kept or not | Run records; `api_error_status` comes from the transcript's result event |
| `data/spend-ledger.csv` | Billed item per batch | `run.json` cost for reviews; `spent_usd` for recall runs; reused runs are not counted twice |
| `data/memory-coding.csv` | Coder judgment: 270 reviews, 60 of them coded twice | Blind coding of whether recall of the upstream fix drove a review |
| `data/recall-scores.csv` | Instance in the 74-instance recall test | `harness/checks/recall.ts` scores, without the model's answer text |
| `data/recall-after-main.csv` | Instance in the recall run after the main run (68) | `harness/checks/recall-csv.ts` over the recall run directory |
| `data/label-check-summary.csv` | Main patch | Three local re-runs of the Verified and SWE-ABS tests |
| `data/label-check-exclusions.csv` | Drawn patch replaced before the main run | Label check |
| `data/patch-similarity.csv` | Main patch | Changed lines per file compared with the official fix and test patch |
| `data/issue-properties.csv` | Main instance (68) | Text patterns over the SWE-bench problem statement |
| `data/issue-requires-coding.csv` | Main patch wrong under either label (63) | Post hoc single-coder judgment of whether the issue requires the behavior the failing SWE-ABS test checks; `no_failing_test` for the three patches that every test passes and the corrected labels make wrong. Rows for patches the corrected labels make correct are kept and not used |
| `outputs/results.json` | Analysis | `analyze.ts` |
| `figures/*.svg` | Figure | `figures.ts`, `models-figure.ts`, `flowchart.ts`, `thinking-figure.ts` |

Costs are list-price USD computed by the Claude Code CLI 2.1.311 from token counts.
