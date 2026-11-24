# cr-effort Cross-Family Extension Analysis Artifact

This directory holds the data and analysis code behind the cross-family extension (RQ7) of the cr-effort paper: eleven reviewer settings from six model families, run as Cursor subagents through [`harness/subagent/`](../../../../harness/subagent/) on the 90 main patches, one review per patch and setting. The extension is exploratory throughout, with no correction for multiplicity.

The scripts need Node.js 24 or later, which runs TypeScript directly. They have no package dependencies.

## Files

| Path | Contents |
|---|---|
| `analysis/build-reviews.ts` | Builds `data/reviews.csv` and `data/discarded.csv` from the run directory |
| `analysis/analyze.ts` | Rates, the paired comparison with Opus 5.5 at medium, the issue-requirement split, the panels and the audit counts; writes one JSON file and prints a line per setting |
| `data/reviews.csv` | One row per review (990): verdict, work measures and audit counts; no review text |
| `data/discarded.csv` | The 9 reviews left out because a launcher resumed them, with the reason; each was run again in a new workspace |
| `outputs/cross-family.json` | The output of `analyze.ts` on the committed data |

## Reproduce the Extension's Numbers From the Committed Data

Run from this directory:

```sh
node analysis/analyze.ts --reviews data/reviews.csv --discarded data/discarded.csv --labels ../../artifact/data/labels.csv --requires ../../artifact/data/issue-requires-coding.csv --main-reviews ../../haiku-vs-opus/artifact/data/reviews.csv --out outputs/cross-family.json
```

A review accepts a patch only with the verdict `pass`; a missing or malformed verdict counts as no acceptance, as in the main study. `analyze.ts` scores each review on the corrected `label` in `../../artifact/data/labels.csv` and stops if a patch has no `main` row there or if its `original_label` differs from `label_stratum`, the SWE-ABS label the patch was drawn with. The main-study reviews come from `../../haiku-vs-opus/artifact/data/reviews.csv`.

| Field | Holds |
|---|---|
| `coverage` | Reviews, discarded reviews, patches reviewed twice by one setting, and audited reviews |
| `audit` | Reviews with each kind of audit flag, reviews that changed the checkout, and reviews with no verdict |
| `paper_reference` | The rates of Opus 5.5 at medium and high, Sonnet 5.5 at high and Haiku 5.5 at high in the main study |
| `by_model` | For each setting: `name`; `reviews`, `wrong`, `correct` and `no_verdict`; `false_success` and `false_alarm`, each with its count, denominator, rate and 95% Wilson interval; `balanced_agreement` and `youden_j`; `by_requirement`; `original_labels`; `versus_paper_opus_medium`; and `work` |
| `by_requirement` | Accepted wrong patches in each group of the issue-requirement code in `issue-requires-coding.csv` |
| `original_labels` | False success, false alarm and balanced accuracy on the SWE-ABS labels |
| `versus_paper_opus_medium` | The setting paired with Opus 5.5 at medium in the main study on the patches both reviewed: the counts of wrong patches each side rejected, the two-sided exact McNemar p on them, the false-success difference with its Newcombe interval, the false alarms only one side raised, and the difference in Youden's J (`delta_j`) with a MOVER interval built from the two Newcombe intervals |
| `work` | The median minutes from launch to the last write of `final.md`, which include the subagent's start-up; the median `tb` test runs and tool calls; the audited reviews; the IDs of reviews with an audit flag; and the reviews with a host `/tmp` path or a changed checkout |
| `paper_reference_by_requirement` | `by_requirement` for the four main-study settings |
| `panel_all`, `panel_non_claude` | Across all eleven settings, or the nine that are not Claude: wrong patches that any setting rejected and that none did, correct patches that any setting rejected, and the errors of a majority vote |
| `bridge` | Sonnet 5.5 at high in the extension against Sonnet 5.5 at high in the main study, and Opus 5.5 at max against the main study's Opus 5.5 at high, in the shape of `versus_paper_opus_medium` |

Cursor reports no tokens or cost for a subagent, so there is no cost field.

| Column of `data/reviews.csv` | Holds |
|---|---|
| `id` | The review's workspace ID, 8 random hex digits |
| `model` | The Cursor model slug, which fixes the model and its effort |
| `instance_id`, `agent_id`, `label_stratum` | The patch and the SWE-ABS label it was drawn with |
| `verdict`, `verdict_failure`, `findings`, `wall_s`, `container_commands`, `container_test_runs`, `checkout_unchanged` | The columns of `harness/subagent/collect.ts` |
| `assistant_turns`, `tool_calls`, `shell_test_runs`, `prompt_exact` | The fields of `harness/subagent/audit.ts` |
| `forbidden_tools`, `network_commands` | The number of each audit flag |
| `outside_tool_output` | Paths outside the workspace that are Cursor's saved tool output, under `~/.cursor/projects/<project>/terminals/` or `agent-tools/` |
| `outside_pathless_search` | Searches with no path, which search the Cursor workspace |
| `outside_tmp` | Paths in the host's `/tmp` given to a file tool |
| `outside_other` | Any other path outside the workspace |
| `host_tmp_paths` | `/tmp` paths in the host side of `Shell` commands |

The `outside_*` columns count the audit's `outside_paths` flags by kind. The flags themselves hold host paths, so they are not committed. The rows are sorted by `instance_id`, `agent_id` and `model`.

## Rebuild the Data From the Run Records

The run directory holds copies of each review's `final.md`, which can quote patch code with no licence for redistribution, so it is private and available from the authors on request; so are the Cursor transcripts. With read access, audit every unit and check the transcripts first, as [the harness README](../../../../harness/README.md#subagent-reviewers) describes, then run:

```sh
node analysis/build-reviews.ts --runs <run dir> --out data
```

`build-reviews.ts` reads every directory under `<run dir>` that holds `collected/results.json` from `collect.ts`, and stops if one has no `audit.json` from `audit.ts` or a review appears twice. The extension's run directory holds the batches prepared before the queue and the units of `manager.ts`. `<run dir>/discarded.json` lists the reviews to leave out, each with `id`, `model`, `instance_id`, `agent_id` and `reason`; list there every review that `integrity.ts` reports.
